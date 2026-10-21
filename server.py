#!/usr/bin/env python3
"""Battle Map Studio server. Python stdlib only. See docs/CONTRACT.md section 12.

Serves dist/index.html behind a password login, stores scenes, and calls the
Anthropic Messages API to generate and edit scenes. Contains a Python port of
src/schema.js (normalizeScene/validateScene/hash32) and src/core/patch.js
(applyPatch/touchedIds) that must give the same verdicts as the JS.
"""
import copy
import datetime
import hashlib
import hmac
import json
import math
import os
import re
import secrets
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

ROOT = os.path.dirname(os.path.abspath(__file__))


def _load_json_file(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


SCHEMA = _load_json_file(os.path.join(ROOT, 'schema.json'))
TYPES = SCHEMA['x-elementTypes']
COLLECTIONS = {'regions': 'region', 'paths': 'path', 'objects': 'object', 'labels': 'label'}
KIND_COLLECTION = {v: k for k, v in COLLECTIONS.items()}
ID_COLLECTIONS = ['regions', 'paths', 'objects', 'labels', 'constraints']
ELEMENT_COLLECTIONS = ['regions', 'paths', 'objects', 'labels']
SCENE_ID_RE = re.compile(r'[a-z0-9-]{1,64}')


# ---------------------------------------------------------------- strict JSON

class BadJson(ValueError):
    pass


def _reject_constant(name):
    raise BadJson(f'{name} is not valid JSON')


def _finite_float(s):
    v = float(s)
    if not math.isfinite(v):
        raise BadJson(f'number {s} is out of range')
    return v


def _bounded_int(s):
    if len(s) > 300:  # JS would turn this into Infinity
        raise BadJson('number is out of range')
    return int(s)


def parse_json(text):
    """json.loads that rejects NaN/Infinity and overflowing numbers (CONTRACT 3)."""
    try:
        return json.loads(text, parse_constant=_reject_constant, parse_float=_finite_float, parse_int=_bounded_int)
    except BadJson:
        raise
    except (ValueError, RecursionError) as e:
        raise BadJson(str(e)) from None


def dump_json(v):
    return json.dumps(v, allow_nan=False, separators=(',', ':'))


# ------------------------------------------------------ schema.js port

def hash32(s):
    """FNV-1a 32-bit over UTF-8 bytes (lone surrogates -> U+FFFD like TextEncoder)."""
    s = ''.join('�' if 0xD800 <= ord(c) <= 0xDFFF else c for c in str(s))
    h = 0x811C9DC5
    for b in s.encode('utf-8'):
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def _js_len(s):
    """String length in UTF-16 code units, like JS .length."""
    return len(s) + sum(1 for c in s if ord(c) > 0xFFFF)


def _is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _to_uint32(v):
    if isinstance(v, bool):
        return int(v)
    if not _is_num(v):
        return 0  # shortcut: JS coerces numeric strings too; such scenes fail validation anyway
    if not math.isfinite(v):
        return 0
    return int(v) % 4294967296


def _r2(v):
    return math.floor(v * 100 + 0.5) / 100  # Math.round(v * 100) / 100


def _missing(d, k):
    return d.get(k) is None  # JS ??= treats null like undefined


def _type_ok(t, v):
    if t == 'object':
        return isinstance(v, dict)
    if t == 'array':
        return isinstance(v, list)
    if t == 'string':
        return isinstance(v, str)
    if t == 'number':
        return _is_num(v) and (isinstance(v, int) or math.isfinite(v))
    if t == 'integer':
        return isinstance(v, int) and not isinstance(v, bool) or (isinstance(v, float) and v.is_integer())
    if t == 'boolean':
        return isinstance(v, bool)
    if t == 'null':
        return v is None
    return False


def _deep_eq(a, b):
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if _is_num(a) and _is_num(b):
        return a == b
    if type(a) is not type(b):
        return False
    if isinstance(a, list):
        return len(a) == len(b) and all(_deep_eq(x, y) for x, y in zip(a, b))
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(_deep_eq(a[k], b[k]) for k in a)
    return a == b


def _resolve_ref(ref):
    if not ref.startswith('#/'):
        raise ValueError(f'unsupported $ref {ref}')
    node = SCHEMA
    for k in ref[2:].split('/'):
        node = node[k.replace('~1', '/').replace('~0', '~')]
    return node


_pattern_cache = {}


def _pattern(p):
    if p not in _pattern_cache:
        # Python's "$" also matches before a trailing newline; JS's does not.
        _pattern_cache[p] = re.compile(p[:-1] + r'\Z' if p.endswith('$') and not p.endswith('\\$') else p)
    return _pattern_cache[p]


def _fmt(v):
    return json.dumps(v)


def validate_against(schema, value, path='', errors=None):
    if errors is None:
        errors = []
    if '$ref' in schema:
        return validate_against(_resolve_ref(schema['$ref']), value, path, errors)

    def err(message):
        errors.append({'path': path or '/', 'message': message})

    if 'const' in schema and not _deep_eq(schema['const'], value):
        err(f"must equal {_fmt(schema['const'])}")
        return errors
    if 'enum' in schema and not any(_deep_eq(e, value) for e in schema['enum']):
        err('must be one of ' + ', '.join(str(e) for e in schema['enum']))
        return errors
    if 'type' in schema:
        types = schema['type'] if isinstance(schema['type'], list) else [schema['type']]
        if not any(_type_ok(t, value) for t in types):
            err('must be ' + ' or '.join(types))
            return errors
    if _is_num(value):
        if 'minimum' in schema and value < schema['minimum']:
            err(f"must be >= {schema['minimum']}")
        if 'maximum' in schema and value > schema['maximum']:
            err(f"must be <= {schema['maximum']}")
    if isinstance(value, str):
        n = _js_len(value)
        if 'minLength' in schema and n < schema['minLength']:
            err(f"must be at least {schema['minLength']} characters")
        if 'maxLength' in schema and n > schema['maxLength']:
            err(f"must be at most {schema['maxLength']} characters")
        if 'pattern' in schema and not _pattern(schema['pattern']).search(value):
            err(f"must match {schema['pattern']}")
    if isinstance(value, list):
        if 'minItems' in schema and len(value) < schema['minItems']:
            err(f"must have at least {schema['minItems']} items")
        if 'maxItems' in schema and len(value) > schema['maxItems']:
            err(f"must have at most {schema['maxItems']} items")
        if 'items' in schema:
            for i, v in enumerate(value):
                validate_against(schema['items'], v, f'{path}/{i}', errors)
    if isinstance(value, dict):
        for k in schema.get('required', []):
            if k not in value:
                err(f'missing required property "{k}"')
        props = schema.get('properties', {})
        addl = schema.get('additionalProperties')
        for k, v in value.items():
            if k in props:
                validate_against(props[k], v, f'{path}/{k}', errors)
            elif addl is False:
                err(f'unknown property "{k}"')
            elif isinstance(addl, dict):
                validate_against(addl, v, f'{path}/{k}', errors)
    return errors


def iter_elements(scene):
    for collection in COLLECTIONS:
        arr = scene.get(collection)
        if isinstance(arr, list):
            for index, el in enumerate(arr):
                yield el, collection, index


def find_element(scene, el_id):
    for el, _, _ in iter_elements(scene):
        if isinstance(el, dict) and el.get('id') == el_id:
            return el
    return None


def normalize_element(el, scene_seed=0):
    if not isinstance(el, dict):
        raise TypeError('element must be an object')
    t = el.get('type')
    d = TYPES.get(t) if isinstance(t, str) else None
    if _missing(el, 'rotation'):
        el['rotation'] = 0
    if isinstance(el.get('id'), str) and _missing(el, 'seed'):
        el['seed'] = (hash32(el['id']) ^ _to_uint32(scene_seed)) & 0xFFFFFFFF
    if _missing(el, 'params'):
        el['params'] = {}
    if _missing(el, 'name') and 'id' in el:
        el['name'] = el['id']
    if not d:
        return el
    if _missing(el, 'layer'):
        el['layer'] = d['layer']
    params = el['params']
    if not isinstance(params, dict):
        return el  # invalid anyway: params must be an object
    for k, s in d.get('params', {}).get('properties', {}).items():
        if k not in params and 'default' in s:
            params[k] = copy.deepcopy(s['default'])
    pts = params.get('points')
    if d['kind'] in ('path', 'region') and isinstance(pts, list) and pts:
        w = params.get('width')
        pad = (w if _is_num(w) else 0) if d['kind'] == 'path' else 0
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        el['size'] = {'w': max(0.1, _r2(max(xs) - min(xs) + pad)), 'h': max(0.1, _r2(max(ys) - min(ys) + pad))}
    if d['kind'] == 'label' and isinstance(params.get('text'), str):
        f = params.get('fontFt')
        f = 3 if f is None else f
        el['size'] = {'w': max(0.1, _r2(_js_len(params['text']) * f * 0.55)), 'h': _r2(f * 1.2)}
    return el


def normalize_scene(inp):
    scene = copy.deepcopy(inp)
    if not isinstance(scene, dict):
        raise TypeError('scene must be an object')
    for k in ('constraints', 'regions', 'paths', 'objects', 'labels'):
        if _missing(scene, k):
            scene[k] = []
    if _missing(scene, 'seed'):
        scene['seed'] = 1
    if isinstance(scene.get('grid'), dict):
        if _missing(scene['grid'], 'color'):
            scene['grid']['color'] = '#000000'
        if _missing(scene['grid'], 'opacity'):
            scene['grid']['opacity'] = 0.22
    if isinstance(scene.get('terrain'), dict) and _missing(scene['terrain'], 'variation'):
        scene['terrain']['variation'] = 0.5
    if isinstance(scene.get('lighting'), dict) and _missing(scene['lighting'], 'elevation'):
        scene['lighting']['elevation'] = 45
    if isinstance(scene['constraints'], list):
        for c in scene['constraints']:
            if isinstance(c, dict):
                if _missing(c, 'measure'):
                    c['measure'] = 'edge'
                if _missing(c, 'direction'):
                    c['direction'] = 'any'
    for el, _, _ in iter_elements(scene):
        normalize_element(el, scene['seed'])
    return scene


def validate_scene(scene):
    errors = validate_against(SCHEMA, scene, '')
    if errors or not isinstance(scene, dict):
        return {'ok': False, 'errors': errors}

    def err(path, message):
        errors.append({'path': path, 'message': message})

    W, H = scene['grid']['widthFt'], scene['grid']['heightFt']
    if W % 5 or H % 5:
        err('/grid', 'widthFt and heightFt must be multiples of 5')
    ids = set()
    for el, collection, index in iter_elements(scene):
        p = f'/{collection}/{index}'
        if el['id'] in ids:
            err(f'{p}/id', f'duplicate id "{el["id"]}"')
        ids.add(el['id'])
        d = TYPES.get(el['type'])
        if not d:
            err(f'{p}/type', f'unknown element type "{el["type"]}"')
            continue
        if COLLECTIONS[collection] != d['kind']:
            err(f'{p}/type', f'type "{el["type"]}" is a {d["kind"]} and belongs in "{KIND_COLLECTION[d["kind"]]}"')
        if el['layer'] not in d['layers']:
            err(f'{p}/layer', f'layer for "{el["type"]}" must be one of {", ".join(d["layers"])}')
        validate_against(d['params'], el['params'], f'{p}/params', errors)
        pts = el['params'].get('points')
        if d['kind'] == 'region' and isinstance(pts, list) and len(pts) < 3:
            err(f'{p}/params/points', 'region needs at least 3 points')
        x, y = el['position']['x'], el['position']['y']
        if x < 0 or y < 0 or x > W or y > H:
            err(f'{p}/position', f'position ({x}, {y}) is outside the {W}x{H} ft map')
    for i, c in enumerate(scene['constraints']):
        p = f'/constraints/{i}'
        if c['id'] in ids:
            err(f'{p}/id', f'duplicate id "{c["id"]}"')
        ids.add(c['id'])
        if not find_element(scene, c['a']):
            err(f'{p}/a', f'unknown element "{c["a"]}"')
        if not find_element(scene, c['b']):
            err(f'{p}/b', f'unknown element "{c["b"]}"')
        if c['a'] == c['b']:
            err(f'{p}/b', 'a and b must differ')
    return {'ok': not errors, 'errors': errors}


def check_scene(inp):
    """Normalise then validate. Returns {ok, errors, scene}."""
    try:
        scene = normalize_scene(inp)
    except Exception as e:  # mirrors the JS try/catch around normalizeScene
        return {'ok': False, 'errors': [{'path': '/', 'message': str(e)}], 'scene': inp}
    return {**validate_scene(scene), 'scene': scene}


# ------------------------------------------------------- patch.js port

class PatchError(Exception):
    def __init__(self, op_index, message):
        super().__init__(f'op {op_index}: {message}')
        self.op_index = op_index


def parse_path(path):
    if not isinstance(path, str) or not path.startswith('/'):
        raise ValueError('path must start with "/"')
    return [t.replace('~1', '/').replace('~0', '~') for t in path[1:].split('/')]


_INDEX_RE = re.compile(r'(0|[1-9][0-9]*)')


def _exists(node, tok):
    if isinstance(node, list):
        return isinstance(tok, int) and tok < len(node)
    return tok in node


def _resolve(doc, tokens, op):
    if not tokens or tokens[0] == '':
        raise ValueError('cannot target the scene root')
    if tokens[0] not in doc:
        raise ValueError(f'unknown top-level key "{tokens[0]}"')
    parent, key = doc, tokens[0]
    for i in range(1, len(tokens)):
        node = parent[key]
        tok = tokens[i]
        if i == 1 and tokens[0] in ID_COLLECTIONS:
            if not isinstance(node, list):
                raise ValueError(f'{tokens[0]} is not an array')
            if tok == '-':
                if len(tokens) != 2 or op != 'add':
                    raise ValueError('"-" is only valid for add of a whole element')
            else:
                idx = next((j for j, e in enumerate(node) if isinstance(e, dict) and e.get('id') == tok), -1)
                if idx < 0:
                    if op == 'add' and len(tokens) == 2:
                        tok = '-'  # add by explicit id == append
                    else:
                        raise ValueError(f'no element with id "{tok}" in {tokens[0]}')
                else:
                    tok = idx
        elif isinstance(node, list):
            if tok != '-':
                if not _INDEX_RE.fullmatch(tok):
                    raise ValueError(f'bad array index "{tok}"')
                tok = int(tok)
        elif not isinstance(node, dict):
            raise ValueError(f'cannot descend into {json.dumps("/".join(tokens[:i]))}')
        if i < len(tokens) - 1 and (tok == '-' or not _exists(node, tok)):
            raise ValueError(f'path /{"/".join(str(t) for t in tokens[:i + 1])} does not exist')
        parent, key = node, tok
    return parent, key


def apply_patch(scene, ops):
    """Apply ops to a deep copy. All-or-nothing; raises PatchError."""
    if not isinstance(ops, list):
        raise PatchError(-1, 'ops must be an array')
    doc = copy.deepcopy(scene)
    for i, o in enumerate(ops):
        try:
            if not isinstance(o, dict):
                raise ValueError('op must be an object')
            op = o.get('op')
            if op not in ('add', 'remove', 'replace'):
                raise ValueError(f'unsupported op "{op}"')
            if op != 'remove' and 'value' not in o:
                raise ValueError('missing value')
            tokens = parse_path(o.get('path'))
            parent, key = _resolve(doc, tokens, op)
            v = copy.deepcopy(o.get('value'))
            if op == 'add':
                if isinstance(parent, list):
                    if key == '-':
                        parent.append(v)
                    elif key > len(parent):
                        raise ValueError('index out of range')
                    else:
                        parent.insert(key, v)
                else:
                    parent[key] = v
            else:
                if not _exists(parent, key):
                    raise ValueError(f'path {o.get("path")} does not exist')
                if op == 'replace':
                    parent[key] = v
                elif isinstance(parent, list):
                    removed = parent.pop(key)
                    if len(tokens) == 2 and tokens[0] in ELEMENT_COLLECTIONS and isinstance(removed, dict) and removed.get('id'):
                        rid = removed['id']
                        doc['constraints'] = [c for c in (doc.get('constraints') or [])
                                              if not (isinstance(c, dict) and (c.get('a') == rid or c.get('b') == rid))]
                else:
                    del parent[key]
        except PatchError:
            raise
        except Exception as e:
            raise PatchError(i, str(e)) from None
    return doc


def touched_ids(scene, ops):
    ids = {}
    for o in ops if isinstance(ops, list) else []:
        try:
            t = parse_path(o.get('path') if isinstance(o, dict) else None)
        except ValueError:
            continue
        if t[0] not in ELEMENT_COLLECTIONS:
            continue
        if len(t) == 1 or t[1] == '-':
            v = o.get('value')
            if isinstance(v, dict) and v.get('id'):
                ids[v['id']] = True
        else:
            ids[t[1]] = True
    return list(ids)


# ------------------------------------------------------------ settings

def _env_int(name, default):
    try:
        return int(os.environ.get(name, '') or default)
    except ValueError:
        sys.exit(f'{name} must be an integer')


CONFIG = _load_json_file(os.path.join(ROOT, 'config.json'))
PORT = _env_int('PORT', 8080)
DATA_DIR = os.path.abspath(os.environ.get('DATA_DIR') or os.path.join(ROOT, 'data'))
SCENES_DIR = os.path.join(DATA_DIR, 'scenes')
APP_PASSWORD = os.environ.get('APP_PASSWORD', '')
API_KEY = os.environ.get('ANTHROPIC_API_KEY', '')
API_URL = os.environ.get('ANTHROPIC_API_URL') or CONFIG.get('apiUrl') or 'https://api.anthropic.com/v1/messages'
MODEL = os.environ.get('CLAUDE_MODEL') or CONFIG.get('model') or 'claude-sonnet-5-5'
COOKIE_SECURE = os.environ.get('COOKIE_SECURE') == '1'
TRUSTED_PROXY = os.environ.get('TRUSTED_PROXY') == '1'
RATE_LIMIT_PER_MIN = _env_int('RATE_LIMIT_PER_MIN', 20)
DAILY_REQUEST_CAP = _env_int('DAILY_REQUEST_CAP', 300)
MAX_BODY_BYTES = _env_int('MAX_BODY_BYTES', 2 * 1024 * 1024)
LOGIN_MAX_FAILS = _env_int('LOGIN_MAX_FAILS', 5)
LOGIN_LOCKOUT_SEC = _env_int('LOGIN_LOCKOUT_MIN', 15) * 60
SESSION_TTL = 7 * 24 * 3600
MAX_SCENES = 500
COOKIE_NAME = 'bms_session'
SESSION_SECRET = b''  # set in main()
PW_DIGEST = hashlib.sha256(APP_PASSWORD.encode('utf-8')).digest()

CSP = ("default-src 'self'; script-src 'self' 'unsafe-inline' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
       "font-src https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; "
       "base-uri 'none'; form-action 'self'")


def load_session_secret():
    env = os.environ.get('SESSION_SECRET')
    if env:
        return env.encode('utf-8')
    path = os.path.join(DATA_DIR, 'session_secret')
    try:
        with open(path, encoding='ascii') as f:
            s = f.read().strip()
        if re.fullmatch(r'[0-9a-f]{64}', s):
            return s.encode('ascii')
    except FileNotFoundError:
        pass
    s = secrets.token_hex(32)
    tmp = path + '.tmp'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='ascii') as f:
        f.write(s)
    os.replace(tmp, path)
    return s.encode('ascii')


