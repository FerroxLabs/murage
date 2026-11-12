"""Mutate temporary product snapshots; require assertion failures in the API probe."""
import json, os, pathlib, shutil, subprocess, sys, tarfile, time
phase=sys.argv[1] if len(sys.argv)>1 else 'mutants'
work=pathlib.Path('/work');out=work/'evidence/ask-regress/raw'/phase;out.mkdir(parents=True,exist_ok=True)
install='installEngineApprovalBuilder(decisionEngineApproval);'
base='function baseEngineVerdict(registration: Readonly<Registration>): AutoVerdict {'
mutations=[
 ('missing-builder','claude ask:', 'server/index.ts',install,'// mutant: no production builder'),
 ('builder-before-host-reset','claude ask:', 'server/index.ts', 'installDecisionHost({ store, view: decisionEngineView,', install+'\ninstallDecisionHost({ store, view: decisionEngineView,'),
 ('ask-runs-silently','claude ask:', 'server/index.ts',base,base+"\n  if(registration.level === 'ask') return {approve:'mutant',source:'auto-mode'};"),
 ('full-cards','claude full:', 'server/index.ts',base,base+"\n  if(registration.level === 'full') return {approve:null,source:'no-grant'};"),
 ('unlimited-cards','claude unlimited: all ten', 'server/decision/implementation.ts',"if(e.fault==='identity'&&!owner(e))", "if(r.level==='unlimited')outcome=approval(e,'base',[]);\n else if(e.fault==='identity'&&!owner(e))"),
]
# Typecheck the same unchanged archive that supplies every mutation.
original=pathlib.Path('/tmp/ask-mutant-original');original.mkdir()
with tarfile.open(work/'evidence/ask-regress/raw/head.tar.gz')as archive:
 archive.extractall(original);original_commit=archive.pax_headers.get('comment')
os.symlink('/work/node_modules',original/'node_modules')
start=time.time()
with (out/'source-typecheck.log').open('w')as log:
 checked=subprocess.run(['pnpm','typecheck'],cwd=original,stdout=log,stderr=subprocess.STDOUT)
(out/'source-typecheck.json').write_text(json.dumps({'sourceCommit':original_commit,'exit':checked.returncode,'seconds':time.time()-start})+'\n')
if checked.returncode:sys.exit(checked.returncode)
records=[]
for name,pattern,file,before,after in mutations:
 root=pathlib.Path('/tmp')/('ask-mutant-'+name);root.mkdir()
 with tarfile.open(work/'evidence/ask-regress/raw/head.tar.gz')as archive:
  archive.extractall(root);source_commit=archive.pax_headers.get('comment')
 p=root/file;s=p.read_text();assert s.count(before)==1,(name,s.count(before));s=s.replace(before,after)
 if name=='builder-before-host-reset':
  # There must only be the premature installation; the host clears it.
  pos=s.rindex(install);s=s[:pos]+s[pos:].replace(install,'// mutant: builder already installed before reset',1)
 p.write_text(s);(out/(name+'.source-diff.txt')).write_text('file: '+file+'\nbefore: '+before+'\nafter: '+after+'\n')
 os.symlink('/work/node_modules',root/'node_modules')
 env={**os.environ,'ASKCARDS_EVIDENCE_DIR':str(out/name)}
 report=out/(name+'.json');start=time.time()
 with (out/(name+'.log')).open('w')as log:
  result=subprocess.run(['node','node_modules/vitest/vitest.mjs','run','server/askcards-budget-api.test.ts','-t',pattern,'--maxWorkers=1','--reporter=json','--outputFile='+str(report)],cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT)
 data=json.loads(report.read_text()) if report.exists()else{}
 failures=[test for suite in data.get('testResults',[])for test in suite['assertionResults']if test['status']=='failed']
 killed=result.returncode==1 and len(failures)==1 and any('AssertionError:' in message for message in failures[0]['failureMessages']) and not any('timed out' in message.lower()for message in failures[0]['failureMessages'])
 record={'sourceCommit':source_commit,'mutant':name,'exit':result.returncode,'killed':killed,'seconds':time.time()-start,'failedIDs':[test['fullName'] for test in failures]};records.append(record)
 (out/'results.json').write_text(json.dumps(records,indent=2)+'\n')
 print(json.dumps(record),flush=True)
 if not killed:sys.exit(1)
