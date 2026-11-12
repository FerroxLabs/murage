"""Behavioral RED on the pinned baseline readers, restoring the implementation afterward."""
import pathlib, tarfile, subprocess, sys
root=pathlib.Path(__file__).resolve().parent.parent
original={}
try:
 with tarfile.open(root/'evidence/busyloop-a21/baseline-production.tar.gz') as tar:
  for m in tar.getmembers():
   p=root/m.name; original[p]=p.read_bytes(); p.write_bytes(tar.extractfile(m).read())
 with (root/'evidence/busyloop-a21/red-transport-corrected.log').open('w') as log:
  rc=subprocess.run(['node_modules/.bin/vitest','run','server/drivers/busyloop-transport.test.ts'],cwd=root,stdout=log,stderr=subprocess.STDOUT).returncode
finally:
 for p,b in original.items():p.write_bytes(b)
text=(root/'evidence/busyloop-a21/red-transport-corrected.log').read_text()
print('Baseline transport RED:',rc,'assertions:',text.count('AssertionError'))
sys.exit(0 if rc and '126 failed' in text and 'AssertionError' in text else 1)
