"""End-to-end tests for server.py: real server in a subprocess, fake Anthropic upstream in-process.

Run: py -m unittest discover tests   (python3 on Linux)
"""
import hashlib
import hmac
import http.client
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PASSWORD = 'correct horse battery staple'
API_KEY = 'sk-ant-test-SECRET-KEY-0123456789'


def read(path):
    with open(path, encoding='utf-8', errors='replace') as f:
        return f.read()


SAMPLE = read(os.path.join(ROOT, 'samples', 'riverside-ruin.json'))


# ------------------------------------------------------------ fake upstream

class FakeUpstream:
    """Speaks the Messages API SSE format. Queue scripted replies; default is a valid sample scene."""

    def __init__(self):
        self.requests = []
        self.queue = []
        self.default = {'text': SAMPLE}
        up = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                up.requests.append({'headers': {k.lower(): v for k, v in self.headers.items()}, 'body': body})
                script = up.queue.pop(0) if up.queue else up.default
                if 'raw' in script:  # verbatim bytes (malformed responses), then hang up
                    self.close_connection = True
                    self.wfile.write(script['raw'])
                    return
                if 'status' in script:
                    data = json.dumps({'type': 'error', 'error': {'type': script.get('etype', 'overloaded_error'),
                                                                  'message': script.get('message', 'busy')}}).encode()
                    self.send_response(script['status'])
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Content-Length', str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()

                def ev(name, obj):
                    self.wfile.write(f'event: {name}\ndata: {json.dumps(obj)}\n\n'.encode())

                ev('message_start', {'type': 'message_start', 'message': {
                    'id': 'msg_1', 'type': 'message', 'role': 'assistant', 'model': script.get('model', body['model']),
                    'content': [], 'stop_reason': None,
                    'usage': {'input_tokens': 1000, 'cache_creation_input_tokens': 2000, 'cache_read_input_tokens': 3000,
                              'output_tokens': 1}}})
                ev('ping', {'type': 'ping'})
                ev('content_block_start', {'type': 'content_block_start', 'index': 0,
                                           'content_block': {'type': 'thinking', 'thinking': ''}})
                ev('content_block_delta', {'type': 'content_block_delta', 'index': 0,
                                           'delta': {'type': 'thinking_delta', 'thinking': '{"not": "output"}'}})
                ev('content_block_stop', {'type': 'content_block_stop', 'index': 0})
                ev('content_block_start', {'type': 'content_block_start', 'index': 1,
                                           'content_block': {'type': 'text', 'text': ''}})
                text = script.get('text', '')
                for i in range(0, len(text), 500):
                    ev('content_block_delta', {'type': 'content_block_delta', 'index': 1,
                                               'delta': {'type': 'text_delta', 'text': text[i:i + 500]}})
                ev('content_block_stop', {'type': 'content_block_stop', 'index': 1})
                ev('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': script.get('stop', 'end_turn')},
                                     'usage': {'output_tokens': 500}})
                ev('message_stop', {'type': 'message_stop'})

        self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), H)
        self.url = f'http://127.0.0.1:{self.httpd.server_address[1]}/v1/messages'
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


# ------------------------------------------------------------ server process

def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class Server:
    def __init__(self, data_dir, upstream_url, **env):
        self.data_dir = data_dir
        self.port = free_port()
        self.env = {**os.environ, 'PORT': str(self.port), 'DATA_DIR': data_dir, 'APP_PASSWORD': PASSWORD,
                    'ANTHROPIC_API_KEY': API_KEY, 'ANTHROPIC_API_URL': upstream_url, 'MAX_BODY_BYTES': '200000',
                    'PYTHONUNBUFFERED': '1'}
        for k in ('SESSION_SECRET', 'CLAUDE_MODEL', 'TRUSTED_PROXY', 'COOKIE_SECURE'):
            self.env.pop(k, None)
        self.env.update({k: str(v) for k, v in env.items() if v is not None})
        for k, v in env.items():
            if v is None:
                self.env.pop(k, None)
        self.log_path = os.path.join(data_dir, f'stderr-{self.port}.log')
        self.log = open(self.log_path, 'w', encoding='utf-8')
        self.proc = subprocess.Popen([sys.executable, os.path.join(ROOT, 'server.py')], env=self.env,
                                     stdout=self.log, stderr=subprocess.STDOUT)
        for _ in range(200):
            try:
                if self.request('GET', '/healthz')[0] == 200:
                    return
            except OSError:
                time.sleep(0.05)
        raise RuntimeError('server did not start')

    def stop(self):
        self.proc.terminate()
        self.proc.wait(10)
        self.log.close()

    def request(self, method, path, body=None, cookie=None, headers=None, raw=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=30)
        h = {}
        data = raw
        if body is not None:
            data = json.dumps(body).encode()
            h['Content-Type'] = 'application/json'
        elif method in ('POST', 'PUT', 'DELETE') and raw is None:
            h['Content-Type'] = 'application/json'
        if cookie:
            h['Cookie'] = f'bms_session={cookie}'
        h.update(headers or {})
        h = {k: v for k, v in h.items() if v is not None}
        conn.request(method, path, body=data, headers=h)
        r = conn.getresponse()
        text = r.read().decode('utf-8')
        conn.close()
        try:
            parsed = json.loads(text)
        except ValueError:
            parsed = text
        return r.status, {k.lower(): v for k, v in r.getheaders()}, parsed

    def login(self, ip_headers=None):
        st, hd, js = self.request('POST', '/login', {'password': PASSWORD}, headers=ip_headers)
        assert st == 200, (st, js)
        return hd['set-cookie'].split(';')[0].split('=', 1)[1]


class Base(unittest.TestCase):
    env = {}

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='bms-test-')
        cls.up = FakeUpstream()
        cls.srv = Server(cls.tmp, cls.up.url, **cls.env)
        cls.cookie = cls.srv.login()

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()
        cls.up.close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        self.up.queue.clear()
        self.up.requests.clear()

    def api(self, method, path, body=None, **kw):
        return self.srv.request(method, path, body, cookie=self.cookie, **kw)


# ------------------------------------------------------------------ tests

class StartupTest(unittest.TestCase):
    def test_refuses_without_strong_password(self):
        for pw in (None, 'short-pw'):
            env = {**os.environ, 'DATA_DIR': tempfile.mkdtemp(prefix='bms-test-'), 'PORT': str(free_port())}
            env.pop('APP_PASSWORD', None)
            if pw:
                env['APP_PASSWORD'] = pw
            p = subprocess.run([sys.executable, os.path.join(ROOT, 'server.py')], env=env, capture_output=True,
                               text=True, timeout=20)
            self.assertEqual(p.returncode, 2)
            self.assertIn('APP_PASSWORD', p.stderr)
            shutil.rmtree(env['DATA_DIR'], ignore_errors=True)


