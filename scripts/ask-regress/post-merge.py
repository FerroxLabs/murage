"""Check the latest copy/relay witnesses and execute the pending wipe mutants."""
import hashlib,json,os,pathlib,subprocess,sys,tarfile,time
work=pathlib.Path('/work');root=pathlib.Path('/tmp/ask-post-merge-source');root.mkdir()
with tarfile.open(work/'evidence/ask-regress/raw/head.tar.gz')as archive:
 archive.extractall(root);source=archive.pax_headers.get('comment')
os.symlink('/work/node_modules',root/'node_modules')
out=work/'evidence/ask-regress/raw/post-merge';out.mkdir(parents=True,exist_ok=True);rows=[]
def run(name,files,pattern=None):
 args=['node','node_modules/vitest/vitest.mjs','run',*files,'--maxWorkers=1','--reporter=json','--outputFile='+str(out/(name+'.json'))]
 if pattern:args+=['-t',pattern]
 start=time.time()
 with (out/(name+'.log')).open('w')as log:rc=subprocess.run(args,cwd=root,stdout=log,stderr=subprocess.STDOUT).returncode
 row={'sourceCommit':source,'check':name,'exit':rc,'seconds':time.time()-start};rows.append(row);(out/'results.json').write_text(json.dumps(rows,indent=2)+'\n');print(json.dumps(row),flush=True)
 return rc
if run('ui',['src/components/PermissionModeMenu.test.ts','src/locales/nolimits-v1-copy.test.ts']):sys.exit(1)
if run('relay',['server/drivers/antigravity-auto.test.ts'],'N1 No limits runs after'):sys.exit(1)
if run('wipe-green',['server/no-limits-wipe-cover.test.ts']):sys.exit(1)
p=root/'server/no-limits-wipe.ts';original=p.read_text();digest=hashlib.sha256(p.read_bytes()).hexdigest()
variants=[('dry-run-fallback-reverted','&&!dryRun','',2),('option-value-hides-wipe','repository=false,dryRun=false','repository=false,dryRun=rest.includes("--dry-run")||rest.includes("-n")',3)]
try:
 for name,before,after,count in variants:
  assert original.count(before)==1;p.write_text(original.replace(before,after,1))
  rc=run(name,['server/no-limits-wipe-cover.test.ts'])
  data=json.loads((out/(name+'.json')).read_text());failures=[t for s in data['testResults']for t in s['assertionResults']if t['status']=='failed']
  killed=rc==1 and len(failures)==count and all(any('AssertionError:'in message for message in t['failureMessages'])for t in failures)
  rows[-1].update({'killed':killed,'failedIDs':[t['fullName']for t in failures]});(out/'results.json').write_text(json.dumps(rows,indent=2)+'\n')
  if not killed:sys.exit(1)
finally:
 p.write_text(original);restored=hashlib.sha256(p.read_bytes()).hexdigest();(out/'restoration.json').write_text(json.dumps({'before':digest,'after':restored,'restored':digest==restored})+'\n');assert digest==restored
