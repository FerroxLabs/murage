"""B8 guard removal must let an automatic resend through and fail the TSV loop."""
import pathlib,subprocess,sys
p=pathlib.Path('server/limit-continuation.ts'); original=p.read_bytes()
old='assertCanSubmit(threadId: string): void {'
assert old in original.decode()
try:
 p.write_text(original.decode().replace(old,old+' return;',1))
 with open('evidence/busyloop-a21/mutants/drop_b8.log','w') as log:
  rc=subprocess.run(['node_modules/.bin/vitest','run','server/busyloop-parity.test.ts'],stdout=log,stderr=subprocess.STDOUT).returncode
finally:p.write_bytes(original)
text=pathlib.Path('evidence/busyloop-a21/mutants/drop_b8.log').read_text()
killed=rc!=0 and 'AssertionError' in text
print('drop_b8', 'KILLED (RED)' if killed else 'SURVIVED/INVALID')
sys.exit(0 if killed else 1)
