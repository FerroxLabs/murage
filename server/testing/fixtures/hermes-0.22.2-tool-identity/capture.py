"""Drive an unmodified Hermes ACP subprocess with a loopback scripted model.
Run only via run-capture.sh (--network none); never reads the host environment.
"""
import http.server, threading, subprocess, os, json, time, pathlib, sys, queue, hashlib, importlib.metadata

CAP = pathlib.Path('/capture')
OUT = pathlib.Path('/evidence')
OUT.mkdir(exist_ok=True)
HOME = pathlib.Path('/tmp/s0-home')
WORK = pathlib.Path('/tmp/s0-work')
HOME.mkdir(); WORK.mkdir()
(HOME/'hermes').mkdir()
(WORK/'seed.txt').write_text('alpha\nbeta\n')
config = {
    'model': {'default': 's0-stub', 'provider': 'custom:s0', 'base_url': 'http://127.0.0.1:18080/v1', 'api_mode': 'chat_completions'},
    'providers': {'s0': {'base_url': 'http://127.0.0.1:18080/v1', 'api_key': 's0-dummy-not-a-credential', 'api_mode': 'chat_completions'}},
    'terminal': {'backend': 'local'},
    'agent': {'max_turns': 8},
    'hooks': {'pre_tool_call': [{'matcher': '(?!(?:'+'|'.join(json.loads((CAP/'free-tools.json').read_text()))+')$).+', 'command': '/node /capture/ask-hook.cjs', 'timeout': 10, 'fail_closed': True}]},
    'platform_toolsets': {'acp': ['terminal','file','skills','todo','memory','clarify','code_execution','web','vision','video','x_search','desktop_ui','session_search']},
}
# JSON is valid YAML; no config or credential mounts from the host.
(HOME/'hermes'/'config.yaml').write_text(json.dumps(config))
(OUT/'config.json').write_text(json.dumps(config,indent=2)+'\n')
scenarios = json.loads((CAP/'scenarios.json').read_text())
active = {}; request_count = 0
class Stub(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.reply({'object':'list','data':[{'id':'s0-stub','object':'model','owned_by':'fixture'}]})
    def reply(self, obj):
        body=json.dumps(obj).encode(); self.send_response(200)
        self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(body)))
        self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        global request_count
        body=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))))
        if self.path != '/v1/chat/completions':
            self.reply({}); return
        # Auxiliary title/compression calls have no tools and do not advance the fixture.
        primary = bool(body.get('tools')) and bool(active)
        if primary: request_count += 1
        with (OUT/'model-requests.jsonl').open('a') as f:
            f.write(json.dumps({'scenario':active.get('id'),'request':request_count,'primary':primary,'path':self.path,'stream':body.get('stream'), 'tools':[t.get('function',{}).get('name') for t in body.get('tools',[])]})+'\n')
        if primary and request_count == 1:
            name, args = active['tool'], active['input']
            offered = [t.get('function',{}).get('name') for t in body.get('tools',[])]
            if name not in offered and 'tool_call' in offered:
                name, args = 'tool_call', {'calls':[{'name':name,'arguments':args}]}
            msg={'role':'assistant','content':None,'tool_calls':[{'id':'stub-'+active['id'],'type':'function','function':{'name':name,'arguments':json.dumps(args)}}]}
            finish='tool_calls'
        else:
            msg={'role':'assistant','content':'S0 fixture complete.'};finish='stop'
        response={'id':'s0-response','object':'chat.completion','created':0,'model':'s0-stub','choices':[{'index':0,'message':msg,'finish_reason':finish}], 'usage':{'prompt_tokens':100,'completion_tokens':20,'total_tokens':120}}
        with (OUT/'model-responses.jsonl').open('a') as f:f.write(json.dumps({'scenario':active.get('id'),'response':response})+'\n')
        if body.get('stream'):
            delta=dict(msg);delta.pop('role',None)
            if 'tool_calls' in delta:
                for i,t in enumerate(delta['tool_calls']):t['index']=i
            chunks=[{'id':'s0-response','object':'chat.completion.chunk','created':0,'model':'s0-stub','choices':[{'index':0,'delta':{'role':'assistant',**delta},'finish_reason':None}]}, {'id':'s0-response','object':'chat.completion.chunk','created':0,'model':'s0-stub','choices':[{'index':0,'delta':{},'finish_reason':finish}], 'usage':response['usage']}]
            data=''.join('data: '+json.dumps(c)+'\n\n' for c in chunks)+'data: [DONE]\n\n'
            b=data.encode();self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Content-Length',str(len(b)));self.end_headers();self.wfile.write(b)
        else:self.reply(response)
    def log_message(self,*args):pass
