"""Tests for build.py (py -m unittest discover tests)."""
import base64
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import build  # noqa: E402


def run_build(root):
    return subprocess.run([sys.executable, str(root / 'build.py')], cwd=root, capture_output=True, text=True)


def copy_tree():
    tmp = Path(tempfile.mkdtemp(prefix='bms-build-'))
    shutil.copy(ROOT / 'build.py', tmp)
    shutil.copy(ROOT / 'schema.json', tmp)
    shutil.copytree(ROOT / 'src', tmp / 'src')
    if (ROOT / 'samples').is_dir():
        shutil.copytree(ROOT / 'samples', tmp / 'samples')
    return tmp


def importmap(html):
    m = re.search(r'<script type="importmap">\n(.*?)\n</script>', html, re.S)
    return json.loads(m.group(1))['imports']


def decode(url):
    return base64.b64decode(url.split(',', 1)[1]).decode('utf-8')


class LexerTests(unittest.TestCase):
    def specs(self, src):
        return [i['spec'] for i in build.find_imports(src, 't.js')]

    def test_forms(self):
        src = """
import a from './a.js';
import { b,
  c as d,
} from "./b.js";
import * as e from './e.js';
import f, { g } from './f.js';
import './side.js';
export { h } from './h.js';
export * from './star.js';
export * as ns from './ns.js';
import S from '../schema.json' with { type: 'json' };
export { local };
export const x = 1;
"""
        self.assertEqual(self.specs(src), ['./a.js', './b.js', './e.js', './f.js', './side.js', './h.js',
                                           './star.js', './ns.js', '../schema.json'])
        json_imp = build.find_imports(src, 't.js')[-1]
        self.assertEqual(json_imp['attr'][2], 'json')

    def test_ignores_strings_comments_regex_templates(self):
        src = r"""
// import x from './no1.js';
/* import y from './no2.js'; */
const s = "import z from './no3.js'";
const t = `import ${ `nested import from './no4.js'` } from './no5.js'`;
const r = /import q from '.\/no6.js'/g;
const o = { import: 1 };
const m = import.meta;
const v = a / b / c;
import real from './real.js';
"""
        self.assertEqual(self.specs(src), ['./real.js'])

    def test_dynamic_import_rejected(self):
        with self.assertRaises(build.BuildError):
            build.find_imports("const m = await import('./x.js');", 't.js')

    def test_every_repo_module_lexes(self):
        for p in sorted((ROOT / 'src').rglob('*.js')):
            build.find_imports(p.read_text(encoding='utf-8'), str(p))


class BuildTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = copy_tree()
        cls.res = run_build(cls.tmp)
        cls.html = (cls.tmp / 'dist' / 'index.html').read_text(encoding='utf-8') if cls.res.returncode == 0 else ''

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_build_succeeds(self):
        self.assertEqual(self.res.returncode, 0, self.res.stderr)

    def test_registry_matches_types(self):
        schema = json.loads((ROOT / 'schema.json').read_text(encoding='utf-8'))
        reg = (self.tmp / 'src' / 'generators' / 'index.js').read_text(encoding='utf-8')
        keys = re.findall(r"^  '([a-z0-9-]+)': \w+,$", reg, re.M)
        self.assertEqual(keys, sorted(schema['x-elementTypes']))
        for k in keys:
            self.assertIn(f"from './{k}.js';", reg)

    def test_output_has_no_relative_imports(self):
        mods = importmap(self.html)
        self.assertIn('@app/src/main.js', mods)
        self.assertIn('@app/schema.json', mods)
        self.assertIn("import '@app/src/main.js';", self.html)
        self.assertNotIn('src="main.js"', self.html)
        self.assertNotIn('styles/base.css"', self.html)
        for name, url in mods.items():
            self.assertTrue(url.startswith('data:text/javascript;base64,'), name)
            code = decode(url)
            for im in build.find_imports(code, name):
                self.assertTrue(im['spec'].startswith('@app/'), f'{name}: {im["spec"]}')
                self.assertIn(im['spec'], mods, f'{name}: {im["spec"]} not in importmap')
                self.assertIsNone(im['attr'])
        self.assertTrue(decode(mods['@app/schema.json']).startswith('export default {'))

    def test_css_order(self):
        style = re.search(r'<style>(.*?)</style>', self.html, re.S).group(1)
        self.assertTrue(style.lstrip().startswith('/* src/styles/base.css */'))

    def test_deterministic(self):
        first = self.html
        res = run_build(self.tmp)
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual((self.tmp / 'dist' / 'index.html').read_text(encoding='utf-8'), first)


class FailureTests(unittest.TestCase):
    def setUp(self):
        self.tmp = copy_tree()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def append_main(self, line):
        main = self.tmp / 'src' / 'main.js'
        main.write_text(line + '\n' + main.read_text(encoding='utf-8'), encoding='utf-8')

    def assertFails(self, needle):
        res = run_build(self.tmp)
        self.assertNotEqual(res.returncode, 0)
        self.assertIn(needle, res.stderr)
        self.assertFalse((self.tmp / 'dist' / 'index.html').exists())

    def test_missing_module(self):
        self.append_main("import { nope } from './does-not-exist.js';")
        self.assertFails('module not found')

    def test_wrong_case(self):
        self.append_main("import { checkScene as c2 } from './Schema.js';")
        self.assertFails('module not found')

    def test_bare_specifier(self):
        self.append_main("import x from 'lodash';")
        self.assertFails('not a relative path')

    def test_json_without_attribute(self):
        self.append_main("import S2 from '../schema.json';")
        self.assertFails("type: 'json'")

    def test_generator_without_schema_type(self):
        (self.tmp / 'src' / 'generators' / 'gizmo.js').write_text(
            "export default { type: 'gizmo', render() { return null; } };\n", encoding='utf-8')
        self.assertFails('gizmo')

    def test_generator_type_mismatch(self):
        p = self.tmp / 'src' / 'generators' / 'crate.js'
        p.write_text(re.sub(r"type: 'crate'", "type: 'box'", p.read_text(encoding='utf-8')), encoding='utf-8')
        self.assertFails("declares type 'box'")

    def test_missing_generator(self):
        (self.tmp / 'src' / 'generators' / 'crate.js').unlink()
        self.assertFails("'crate'")


if __name__ == '__main__':
    unittest.main()
