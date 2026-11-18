#!/usr/bin/env python3
"""Protocol REDs use the reviewed worker with precisely the named fix reverted.
The checked-in test overlay and raw source diffs are retained with each result.
Run inside the lane's network-none container. Setup never carries oracle tags.
"""
from pathlib import Path
import difflib,json,shutil,subprocess,tarfile
root=Path.cwd();out=root/'evidence/bld-fts-amend/afix/reviewed';tree=out/'tree'
out.mkdir(parents=True,exist_ok=True)
if tree.exists():raise RuntimeError('refusing existing reviewed fixture')
tree.mkdir()
worker='server/search-index-worker.ts';core='server/search-index-r3.test.ts'
rebuild="    if (batch.more) put('built',batch.rows.at(-1).rowid); else del('built');"
# Every mutation undoes the named safety property; no setup or test assertions change.
cases=[
 ('C14',"rebuild rows and progress roll back",['C14'],[("  write(() => {\n    for (const row of batch.rows) converge(row);",rebuild+"\n  write(() => {\n    for (const row of batch.rows) converge(row);"),(rebuild+"\n    observed(batch.seen);","    observed(batch.seen);")]),
 ('C5prime',"terminating after FTS",['C5',"C5'"],[("  write(() => {\n    for (const item of batch.rows)","  applied(batch.rows.at(-1).intent);\n  write(() => {\n    for (const item of batch.rows)"),("    applied(batch.rows.at(-1).intent); observed(batch.seen);","    observed(batch.seen);")]),
 ('C14prime',"rebuild rows and cursor",["C14'"],[(rebuild,"    setImmediate(() => { if (batch.more) put('built',batch.rows.at(-1).rowid); else del('built'); });")]),
 ('lineage',"pruned lineage|different nonce",['T-IDENTITY-ROLLBACK','C17'],[("    if (!row || String(row.nonce) !== nonce) return false;","    /* reverted retained lineage verification */")]),
 ('rebuild-seen',"a rebuild records",['T-IDENTITY-REBUILD'],[("    observed(batch.seen);\n  });\n  barrier('rebuild-after-commit');","  });\n  barrier('rebuild-after-commit');")]),
 ('scrub-backoff','T-SCRUB-BACKOFF:',['T-SCRUB-BACKOFF'],[]),
]
results=[]
try:
 for item in root.iterdir():
  if item.name in {'.git','server','evidence','.fts-r3-evidence'}:continue
  (tree/item.name).symlink_to(item,target_is_directory=item.is_dir())
 with tarfile.open(root/'evidence/bld-fts-amend/afix/reviewed-source/server.tar') as archive:
  members=archive.getmembers()
  if any(not (member.isfile() or member.isdir()) or Path(member.name).parts[0]!='server' or '..' in Path(member.name).parts for member in members):raise RuntimeError('unexpected archive member')
  archive.extractall(tree,members=members)
 for source in (root/'server').rglob('*'):
  if source.is_file() and (source.name.endswith('.test.ts') or 'testing' in source.relative_to(root/'server').parts):
   target=tree/'server'/source.relative_to(root/'server');target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target)
 originals={}
 for source in (root/'evidence/bld-fts-amend/afix/reviewed-source').glob('*.ts'):
  target=tree/'server'/source.name;target.write_bytes(source.read_bytes());originals['server/'+source.name]=source.read_text()
 (tree/'evidence/bld-fts-amend').mkdir(parents=True)
 for name,pattern,ids,replacements in cases:
  original=originals[worker];changed=original
  for before,after in replacements:
   if before not in changed:raise RuntimeError(name+': missing revert anchor')
   changed=changed.replace(before,after)
  (tree/worker).write_text(changed)
  (out/(name+'.patch')).write_text(''.join(difflib.unified_diff(original.splitlines(True),changed.splitlines(True),fromfile=worker,tofile=worker)))
  command=['node','node_modules/vitest/vitest.mjs','run',core,'-t',pattern,'--maxWorkers=1','--reporter=json','--outputFile='+str(out/(name+'.json'))]
  with(out/(name+'.log')).open('w')as log:
   log.write('COMMAND '+__import__('shlex').join(command)+'\n');log.flush();result=subprocess.run(command,cwd=tree,stdout=log,stderr=subprocess.STDOUT,timeout=120)
  report=json.loads((out/(name+'.json')).read_text());tests=[t for suite in report['testResults'] for t in suite['assertionResults'] if t['status']!='skipped']
  expected=[{'id':id,'file':core,'pattern':pattern if id!='C17' else 'pruned lineage'}for id in ids]
  table=out/(name+'-TABLE.json');table.write_text(json.dumps({'RED':expected,'PRESERVE':[]}))
  classified=subprocess.run(['python3',str(root/'server/testing/red-classify.py'),str(out/(name+'.json')),str(table)],capture_output=True,text=True)
  (out/(name+'-classify.txt')).write_text(classified.stdout+classified.stderr)
  passed=result.returncode!=0 and classified.returncode==0
  results.append({'case':name,'base':'102c9a79f','reverted':name if replacements else 'unamended scrub cadence','ids':ids,'command':command,'RED-BEHAVIOUR':passed})
  (out/'results.json').write_text(json.dumps(results,indent=2)+'\n');print(name,'RED-BEHAVIOUR'if passed else'INVALID',flush=True)
 if not all(row['RED-BEHAVIOUR']for row in results):raise SystemExit(1)
finally:shutil.rmtree(tree)
