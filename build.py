#!/usr/bin/env python3
"""Battle Map Studio build (docs/CONTRACT.md section 13). Python stdlib only.

1. Regenerate src/generators/index.js from src/generators/*.js, checked against
   schema.json x-elementTypes.
2. Bundle every module reachable from src/main.js into dist/index.html: relative
   specifiers become bare '@app/<repo path>' specifiers resolved by an importmap of
   data: URLs. JSON modules become 'export default <json>;' JS modules.
3. Inline src/styles/base.css, then the other src/**/*.css sorted, into one <style>.

Deterministic output. Exits 1 with a list of errors on failure.
"""
import base64
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / 'src'
DIST = ROOT / 'dist'
ENTRY = 'src/main.js'
GEN_DIR = SRC / 'generators'


class BuildError(Exception):
    pass


# ---------------------------------------------------------------- lexer
# Just enough JavaScript lexing to find import/export specifiers without being fooled by
# strings, template literals, comments or regex literals that contain the word "import".

IDENT_RE = re.compile(r'[A-Za-z_$\u0080-￿][\w$\u0080-￿]*')
NUM_RE = re.compile(r'\.?\d[\w.]*')
REGEX_AFTER_KEYWORDS = {'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
                        'throw', 'case', 'do', 'else', 'yield', 'await'}


def _scan_string(src, i, where):
    q = src[i]
    j = i + 1
    while j < len(src):
        c = src[j]
        if c == '\\':
            j += 2
            continue
        if c == q:
            return j + 1
        if c == '\n':
            break
        j += 1
    raise BuildError(f'{where}: unterminated string at offset {i}')


def _scan_template(src, j, where):
    """Scan template text from j (just after ` or }). Returns (end, closed) where closed
    means the template ended with a backtick (else it stopped after '${')."""
    while j < len(src):
        c = src[j]
        if c == '\\':
            j += 2
            continue
        if c == '`':
            return j + 1, True
        if c == '$' and src.startswith('${', j):
            return j + 2, False
        j += 1
    raise BuildError(f'{where}: unterminated template literal')


def _scan_regex(src, i, where):
    j = i + 1
    in_class = False
    while j < len(src):
        c = src[j]
        if c == '\\':
            j += 2
            continue
        if c == '\n':
            break
        if in_class:
            if c == ']':
                in_class = False
        elif c == '[':
            in_class = True
        elif c == '/':
            j += 1
            m = IDENT_RE.match(src, j)
            return m.end() if m else j
        j += 1
    raise BuildError(f'{where}: unterminated regex literal at offset {i}')


def lex(src, where='<src>'):
    """-> list of (kind, value, start, end); kind in ident, str, tpl, regex, num, punct."""
    toks = []
    i, n = 0, len(src)
    depth = 0
    tpl_stack = []  # brace depth at which each open '${' resumes its template

    def regex_allowed():
        if not toks:
            return True
        kind, val = toks[-1][0], toks[-1][1]
        if kind == 'punct':
            return val not in (')', ']', '}')
        return kind == 'ident' and val in REGEX_AFTER_KEYWORDS

    while i < n:
        c = src[i]
        if c in ' \t\r\n﻿   \v\f':
            i += 1
        elif src.startswith('//', i):
            j = src.find('\n', i)
            i = n if j < 0 else j
        elif src.startswith('/*', i):
            j = src.find('*/', i + 2)
            if j < 0:
                raise BuildError(f'{where}: unterminated block comment')
            i = j + 2
        elif c in '"\'':
            j = _scan_string(src, i, where)
            toks.append(('str', src[i:j], i, j))
            i = j
        elif c == '`' or (c == '}' and tpl_stack and tpl_stack[-1] == depth):
            if c == '}':
                tpl_stack.pop()
            j, closed = _scan_template(src, i + 1, where)
            toks.append(('tpl', src[i:j], i, j))
            if not closed:
                tpl_stack.append(depth)
            i = j
        elif c == '/' and regex_allowed():
            j = _scan_regex(src, i, where)
            toks.append(('regex', src[i:j], i, j))
            i = j
        elif IDENT_RE.match(src, i):
            m = IDENT_RE.match(src, i)
            toks.append(('ident', m.group(), i, m.end()))
            i = m.end()
        elif NUM_RE.match(src, i):
            m = NUM_RE.match(src, i)
            toks.append(('num', m.group(), i, m.end()))
            i = m.end()
        else:
            if c == '{':
                depth += 1
            elif c == '}':
                depth -= 1
            toks.append(('punct', c, i, i + 1))
            i += 1
    if tpl_stack:
        raise BuildError(f'{where}: unterminated template literal')
    return toks


