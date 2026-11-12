import pathlib,subprocess
root=pathlib.Path.cwd();base=root/'.afix-evidence/r3/base-source';saved={}
try:
 for p in base.rglob('*.ts'):
  dest=root/'server/drivers'/p.relative_to(base);saved[dest]=dest.read_bytes();dest.write_bytes(p.read_bytes())
 for name,files,pattern in [('T3',['answer-idempotency','request-delivery'],'T3'),('T4',['native-answer-retry'],'T4'),('T5',['acp-posture-switch'],'T5')]:
  cmd=['pnpm','exec','vitest','run',*[f'server/drivers/{f}.test.ts'for f in files],'-t',pattern,'--maxWorkers=1'];p=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=180)
  (root/f'.afix-evidence/r3/{name}-red-final.log').write_text('$ '+' '.join(cmd)+'\n'+p.stdout)
  if p.returncode==0 or 'AssertionError'not in p.stdout:raise RuntimeError(name+' did not fail assertions on original tip')
finally:
 for p,value in saved.items():p.write_bytes(value)