def atomic_write(path, text):
    d = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=d, prefix='.tmp-', suffix='.json')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'


def utc_date():
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d')


def secs_to_utc_midnight():
    now = datetime.datetime.now(datetime.timezone.utc)
    tomorrow = (now + datetime.timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return max(1, int((tomorrow - now).total_seconds()))


# ------------------------------------------------------- sessions/auth

def sign(payload):
    return hmac.new(SESSION_SECRET, payload.encode('ascii'), hashlib.sha256).hexdigest()


def make_cookie():
    sid = secrets.token_hex(16)
    exp = int(time.time()) + SESSION_TTL
    payload = f'v1.{sid}.{exp}'
    return f'{payload}.{sign(payload)}'


_COOKIE_RE = re.compile(r'v1\.([0-9a-f]{32})\.([0-9]{1,12})\.([0-9a-f]{64})')


def session_from_header(cookie_header):
    """Returns the session id for a valid, unexpired cookie, else None."""
    for part in (cookie_header or '').split(';'):
        name, _, value = part.strip().partition('=')
        if name != COOKIE_NAME:
            continue
        m = _COOKIE_RE.fullmatch(value.strip())
        if not m:
            continue
        sid, exp, sig = m.groups()
        if hmac.compare_digest(sign(f'v1.{sid}.{exp}'), sig) and int(exp) > time.time():
            return sid
    return None


def cookie_header(value, max_age):
    attrs = f'{COOKIE_NAME}={value}; HttpOnly; SameSite=Strict; Path=/; Max-Age={max_age}'
    return attrs + ('; Secure' if COOKIE_SECURE else '')


class LoginGuard:
    """Per-IP failure counter with lockout (CONTRACT 12.2)."""

    def __init__(self):
        self.lock = threading.Lock()
        self.fails = {}   # ip -> deque of failure times
        self.locked = {}  # ip -> unlock time

    def locked_for(self, ip):
        with self.lock:
            until = self.locked.get(ip, 0)
            left = until - time.time()
            if left <= 0:
                self.locked.pop(ip, None)
                return 0
            return int(math.ceil(left))

    def fail(self, ip):
        """Records a failure. Returns attempts left (0 = now locked)."""
        now = time.time()
        with self.lock:
            if len(self.fails) > 10000:  # bound memory under a spray of IPs
                for k in [k for k, q in self.fails.items() if not q or q[-1] < now - LOGIN_LOCKOUT_SEC]:
                    del self.fails[k]
            q = self.fails.setdefault(ip, deque())
            q.append(now)
            while q and q[0] < now - LOGIN_LOCKOUT_SEC:
                q.popleft()
            if len(q) >= LOGIN_MAX_FAILS:
                self.locked[ip] = now + LOGIN_LOCKOUT_SEC
                del self.fails[ip]
                return 0
            return LOGIN_MAX_FAILS - len(q)

    def success(self, ip):
        with self.lock:
            self.fails.pop(ip, None)


class RateLimiter:
    def __init__(self):
        self.lock = threading.Lock()
        self.hits = {}

    def check(self, sid):
        """Returns 0 when allowed (and records the hit), else seconds to wait."""
        now = time.time()
        with self.lock:
            q = self.hits.setdefault(sid, deque())
            while q and q[0] <= now - 60:
                q.popleft()
            if len(q) >= RATE_LIMIT_PER_MIN:
                return max(1, int(math.ceil(q[0] + 60 - now)))
            q.append(now)
            return 0


class Usage:
    """Daily request cap and token/cost totals, persisted in DATA_DIR/usage-daily.json."""

    def __init__(self):
        self.lock = threading.Lock()
        self.path = os.path.join(DATA_DIR, 'usage-daily.json')
        self.log_path = os.path.join(DATA_DIR, 'usage.log')
        self.day = self._load()

    def _blank(self):
        return {'date': utc_date(), 'requests': 0, 'inputTokens': 0, 'outputTokens': 0, 'costUsd': 0.0}

    def _load(self):
        try:
            d = parse_json(open(self.path, encoding='utf-8').read())
            if isinstance(d, dict) and isinstance(d.get('date'), str) and isinstance(d.get('requests'), int):
                return {**self._blank(), **d}
        except (OSError, ValueError):
            pass
        return self._blank()

    def _roll(self):
        if self.day['date'] != utc_date():
            self.day = self._blank()

    def _save(self):
        atomic_write(self.path, dump_json(self.day))

    def take(self):
        """Counts one request against the daily cap. False when the cap is reached."""
        with self.lock:
            self._roll()
            if self.day['requests'] >= DAILY_REQUEST_CAP:
                return False
            self.day['requests'] += 1
            self._save()
            return True

    def record(self, entry):
        with self.lock:
            self._roll()
            self.day['inputTokens'] += entry['inputTokens'] + entry['cacheReadTokens'] + entry['cacheWriteTokens']
            self.day['outputTokens'] += entry['outputTokens']
            self.day['costUsd'] = round(self.day['costUsd'] + entry['costUsd'], 6)
            self._save()
            with open(self.log_path, 'a', encoding='utf-8') as f:
                f.write(dump_json(entry) + '\n')

    def snapshot(self):
        with self.lock:
            self._roll()
            d = dict(self.day)
        d.update(cap=DAILY_REQUEST_CAP, remaining=max(0, DAILY_REQUEST_CAP - d['requests']), model=MODEL)
        return {k: d[k] for k in ('date', 'requests', 'cap', 'remaining', 'inputTokens', 'outputTokens', 'costUsd', 'model')}


# ---------------------------------------------------------------- LLM

def _param_desc(name, s):
    if '$ref' in s:
        ref = s['$ref']
        if ref.endswith('/points'):
            return f'{name}: [[x,y],...] 2-500 points (required)'
        if ref.endswith('/color'):
            return f'{name}: "#rrggbb"' + (f' (default {s["default"]})' if 'default' in s else '')
        s = {**_resolve_ref(ref), **{k: v for k, v in s.items() if k != '$ref'}}
    if 'enum' in s:
        desc = '|'.join(str(e) for e in s['enum'])
    elif s.get('type') == 'array' and isinstance(s.get('items'), dict) and 'properties' in s['items']:
        inner = ', '.join(_param_desc(k, v) for k, v in s['items']['properties'].items())
        desc = f'array of {{{inner}}}'
        if 'minItems' in s:
            desc += f' min {s["minItems"]}'
    elif s.get('type') == 'array':
        desc = f'[[x,y],...] {s.get("minItems", 0)}-{s.get("maxItems", "")} points'
    else:
        desc = s.get('type', 'any')
        if 'minimum' in s or 'maximum' in s:
            desc += f' {s.get("minimum", "")}-{s.get("maximum", "")}'
        if 'maxLength' in s:
            desc += f' max {s["maxLength"]} chars'
    if 'default' in s:
        desc += f' (default {json.dumps(s["default"])})'
    return f'{name}: {desc}'


def render_element_types():
    lines = []
    for t, d in TYPES.items():
        head = f'- {t} ({d["kind"]}, {d["cat"]}) layers {"|".join(d["layers"])}'
        if 'sizeFt' in d:
            sz = d['sizeFt']
            head += '; size ' + ' / '.join(f'{a}x{b}' for a, b in (sz['min'], sz['typical'], sz['max']))
        if 'widthFt' in d:
            w = d['widthFt']
            head += f'; width {w["min"]} / {w["typical"]} / {w["max"]}'
        if d['kind'] == 'object':
            head += f'; footprint {d["footprint"]} {round(d["footprintScale"] * 100)}%'
        if d.get('blockedBy'):
            head += f'; blockedBy {",".join(d["blockedBy"])}'
        if d.get('minGapFt'):
            head += f'; minGap {d["minGapFt"]}'
        req = set(d['params'].get('required', []))
        params = '; '.join(_param_desc(k, v) + (' (required)' if k in req and '$ref' not in v else '')
                           for k, v in d['params'].get('properties', {}).items())
        lines.append(f'{head}\n  {d["description"]}\n  params: {params}')
    return '\n'.join(lines)


def load_prompt(name):
    with open(os.path.join(ROOT, 'prompts', name), encoding='utf-8') as f:
        return f.read()


def render_prompt(name):
    rules = load_prompt('rules.md')
    return load_prompt(name).replace('{{ELEMENT_TYPES}}', render_element_types()).replace('{{RULES}}', rules)


class LLMError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def call_model(route, system, messages):
    """Streams one Messages API call. Returns {text, stop_reason, model, usage}."""
    body = {
        'model': MODEL,
        'max_tokens': CONFIG['maxTokens'][route],
        'stream': True,
        'system': [{'type': 'text', 'text': system, 'cache_control': {'type': 'ephemeral'}}],
        'messages': messages,
        'output_config': {'effort': CONFIG['effort'][route]},
    }
    headers = {'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'}
    # Haiku has no server-side fallback; sending the parameter would be rejected.
    if CONFIG.get('fallbacks') and 'haiku' not in MODEL:
        body['fallbacks'] = CONFIG['fallbacks']
        if CONFIG.get('betas'):
            headers['anthropic-beta'] = ','.join(CONFIG['betas'])
    req = urllib.request.Request(API_URL, data=json.dumps(body).encode('utf-8'), headers=headers, method='POST')
    timeout = CONFIG.get('timeoutSec', 300)
    deadline = time.time() + timeout
    out = {'text': '', 'stop_reason': None, 'model': MODEL, 'usage': {}}
    blocks = {}
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            for raw in resp:
                if time.time() > deadline:
                    raise LLMError('llm_error', f'Model call timed out after {timeout} s')
                line = raw.decode('utf-8', 'replace').rstrip('\r\n')
                if not line.startswith('data:'):
                    continue
                try:
                    ev = json.loads(line[5:].strip())
                except ValueError:
                    continue
                if not isinstance(ev, dict):
                    continue
                typ = ev.get('type')
                if typ == 'message_start':
                    msg = ev.get('message') or {}
                    out['model'] = msg.get('model') or out['model']
                    out['usage'].update(msg.get('usage') or {})
                elif typ == 'content_block_start':
                    cb = ev.get('content_block') or {}
                    blocks[ev.get('index')] = cb.get('type')
                    if cb.get('type') == 'text' and isinstance(cb.get('text'), str):
                        out['text'] += cb['text']
                elif typ == 'content_block_delta':
                    delta = ev.get('delta') or {}
                    if delta.get('type') == 'text_delta' and blocks.get(ev.get('index')) == 'text':
                        out['text'] += delta.get('text', '')
                elif typ == 'message_delta':
                    out['stop_reason'] = (ev.get('delta') or {}).get('stop_reason') or out['stop_reason']
                    out['usage'].update(ev.get('usage') or {})
                elif typ == 'error':
                    e = ev.get('error') or {}
                    raise LLMError('llm_error', f'Model error: {e.get("type", "error")}: {str(e.get("message", ""))[:300]}')
                if len(out['text']) > 4_000_000:
                    raise LLMError('llm_error', 'Model output too large')
    except urllib.error.HTTPError as e:
        detail = ''
        try:
            err = json.loads(e.read(65536).decode('utf-8', 'replace')).get('error') or {}
            detail = f': {err.get("type", "")}: {str(err.get("message", ""))[:300]}'
        except Exception:
            pass
        raise LLMError('llm_error', f'Model API returned HTTP {e.code}{detail}') from None
    except (urllib.error.URLError, OSError) as e:
        reason = getattr(e, 'reason', e)
        raise LLMError('llm_error', f'Model API unreachable: {type(reason).__name__}') from None
    return out


def cost_of(model, usage):
    p = CONFIG.get('pricing', {}).get(model) or CONFIG.get('pricing', {}).get(MODEL) or {}
    # shortcut: with a server-side fallback only the serving attempt's usage is priced (usage.iterations ignored).
    return round((usage['inputTokens'] * p.get('inputPerMTok', 0) + usage['outputTokens'] * p.get('outputPerMTok', 0)
                  + usage['cacheReadTokens'] * p.get('cacheReadPerMTok', 0)
                  + usage['cacheWriteTokens'] * p.get('cacheWritePerMTok', 0)) / 1e6, 6)


def extract_json(text):
    """Strip ``` fences and take the outermost {...}."""
    t = re.sub(r'```[a-zA-Z]*', '', text)
    a, b = t.find('{'), t.rfind('}')
    if a < 0 or b < a:
        raise BadJson('no JSON object in the output')
    return parse_json(t[a:b + 1])


def _int_ok(v, lo, hi):
    return isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi


# --------------------------------------------------------------- pages

LOGIN_PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Battle Map Studio - Sign in</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500&display=swap">
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#202020;color:#fff;font-family:Roboto,system-ui,sans-serif}
form{width:min(360px,calc(100vw - 32px));background:#272626;border:1px solid #fff;border-radius:15px;padding:28px;display:grid;gap:14px}
h1{margin:0;font-size:20px;font-weight:500}
label{font-size:14px;display:grid;gap:6px}
input{font:inherit;color:#fff;background:#202020;border:1px solid #fff;border-radius:15px;padding:10px 14px}
input:focus{outline:2px solid #8ab4ff;outline-offset:1px}
button{font:inherit;font-weight:500;color:#202020;background:#fff;border:1px solid #fff;border-radius:15px;padding:10px 14px;cursor:pointer}
button:disabled{opacity:.6;cursor:default}
#msg{min-height:1.2em;margin:0;font-size:14px;color:#ff9b9b}
</style></head>
<body><form id="f"><h1>Battle Map Studio</h1>
<label>Password<input id="pw" type="password" autocomplete="current-password" required autofocus></label>
<button id="b" type="submit">Sign in</button><p id="msg" role="alert"></p></form>
<script>
const f=document.getElementById('f'),msg=document.getElementById('msg'),b=document.getElementById('b');
f.addEventListener('submit',async e=>{e.preventDefault();b.disabled=true;msg.textContent='';
try{const r=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',
body:JSON.stringify({password:document.getElementById('pw').value})});
if(r.ok){location.assign('/');return}
const j=await r.json().catch(()=>({}));const er=j.error||{};
msg.textContent=(er.message||'Sign in failed')+(er.attemptsLeft!==undefined?' ('+er.attemptsLeft+' attempts left)':'');
}catch(_){msg.textContent='Network error'}b.disabled=false});
</script></body></html>"""

NO_BUILD_PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Battle Map Studio</title></head>
<body style="background:#202020;color:#fff;font-family:Roboto,sans-serif;padding:32px">
<p>dist/index.html is missing: run python build.py</p></body></html>"""


# ------------------------------------------------------------- handler

class ApiError(Exception):
    def __init__(self, status, code, message, **extra):
        super().__init__(message)
        self.status, self.code, self.message, self.extra = status, code, message, extra


LOGIN_GUARD = LoginGuard()
RATE = RateLimiter()
USAGE = None  # set in main()
SCENE_LOCK = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    server_version = 'BattleMapStudio'
    sys_version = ''
    protocol_version = 'HTTP/1.1'
    timeout = 60  # client socket timeout (slow clients)

    # ----- plumbing
    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Frame-Options', 'DENY')
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % args))

    def send_json(self, status, obj, headers=()):
        data = dump_json(obj).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def send_page(self, status, html, headers=()):
        data = html.encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Security-Policy', CSP)
        self.send_header('Content-Length', str(len(data)))
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def redirect(self, location, headers=()):
        self.send_response(302)
        self.send_header('Location', location)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', '0')
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()

    def send_error_json(self, e):
        body = {'code': e.code, 'message': e.message, **e.extra}
        headers = []
        if 'retryAfterSec' in e.extra:
            headers.append(('Retry-After', str(e.extra['retryAfterSec'])))
        if e.status == 413:
            headers.append(('Connection', 'close'))
            self.close_connection = True
        self.send_json(e.status, {'error': body}, headers)

    def client_ip(self):
        if TRUSTED_PROXY:
            xff = [p.strip() for p in (self.headers.get('X-Forwarded-For') or '').split(',') if p.strip()]
            if xff:
                return xff[-1]
        return self.client_address[0]

    def do_GET(self):
        self.handle_request('GET')

    def do_POST(self):
        self.handle_request('POST')

    def do_PUT(self):
        self.handle_request('PUT')

    def do_DELETE(self):
        self.handle_request('DELETE')

    # ----- request pipeline
    def handle_request(self, method):
        path = urlsplit(self.path).path
        self._body_read = False
        try:
            public = (method, path) in (('GET', '/login'), ('POST', '/login'), ('GET', '/healthz'))
            self.sid = session_from_header(self.headers.get('Cookie'))
            if not public and not self.sid:
                if path.startswith('/api/'):
                    raise ApiError(401, 'unauthorized', 'Sign in required')
                self.close_connection = method != 'GET'  # an unread body must not be parsed as the next request
                return self.redirect('/login')
            body = self.read_body() if method in ('POST', 'PUT', 'DELETE') else None
            self.route(method, path, body)
        except ApiError as e:
            if method in ('POST', 'PUT', 'DELETE') and not getattr(self, '_body_read', False):
                self.close_connection = True
            self.send_error_json(e)
        except Exception:
            import traceback
            traceback.print_exc()
            self.close_connection = True
            self.send_error_json(ApiError(500, 'internal', 'Internal server error'))

    def read_body(self):
        ctype = (self.headers.get('Content-Type') or '').split(';')[0].strip().lower()
        if ctype != 'application/json':
            raise ApiError(415, 'unsupported_media_type', 'Content-Type must be application/json')
        origin = self.headers.get('Origin')
        if origin is not None:
            host = (self.headers.get('Host') or '').lower()
            if not host or urlsplit(origin).netloc.lower() != host:
                raise ApiError(403, 'bad_origin', 'Cross-origin request refused')
        if self.headers.get('Transfer-Encoding'):
            raise ApiError(400, 'bad_request', 'Chunked bodies are not supported')
        raw_len = self.headers.get('Content-Length') or '0'
        if not raw_len.isdigit():
            raise ApiError(400, 'bad_request', 'Invalid Content-Length')
        n = int(raw_len)
        if n > MAX_BODY_BYTES:
            raise ApiError(413, 'payload_too_large', f'Request body exceeds {MAX_BODY_BYTES} bytes')
        data = self.rfile.read(n) if n else b''
        self._body_read = True
        if len(data) != n:
            raise ApiError(400, 'bad_request', 'Incomplete body')
        if not data.strip():
            return None
        try:
            return parse_json(data.decode('utf-8'))
        except (UnicodeDecodeError, BadJson) as e:
            raise ApiError(400, 'bad_json', f'Invalid JSON: {str(e)[:200]}') from None

    def route(self, method, path, body):
        if path in ('/', '/index.html') and method == 'GET':
            try:
                with open(os.path.join(ROOT, 'dist', 'index.html'), encoding='utf-8') as f:
                    return self.send_page(200, f.read())
            except FileNotFoundError:
                return self.send_page(503, NO_BUILD_PAGE)
        if path == '/login':
            return self.login_page() if method == 'GET' else self.login(body)
        if path == '/healthz' and method == 'GET':
            return self.send_json(200, {'ok': True})
        if path == '/logout' and method == 'POST':
            return self.send_json(200, {'ok': True}, [('Set-Cookie', cookie_header('', 0))])
        if path == '/api/session' and method == 'GET':
            return self.send_json(200, {'authenticated': True, 'model': MODEL,
                                        'limits': {'ratePerMin': RATE_LIMIT_PER_MIN, 'dailyCap': DAILY_REQUEST_CAP}})
        if path == '/api/usage' and method == 'GET':
            return self.send_json(200, USAGE.snapshot())
        if path == '/api/scenes' and method == 'GET':
            return self.list_scenes()
        if path.startswith('/api/scenes/') and method in ('GET', 'PUT', 'DELETE'):
            return self.scene_route(method, path[len('/api/scenes/'):], body)
        if path == '/api/generate' and method == 'POST':
            return self.generate(body)
        if path == '/api/edit' and method == 'POST':
            return self.edit(body)
        raise ApiError(404, 'not_found', 'Not found')

    # ----- auth routes
    def login_page(self):
        if self.sid:
            return self.redirect('/')
        self.send_page(200, LOGIN_PAGE)

    def login(self, body):
        ip = self.client_ip()
        wait = LOGIN_GUARD.locked_for(ip)
        if wait:
            raise ApiError(429, 'locked_out', 'Too many failed attempts. Try again later.', retryAfterSec=wait)
        if not isinstance(body, dict) or not isinstance(body.get('password'), str):
            raise ApiError(400, 'bad_request', 'Body must be {"password": "..."}')
        given = hashlib.sha256(body['password'].encode('utf-8', 'replace')).digest()
        if not hmac.compare_digest(given, PW_DIGEST):
            left = LOGIN_GUARD.fail(ip)
            if left == 0:
                raise ApiError(429, 'locked_out', 'Too many failed attempts. Try again later.', retryAfterSec=LOGIN_LOCKOUT_SEC)
            raise ApiError(401, 'invalid_password', 'Wrong password', attemptsLeft=left)
        LOGIN_GUARD.success(ip)
        self.send_json(200, {'ok': True}, [('Set-Cookie', cookie_header(make_cookie(), SESSION_TTL))])

    # ----- scenes
    def scene_path(self, scene_id):
        if not SCENE_ID_RE.fullmatch(scene_id):
            raise ApiError(400, 'bad_scene_id', 'Scene id must match ^[a-z0-9-]{1,64}$')
        base = os.path.realpath(SCENES_DIR)
        p = os.path.realpath(os.path.join(base, scene_id + '.json'))
        if os.path.dirname(p) != base:
            raise ApiError(400, 'bad_scene_id', 'Invalid scene id')
        return p

    def list_scenes(self):
        out = []
        for name in os.listdir(SCENES_DIR):
            if not name.endswith('.json') or not SCENE_ID_RE.fullmatch(name[:-5]):
                continue
            try:
                with open(os.path.join(SCENES_DIR, name), encoding='utf-8') as f:
                    s = parse_json(f.read())
                meta, grid = s.get('meta') or {}, s.get('grid') or {}
                out.append({'id': name[:-5], 'name': meta.get('name', name[:-5]), 'updatedAt': meta.get('updatedAt', ''),
                            'widthFt': grid.get('widthFt'), 'heightFt': grid.get('heightFt')})
            except (OSError, ValueError, AttributeError):
                continue
        out.sort(key=lambda s: s['id'])
        out.sort(key=lambda s: str(s['updatedAt']), reverse=True)
        self.send_json(200, {'scenes': out})

    def scene_route(self, method, scene_id, body):
        p = self.scene_path(scene_id)
        if method == 'GET':
            try:
                with open(p, encoding='utf-8') as f:
                    scene = parse_json(f.read())
            except FileNotFoundError:
                raise ApiError(404, 'not_found', 'Scene not found') from None
            return self.send_json(200, {'id': scene_id, 'scene': scene})
        if method == 'DELETE':
            with SCENE_LOCK:
                try:
                    os.remove(p)
                except FileNotFoundError:
                    raise ApiError(404, 'not_found', 'Scene not found') from None
            return self.send_json(200, {'ok': True})
        if not isinstance(body, dict) or 'scene' not in body:
            raise ApiError(400, 'bad_request', 'Body must be {"scene": {...}}')
        res = check_scene(body['scene'])
        if not res['ok']:
            raise ApiError(400, 'invalid_scene', 'Scene is not valid', details=res['errors'][:100])
        scene = res['scene']
        now = now_iso()
        with SCENE_LOCK:
            created = None
            if os.path.exists(p):
                try:
                    with open(p, encoding='utf-8') as f:
                        created = (parse_json(f.read()).get('meta') or {}).get('createdAt')
                except (OSError, ValueError, AttributeError):
                    pass
            elif sum(1 for n in os.listdir(SCENES_DIR) if n.endswith('.json')) >= MAX_SCENES:
                raise ApiError(409, 'too_many_scenes', f'At most {MAX_SCENES} scenes can be stored')
            meta = scene['meta']
            meta['id'] = scene_id
            meta['updatedAt'] = now
            meta['createdAt'] = created if isinstance(created, str) and len(created) <= 40 else meta.get('createdAt') or now
            atomic_write(p, dump_json(scene))
        self.send_json(200, {'id': scene_id, 'updatedAt': now})

    # ----- LLM routes
    def llm_gate(self):
        """Rate limit + daily cap, in that order (CONTRACT 12.5)."""
        wait = RATE.check(self.sid)
        if wait:
            raise ApiError(429, 'rate_limited', f'Too many requests (limit {RATE_LIMIT_PER_MIN} per minute)', retryAfterSec=wait)
        if not USAGE.take():
            raise ApiError(429, 'daily_cap', f'Daily limit reached ({DAILY_REQUEST_CAP} requests). Resets at 00:00 UTC.',
                           retryAfterSec=secs_to_utc_midnight())

    def run_llm(self, route, endpoint, system, first_user, check):
        """Calls the model, validates with check(obj) -> (result, errors), retries once with feedback."""
        messages = [{'role': 'user', 'content': first_user}]
        errors = []
        for attempt in (1, 2):
            try:
                r = call_model(route, system, messages)
            except LLMError as e:
                self.log_call(endpoint, attempt, {}, MODEL, False, e.code)
                raise ApiError(502, e.code, str(e)) from None
            if r['stop_reason'] == 'refusal':
                self.log_call(endpoint, attempt, r['usage'], r['model'], False, 'refusal')
                raise ApiError(502, 'llm_refusal', 'The model declined this request. Try rephrasing it.')
            if r['stop_reason'] == 'max_tokens':
                errors = [{'path': '/', 'message': 'output was cut off at the token limit'}]
                feedback = ('Your previous answer was cut off at the output token limit, so it was not valid JSON. '
                            'Produce a more compact result: fewer elements and fewer polygon points, no extra whitespace.')
                # The truncated output is not shown back: it is huge and useless as context.
                messages = [{'role': 'user', 'content': first_user + '\n\n' + feedback}]
                self.log_call(endpoint, attempt, r['usage'], r['model'], False, 'max_tokens')
                continue
            try:
                result, errors = check(extract_json(r['text']))
            except BadJson as e:
                result, errors = None, [{'path': '/', 'message': f'output is not a JSON object: {e}'}]
            self.log_call(endpoint, attempt, r['usage'], r['model'], not errors, None if not errors else 'invalid_output')
            if not errors:
                return result, attempt
            listed = '\n'.join(f'- {e["path"]}: {e["message"]}' for e in errors[:40])
            messages = [messages[0], {'role': 'assistant', 'content': r['text'] or '(empty)'},
                        {'role': 'user', 'content': f'Your output has these problems:\n{listed}\n\n'
                                                    'Fix them and return the complete corrected JSON only.'}]
        raise ApiError(502, 'llm_invalid', 'The model returned invalid output twice.', details=errors[:50])

    def log_call(self, endpoint, attempt, usage, model, ok, error):
        u = {'inputTokens': int(usage.get('input_tokens') or 0), 'outputTokens': int(usage.get('output_tokens') or 0),
             'cacheReadTokens': int(usage.get('cache_read_input_tokens') or 0),
             'cacheWriteTokens': int(usage.get('cache_creation_input_tokens') or 0)}
        entry = {'ts': now_iso(), 'endpoint': endpoint, 'model': model, 'attempt': attempt, **u,
                 'costUsd': cost_of(model, u), 'ok': ok,
                 'session': hashlib.sha256(self.sid.encode('ascii')).hexdigest()[:12]}
        if error:
            entry['error'] = error
        USAGE.record(entry)

    def require_llm(self):
        if not API_KEY:
            raise ApiError(503, 'llm_not_configured', 'ANTHROPIC_API_KEY is not set on the server')

    def generate(self, body):
        self.require_llm()
        if not isinstance(body, dict):
            raise ApiError(400, 'bad_request', 'Body must be a JSON object')
        desc, w, h, seed = body.get('description'), body.get('widthFt'), body.get('heightFt'), body.get('seed')
        problems = []
        if not isinstance(desc, str) or not 1 <= len(desc.strip()) or len(desc) > 4000:
            problems.append('description must be 1-4000 characters')
        for name, v in (('widthFt', w), ('heightFt', h)):
            if v is not None and not (_int_ok(v, 20, 600) and v % 5 == 0):
                problems.append(f'{name} must be an integer multiple of 5 between 20 and 600')
        if seed is not None and not _int_ok(seed, 0, 4294967295):
            problems.append('seed must be an integer 0-4294967295')
        if problems:
            raise ApiError(400, 'bad_request', '; '.join(problems))
        self.llm_gate()
        size = (f'Map size: exactly {w or "(you choose)"} ft wide (x) by {h or "(you choose)"} ft tall (y).'
                if w or h else 'Map size: choose a suitable size.')
        user = f'<description>\n{desc}\n</description>\n\n{size}\nReturn the scene JSON.'

        def check(obj):
            if not isinstance(obj, dict):
                return None, [{'path': '/', 'message': 'output must be a scene object'}]
            if seed is not None:
                obj['seed'] = seed
            res = check_scene(obj)
            errs = list(res['errors'])
            if res['ok']:
                g = res['scene']['grid']
                if w and g['widthFt'] != w:
                    errs.append({'path': '/grid/widthFt', 'message': f'must be {w} as requested'})
                if h and g['heightFt'] != h:
                    errs.append({'path': '/grid/heightFt', 'message': f'must be {h} as requested'})
            return res['scene'], errs

        scene, attempts = self.run_llm('generate', 'generate', PROMPTS['generate'], user, check)
        self.send_json(200, {'scene': scene, 'usage': USAGE.snapshot(), 'attempts': attempts})

    def edit(self, body):
        self.require_llm()
        if not isinstance(body, dict):
            raise ApiError(400, 'bad_request', 'Body must be a JSON object')
        instr, sel_ids = body.get('instruction'), body.get('selectedIds', [])
        neighbours, summary = body.get('neighbours', []), body.get('summary')
        problems = []
        if not isinstance(instr, str) or not instr.strip() or len(instr) > 2000:
            problems.append('instruction must be 1-2000 characters')
        if not isinstance(sel_ids, list) or len(sel_ids) > 50 or not all(isinstance(i, str) for i in sel_ids):
            problems.append('selectedIds must be a list of at most 50 ids')
        if not isinstance(neighbours, list) or len(neighbours) > 200 or not all(isinstance(n, dict) for n in neighbours):
            problems.append('neighbours must be a list of at most 200 elements')
        if problems:
            raise ApiError(400, 'bad_request', '; '.join(problems))
        res = check_scene(body.get('scene'))
        if not res['ok']:
            raise ApiError(400, 'invalid_scene', 'Scene is not valid', details=res['errors'][:100])
        scene = res['scene']
        self.llm_gate()
        existing = {el['id'] for el, _, _ in iter_elements(scene)}
        neighbour_ids = [n['id'] for n in neighbours if isinstance(n.get('id'), str)]
        if sel_ids:
            # Element bodies come from the validated scene, not from the client copies.
            selected = [e for e in (find_element(scene, i) for i in sel_ids) if e]
            near = [e for e in (find_element(scene, i) for i in neighbour_ids) if e]
            scope = set(sel_ids) | set(neighbour_ids)
            payload = {'instruction': instr, 'selectedIds': sel_ids, 'selected': selected, 'neighbours': near,
                       'constraints': [c for c in scene['constraints'] if c['a'] in scope or c['b'] in scope],
                       'summary': summary if isinstance(summary, dict) else {}}
        else:
            payload = {'instruction': instr, 'selectedIds': [], 'scene': scene}
        user = json.dumps(payload, separators=(',', ':'))
        allowed = set(sel_ids) | set(neighbour_ids)

        def check(obj):
            if not isinstance(obj, dict) or not isinstance(obj.get('ops'), list):
                return None, [{'path': '/', 'message': 'output must be {"ops": [...], "summary": "..."}'}]
            ops = obj['ops']
            try:
                nxt = apply_patch(scene, ops)
            except PatchError as e:
                return None, [{'path': f'/ops/{e.op_index}', 'message': str(e)}]
            r = check_scene(nxt)
            errs = list(r['errors'])
            if sel_ids:
                outside = [i for i in touched_ids(scene, ops) if i in existing and i not in allowed]
                if outside:
                    errs.append({'path': '/ops', 'message': 'changes elements outside the selection and its neighbours: '
                                 + ', '.join(outside[:20])})
            summ = obj.get('summary') if isinstance(obj.get('summary'), str) else ''
            return {'ops': ops, 'summary': summ[:500]}, errs

        result, attempts = self.run_llm('edit', 'edit', PROMPTS['edit'], user, check)
        self.send_json(200, {**result, 'usage': USAGE.snapshot(), 'attempts': attempts})


PROMPTS = {}


def main():
    global SESSION_SECRET, USAGE
    if len(APP_PASSWORD) < 12:
        sys.stderr.write('ERROR: APP_PASSWORD must be set and at least 12 characters long. Refusing to start.\n')
        sys.exit(2)
    os.makedirs(SCENES_DIR, exist_ok=True)
    SESSION_SECRET = load_session_secret()
    USAGE = Usage()
    PROMPTS['generate'] = render_prompt('generate.md')
    PROMPTS['edit'] = render_prompt('edit.md')
    if not API_KEY:
        sys.stderr.write('WARNING: ANTHROPIC_API_KEY is not set; /api/generate and /api/edit will return 503.\n')
    httpd = ThreadingHTTPServer(('0.0.0.0', PORT), Handler)
    httpd.daemon_threads = True
    sys.stderr.write(f'Battle Map Studio listening on 0.0.0.0:{PORT} (model {MODEL})\n')
    sys.stderr.flush()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