server=http.server.ThreadingHTTPServer(('127.0.0.1',18080),Stub)
threading.Thread(target=server.serve_forever,daemon=True).start()
env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':str(HOME),'HERMES_HOME':str(HOME/'hermes'), 'PYTHONPATH':'/deps:/hermes','PYTHONDONTWRITEBYTECODE':'1','NO_COLOR':'1','HERMES_ACCEPT_HOOKS':'1','XAI_API_KEY':'s0-dummy-xai-not-a-credential','XAI_BASE_URL':'http://127.0.0.1:18080/v1'}
assert sorted(os.listdir('/sys/class/net')) == ['lo'], 'capture must have loopback only'
version=subprocess.run([sys.executable,'-m','hermes_cli.main','--version'],cwd='/hermes',env=env,capture_output=True,text=True,check=True)
(OUT/'runtime.json').write_text(json.dumps({'version_stdout':version.stdout,'version_stderr':version.stderr,'python_version':sys.version,'python_sha256':hashlib.sha256(pathlib.Path(sys.executable).read_bytes()).hexdigest(),'cli_entry_sha256':hashlib.sha256(pathlib.Path('/hermes/hermes_cli/main.py').read_bytes()).hexdigest(),'interfaces':os.listdir('/sys/class/net'),'environment':env},indent=2)+'\n')
err=(OUT/'stderr.log').open('w')
p=subprocess.Popen([sys.executable,'-m','hermes_cli.main','-p','default','acp'],cwd='/hermes',env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=err)
lines=queue.Queue()
def reader():
    for b in p.stdout:lines.put(b.decode().rstrip('\n'))
    lines.put(None)
threading.Thread(target=reader,daemon=True).start()
wire=(OUT/'frames.jsonl').open('w')
def record(direction,line):
    wire.write(json.dumps({'scenario':active.get('id'),'direction':direction,'line':line})+'\n');wire.flush()
def send(obj):
    line=json.dumps(obj,separators=(',',':'));record('stdin',line);p.stdin.write((line+'\n').encode());p.stdin.flush()
def rpc(i,method,params):
    send({'jsonrpc':'2.0','id':i,'method':method,'params':params})
    deadline=time.monotonic()+120
    while time.monotonic()<deadline:
        try:line=lines.get(timeout=1)
        except queue.Empty:continue
        if line is None:raise RuntimeError('Hermes exited: '+str(p.poll()))
        record('stdout',line)
        m=json.loads(line)
        if m.get('method')=='session/request_permission':
            send({'jsonrpc':'2.0','id':m['id'],'result':{'outcome':{'outcome':'selected','optionId':active.get('answer','allow_once')}}})
        elif 'method' in m and 'id' in m:
            send({'jsonrpc':'2.0','id':m['id'],'error':{'code':-32601,'message':'fixture client does not implement this method'}})
        elif m.get('id')==i:
            if 'error' in m:raise RuntimeError(m['error'])
            return m['result']
    raise TimeoutError(method)
try:
    rpc(1,'initialize',{'protocolVersion':1,'clientCapabilities':{},'clientInfo':{'name':'murage-s0-capture','version':'1.0.19'}})
    session=rpc(2,'session/new',{'cwd':str(WORK),'mcpServers':[{'name':'s0','command':sys.executable,'args':['/capture/mcp-stub.py'],'env':[]}]})['sessionId']
    for n,s in enumerate(scenarios):
        active=s;request_count=0
        if 'mode' in s:
            rpc(1000+n,'session/set_mode',{'sessionId':session,'modeId':s['mode']})
        result=rpc(10+n,'session/prompt',{'sessionId':session,'prompt':[{'type':'text','text':'Run isolated fixture '+s['id']}]})
        print(s['id'],result,flush=True)
    (OUT/'installed-packages.json').write_text(json.dumps(sorted([{'name':d.metadata['Name'],'version':d.version} for d in importlib.metadata.distributions(path=['/deps'])],key=lambda d:d['name'].lower()),indent=2)+'\n')
    (OUT/'workspace-after.json').write_text(json.dumps({x.name:x.read_text() for x in WORK.iterdir() if x.is_file()},indent=2)+'\n')
finally:
    p.terminate()
    try:p.wait(timeout=10)
    except subprocess.TimeoutExpired:p.kill();p.wait()
    server.shutdown();wire.close();err.close()