class AuthTest(Base):
    PROTECTED = [('GET', '/api/session'), ('GET', '/api/usage'), ('GET', '/api/scenes'), ('GET', '/api/scenes/x'),
                 ('PUT', '/api/scenes/x'), ('DELETE', '/api/scenes/x'), ('POST', '/api/generate'),
                 ('POST', '/api/edit'), ('GET', '/api/nope'), ('POST', '/api/nope'), ('GET', '/api/scenes/..')]

    def test_api_routes_401_without_session(self):
        for m, p in self.PROTECTED:
            for cookie in (None, 'garbage', 'v1.' + 'a' * 32 + '.9999999999.' + 'b' * 64):
                with self.subTest(m=m, p=p, cookie=cookie):
                    st, hd, js = self.srv.request(m, p, {} if m != 'GET' else None, cookie=cookie)
                    self.assertEqual(st, 401)
                    self.assertEqual(js['error']['code'], 'unauthorized')
                    self.assertEqual(hd['content-type'], 'application/json; charset=utf-8')

    def test_pages_redirect_without_session(self):
        for m, p in (('GET', '/'), ('GET', '/index.html'), ('GET', '/whatever'), ('POST', '/logout')):
            st, hd, _ = self.srv.request(m, p)
            self.assertEqual(st, 302, p)
            self.assertEqual(hd['location'], '/login')

    def test_expired_cookie_rejected(self):
        secret = read(os.path.join(self.tmp, 'session_secret')).strip().encode()
        payload = f'v1.{"c" * 32}.{int(time.time()) - 10}'
        cookie = payload + '.' + hmac.new(secret, payload.encode(), hashlib.sha256).hexdigest()
        self.assertEqual(self.srv.request('GET', '/api/session', cookie=cookie)[0], 401)
        payload = f'v1.{"c" * 32}.{int(time.time()) + 100}'
        cookie = payload + '.' + hmac.new(secret, payload.encode(), hashlib.sha256).hexdigest()
        self.assertEqual(self.srv.request('GET', '/api/session', cookie=cookie)[0], 200)

    def test_secret_file_is_64_hex(self):
        s = read(os.path.join(self.tmp, 'session_secret')).strip()
        self.assertRegex(s, r'^[0-9a-f]{64}$')

    def test_login_flow_and_cookie_format(self):
        st, hd, js = self.srv.request('POST', '/login', {'password': PASSWORD})
        self.assertEqual((st, js), (200, {'ok': True}))
        c = hd['set-cookie']
        self.assertRegex(c, r'^bms_session=v1\.[0-9a-f]{32}\.[0-9]+\.[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800$')
        exp = int(c.split('.')[2])
        self.assertAlmostEqual(exp, time.time() + 604800, delta=60)
        st, hd, js = self.api('GET', '/api/session')
        self.assertEqual(st, 200)
        self.assertEqual(js, {'authenticated': True, 'model': 'claude-sonnet-5-5', 'backend': 'api',
                              'limits': {'ratePerMin': 20, 'dailyCap': 300}})
        st, hd, _ = self.api('GET', '/login')
        self.assertEqual((st, hd['location']), (302, '/'))

    def test_wrong_password_and_login_page(self):
        st, _, js = self.srv.request('POST', '/login', {'password': 'nope'})
        self.assertEqual(st, 401)
        self.assertEqual(js['error']['code'], 'invalid_password')
        self.assertIsInstance(js['error']['attemptsLeft'], int)
        self.srv.request('POST', '/login', {'password': PASSWORD})  # reset counter for other tests
        st, hd, page = self.srv.request('GET', '/login')
        self.assertEqual(st, 200)
        self.assertIn("frame-ancestors 'none'", hd['content-security-policy'])
        self.assertIn('#272626', page)
        self.assertIn('15px', page)
        self.assertTrue(all(ord(ch) < 0x2000 for ch in page), 'no emoji / pictographs')

    def test_logout_clears_cookie(self):
        st, hd, js = self.api('POST', '/logout')
        self.assertEqual(st, 200)
        self.assertIn('Max-Age=0', hd['set-cookie'])

    def test_security_headers(self):
        for path, cookie in (('/healthz', None), ('/api/usage', self.cookie), ('/', self.cookie), ('/login', None)):
            st, hd, _ = self.srv.request('GET', path, cookie=cookie)
            self.assertEqual(hd['x-content-type-options'], 'nosniff')
            self.assertEqual(hd['referrer-policy'], 'no-referrer')
            self.assertEqual(hd['x-frame-options'], 'DENY')
            self.assertEqual(hd['cache-control'], 'no-store')
        st, hd, body = self.api('GET', '/')
        self.assertIn('content-security-policy', hd)
        if st == 503:
            self.assertIn('run python build.py', body)

    def test_healthz_public(self):
        self.assertEqual(self.srv.request('GET', '/healthz')[2], {'ok': True})


class RequestRulesTest(Base):
    def test_content_type_required(self):
        for ctype in (None, 'text/plain', 'application/x-www-form-urlencoded'):
            st, _, js = self.api('POST', '/api/generate', raw=b'{"description":"x"}', headers={'Content-Type': ctype})
            self.assertEqual(st, 415, ctype)
            self.assertEqual(js['error']['code'], 'unsupported_media_type')
        st, _, _ = self.srv.request('POST', '/login', raw=b'{"password":"x"}', headers={'Content-Type': 'text/plain'})
        self.assertEqual(st, 415)
        st, _, _ = self.api('DELETE', '/api/scenes/abc', raw=b'', headers={'Content-Type': 'text/plain'})
        self.assertEqual(st, 415)

    def test_origin_must_match(self):
        st, _, js = self.api('PUT', '/api/scenes/o1', {'scene': json.loads(SAMPLE)}, headers={'Origin': 'http://evil.example'})
        self.assertEqual((st, js['error']['code']), (403, 'bad_origin'))
        st, _, _ = self.api('PUT', '/api/scenes/o1', {'scene': json.loads(SAMPLE)}, headers={'Origin': 'null'})
        self.assertEqual(st, 403)
        st, _, _ = self.api('PUT', '/api/scenes/o1', {'scene': json.loads(SAMPLE)},
                            headers={'Origin': f'http://127.0.0.1:{self.srv.port}'})
        self.assertEqual(st, 200)

    def test_body_cap_without_reading(self):
        conn = http.client.HTTPConnection('127.0.0.1', self.srv.port, timeout=10)
        conn.putrequest('POST', '/api/generate')
        conn.putheader('Content-Type', 'application/json')
        conn.putheader('Cookie', f'bms_session={self.cookie}')
        conn.putheader('Content-Length', str(10 ** 9))
        conn.endheaders()  # body never sent: the server must answer from the header alone
        r = conn.getresponse()
        js = json.loads(r.read())
        conn.close()
        self.assertEqual((r.status, js['error']['code']), (413, 'payload_too_large'))

    def test_bad_json(self):
        for raw in (b'{', b'{"a": NaN}', b'{"a": 1e999}', b'\xff\xfe'):
            st, _, js = self.api('POST', '/api/generate', raw=raw, headers={'Content-Type': 'application/json'})
            self.assertEqual((st, js['error']['code']), (400, 'bad_json'), raw)

    def test_unknown_route_404_when_authed(self):
        st, _, js = self.api('GET', '/api/nothing')
        self.assertEqual((st, js['error']['code']), (404, 'not_found'))


