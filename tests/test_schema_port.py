"""Python port of schema.js / patch.js must give the same verdicts as the JS (CONTRACT 3, 7)."""
import json
import os
import shutil
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ.setdefault('APP_PASSWORD', 'unit-test-password')
import server  # noqa: E402

CASES = json.load(open(os.path.join(ROOT, 'tests', 'cases.json'), encoding='utf-8'))


def sample(name):
    with open(os.path.join(ROOT, 'samples', f'{name}.json'), encoding='utf-8') as f:
        return server.parse_json(f.read())


def mutate(base, path, value):
    """Set a nested key (list of tokens) on a deep copy; value DELETE removes it."""
    s = json.loads(json.dumps(base))
    node = s
    for t in path[:-1]:
        node = node[t]
    if value == 'DELETE':
        del node[path[-1]]
    else:
        node[path[-1]] = value
    return s


# Extra tricky inputs, checked against the JS validator when node is available.
def extra_scenes():
    r, f = sample('riverside-ruin'), sample('forest-road-ambush')
    return [
        ('null rotation filled', mutate(r, ['objects', 0, 'rotation'], None)),
        ('float integer seed', mutate(r, ['seed'], 7.0)),
        ('bool seed', mutate(r, ['seed'], True)),
        ('id with trailing newline', mutate(r, ['objects', 0, 'id'], 'tree\n')),
        ('astral name at limit', mutate(r, ['objects', 0, 'name'], '\U0001F332' * 40)),
        ('astral name over limit', mutate(r, ['objects', 0, 'name'], '\U0001F332' * 41)),
        ('enum bool vs int', mutate(r, ['grid', 'cellFt'], True)),
        ('const 5.0', mutate(r, ['grid', 'cellFt'], 5.0)),
        ('width 0 integer', mutate(f, ['grid', 'widthFt'], 0)),
        ('null params', mutate(r, ['objects', 1, 'params'], None)),
        ('params is list', mutate(r, ['objects', 1, 'params'], [])),
        ('grid null', mutate(r, ['grid'], None)),
        ('constraints null', mutate(r, ['constraints'], None)),
        ('objects is object', mutate(r, ['objects'], {})),
        ('label font string', mutate(r, ['labels', 0, 'params', 'fontFt'], '3')),
        ('path width string', mutate(r, ['paths', 0, 'params', 'width'], '10')),
        ('point as dict', mutate(r, ['paths', 0, 'params', 'points', 0], {'0': 1, '1': 2})),
        ('point 3 values', mutate(r, ['paths', 0, 'params', 'points', 0], [1, 2, 3])),
        ('element null', mutate(r, ['objects', 0], None)),
        ('scene is array', [1, 2]),
        ('position on edge', mutate(r, ['objects', 0, 'position'], {'x': 120, 'y': 0})),
        ('negative zero', mutate(r, ['objects', 0, 'position', 'x'], -0.0)),
        ('huge path', mutate(r, ['paths', 0, 'params', 'points', 0], [-9999, 0])),
        ('layer null', mutate(r, ['objects', 0, 'layer'], None)),
        ('meta id uppercase', mutate(r, ['meta', 'id'], 'Riverside')),
        ('tint ok', mutate(r, ['terrain', 'tint'], '#AbCdEf')),
        ('constraint same a b', mutate(r, ['constraints', 0, 'b'], 'watchtower')),
        ('doors not list', mutate(r, ['objects', 0, 'params', 'doors'], {'side': 'n'})),
        ('lighting extra', mutate(r, ['lighting', 'fog'], 1)),
    ]


class SchemaPortTest(unittest.TestCase):
    def test_shared_cases(self):
        for c in CASES['cases']:
            with self.subTest(c['name']):
                base = server.check_scene(sample(c['base']))
                self.assertTrue(base['ok'], base['errors'])
                try:
                    nxt = server.apply_patch(base['scene'], c['ops'])
                except server.PatchError:
                    self.assertEqual(c['patch'], 'error')
                    continue
                self.assertEqual(c['patch'], 'ok')
                res = server.check_scene(nxt)
                self.assertEqual(res['ok'], c['valid'], res['errors'])

    def test_hash32(self):
        for v in CASES['hash32']:
            self.assertEqual(server.hash32(v['input']), v['output'])

    def test_patch_all_or_nothing(self):
        s = server.check_scene(sample('riverside-ruin'))['scene']
        before = json.dumps(s)
        with self.assertRaises(server.PatchError) as cm:
            server.apply_patch(s, [{'op': 'replace', 'path': '/meta/name', 'value': 'X'}, {'op': 'remove', 'path': '/objects/ghost'}])
        self.assertEqual(cm.exception.op_index, 1)
        server.apply_patch(s, [{'op': 'replace', 'path': '/meta/name', 'value': 'Y'}])
        self.assertEqual(json.dumps(s), before)

    def test_remove_drops_constraints(self):
        s = server.check_scene(sample('riverside-ruin'))['scene']
        self.assertEqual(server.apply_patch(s, [{'op': 'remove', 'path': '/paths/stream'}])['constraints'], [])

    def test_touched_ids(self):
        s = server.check_scene(sample('riverside-ruin'))['scene']
        ops = [{'op': 'replace', 'path': '/objects/campfire/params/lit', 'value': True},
               {'op': 'add', 'path': '/objects/-', 'value': {'id': 'new-1'}},
               {'op': 'replace', 'path': '/terrain/base', 'value': 'snow'}, None, {'path': 7}]
        self.assertEqual(server.touched_ids(s, ops), ['campfire', 'new-1'])

    def test_rejects_nan_and_overflow(self):
        for bad in ('{"a": NaN}', '{"a": Infinity}', '{"a": -Infinity}', '{"a": 1e400}', '{"a": 1' + '0' * 400 + '}'):
            with self.assertRaises(server.BadJson):
                server.parse_json(bad)

    def test_normalize_matches_js_sizes_and_seeds(self):
        node = shutil.which('node')
        if not node:
            self.skipTest('node not installed')
        js = ("import {normalizeScene} from './src/schema.js'; import {readFileSync} from 'node:fs';"
              "const out={}; for (const n of ['riverside-ruin','forest-road-ambush']) "
              "out[n]=normalizeScene(JSON.parse(readFileSync('samples/'+n+'.json','utf8')));"
              "console.log(JSON.stringify(out));")
        out = json.loads(subprocess.run([node, '--input-type=module', '-e', js], cwd=ROOT, capture_output=True,
                                        text=True, check=True).stdout)
        for name, js_scene in out.items():
            py_scene = server.normalize_scene(sample(name))
            self.assertEqual(json.loads(json.dumps(py_scene)), js_scene, name)

    def test_parity_with_js_on_extra_inputs(self):
        node = shutil.which('node')
        if not node:
            self.skipTest('node not installed')
        scenes = extra_scenes()
        js = ("import {checkScene} from './src/schema.js'; let s='';process.stdin.on('data',d=>s+=d);"
              "process.stdin.on('end',()=>console.log(JSON.stringify(JSON.parse(s).map(x=>checkScene(x).ok))));")
        res = subprocess.run([node, '--input-type=module', '-e', js], cwd=ROOT, capture_output=True, text=True,
                             input=json.dumps([s for _, s in scenes]), check=True, encoding='utf-8')
        js_ok = json.loads(res.stdout)
        for (name, s), expected in zip(scenes, js_ok):
            with self.subTest(name):
                self.assertEqual(server.check_scene(s)['ok'], expected)


if __name__ == '__main__':
    unittest.main()
