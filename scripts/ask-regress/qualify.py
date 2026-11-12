"""Focused checks and typecheck on one immutable, owned source snapshot."""
import json, os, pathlib, subprocess, sys, tarfile, time
work=pathlib.Path('/work');root=pathlib.Path('/tmp/ask-qualified-source');root.mkdir()
with tarfile.open(work/'evidence/ask-regress/raw/head.tar.gz')as archive:
 archive.extractall(root);source_commit=archive.pax_headers.get('comment')
config=root.parent/'ask-qualified-gitconfig';config.write_text('')
env={**os.environ,'GIT_CONFIG_GLOBAL':str(config),'GIT_CONFIG_SYSTEM':str(config)}
for args in [['init'],['add','-f','.'],['-c','user.name=ci','-c','user.email=fixture@example.test','commit','-qm','Exact qualification source']]:
 subprocess.run(['git',*args],cwd=root,env=env,check=True,stdout=subprocess.DEVNULL)
os.symlink('/work/node_modules',root/'node_modules')
phase=sys.argv[1] if len(sys.argv)>1 else 'qualified'
out=work/'evidence/ask-regress/raw'/phase;out.mkdir(parents=True,exist_ok=True)
(out/'source.json').write_text(json.dumps({'sourceCommit':source_commit})+'\n')
env['ASKCARDS_EVIDENCE_DIR']=str(out)
commands=[
 ('typecheck',['pnpm','typecheck']),
 ('test-tiers',['node','scripts/ci-test-tiers.mjs','check']),
 ('focused',['node','node_modules/vitest/vitest.mjs','run','server/askcards-budget-api.test.ts','server/decision/boot-wiring.test.ts','server/decision/engine-action.test.ts','server/decision/contract.test.ts','server/no-limits-wipe-cover.test.ts','server/no-limits-wipe-git.test.ts','server/no-limits-wipe-r3.test.ts','server/no-limits-wipe-scripts.test.ts','server/no-limits-wipe-mcp.test.ts','--maxWorkers=1','--reporter=json','--outputFile='+str(out/'focused.json')]),
]
records=[]
for name,command in commands:
 start=time.time()
 with (out/(name+'.log')).open('w')as log:result=subprocess.run(command,cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT)
 record={'check':name,'command':command,'exit':result.returncode,'seconds':time.time()-start};records.append(record)
 (out/'checks.json').write_text(json.dumps(records,indent=2)+'\n');print(json.dumps(record),flush=True)
sys.exit(0 if all(row['exit']==0 for row in records)else 1)
