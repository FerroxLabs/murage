"""Qualify the merged source and kill both dry-run classifier mutations."""
import hashlib,json,os,pathlib,subprocess,sys,tarfile,time
work=pathlib.Path('/work');root=pathlib.Path('/tmp/ask-final-merge-source');root.mkdir()
with tarfile.open(work/'evidence/ask-regress/raw/head.tar.gz')as archive:
 archive.extractall(root);source=archive.pax_headers.get('comment')
os.symlink('/work/node_modules',root/'node_modules')
out=work/'evidence/ask-regress/raw/final-neighbours';out.mkdir(parents=True,exist_ok=True)
records=[]
def run(name,command):
 start=time.time()
 with (out/(name+'.log')).open('w')as log:rc=subprocess.run(command,cwd=root,stdout=log,stderr=subprocess.STDOUT).returncode
 row={'sourceCommit':source,'check':name,'exit':rc,'seconds':time.time()-start};records.append(row)
 (out/'results.json').write_text(json.dumps(records,indent=2)+'\n');print(json.dumps(row),flush=True)
 return rc
if run('typecheck',['pnpm','typecheck']):sys.exit(1)
files=['server/decision/contract.test.ts','server/no-limits-wipe-cover.test.ts','server/no-limits-wipe-git.test.ts','server/no-limits-wipe-r3.test.ts','server/no-limits-wipe-scripts.test.ts','server/no-limits-wipe-mcp.test.ts','src/components/PermissionModeMenu.test.ts','src/locales/nolimits-v1-copy.test.ts','server/drivers/antigravity-auto.test.ts']
def vitest(name,selected):return ['node','node_modules/vitest/vitest.mjs','run',*selected,'--maxWorkers=1','--reporter=json','--outputFile='+str(out/(name+'.json'))]
if run('green',vitest('green',files)):sys.exit(1)
p=root/'server/no-limits-wipe.ts';original=p.read_text();digest=hashlib.sha256(p.read_bytes()).hexdigest()
mutants=[('dry-run-fallback-reverted','&&!dryRun','',2),('option-value-hides-wipe','repository=false,dryRun=false','repository=false,dryRun=rest.includes("--dry-run")||rest.includes("-n")',3)]
try:
 for name,before,after,expected in mutants:
  assert original.count(before)==1
  p.write_text(original.replace(before,after,1))
  rc=run(name,vitest(name,['server/no-limits-wipe-cover.test.ts']))
  report=json.loads((out/(name+'.json')).read_text())
  failures=[t for s in report['testResults']for t in s['assertionResults']if t['status']=='failed']
  killed=rc==1 and len(failures)==expected and all(any('AssertionError:'in m for m in t['failureMessages'])for t in failures)
  records[-1].update({'killed':killed,'failedIDs':[t['fullName']for t in failures]})
  (out/'results.json').write_text(json.dumps(records,indent=2)+'\n')
  if not killed:sys.exit(1)
finally:
 p.write_text(original)
 restored=hashlib.sha256(p.read_bytes()).hexdigest()
 (out/'restoration.json').write_text(json.dumps({'before':digest,'after':restored,'restored':digest==restored})+'\n')
 assert digest==restored