def _str_value(tok, where):
    raw = tok[1][1:-1]
    if '\\' in raw:
        raise BuildError(f'{where}: escape sequences in module specifiers are not supported: {tok[1]}')
    return raw


def find_imports(src, where):
    """-> list of dicts {spec, start, end, attr: (start, end, type) | None} for every static
    import / export-from. Raises on dynamic import()."""
    toks = lex(src, where)
    out = []
    k = 0
    while k < len(toks):
        kind, val = toks[k][0], toks[k][1]
        if kind != 'ident' or val not in ('import', 'export') or (k and toks[k - 1][1] == '.'):
            k += 1
            continue
        nxt = toks[k + 1] if k + 1 < len(toks) else None
        spec_at = None
        if val == 'import':
            if nxt is None:
                raise BuildError(f'{where}: dangling import')
            if nxt[1] == '(':
                raise BuildError(f'{where}: dynamic import() is not allowed (CONTRACT section 1)')
            if nxt[1] in ('.', ':'):  # import.meta, or an object key named import
                k += 1
                continue
            if nxt[0] == 'str':
                spec_at = k + 1
            else:
                spec_at = _scan_clause(toks, k + 1, where, require=True)
        else:
            if nxt is not None and nxt[1] in ('*', '{'):
                spec_at = _scan_clause(toks, k + 1, where, require=nxt[1] == '*')
        if spec_at is None:
            k += 1
            continue
        stok = toks[spec_at]
        item = {'spec': _str_value(stok, where), 'start': stok[2], 'end': stok[3], 'attr': None}
        a = spec_at + 1
        if a + 1 < len(toks) and toks[a][0] == 'ident' and toks[a][1] in ('with', 'assert') and toks[a + 1][1] == '{':
            b = a + 2
            while b < len(toks) and toks[b][1] != '}':
                b += 1
            if b >= len(toks):
                raise BuildError(f'{where}: unterminated import attributes')
            body = [t[1] for t in toks[a + 2:b]]
            if len(body) not in (3, 4) or body[0] not in ('type', "'type'", '"type"') or body[1] != ':' \
                    or toks[a + 4][0] != 'str' or (len(body) == 4 and body[3] != ','):
                raise BuildError(f'{where}: unsupported import attributes for {item["spec"]}')
            item['attr'] = (stok[3], toks[b][3], _str_value(toks[a + 4], where))
            spec_at = b
        out.append(item)
        k = spec_at + 1
    return out


def _scan_clause(toks, j, where, require):
    """Scan an import/export clause starting at toks[j] up to `from '<spec>'`.
    Returns the spec token index, or None when (export only) there is no `from`."""
    depth = 0
    while j < len(toks):
        kind, val = toks[j][0], toks[j][1]
        if depth == 0 and kind == 'ident' and val == 'from' and j + 1 < len(toks) and toks[j + 1][0] == 'str':
            return j + 1
        if val == '{':
            depth += 1
        elif val == '}':
            depth -= 1
            if depth == 0 and not require:
                nxt = toks[j + 1] if j + 1 < len(toks) else None
                if not (nxt and nxt[0] == 'ident' and nxt[1] == 'from'):
                    return None  # plain `export { a, b }`
        elif not (kind in ('ident', 'str') or val in (',', '*')):
            if require:
                raise BuildError(f'{where}: cannot parse import statement near offset {toks[j][2]}')
            return None
        j += 1
    if require:
        raise BuildError(f'{where}: import without a module specifier')
    return None


