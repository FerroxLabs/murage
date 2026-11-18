import importlib.util
import pathlib
import tempfile
import unittest
import zipfile
spec = importlib.util.spec_from_file_location('layout', pathlib.Path(__file__).with_name('signal-jar-layout.py'))
layout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(layout)
class NativeStripping(unittest.TestCase):
    def test_deterministic_metadata_and_no_nested_native(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            for n in [1, 2]:
                with zipfile.ZipFile(root / f'{n}.jar', 'w') as z:
                    for name in (['B.class', 'lib.so', 'A.class'] if n == 1 else ['A.class', 'lib.so', 'B.class']):
                        info = zipfile.ZipInfo(name, (2020 + n, 1, 1, 0, 0, 0))
                        info.comment = b'different' * n
                        z.writestr(info, name)
                p = layout.rewrite(root / f'{n}.jar', root / f'{n}.out', strip=True)
                self.assertEqual(p['removed'], ['lib.so'])
            self.assertEqual((root / '1.out').read_bytes(), (root / '2.out').read_bytes())
            with zipfile.ZipFile(root / '1.out') as z:
                self.assertEqual(z.namelist(), ['A.class', 'B.class'])
                for i in z.infolist():
                    self.assertEqual(i.date_time, (1980,1,1,0,0,0))
                    self.assertEqual(i.extra, b'')
    def test_signed_and_unlisted_native_fail(self):
        with tempfile.TemporaryDirectory() as d:
            a, b = pathlib.Path(d)/'a.jar', pathlib.Path(d)/'b.jar'
            with zipfile.ZipFile(a, 'w') as z:
                z.writestr('native.dll', b'code')
                z.writestr('META-INF/A.SF', b'signature')
            with self.assertRaisesRegex(ValueError, 'signed'): layout.rewrite(a,b,strip=True)
            with self.assertRaisesRegex(ValueError, 'Unlisted'): layout.rewrite(a,b)
if __name__ == '__main__': unittest.main()
