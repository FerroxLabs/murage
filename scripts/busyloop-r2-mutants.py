"""MAIN R1/R2 plus all retained mutants, in a disposable offline source tree."""
import json, os, pathlib, shutil, subprocess, tempfile
root=pathlib.Path(__file__).resolve().parent.parent
out=root/'evidence/cfix2-busyA22'; out.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix='busyloop-r2-mutants-') as temp:
 work=pathlib.Path(temp)/'work'
 shutil.copytree(root,work,ignore=shutil.ignore_patterns('.git','node_modules','evidence','__pycache__','dist','dist-server','build','.ijfw','.planning','test-results'),symlinks=True)
 (work/'node_modules').symlink_to(root/'node_modules',target_is_directory=True)
 logs=work/'evidence/cfix2-busyA22/mutants';logs.mkdir(parents=True)
 results=[]
 # A mutant is meaningful only against a green control on the same source.
 with (out/'mutant-control.log').open('w') as stream:
  control=subprocess.run(['node_modules/.bin/vitest','run','server/drivers/busyloop-sites.test.ts','server/drivers/busyloop-review.test.ts','-t','every driver response site|R1 bare 429'],cwd=work,stdout=stream,stderr=subprocess.STDOUT).returncode
 assert control==0,'mutation control must be GREEN'
 def check(name,file,transform,tests):
  path=work/file;original=path.read_bytes();changed=transform(original.decode());assert changed!=original.decode(),name
  try:
   path.write_text(changed)
   log=logs/(name+'.log')
   with log.open('w') as stream:
    rc=subprocess.run(['node_modules/.bin/vitest','run',*tests],cwd=work,stdout=stream,stderr=subprocess.STDOUT).returncode
   killed=rc!=0 and 'AssertionError' in log.read_text()
   results.append([name,'KILLED (RED)' if killed else 'SURVIVED/INVALID']);print(*results[-1],flush=True)
  finally:
   path.write_bytes(original);assert path.read_bytes()==original
 for driver in ['codex','claude','openai-chat','http-text-only','headless-text-only','acp/core']:
  check('r1-bypass-'+driver.replace('/','-'),'server/drivers/'+driver+'.ts',
   lambda s:'const bypassFluxRoute = (requestUrl: any) => ({requestUrl, routed:false});\n'+s.replace('fluxRouteFor(', 'bypassFluxRoute('),
   ['server/drivers/busyloop-sites.test.ts','-t','every driver response site'])
 check('r2-delete-marker','server/drivers/openai-chat.ts',lambda s:s.replace('registerBusyloopPayloadSite("classify",','unmarkedPayload("classify",',1),['server/drivers/busyloop-sites.test.ts','-t','every driver response site'])
 check('r2-add-unmarked-payload','server/drivers/openai-chat.ts',lambda s:s+'\nfunction addedPayload(line: string) { return JSON.parse(line).error; }\n',['server/drivers/busyloop-sites.test.ts','-t','every driver response site'])
 check('r1-drop-flux-scope','shared/flux-route.ts',lambda s:s.replace('return { requestUrl, routed };','return { requestUrl, routed: true };'),['server/drivers/busyloop-review.test.ts','-t','R1 bare 429'])
 (logs/'results.json').write_text(json.dumps(results,indent=2)+'\n')
 checks=[]
 for script in ([] if os.environ.get('BUSYLOOP_R2_SKIP_RETAINED') else ['busyloop-review-mutants.py','busyloop-mutants.py','busyloop-reset-mutant.py','busyloop-guard-mutant.py']):
  checks.append(subprocess.run(['python3','scripts/'+script],cwd=work,env=dict(os.environ,PYTHONDONTWRITEBYTECODE='1')).returncode)
 for src,dest in [('evidence/cfix2-busyA22/mutants','mutants'),('evidence/cfix-busyA22/mutants','boundary-mutants'),('evidence/busyloop-a21/mutants','port-mutants')]:
  if (work/src).exists():shutil.copytree(work/src,out/dest,dirs_exist_ok=True)
 assert all(r[1]=='KILLED (RED)' for r in results) and not any(checks),(results,checks)
 print('All R1/R2, boundary and port mutants RED; disposable sources restored and removed')