# ---------------------------------------------------------------- helpers

def read_text(path):
    try:
        return path.read_text(encoding='utf-8')  # universal newlines: CRLF checkouts build the same
    except FileNotFoundError:
        raise BuildError(f'missing file: {rel(path)}')


def write_text(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)


def rel(path):
    return Path(os.path.relpath(path, ROOT)).as_posix()


def check_exact_case(path):
    """Windows resolves paths case-insensitively; Linux (the container) does not."""
    parts = Path(os.path.relpath(path, ROOT)).parts
    cur = ROOT
    for part in parts:
        if part not in os.listdir(cur):
            return False
        cur = cur / part
    return True


# ---------------------------------------------------------------- 1. registry

JS_RESERVED = {'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete',
               'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if',
               'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw',
               'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static',
               'await', 'implements', 'interface', 'package', 'private', 'protected', 'public'}


def generator_type(src, where):
    """The `type: '<x>'` declared in the generator's default export."""
    toks = lex(src, where)
    for k in range(len(toks) - 1):
        if toks[k][1] == 'export' and toks[k + 1][1] == 'default':
            for j in range(k + 2, len(toks) - 2):
                if toks[j][0] == 'ident' and toks[j][1] == 'type' and toks[j + 1][1] == ':' and toks[j + 2][0] == 'str':
                    return _str_value(toks[j + 2], where)
            break
    raise BuildError(f"{where}: no `export default {{ type: '...' }}` found")


def build_registry(errors):
    try:
        schema = json.loads(read_text(ROOT / 'schema.json'))
    except json.JSONDecodeError as e:
        raise BuildError(f'schema.json: {e}')
    schema_types = set(schema.get('x-elementTypes', {}))
    files = sorted(p for p in GEN_DIR.glob('*.js') if p.name != 'index.js' and not p.name.startswith('_'))
    types = []
    for p in files:
        where = rel(p)
        try:
            declared = generator_type(read_text(p), where)
        except BuildError as e:
            errors.append(str(e))
            continue
        if declared != p.stem:
            errors.append(f"{where}: declares type '{declared}' but the filename says '{p.stem}'")
        types.append(p.stem)
    for t in sorted(schema_types - set(types)):
        errors.append(f"schema.json x-elementTypes has '{t}' but src/generators/{t}.js is missing")
    for t in sorted(set(types) - schema_types):
        errors.append(f"src/generators/{t}.js has no x-elementTypes entry in schema.json")
    if errors:
        return
    lines = ['// GENERATED by build.py from src/generators/*.js. Do not edit.']
    names = {}
    for t in types:
        name = re.sub(r'[-_]+([a-z0-9])', lambda m: m.group(1).upper(), t)
        if not IDENT_RE.fullmatch(name) or name in JS_RESERVED or name == 'GENERATORS':
            name = 'gen' + name[:1].upper() + name[1:]
        names[t] = name
        lines.append(f"import {name} from './{t}.js';")
    lines += ['', 'export const GENERATORS = {']
    lines += [f"  '{t}': {names[t]}," for t in types]
    lines += ['};', '']
    text = '\n'.join(lines)
    target = GEN_DIR / 'index.js'
    if not target.exists() or read_text(target) != text:
        write_text(target, text)


# ---------------------------------------------------------------- 2. bundle