class ScenesTest(Base):
    def test_crud(self):
        scene = json.loads(SAMPLE)
        st, _, js = self.api('PUT', '/api/scenes/my-map', {'scene': scene})
        self.assertEqual(st, 200)
        first = js['updatedAt']
        st, _, js = self.api('GET', '/api/scenes/my-map')
        self.assertEqual(js['id'], 'my-map')
        self.assertEqual(js['scene']['meta']['id'], 'my-map')
        created = js['scene']['meta']['createdAt']
        self.assertEqual(js['scene']['objects'][0]['layer'], 'objects')  # normalised
        time.sleep(0.01)
        self.api('PUT', '/api/scenes/second', {'scene': scene})
        st, _, js = self.api('PUT', '/api/scenes/my-map', {'scene': scene})
        self.assertNotEqual(js['updatedAt'], first)
        st, _, js = self.api('GET', '/api/scenes/my-map')
        self.assertEqual(js['scene']['meta']['createdAt'], created)
        st, _, js = self.api('GET', '/api/scenes')
        ids = [s['id'] for s in js['scenes']]
        self.assertEqual(ids[:2], ['my-map', 'second'])
        self.assertEqual(js['scenes'][0]['widthFt'], 120)
        self.assertEqual(self.api('DELETE', '/api/scenes/my-map')[0], 200)
        self.assertEqual(self.api('DELETE', '/api/scenes/my-map')[2]['error']['code'], 'not_found')
        self.assertEqual(self.api('GET', '/api/scenes/my-map')[0], 404)

    def test_invalid_scene(self):
        scene = json.loads(SAMPLE)
        scene['objects'][0]['type'] = 'dragon'
        st, _, js = self.api('PUT', '/api/scenes/bad', {'scene': scene})
        self.assertEqual((st, js['error']['code']), (400, 'invalid_scene'))
        self.assertTrue(js['error']['details'])
        st, _, js = self.api('PUT', '/api/scenes/bad', {'nope': 1})
        self.assertEqual(st, 400)

    def test_bad_ids(self):
        before = set(os.listdir(self.tmp))
        for sid in ('..', '%2e%2e', '%2E%2E', 'a/b', '..%2f..%2fx', 'Upper', 'a' * 65, '', 'a.b', 'a%00', '.', 'a\\b'):
            for m in ('GET', 'PUT', 'DELETE'):
                with self.subTest(sid=sid, m=m):
                    st, _, js = self.api(m, '/api/scenes/' + sid, {'scene': json.loads(SAMPLE)} if m == 'PUT' else None)
                    self.assertEqual((st, js['error']['code']), (400, 'bad_scene_id'))
        self.assertEqual(self.api('PUT', '/api/scenes/' + 'a' * 64, {'scene': json.loads(SAMPLE)})[0], 200)
        self.assertEqual(set(os.listdir(self.tmp)), before)


VALID_OPS = json.dumps({'ops': [{'op': 'replace', 'path': '/objects/campfire/params/lit', 'value': True}],
                        'summary': 'Lit the campfire.'})


