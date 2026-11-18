"""Exact 83a3a611c driver sources, each site in its own fresh Vitest process."""
import pathlib,subprocess,json,hashlib
root=pathlib.Path.cwd();out=root/'.afix-evidence/r3/fix4';saved={};proof=[]
try:
 for p in (root/'.afix-evidence/r3/base-source').rglob('*.ts'):
  rel='server/drivers/'+str(p.relative_to(root/'.afix-evidence/r3/base-source'))
  # The host recorded these git objects before entering the no-network container.
  dest=root/rel;saved[dest]=dest.read_bytes();dest.write_bytes(p.read_bytes())
  proof.append({'path':rel,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
 for engine in ['claude','fuigo']:
  cmd=['pnpm','exec','vitest','run','server/drivers/native-answer-retry.test.ts','-t','T4b '+engine,'--maxWorkers=1']
  r=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=150)
  (out/f'BLOCK4-T4b-{engine}-red.log').write_text('$ '+' '.join(cmd)+'\n'+r.stdout)
  if r.returncode==0 or 'AssertionError' not in r.stdout or 'Test timed out' in r.stdout or 'no matching event' in r.stdout:raise RuntimeError(engine+' did not fail at the native resolution assertion')
finally:
 for p,data in saved.items():p.write_bytes(data)
 (out/'BLOCK4-red-source.json').write_text(json.dumps(proof,indent=2)+'\n')
