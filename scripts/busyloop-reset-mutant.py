"""A2.2 copy-only reset projection must survive the reader boundary."""
import pathlib,subprocess,sys
p=pathlib.Path('server/drivers/flux-busyloop-readers.ts');original=p.read_bytes()
old="[u.resets_at, e.resets_at, p.resets_at]"
assert old in original.decode()
try:
 p.write_text(original.decode().replace(old,"[undefined, e.resets_at, p.resets_at]",1))
 with open('evidence/busyloop-a21/mutants/drop_resets_at.log','w') as log:
  rc=subprocess.run(['node_modules/.bin/vitest','run','server/busyloop-parity.test.ts'],stdout=log,stderr=subprocess.STDOUT).returncode
finally:p.write_bytes(original)
text=pathlib.Path('evidence/busyloop-a21/mutants/drop_resets_at.log').read_text()
killed=rc!=0 and 'AssertionError' in text
print('drop_resets_at', 'KILLED (RED)' if killed else 'SURVIVED/INVALID')
sys.exit(0 if killed else 1)
