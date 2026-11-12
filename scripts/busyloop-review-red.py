"""Replay review workflow and site inventory on the verified baseline; restore in finally."""
import json,pathlib,subprocess
root=pathlib.Path(__file__).resolve().parent.parent
out=root/'evidence/cfix-busyA22'; baseline=out/'baseline'
paths=json.loads((baseline/'paths.json').read_text())
original={p:(root/p).read_bytes() for p in paths}
try:
 for i,p in enumerate(paths): (root/p).write_bytes((baseline/str(i)).read_bytes())
 with (out/'red-sites.json').open('w') as f:
  sites=subprocess.run(['node','scripts/busyloop-sites.mjs'],cwd=root,stdout=f,stderr=subprocess.STDOUT)
 assert sites.returncode==1
 with (out/'red-room.log').open('w') as f:
  room=subprocess.run(['node_modules/.bin/vitest','run','server/busyloop-room-goal.test.ts'],cwd=root,stdout=f,stderr=subprocess.STDOUT)
 assert room.returncode!=0 and 'AssertionError' in (out/'red-room.log').read_text()
 print('Baseline room-goal RED; baseline site inventory RED')
finally:
 for p,data in original.items(): (root/p).write_bytes(data)