class GenerateTest(Base):
    def gen(self, **body):
        return self.api('POST', '/api/generate', {'description': 'A ruined watchtower by a stream', **body})

    def test_valid_and_request_shape(self):
        st, _, js = self.gen(seed=42)
        self.assertEqual(st, 200, js)
        self.assertEqual(js['attempts'], 1)
        self.assertEqual(js['scene']['seed'], 42)
        self.assertEqual(js['scene']['objects'][0]['layer'], 'objects')
        self.assertEqual(set(js['usage']), {'date', 'requests', 'cap', 'remaining', 'inputTokens', 'outputTokens', 'costUsd', 'model', 'backend'})
        self.assertEqual(js['usage']['backend'], 'api')
        req = self.up.requests[0]
        h, b = req['headers'], req['body']
        self.assertEqual(h['x-api-key'], API_KEY)
        self.assertEqual(h['anthropic-version'], '2023-06-01')
        self.assertEqual(h['anthropic-beta'], 'server-side-fallback-2026-07-01')
        self.assertTrue(h['content-type'].startswith('application/json'))
        self.assertEqual(b['model'], 'claude-sonnet-5-5')
        self.assertEqual(b['max_tokens'], 32000)
        self.assertIs(b['stream'], True)
        self.assertEqual(b['output_config'], {'effort': 'medium'})
        self.assertEqual(b['fallbacks'], 'default')
        self.assertEqual(b['system'][0]['cache_control'], {'type': 'ephemeral'})
        self.assertNotIn('temperature', b)
        self.assertEqual(b['messages'][-1]['role'], 'user')
        self.assertEqual(len(b['messages']), 1)
        system = b['system'][0]['text']
        self.assertNotIn('{{', system)
        self.assertIn('wagon', system)
        self.assertIn('Stated distances are exact', system)
        self.assertIn('A ruined watchtower', b['messages'][0]['content'])

    def test_fenced_output(self):
        self.up.queue.append({'text': 'Here you go:\n```json\n' + SAMPLE + '\n```'})
        self.assertEqual(self.gen()[0], 200)

    def test_invalid_then_valid(self):
        bad = json.loads(SAMPLE)
        bad['objects'][0]['type'] = 'dragon'
        self.up.queue += [{'text': json.dumps(bad)}, {'text': SAMPLE}]
        st, _, js = self.gen()
        self.assertEqual((st, js['attempts']), (200, 2))
        retry = self.up.requests[1]['body']['messages']
        self.assertEqual([m['role'] for m in retry], ['user', 'assistant', 'user'])
        self.assertIn('dragon', retry[1]['content'])
        self.assertIn('/objects/0', retry[2]['content'])

    def test_invalid_twice(self):
        self.up.queue += [{'text': 'not json'}, {'text': '{"meta": {}}'}]
        st, _, js = self.gen()
        self.assertEqual((st, js['error']['code']), (502, 'llm_invalid'))
        self.assertTrue(js['error']['details'])
        self.assertEqual(len(self.up.requests), 2)

    def test_size_mismatch_retries(self):
        self.up.queue += [{'text': SAMPLE}, {'text': SAMPLE}]
        st, _, js = self.gen(widthFt=200, heightFt=120)
        self.assertEqual((st, js['error']['code']), (502, 'llm_invalid'))
        self.assertIn('/grid/widthFt', json.dumps(js['error']['details']))
        self.assertIn('200 ft wide', self.up.requests[0]['body']['messages'][0]['content'])

    def test_refusal(self):
        self.up.queue.append({'text': '', 'stop': 'refusal'})
        st, _, js = self.gen()
        self.assertEqual((st, js['error']['code']), (502, 'llm_refusal'))
        self.assertEqual(len(self.up.requests), 1)

    def test_max_tokens_then_valid(self):
        self.up.queue += [{'text': SAMPLE[:500], 'stop': 'max_tokens'}, {'text': SAMPLE}]
        st, _, js = self.gen()
        self.assertEqual((st, js['attempts']), (200, 2))
        self.assertIn('compact', self.up.requests[1]['body']['messages'][-1]['content'])

    def test_upstream_error(self):
        self.up.queue.append({'status': 529})
        st, _, js = self.gen()
        self.assertEqual((st, js['error']['code']), (502, 'llm_error'))
        self.assertNotIn(API_KEY, json.dumps(js))

    def test_bad_requests(self):
        for body in ({'description': ''}, {'description': 'x' * 4001}, {'description': 'x', 'widthFt': 33},
                     {'description': 'x', 'widthFt': 700}, {'description': 'x', 'heightFt': True},
                     {'description': 'x', 'seed': -1}, {'description': 5}, [1]):
            st, _, js = self.api('POST', '/api/generate', body)
            self.assertEqual((st, js['error']['code']), (400, 'bad_request'), body)
        self.assertEqual(self.up.requests, [])

    def test_usage_log_and_cost(self):
        self.gen()
        lines = read(os.path.join(self.tmp, 'usage.log')).strip().splitlines()
        e = json.loads(lines[-1])
        self.assertEqual(set(e) - {'error'}, {'ts', 'endpoint', 'model', 'attempt', 'inputTokens', 'outputTokens',
                                               'cacheReadTokens', 'cacheWriteTokens', 'costUsd', 'ok', 'session', 'backend'})
        self.assertEqual((e['inputTokens'], e['outputTokens'], e['cacheReadTokens'], e['cacheWriteTokens']), (1000, 500, 3000, 2000))
        # sonnet: 1000*2 + 500*10 + 3000*0.2 + 2000*2.5 per million
        self.assertAlmostEqual(e['costUsd'], (2000 + 5000 + 600 + 5000) / 1e6)
        self.assertRegex(e['session'], r'^[0-9a-f]{12}$')
        self.assertTrue(e['ok'])

    def test_key_never_leaks(self):
        self.gen()
        self.up.queue.append({'status': 401})
        self.gen()
        for path in ('/api/session', '/api/usage', '/', '/login'):
            self.assertNotIn(API_KEY, json.dumps(self.api('GET', path)))
        for name in os.listdir(self.tmp):
            p = os.path.join(self.tmp, name)
            if os.path.isfile(p):
                self.assertNotIn(API_KEY, read(p), name)
                self.assertNotIn(PASSWORD, read(p), name)


class EditTest(Base):
    def edit(self, **kw):
        scene = json.loads(SAMPLE)
        body = {'instruction': 'Light the fire', 'selectedIds': ['campfire'], 'selected': [], 'neighbours': [],
                'summary': {'name': 'x'}, 'scene': scene, **kw}
        return self.api('POST', '/api/edit', body)

    def test_valid(self):
        self.up.queue.append({'text': VALID_OPS})
        st, _, js = self.edit()
        self.assertEqual(st, 200, js)
        self.assertEqual(js['ops'][0]['path'], '/objects/campfire/params/lit')
        self.assertEqual(js['summary'], 'Lit the campfire.')
        b = self.up.requests[0]['body']
        self.assertEqual((b['max_tokens'], b['output_config']), (8000, {'effort': 'low'}))
        sent = json.loads(b['messages'][0]['content'])
        self.assertEqual(sent['selected'][0]['id'], 'campfire')
        self.assertNotIn('scene', sent)

    def test_whole_map_sends_scene(self):
        self.up.queue.append({'text': json.dumps({'ops': [{'op': 'replace', 'path': '/terrain/base', 'value': 'snow'}],
                                                  'summary': 'Snow.'})})
        st, _, js = self.edit(selectedIds=[])
        self.assertEqual(st, 200, js)
        self.assertIn('scene', json.loads(self.up.requests[0]['body']['messages'][0]['content']))

    def test_out_of_scope_rejected_after_retry(self):
        out = json.dumps({'ops': [{'op': 'remove', 'path': '/objects/tree-1'}], 'summary': 'x'})
        self.up.queue += [{'text': out}, {'text': out}]
        st, _, js = self.edit()
        self.assertEqual((st, js['error']['code']), (502, 'llm_invalid'))
        self.assertIn('tree-1', json.dumps(js['error']['details']))

    def test_neighbour_and_added_ids_allowed(self):
        ops = {'ops': [{'op': 'replace', 'path': '/objects/crate-1/rotation', 'value': 30},
                       {'op': 'add', 'path': '/objects/-', 'value': {'id': 'crate-9', 'type': 'crate', 'name': 'Crate',
                                                                       'position': {'x': 50, 'y': 90}, 'size': {'w': 3, 'h': 3}}}],
               'summary': 's'}
        self.up.queue.append({'text': json.dumps(ops)})
        st, _, js = self.edit(neighbours=[{'id': 'crate-1'}])
        self.assertEqual(st, 200, js)

    def test_patch_error_then_fix(self):
        self.up.queue += [{'text': json.dumps({'ops': [{'op': 'remove', 'path': '/objects/ghost'}]})}, {'text': VALID_OPS}]
        st, _, js = self.edit()
        self.assertEqual((st, js['attempts']), (200, 2))

    def test_invalid_scene(self):
        st, _, js = self.edit(scene={'meta': {}})
        self.assertEqual((st, js['error']['code']), (400, 'invalid_scene'))
        self.assertEqual(self.up.requests, [])


