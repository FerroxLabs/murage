import ast,json,pathlib,hashlib
cap=pathlib.Path(__file__).parent
source=pathlib.Path('/tmp/fixture-root/keylimits-fin/master/src/rate_limits.py')
tree=ast.parse(source.read_text())
for n in ast.walk(tree):
 if isinstance(n,ast.Return) and isinstance(n.value,ast.Dict) and 'free_cap_reached' in ast.unparse(n.value):
  body=eval(compile(ast.Expression(n.value),str(source),'eval'),{'upgrade_url':'fluxrouter.ai/pricing'})
  if body.get('error',{}).get('state')=='free_cap_reached':break
else:raise RuntimeError('literal source body not found')
(cap/'S1.json').write_text(json.dumps(body))
# Prefix and type from LiteLLM 1.92.2 exceptions.py:441,484; proxy envelope :1338-1348.
# The production wrapper and source commit still need the FluxMain cross-check.
(cap/'S2.json').write_text(json.dumps({'error':{'message':'litellm.RateLimitError: '+json.dumps(body),'type':'throttling_error','param':None,'code':'429'}}))
(cap/'S3.json').write_text(json.dumps({'error':{'type':'rate_limit_exceeded','message':'Rate limit exceeded. Please retry.'}}))
credit=pathlib.Path('/tmp/fixture-root/keylimits-fin/master/src/gateway.py')
for n in ast.walk(ast.parse(credit.read_text())):
 if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute) and n.func.attr=='_credit_402' and len(n.args)>1 and isinstance(n.args[0],ast.Constant) and n.args[0].value=='credit_exhausted' and isinstance(n.args[1],ast.Constant):
  message=n.args[1].value;line=n.lineno;break
(cap/'S4.json').write_text(json.dumps({'error':{'message':message+' Top up at https://fluxrouter.ai/home/billing','type':'None','param':None,'code':'402'}}))
(cap/'body-sources.json').write_text(json.dumps({'status':'PROVISIONAL: FluxMain production cross-check and live commit unavailable','S1':{'file':str(source),'line':1270,'sha256':hashlib.sha256(source.read_bytes()).hexdigest()},'S2':{'version':'1.92.2','files':['litellm-exceptions.py:441,484','litellm-proxy-server.py:1338-1348'],'wrapper':'source-derived; production match unverified'},'S3':{'kind':'controlled plain busy response; not production capture'},'S4':{'file':str(credit),'line':line,'sha256':hashlib.sha256(credit.read_bytes()).hexdigest()}},indent=2))
