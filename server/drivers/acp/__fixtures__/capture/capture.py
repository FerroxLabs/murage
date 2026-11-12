import http.server,threading,subprocess,os,json,time,pathlib,sys,selectors
cap=pathlib.Path('/cap'); scenario=sys.argv[1]; run=sys.argv[2]; tag=f'{scenario}-{run}'
body=(cap/f'{scenario}.json').read_bytes()
class Stub(http.server.BaseHTTPRequestHandler):
 def do_POST(self):
  self.rfile.read(int(self.headers.get('Content-Length',0)))
  with (cap/f'requests-{tag}.jsonl').open('a') as f:f.write(json.dumps({'method':'POST','path':self.path,'time':time.monotonic_ns()})+'\n')
  self.send_response(402 if scenario=='S4' else 429)
  if scenario=='S3':self.send_header('Retry-After','5')
  if scenario=='S4':self.send_header('X-Flux-Hold-Reason','credit_exhausted')
  self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
 def do_GET(self):
  b=b'{"data":[]}'
  self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b)
 def log_message(self,*args):pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',18080),Stub)
threading.Thread(target=server.serve_forever,daemon=True).start()
home=cap/'scratch'/tag;home.mkdir(parents=True,exist_ok=True)
env={'PATH':os.environ['PATH'],'HOME':str(home),'FUIGO_HOME':str(home/'fuigo'),'FUIGO_API_KEY':'fuigo-capture-dummy-0000','FUIGO_API_BASE_URL':'http://127.0.0.1:18080/v1','NO_COLOR':'1'}
args=['/cap/package/bin/fuigo','--permission-mode','default','--no-memory','agent','--no-leader','-m','flux-auto','stdio']
log=(cap/f'frames-{tag}.jsonl').open('w')
err=(cap/f'stderr-{tag}.log').open('w')
p=subprocess.Popen(args,env=env,cwd=home,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=err)
def record(direction,line):log.write(json.dumps({'monotonic_ns':time.monotonic_ns(),'direction':direction,'line':line})+'\n');log.flush()
def send(obj):
 line=json.dumps(obj,separators=(',',':'));record('stdin',line);p.stdin.write((line+'\n').encode());p.stdin.flush()
send({'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':1,'clientCapabilities':{},'clientInfo':{'name':'murage-capture','version':'1.0.19'}}})
sel=selectors.DefaultSelector();sel.register(p.stdout,selectors.EVENT_READ);deadline=time.monotonic()+600
try:
 while time.monotonic()<deadline:
  if not sel.select(1):continue
  raw=p.stdout.readline()
  if not raw:raise RuntimeError('engine exited before prompt response')
  line=raw.decode().rstrip('\n');record('stdout',line)
  try:m=json.loads(line)
  except ValueError:continue
  if m.get('id')==1 and 'result' in m:send({'jsonrpc':'2.0','id':2,'method':'session/new','params':{'cwd':str(home),'mcpServers':[]}})
  elif m.get('id')==2 and 'result' in m:send({'jsonrpc':'2.0','id':3,'method':'session/prompt','params':{'sessionId':m['result']['sessionId'],'prompt':[{'type':'text','text':'hi'}]}})
  elif m.get('id')==3 and ('error' in m or 'result' in m):print(line,flush=True);break
  elif 'id' in m and 'method' in m:send({'jsonrpc':'2.0','id':m['id'],'result':{'outcome':{'outcome':'cancelled'}}})
 else:raise TimeoutError('prompt response deadline')
finally:
 p.terminate()
 try:p.wait(timeout=10)
 except subprocess.TimeoutExpired:p.kill();p.wait()
 server.shutdown();log.close();err.close()