class NoKeyTest(Base):
    env = {'ANTHROPIC_API_KEY': None}

    def test_llm_routes_503_others_fine(self):
        for p in ('/api/generate', '/api/edit'):
            st, _, js = self.api('POST', p, {'description': 'x'})
            self.assertEqual((st, js['error']['code']), (503, 'llm_not_configured'))
        self.assertEqual(self.api('GET', '/api/session')[0], 200)
        self.assertIn('ANTHROPIC_API_KEY is not set', read(self.srv.log_path))


class RateLimitTest(Base):
    env = {'RATE_LIMIT_PER_MIN': 2}

    def test_rate_limited(self):
        for _ in range(2):
            self.assertEqual(self.api('POST', '/api/generate', {'description': 'x'})[0], 200)
        st, hd, js = self.api('POST', '/api/generate', {'description': 'x'})
        self.assertEqual((st, js['error']['code']), (429, 'rate_limited'))
        self.assertGreater(int(hd['retry-after']), 0)
        self.assertEqual(js['error']['retryAfterSec'], int(hd['retry-after']))
        other = self.srv.login()  # the limit is per session
        self.assertEqual(self.srv.request('POST', '/api/generate', {'description': 'x'}, cookie=other)[0], 200)


class DailyCapTest(Base):
    env = {'DAILY_REQUEST_CAP': 2}

    def test_cap_persists_across_restart(self):
        self.up.queue += [{'text': 'bad'}, {'text': SAMPLE}]  # retry counts as one request
        self.assertEqual(self.api('POST', '/api/generate', {'description': 'x'})[2]['attempts'], 2)
        st, _, js = self.api('POST', '/api/generate', {'description': 'x'})
        self.assertEqual(js['usage']['remaining'], 0)
        st, hd, js = self.api('POST', '/api/generate', {'description': 'x'})
        self.assertEqual((st, js['error']['code']), (429, 'daily_cap'))
        self.assertEqual(js['error']['message'], 'Daily limit reached (2 requests). Resets at 00:00 UTC.')
        self.assertIn('retry-after', hd)
        daily = json.loads(read(os.path.join(self.tmp, 'usage-daily.json')))
        self.assertEqual(daily['requests'], 2)
        self.assertEqual(set(daily), {'date', 'requests', 'inputTokens', 'outputTokens', 'costUsd'})
        self.srv.stop()
        type(self).srv = Server(self.tmp, self.up.url, **self.env)
        type(self).cookie = self.srv.login()
        st, _, js = self.api('POST', '/api/generate', {'description': 'x'})
        self.assertEqual((st, js['error']['code']), (429, 'daily_cap'))
        self.assertEqual(self.api('GET', '/api/usage')[2]['requests'], 2)


class LockoutTest(Base):
    env = {'LOGIN_MAX_FAILS': 3, 'TRUSTED_PROXY': 1}

    def test_lockout_by_rightmost_forwarded_ip(self):
        bad = {'password': 'wrong-password'}
        xff = {'X-Forwarded-For': '1.1.1.1, 2.2.2.2'}
        st, _, js = self.srv.request('POST', '/login', bad, headers=xff)
        self.assertEqual(js['error']['attemptsLeft'], 2)
        self.srv.request('POST', '/login', bad, headers=xff)
        st, _, js = self.srv.request('POST', '/login', bad, headers=xff)
        self.assertEqual((st, js['error']['code']), (429, 'locked_out'))
        # same right-most IP is still locked even with the right password and a spoofed left part
        st, hd, js = self.srv.request('POST', '/login', {'password': PASSWORD}, headers={'X-Forwarded-For': '9.9.9.9, 2.2.2.2'})
        self.assertEqual((st, js['error']['code']), (429, 'locked_out'))
        self.assertIn('retry-after', hd)
        # a different client IP is unaffected
        self.srv.login({'X-Forwarded-For': '2.2.2.2, 3.3.3.3'})

    def test_success_resets_count(self):
        h = {'X-Forwarded-For': '5.5.5.5'}
        for _ in range(2):
            self.srv.request('POST', '/login', {'password': 'x'}, headers=h)
        self.srv.login(h)
        st, _, js = self.srv.request('POST', '/login', {'password': 'x'}, headers=h)
        self.assertEqual(js['error']['attemptsLeft'], 2)


class SessionSecretEnvTest(Base):
    env = {'SESSION_SECRET': 'env-secret-value-for-tests', 'COOKIE_SECURE': 1}

    def test_env_secret_used_and_secure_flag(self):
        self.assertFalse(os.path.exists(os.path.join(self.tmp, 'session_secret')))
        st, hd, _ = self.srv.request('POST', '/login', {'password': PASSWORD})
        self.assertTrue(hd['set-cookie'].endswith('; Secure'))
        payload, sig = hd['set-cookie'].split(';')[0].split('=', 1)[1].rsplit('.', 1)
        self.assertEqual(sig, hmac.new(b'env-secret-value-for-tests', payload.encode(), hashlib.sha256).hexdigest())


# ------------------------------------------------------------ review regressions

def raw_request(port, data, shutdown_write=False, timeout=10):
    """Sends raw bytes, returns the raw response (until the server closes, the body is complete, or a timeout)."""
    with socket.create_connection(('127.0.0.1', port), timeout=timeout) as s:
        s.sendall(data)
        if shutdown_write:
            s.shutdown(socket.SHUT_WR)
        out = b''
        try:
            while True:
                chunk = s.recv(65536)
                if not chunk:
                    break
                out += chunk
                if b'\r\n\r\n' in out:
                    head, _, body = out.partition(b'\r\n\r\n')
                    m = [ln for ln in head.split(b'\r\n') if ln.lower().startswith(b'content-length:')]
                    if m and len(body) >= int(m[0].split(b':')[1]):
                        break
        except (socket.timeout, ConnectionError):
            pass
        return out


def sse(*events):
    return b''.join(f'data: {json.dumps(e)}\n\n'.encode() for e in events)


