#!/usr/bin/env python3
"""Run executable regression mutants in a disposable server copy."""
from pathlib import Path
import shutil, subprocess, json, sys
root=Path.cwd();tree=root/'evidence/bld-fts-amend/legacy-mutant-tree';dest=root/'evidence/bld-fts-amend/legacy-mutants'
if tree.exists():raise RuntimeError('mutant tree already exists')
tree.mkdir(parents=True);dest.mkdir(parents=True,exist_ok=True)
try:
 for item in root.iterdir():
  if item.name in ['.git','.fts-r3-evidence','evidence','server']:continue
  (tree/item.name).symlink_to(item,target_is_directory=item.is_dir())
 shutil.copytree(root/'server',tree/'server')
 selected=sys.argv[1:] or ['R1reuse','R1admission','R1cap','R1ready','R2worker','R2main','R3reader','R3prune','R4credit','R5scan','R6ownerwrite','M2','M3','M14','R5aggregate','R6autorestart']
 command=['python3','server/testing/search-index-r3-mutants.py',*selected]
 result=subprocess.run(command,cwd=tree,timeout=900)
 for item in (tree/'.fts-r3-evidence/mutants').iterdir():shutil.copyfile(item,dest/item.name)
 rows=json.loads((dest/'results.json').read_text());assert len(rows)==len(selected)
 for row in rows:row['log']=str((dest/(row['id']+'.log')).relative_to(root))
 (dest/'results.json').write_text(json.dumps(rows,indent=2)+'\n')
 if result.returncode:raise SystemExit(result.returncode)
 print('ALL '+str(len(rows))+' MUTANTS KILLED BY ASSERTIONS',flush=True)
finally:shutil.rmtree(tree)