def bundle(errors):
    """-> {repo path: module JS source}, rewritten, for every module reachable from ENTRY."""
    modules = {}
    queue = [ROOT / ENTRY]
    seen = {ENTRY}
    while queue:
        path = queue.pop()
        key = rel(path)
        src = read_text(path)
        if path.suffix == '.json':
            try:
                data = json.loads(src)
            except json.JSONDecodeError as e:
                errors.append(f'{key}: invalid JSON: {e}')
                continue
            modules[key] = 'export default ' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n'
            continue
        try:
            imports = find_imports(src, key)
        except BuildError as e:
            errors.append(str(e))
            continue
        edits = []
        for im in imports:
            spec = im['spec']
            if not spec.startswith(('./', '../')):
                errors.append(f"{key}: import '{spec}' is not a relative path (CONTRACT section 1)")
                continue
            target = Path(os.path.normpath(path.parent / spec))  # not resolve(): it fixes case on Windows
            try:
                target.relative_to(ROOT)
            except ValueError:
                errors.append(f"{key}: import '{spec}' points outside the repository")
                continue
            if not target.is_file() or not check_exact_case(target):
                errors.append(f"{key}: import '{spec}' -> {rel(target)}: module not found")
                continue
            if target.suffix not in ('.js', '.json'):
                errors.append(f"{key}: import '{spec}' must end in .js or .json")
                continue
            is_json_attr = im['attr'] is not None and im['attr'][2] == 'json'
            if im['attr'] is not None and not is_json_attr:
                errors.append(f"{key}: import '{spec}' has unsupported attribute type '{im['attr'][2]}'")
                continue
            if (target.suffix == '.json') != is_json_attr:
                errors.append(f"{key}: import '{spec}': JSON must be imported with {{ type: 'json' }} and only JSON")
                continue
            tkey = rel(target)
            edits.append((im['start'], im['end'], f"'@app/{tkey}'"))
            if im['attr']:
                a0 = im['attr'][0]
                edits.append((a0, im['attr'][1], ''))
            if tkey not in seen:
                seen.add(tkey)
                queue.append(target)
        for start, end, repl in sorted(edits, reverse=True):
            src = src[:start] + repl + src[end:]
        modules[key] = src
    return modules


def importmap_html(modules):
    imports = {}
    for key in sorted(modules):
        b64 = base64.b64encode(modules[key].encode('utf-8')).decode('ascii')
        imports[f'@app/{key}'] = 'data:text/javascript;base64,' + b64
    body = json.dumps({'imports': imports}, indent=1).replace('</', '<\\/')
    return (f'<script type="importmap">\n{body}\n</script>\n'
            f"  <script type=\"module\">import '@app/{ENTRY}';</script>")


# ---------------------------------------------------------------- 3. css

def css_html(errors):
    base = SRC / 'styles' / 'base.css'
    others = sorted((p for p in SRC.rglob('*.css') if p.resolve() != base.resolve()), key=lambda p: rel(p))
    parts = []
    for p in [base] + others:
        css = read_text(p)
        if re.search(r'</style', css, re.I):
            errors.append(f'{rel(p)}: contains </style')
        parts.append(f'/* {rel(p)} */\n{css.rstrip()}\n')
    return '<style>\n' + '\n'.join(parts) + '</style>'


def replace_marker(html, name, content, errors):
    pat = re.compile(rf'(<!-- BUILD:{name} -->)(.*?)(<!-- /BUILD:{name} -->)', re.S)
    if len(pat.findall(html)) != 1:
        errors.append(f'src/index.html: expected exactly one <!-- BUILD:{name} --> ... <!-- /BUILD:{name} --> region')
        return html
    return pat.sub(lambda m: f'{m.group(1)}\n  {content}\n  {m.group(3)}', html)


# ---------------------------------------------------------------- main

def build():
    errors = []
    build_registry(errors)
    if errors:
        raise BuildError('\n'.join(errors))
    modules = bundle(errors)
    css = css_html(errors)
    html = read_text(SRC / 'index.html')
    html = replace_marker(html, 'CSS', css, errors)
    html = replace_marker(html, 'JS', importmap_html(modules), errors)
    if errors:
        raise BuildError('\n'.join(errors))
    write_text(DIST / 'index.html', html)
    return modules, html


def main():
    try:
        modules, html = build()
    except BuildError as e:
        print('build failed:\n' + '\n'.join('  ' + line for line in str(e).splitlines()), file=sys.stderr)
        return 1
    print(f'dist/index.html: {len(modules)} modules, {len(html.encode("utf-8")) // 1024} KiB')
    return 0


if __name__ == '__main__':
    sys.exit(main())