class UpstreamRobustnessTest(Base):
    """D4 / T1: malformed or hostile upstream responses become 502 llm_error, logged, never 500 or a key leak."""

    def gen(self):
        return self.api('POST', '/api/generate', {'description': 'x'})

    def last_log(self):
        return json.loads(read(os.path.join(self.tmp, 'usage.log')).strip().splitlines()[-1])

    def test_malformed_streams(self):
        head = b'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n'
        cases = {
            'incomplete read': head + b'Content-Length: 5000\r\n\r\n' + sse({'type': 'ping'}),
            'usage is a list': head + b'\r\n' + sse({'type': 'message_start', 'message': {'model': 'm', 'usage': [1, 2]}}),
            'message is a list': head + b'\r\n' + sse({'type': 'message_start', 'message': [1]}),
            'delta text not a string': head + b'\r\n' + sse(
                {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}},
                {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': 5}}),
            'garbage status line': b'NOT HTTP\r\n\r\n',
        }
        for name, raw in cases.items():
            with self.subTest(name):
                self.up.queue.append({'raw': raw})
                st, _, js = self.gen()
                self.assertEqual((st, js['error']['code']), (502, 'llm_error'), js)
                e = self.last_log()
                self.assertEqual((e['ok'], e['error']), (False, 'llm_error'))

    def test_bad_usage_values_are_ignored(self):
        raw = (b'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n' + sse(
            {'type': 'message_start', 'message': {'model': ['x'], 'usage': {'input_tokens': 'lots', 'output_tokens': -5,
                                                                             'cache_read_input_tokens': True}}},
            {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': SAMPLE}},
            {'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}, 'usage': {'output_tokens': None}}))
        self.up.queue.append({'raw': raw})
        st, _, js = self.gen()
        self.assertEqual(st, 200, js)
        e = self.last_log()
        self.assertEqual((e['model'], e['inputTokens'], e['outputTokens'], e['cacheReadTokens']), ('claude-sonnet-5-5', 0, 0, 0))

    def test_key_scrubbed_from_upstream_errors(self):
        msg = f'invalid x-api-key {API_KEY} (also sk-ant-api03-OTHERKEY_abc-123)'
        self.up.queue.append({'status': 401, 'etype': 'authentication_error', 'message': msg})
        st, _, js = self.gen()
        self.assertEqual((st, js['error']['code']), (502, 'llm_error'))
        dumped = json.dumps(js)
        self.assertNotIn(API_KEY, dumped)
        self.assertNotIn('OTHERKEY', dumped)
        self.assertIn('[redacted]', dumped)
        self.up.queue.append({'raw': b'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n' + sse(
            {'type': 'error', 'error': {'type': 'api_error', 'message': 'echo ' + API_KEY}})})
        st, _, js = self.gen()
        self.assertEqual(st, 502)
        self.assertNotIn(API_KEY, json.dumps(js))
        for name in os.listdir(self.tmp):
            p = os.path.join(self.tmp, name)
            if os.path.isfile(p):
                self.assertNotIn(API_KEY, read(p), name)
                self.assertNotIn('OTHERKEY', read(p), name)


class LoginRaceTest(Base):
    env = {'LOGIN_MAX_FAILS': 5, 'TRUSTED_PROXY': 1}

    def burst(self, ip, passwords):
        barrier = threading.Barrier(len(passwords))
        results = []

        def go(pw):
            barrier.wait()
            st, _, _ = self.srv.request('POST', '/login', {'password': pw}, headers={'X-Forwarded-For': ip})
            results.append((pw, st))

        ts = [threading.Thread(target=go, args=(pw,)) for pw in passwords]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        return results

    def test_parallel_wrong_guesses_capped(self):
        res = self.burst('7.7.7.7', ['wrong-%d' % i for i in range(60)])
        self.assertLessEqual(sum(1 for _, st in res if st == 401), 4)  # the 5th checked failure answers 429
        self.assertEqual([st for _, st in res if st not in (401, 429)], [])
        st, _, js = self.srv.request('POST', '/login', {'password': PASSWORD}, headers={'X-Forwarded-For': '7.7.7.7'})
        self.assertEqual((st, js['error']['code']), (429, 'locked_out'))

    def test_guard_reserves_before_checking(self):
        sys.path.insert(0, ROOT)
        os.environ.setdefault('APP_PASSWORD', 'unit-test-password')
        import server
        g, ip = server.LoginGuard(), '9.9.9.9'
        tokens = [g.begin(ip) for _ in range(server.LOGIN_MAX_FAILS)]
        self.assertTrue(all(w == 0 for w, _ in tokens))
        self.assertGreater(g.begin(ip)[0], 0)  # every slot is pending: a 6th guess is not compared
        g.finish(ip, tokens[0][1], True)  # a success clears settled failures but keeps other pending slots
        w, t = g.begin(ip)
        self.assertEqual(w, 0)
        for _, tok in tokens[1:] + [(0, t)]:
            left = g.finish(ip, tok, False)
        self.assertEqual(left, 0)
        self.assertGreater(g.begin(ip)[0], 0)  # locked: the right password is never compared


class RequestHardeningTest(Base):
    env = {'REQUEST_TIMEOUT_SEC': 1}

    def post(self, cl_lines, body=b'', shutdown_write=False):
        head = (b'POST /api/generate HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n'
                + f'Cookie: bms_session={self.cookie}\r\n'.encode() + b''.join(cl_lines) + b'\r\n')
        return raw_request(self.srv.port, head + body, shutdown_write)

    def test_bad_content_length(self):
        for cl in ([b'Content-Length: \xc2\xb2\r\n'], [b'Content-Length: -1\r\n'], [b'Content-Length: 12345678901\r\n'],
                   [b'Content-Length: 1e3\r\n'], [b'Content-Length: 5\r\n', b'Content-Length: 3000000\r\n']):
            with self.subTest(cl):
                r = self.post(cl, b'{}')
                self.assertTrue(r.startswith(b'HTTP/1.1 400'), r[:80])

    def test_short_body(self):
        t = time.time()
        r = self.post([b'Content-Length: 100\r\n'], b'{"descr', shutdown_write=True)
        self.assertTrue(r.startswith(b'HTTP/1.1 400'), r[:80])
        r = self.post([b'Content-Length: 100\r\n'], b'{"descr')  # client stalls: the socket timeout fires
        self.assertTrue(r.startswith(b'HTTP/1.1 400'), r[:80])
        self.assertLess(time.time() - t, 8)
        self.assertNotIn(b'internal', r)

    def test_other_methods(self):
        for m in ('HEAD', 'OPTIONS', 'PATCH'):
            with self.subTest(m):
                st, _, _ = self.srv.request(m, '/api/scenes')
                self.assertEqual(st, 401)
                st, hd, _ = self.srv.request(m, '/')
                self.assertEqual((st, hd['location']), (302, '/login'))
                st, hd, js = self.api(m, '/api/scenes')
                if m == 'HEAD':  # same as GET, no body
                    self.assertEqual((st, js), (200, ''))
                else:
                    self.assertEqual((st, js['error']['code']), (405, 'method_not_allowed'))
                self.assertEqual(hd['x-frame-options'], 'DENY')
        self.assertEqual(self.api('GET', '/api/session')[0], 200)

    def test_head_follows_get_rules(self):
        for path in ('/healthz', '/login'):
            st, hd, body = self.srv.request('HEAD', path)
            self.assertEqual((st, body), (200, ''), path)
            self.assertEqual(hd['content-length'], self.srv.request('GET', path)[1]['content-length'])
        st, hd, _ = self.api('HEAD', '/login')
        self.assertEqual((st, hd['location']), (302, '/'))
        self.assertEqual(self.api('GET', '/api/session')[0], 200)  # connection still in sync


class ConnectionCapTest(Base):
    env = {'MAX_CONNECTIONS': 3, 'REQUEST_TIMEOUT_SEC': 5}

    def test_busy_when_connection_slots_full(self):
        idle = [socket.create_connection(('127.0.0.1', self.srv.port)) for _ in range(3)]
        try:
            time.sleep(0.5)
            r = raw_request(self.srv.port, b'GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n')
            self.assertTrue(r.startswith(b'HTTP/1.1 503'), r[:80])
            self.assertIn(b'"busy"', r)
        finally:
            for s in idle:
                s.close()
        time.sleep(0.5)
        self.assertEqual(self.srv.request('GET', '/healthz')[0], 200)

    def test_queue_size(self):
        sys.path.insert(0, ROOT)
        os.environ.setdefault('APP_PASSWORD', 'unit-test-password')
        import server
        self.assertEqual(server.Server.request_queue_size, 128)


class DailyCapSingularTest(Base):
    env = {'DAILY_REQUEST_CAP': 1}

    def test_singular_message(self):
        self.assertEqual(self.api('POST', '/api/generate', {'description': 'x'})[0], 200)
        st, _, js = self.api('POST', '/api/generate', {'description': 'x'})
        self.assertEqual(js['error']['message'], 'Daily limit reached (1 request). Resets at 00:00 UTC.')


@unittest.skipIf(os.name == 'nt', 'SIGTERM cannot be delivered to a handler on Windows')
class SigtermTest(Base):
    def test_clean_fast_shutdown(self):
        import signal
        t = time.time()
        self.srv.proc.send_signal(signal.SIGTERM)
        self.assertEqual(self.srv.proc.wait(5), 0)
        self.assertLess(time.time() - t, 5)
        self.assertIn('stopped', read(self.srv.log_path))
        type(self).srv = Server(self.tmp, self.up.url)  # tearDownClass stops it


# ------------------------------------------------------------ LLM_BACKEND=claude-cli

FAKE_CLAUDE = r'''
import json, os, sys, time
stdin = sys.stdin.buffer.read().decode('utf-8')
qpath = os.environ['FAKE_CLAUDE_QUEUE']
with open(qpath, encoding='utf-8') as f:
    queue = json.load(f)
item = queue.pop(0) if queue else {}
with open(qpath, 'w', encoding='utf-8') as f:
    json.dump(queue, f)
with open(os.environ['FAKE_CLAUDE_LOG'], 'a', encoding='utf-8') as f:
    f.write(json.dumps({'argv': sys.argv[1:], 'stdin': stdin, 'cwd': os.getcwd(), 'cwd_files': os.listdir('.'),
                        'env': sorted(os.environ)}) + '\n')
if 'sleep' in item:
    time.sleep(item['sleep'])
if 'raw' in item:
    sys.stdout.write(item['raw'])
    sys.stderr.write(item.get('stderr', ''))
    sys.exit(item.get('exit', 1))
sample = open(os.environ['FAKE_CLAUDE_SAMPLE'], encoding='utf-8').read()
print(json.dumps({'type': 'result', 'subtype': 'success', 'is_error': item.get('is_error', False),
                  'result': item.get('result', sample), 'stop_reason': item.get('stop_reason', 'end_turn'),
                  'total_cost_usd': 0.42, 'modelUsage': {'claude-sonnet-5-5': {}},
                  'usage': {'input_tokens': 10, 'cache_creation_input_tokens': 20, 'cache_read_input_tokens': 30,
                            'output_tokens': 40}}))
sys.exit(item.get('exit', 0))
'''


def make_fake_claude(dirpath):
    script = os.path.join(dirpath, 'fake_claude.py')
    with open(script, 'w', encoding='utf-8') as f:
        f.write(FAKE_CLAUDE)
    if os.name == 'nt':  # like the real npm install, which is claude.cmd
        shim = os.path.join(dirpath, 'claude.cmd')
        with open(shim, 'w', encoding='utf-8') as f:
            f.write(f'@"{sys.executable}" "{script}" %*\r\n')
    else:
        shim = os.path.join(dirpath, 'claude')
        with open(shim, 'w', encoding='utf-8') as f:
            f.write(f'#!/bin/sh\nexec "{sys.executable}" "{script}" "$@"\n')
        os.chmod(shim, 0o755)
    return shim


class CliBase(Base):
    extra_env = {}

    @classmethod
    def setUpClass(cls):
        cls.fake_dir = tempfile.mkdtemp(prefix='bms-fake-claude-')
        cls.shim = make_fake_claude(cls.fake_dir)
        cls.queue = os.path.join(cls.fake_dir, 'queue.json')
        cls.calls = os.path.join(cls.fake_dir, 'calls.log')
        sample = os.path.join(cls.fake_dir, 'sample.json')
        with open(sample, 'w', encoding='utf-8') as f:
            f.write(SAMPLE)
        cls.env = {'LLM_BACKEND': 'claude-cli', 'CLAUDE_CLI': cls.shim, 'FAKE_CLAUDE_QUEUE': cls.queue,
                   'FAKE_CLAUDE_LOG': cls.calls, 'FAKE_CLAUDE_SAMPLE': sample, 'LLM_TIMEOUT_SEC': 3,
                   'SESSION_SECRET': 'cli-test-session-secret', **cls.extra_env}
        super().setUpClass()

    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        shutil.rmtree(cls.fake_dir, ignore_errors=True)

    def setUp(self):
        super().setUp()
        self.script([])
        if os.path.exists(self.calls):
            os.remove(self.calls)

    def script(self, items):
        with open(self.queue, 'w', encoding='utf-8') as f:
            json.dump(items, f)

    def cli_calls(self):
        return [json.loads(ln) for ln in read(self.calls).splitlines()] if os.path.exists(self.calls) else []

    def gen(self):
        return self.api('POST', '/api/generate', {'description': 'A ford with a watchtower'})


class CliBackendTest(CliBase):
    def test_valid_call_shape_and_usage(self):
        st, _, js = self.gen()
        self.assertEqual(st, 200, js)
        self.assertEqual(js['attempts'], 1)
        self.assertEqual((js['usage']['backend'], js['usage']['costUsd']), ('claude-cli', 0))
        self.assertEqual(self.up.requests, [])  # the HTTP API is not used
        (call,) = self.cli_calls()
        self.assertEqual(call['argv'], ['-p', '--output-format', 'json', '--model', 'claude-sonnet-5-5', '--system-prompt',
                                        'You produce JSON only, exactly as instructed in the input.', '--tools', '',
                                        '--no-session-persistence', '--strict-mcp-config', '--setting-sources', ''])
        self.assertIn('=== INSTRUCTIONS ===', call['stdin'])
        self.assertIn('Stated distances are exact', call['stdin'])  # full system prompt goes through stdin
        self.assertIn('A ford with a watchtower', call['stdin'])
        for secret in ('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'APP_PASSWORD', 'SESSION_SECRET'):
            self.assertNotIn(secret, call['env'])
        self.assertEqual(call['cwd_files'], [])
        self.assertNotEqual(os.path.realpath(call['cwd']), os.path.realpath(ROOT))
        e = json.loads(read(os.path.join(self.tmp, 'usage.log')).strip().splitlines()[-1])
        self.assertEqual((e['backend'], e['costUsd'], e['inputTokens'], e['outputTokens'], e['cacheReadTokens'],
                          e['cacheWriteTokens'], e['ok']), ('claude-cli', 0, 10, 40, 30, 20, True))
        self.assertEqual(self.api('GET', '/api/session')[2]['backend'], 'claude-cli')
        self.assertIn('LLM backend claude-cli', read(self.srv.log_path))

    def test_invalid_then_valid_flattens_retry(self):
        self.script([{'result': 'not json at all'}, {}])
        st, _, js = self.gen()
        self.assertEqual((st, js['attempts']), (200, 2))
        second = self.cli_calls()[1]['stdin']
        self.assertIn('--- ASSISTANT (your previous answer) ---\nnot json at all', second)
        self.assertIn('Your output has these problems', second)

    def test_errors(self):
        cases = [
            ({'is_error': True, 'result': 'Invalid API key sk-ant-api03-LEAKED_key-1 / please run /login'}, 'llm_error', 'please run'),
            ({'raw': 'Traceback garbage', 'stderr': 'boom ' + API_KEY, 'exit': 3}, 'llm_error', 'exit 3'),
            ({'exit': 1}, 'llm_error', 'exit 1'),
            ({'stop_reason': 'refusal', 'result': ''}, 'llm_refusal', 'declined'),
        ]
        for item, code, text in cases:
            with self.subTest(item=item):
                if os.path.exists(self.calls):
                    os.remove(self.calls)
                self.script([item, item])
                st, _, js = self.gen()
                self.assertEqual((st, js['error']['code']), (502, code), js)
                self.assertIn(text, js['error']['message'])
                self.assertNotIn('LEAKED', json.dumps(js))
                self.assertNotIn(API_KEY, json.dumps(js))
                self.assertEqual(len(self.cli_calls()), 1)  # no retry for errors and refusals
        for name in os.listdir(self.tmp):
            p = os.path.join(self.tmp, name)
            if os.path.isfile(p):
                self.assertNotIn('LEAKED', read(p))

    def test_max_tokens_retries(self):
        self.script([{'stop_reason': 'max_tokens', 'result': '{"meta": '}, {}])
        st, _, js = self.gen()
        self.assertEqual((st, js['attempts']), (200, 2))
        self.assertIn('compact', self.cli_calls()[1]['stdin'])

    def test_timeout(self):
        self.script([{'sleep': 30}])
        t = time.time()
        st, _, js = self.gen()
        self.assertEqual((st, js['error']['code']), (502, 'llm_error'))
        self.assertIn('timed out', js['error']['message'])
        self.assertLess(time.time() - t, 15)

    def test_missing_executable(self):
        os.rename(self.shim, self.shim + '.off')
        try:
            st, _, js = self.gen()
        finally:
            os.rename(self.shim + '.off', self.shim)
        self.assertEqual((st, js['error']['code']), (502, 'llm_error'))
        self.assertIn('claude CLI not found - install Claude Code and run `claude` once to log in', js['error']['message'])

    def test_edit_route(self):
        self.script([{'result': VALID_OPS}])
        body = {'instruction': 'Light the fire', 'selectedIds': ['campfire'], 'selected': [], 'neighbours': [],
                'summary': {}, 'scene': json.loads(SAMPLE)}
        st, _, js = self.api('POST', '/api/edit', body)
        self.assertEqual(st, 200, js)
        self.assertEqual(js['summary'], 'Lit the campfire.')


class CliNoKeyTest(CliBase):
    extra_env = {'ANTHROPIC_API_KEY': None, 'DAILY_REQUEST_CAP': 1}

    def test_works_without_key_and_cap_applies(self):
        self.assertEqual(self.gen()[0], 200)  # no 503 llm_not_configured on this backend
        st, _, js = self.gen()
        self.assertEqual((st, js['error']['code']), (429, 'daily_cap'))


class BackendStartupTest(unittest.TestCase):
    def test_unknown_backend_refused(self):
        env = {**os.environ, 'DATA_DIR': tempfile.mkdtemp(prefix='bms-test-'), 'PORT': str(free_port()),
               'APP_PASSWORD': PASSWORD, 'LLM_BACKEND': 'carrier-pigeon'}
        p = subprocess.run([sys.executable, os.path.join(ROOT, 'server.py')], env=env, capture_output=True, text=True, timeout=20)
        self.assertEqual(p.returncode, 2)
        self.assertIn('LLM_BACKEND', p.stderr)
        shutil.rmtree(env['DATA_DIR'], ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
