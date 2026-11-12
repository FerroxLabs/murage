#!/usr/bin/env python3
"""Isolate historical REDs; never replace the active checkout's production files."""
from pathlib import Path
import shutil, subprocess, sys
root=Path.cwd(); out=root/'.fts-r3-evidence/review';tree=out/'historical-tree'
if tree.exists(): raise RuntimeError('historical tree already exists')
tree.mkdir()
try:
 for item in root.iterdir():
  if item.name in ['.git','.fts-r3-evidence','server']:continue
  (tree/item.name).symlink_to(item,target_is_directory=item.is_dir())
 shutil.copytree(root/'server',tree/'server')
 mode=sys.argv[1]
 if mode=='warm':
  for item in (out/'original').glob('*.ts'):(tree/'server'/item.name).write_bytes(item.read_bytes())
  test='server/memory/roster-scoped-revokes.test.ts';pattern='R6-BEHAVIORAL'
 elif mode=='recovery':
  for name in ['message-search-index.ts','search-index-worker.ts']:
   (tree/'server'/name).write_bytes((out/'base'/name).read_bytes())
  test='server/search-index-review-recovery.test.ts';pattern='R1|R2|R3'
 else:
  (tree/'server/wal-maintenance.ts').write_bytes((out/'base/wal-maintenance.ts').read_bytes())
  test='server/wal-review-credit.test.ts';pattern='R4:'
 command=['node','node_modules/vitest/vitest.mjs','run',test,'-t',pattern,'--maxWorkers=1']
 log=out/('red-'+mode+'.log')
 with log.open('w') as stream:
  stream.write('COMMAND '+repr(command)+'\n');stream.flush()
  result=subprocess.run(command,cwd=tree,stdout=stream,stderr=subprocess.STDOUT,timeout=180)
 text=log.read_text()
 if result.returncode==0 or 'AssertionError' not in text or 'not a function' in text or 'no such table' in text:raise RuntimeError('RED did not reach its behavioral assertion: '+str(log))
 print('ASSERTION RED',mode,flush=True)
finally:shutil.rmtree(tree)
