"""Python port of schema.js / patch.js must give the same verdicts as the JS (CONTRACT 3, 7)."""
import json
import os
import shutil
import subprocess
import sys
import time
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

    def test_depth_cap(self):
        s = server.check_scene(sample('riverside-ruin'))['scene']
        deep = 1
        for _ in range(64):
            deep = [deep]
        with self.assertRaises(server.PatchError):
            server.apply_patch(s, [{'op': 'add', 'path': '/objects/campfire/params/x', 'value': [deep]}])
        server.apply_patch(s, [{'op': 'add', 'path': '/objects/campfire/params/x', 'value': deep}])  # exactly 64 is fine
        nested = mutate(s, ['objects', 0, 'params', 'x'], deep)  # scene depth > 64
        self.assertFalse(server.check_scene(nested)['ok'])

    def test_proto_and_inherited_names(self):
        s = server.check_scene(sample('riverside-ruin'))['scene']
        for path in ('/objects/campfire/params/__proto__', '/meta/__proto__', '/__proto__'):
            with self.assertRaises(server.PatchError):
                server.apply_patch(s, [{'op': 'add', 'path': path, 'value': {'x': 1}}])
        for path in ('/objects/campfire/params/constructor', '/meta/toString'):
            with self.assertRaises(server.PatchError):
                server.apply_patch(s, [{'op': 'replace', 'path': path, 'value': 1}])

    def test_touched_ids_conservative(self):
        s = server.check_scene(sample('forest-road-ambush'))['scene']
        everything = {o['id'] for o in s['objects']}
        self.assertEqual(set(server.touched_ids(s, [{'op': 'replace', 'path': '/objects', 'value': []}])), everything)
        self.assertEqual(set(server.touched_ids(s, [{'op': 'remove', 'path': '/constraints/c-wagons'}])), {'wagon-wreck', 'wagon-rear'})
        self.assertEqual(set(server.touched_ids(s, [{'op': 'replace', 'path': '/constraints/c-wagons/b', 'value': 'tree-1'}])),
                         {'wagon-wreck', 'wagon-rear', 'tree-1'})
        self.assertEqual(set(server.touched_ids(s, [{'op': 'add', 'path': '/constraints/-', 'value': {'a': 'tree-2', 'b': 'tree-3'}}])),
                         {'tree-2', 'tree-3'})

    def test_label_font_list_is_not_repeated(self):
        s = sample('riverside-ruin')
        s['labels'][0]['params'] = {'text': 'x' * 100000, 'fontFt': [1] * 1000}
        t = time.time()
        self.assertFalse(server.check_scene(s)['ok'])
        self.assertLess(time.time() - t, 1)
        s['labels'][0]['params'] = {'text': 'abc', 'fontFt': 'abc'}
        self.assertFalse(server.check_scene(s)['ok'])
        p = sample('riverside-ruin')
        p['paths'][0]['params']['points'] = [['ab', 'cd'], ['ef', 'gh']]
        self.assertFalse(server.check_scene(p)['ok'])

    def test_patch_parity_with_js(self):
        node = shutil.which('node')
        if not node:
            self.skipTest('node not installed')
        import random
        rng = random.Random(7)
        base = server.check_scene(sample('forest-road-ambush'))['scene']
        values = [None, 0, -0.0, 1.5, True, '', 'x', [], {}, [1, 2], {'x': 1, 'y': 2}, {'a': 'tree-1', 'b': 'tree-2'},
                  base['objects'][0], {'id': 'new-1', 'type': 'crate'}, [base['objects'][1]], '__proto__', '\U0001F600' * 30]
        paths = ['/objects/tree-1/position', '/objects/tree-1/params/constructor', '/objects/tree-1/params/__proto__',
                 '/meta/toString', '/objects', '/objects/-', '/objects/new-x', '/objects/0', '/constraints', '/constraints/-',
                 '/constraints/c-wagons', '/constraints/c-wagons/ft', '/constraints/c-wagons/a', '/constraints/c-wagons/b',
                 '/paths/road/params/points/0', '/paths/road/params/points/-', '/paths/road/params/points/01', '', '/',
                 '/x', '/objects/tree~01', '/objects/wagon-wreck', '/labels', '/regions/mud-patch', '/terrain/base', None, 5]
        cases = []
        for _ in range(400):
            ops = []
            for _ in range(rng.choice([1, 1, 2, 3])):
                o = {'op': rng.choice(['add', 'remove', 'replace', 'move', None]), 'path': rng.choice(paths)}
                if rng.random() < 0.85:
                    o['value'] = rng.choice(values)
                ops.append(o)
            cases.append(ops)
        cases.append(['not an op', None])
        js = ("import {applyPatch, touchedIds} from './src/core/patch.js'; let s='';process.stdin.on('data',d=>s+=d);"
              "process.stdin.on('end',()=>{const {base, cases}=JSON.parse(s);console.log(JSON.stringify(cases.map(ops=>{"
              "const t=[...touchedIds(base, ops)].sort(); try { return {ok:true, doc:applyPatch(base, ops), t}; }"
              " catch (e) { return {ok:false, t}; }})))});")
        res = subprocess.run([node, '--input-type=module', '-e', js], cwd=ROOT, capture_output=True, text=True,
                             input=json.dumps({'base': base, 'cases': cases}), check=True, encoding='utf-8')
        out = json.loads(res.stdout)
        for ops, j in zip(cases, out):
            with self.subTest(ops=json.dumps(ops)[:200]):
                self.assertEqual(sorted(server.touched_ids(base, ops)), j['t'])
                try:
                    doc = server.apply_patch(base, ops)
                except server.PatchError:
                    self.assertFalse(j['ok'])
                    continue
                self.assertTrue(j['ok'])
                self.assertEqual(json.loads(json.dumps(doc)), j['doc'])


if __name__ == '__main__':
    unittest.main()
