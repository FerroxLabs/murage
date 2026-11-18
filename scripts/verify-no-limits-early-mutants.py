#!/usr/bin/env python3
"""Isolated correction proof; inert tools only, no corpus inputs or live app."""
import hashlib,json,os,pathlib,shutil,subprocess,sys,tempfile
archive=pathlib.Path(sys.argv[1]).resolve();out=pathlib.Path(sys.argv[2]).resolve();out.mkdir(parents=True,exist_ok=True)
work=pathlib.Path.cwd();root=pathlib.Path(tempfile.mkdtemp(prefix='nolim-early-mutants-'));results=[]
def run(label,files,pattern=None):
 args=['node',str(work/'node_modules/vitest/vitest.mjs'),'run',*files,'--maxWorkers=1','--reporter=json','--outputFile='+str(out/(label+'.json'))]
 if pattern:args+=['--testNamePattern',pattern]
 with (out/(label+'.log')).open('w') as log:
  r=subprocess.run(args,cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=240)
 report=json.loads((out/(label+'.json')).read_text())
 failed=[a['fullName'] for t in report['testResults'] for a in t['assertionResults'] if a['status']=='failed']
 return r.returncode,report,failed
try:
 sealed=root/'source.tar.gz';shutil.copyfile(archive,sealed);archive_digest=hashlib.sha256(sealed.read_bytes()).hexdigest()
 subprocess.run(['tar','-xzf',str(sealed),'--no-same-owner','-C',str(root)],check=True);sealed.unlink()
 (root/'node_modules').symlink_to(work/'node_modules',target_is_directory=True)
 (root/'server/testing/.git-ls-files.fixture').write_bytes((work/'.nolim-evidence/early/qualification-tracked.fixture').read_bytes())
 empty=root/'empty.gitconfig';empty.write_text('');home=root/'home';home.mkdir()
 env={**os.environ,'HOME':str(home),'GIT_CONFIG_GLOBAL':str(empty),'GIT_CONFIG_SYSTEM':str(empty)}
 focused=['server/decision/no-limits-early-denials.test.ts','server/decision/no-limits-feature-off.test.ts','server/no-limits-early-api.test.ts','server/no-limits-early-apps.test.ts','server/no-limits-early-host.test.ts','server/no-limits-early-wipe.test.ts','server/no-limits-early-origins.test.ts','server/highlevel/no-limits-early-denials.test.ts','scripts/nolim-replay/permission-rule-contract.test.mjs']
 rc,r,f=run('green',focused)
 results.append({'id':'green','exit':rc,'tests':r['numTotalTests'],'passed':r['numPassedTests'],'failed':f})
 if rc or f:raise RuntimeError('GREEN_FAILED')
 with (out/'python-green.log').open('w') as log:
  code=subprocess.run(['python3','scripts/nolim-replay/display-cards.test.py'],cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=180).returncode
 import re
 counted=re.search(r'Ran (\d+) tests', (out/'python-green.log').read_text());count=int(counted[1]) if counted else 0
 results.append({'id':'python-green','exit':code,'tests':count})
 if code or count<19:raise RuntimeError('PYTHON_GREEN_FAILED')
 mutants=[
 ('channel-off-execution','server/feature-off.ts',"if(origin==='owner-channel'&&settings.noLimits===true&&settings.fullAccessChannelMessages===false)","if(false)",['server/decision/no-limits-feature-off.test.ts'],'channel messages off'),
 ('highlevel-write-permission','server/highlevel/host.ts','!noLimits && policy.mode === "restricted"','policy.mode === "restricted"',['server/highlevel/no-limits-early-denials.test.ts'],'permission-writes-off'),
 ('disconnected-app-execution','server/highlevel/host.ts','!["connected", "degraded"].includes(connection.state)','false',['server/highlevel/no-limits-early-denials.test.ts'],'EARLY-HL-OFF disconnected'),
 ('explicit-guest-denial','server/no-limits-origin.ts','if (guest) return explicitNoLimits(bot);','if (guest) return false;',['server/no-limits-early-origins.test.ts'],'EARLY-ORIGIN'),
 ('guest-inheritance','server/permission-inheritance.ts','value.permissionExplicit===true','value.fullAccess===true',['server/no-limits-early-origins.test.ts'],'EARLY-ORIGIN'),
 ('stored-rule-refusal','server/decision/implementation.ts',"else outcome={kind:'run'};","else outcome=r.deny.length?{kind:'refuse',message:'Mutant stored denial'}:{kind:'run'};",['server/decision/no-limits-early-denials.test.ts'],'EARLY-DENY'),
 ('feature-off-execution','server/decision/implementation.ts',"const off=isQuestion(r)?undefined:host?.featureOff?.(e.threadId,e.authority.botId,r.action.tool);","const off=undefined;",['server/decision/no-limits-feature-off.test.ts'],'EARLY-OFF'),
 ('feature-off-line','server/decision/implementation.ts','function explainFeatureOff(e:Entry,o:T.Outcome):void {','function explainFeatureOff(e:Entry,o:T.Outcome):void { return;', ['server/decision/no-limits-feature-off.test.ts'],'EARLY-OFF'),
 ('native-feature-off','server/decision/implementation.ts',"if(off){\n  if(e)explainFeatureOff(e,{kind:'refuse',message:off});","if(false){\n  if(e)explainFeatureOff(e,{kind:'refuse',message:off});",['server/decision/no-limits-feature-off.test.ts'],'cached native'),
 ('app-rule-refusal','server/bot-access.ts','if(highlevel.noLimits===true)return;','if(false)return;',['server/no-limits-early-apps.test.ts'],'EARLY-APP'),
 ('host-rule-suppression','server/host-computer-consent.ts',' && !noLimitsAppliesTo(origin,bot)','',['server/no-limits-early-host.test.ts'],'EARLY-HOST'),
 ('highlevel-rule-review','server/highlevel/host.ts','if (serviceNoLimits(claim.generation, claim.threadId, claim.botId)) return false;','if (false) return false;',['server/highlevel/no-limits-early-denials.test.ts'],'EARLY-HL-DENY'),
 ('marked-thread-denial','server/index.ts',"readTurnPolicy({threadId:event.threadId,generation:turnGenerationFor(event.threadId)??''})?.permission.noLimits === true ? undefined : highlevelEngineRequest(event,",'highlevelEngineRequest(event,',['server/no-limits-early-api.test.ts'],'ordinary'),
 ('replay-stored-card','scripts/nolim-replay/release-check.mjs',"const count = label.kind === 'wipe' && !featureOff ? 1 : 0;","const count = ['wipe','deny'].includes(label.kind) && !featureOff ? 1 : 0;",['scripts/nolim-replay/permission-rule-contract.test.mjs'],'stored permission'),
 ('replay-feature-runs','scripts/nolim-replay/release-check.mjs','if (got.ran !== false || got.explanationLines !== 1','if (false || got.explanationLines !== 1',['scripts/nolim-replay/permission-rule-contract.test.mjs'],'feature off'),
 ]
 for label,file,before,after,tests,pattern in mutants:
  path=root/file;original=path.read_bytes();s=original.decode()
  if before not in s:raise RuntimeError('MUTANT_ANCHOR_'+label)
  try:
   path.write_text(s.replace(before,after));rc,r,failed=run(label,tests,pattern)
   killed=rc!=0 and bool(failed) and all('EARLY' in name or label.startswith('replay-') or label=='native-feature-off' for name in failed)
   results.append({'id':label,'sourceHash':hashlib.sha256(original).hexdigest(),'exit':rc,'killed':killed,'failedTestIds':failed})
   if not killed:raise RuntimeError('SURVIVED_'+label)
  finally:path.write_bytes(original)
 path=root/'scripts/nolim-replay/replay-display.py';original=path.read_bytes()
 try:
  path.write_text(original.decode().replace("if kind!='wipe-list'","if kind not in ('wipe-list','deny-rule')"))
  with (out/'display-stored-denial.log').open('w') as log:
   code=subprocess.run(['python3','scripts/nolim-replay/display-cards.test.py'],cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=180).returncode
  output=(out/'display-stored-denial.log').read_text();killed=code!=0 and 'AssertionError' in output and 'test_owner_holds_need_exception_evidence_and_complete_input' in output
  results.append({'id':'display-stored-denial','exit':code,'killed':killed,'sourceHash':hashlib.sha256(original).hexdigest()})
  if not killed:raise RuntimeError('SURVIVED_display-stored-denial')
 finally:path.write_bytes(original)

finally:
 (out/'summary.json').write_text(json.dumps({'archiveSha256':archive_digest,'results':results},indent=2)+'\n')
 assert root.parent==pathlib.Path('/tmp') and root.name.startswith('nolim-early-mutants-');shutil.rmtree(root)
print(json.dumps({'green':True,'killed':sum(r.get('killed',False) for r in results)}))
