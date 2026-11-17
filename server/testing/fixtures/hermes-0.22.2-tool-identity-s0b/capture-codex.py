"""Real Codex app-server + trusted hook, loopback Responses stub, no credentials."""
import hashlib
import http.server
import json
import os
from pathlib import Path
import queue
import subprocess
import threading
import time

OUT = Path(__file__).resolve().parent
HOME = Path('/work/.s0b-runtime/codex-home')
WORK = Path('/tmp/s0b-codex-work')
BIN = Path('/work/.s0b-runtime/codex')
HOME.mkdir()
WORK.mkdir()
assert os.listdir('/sys/class/net') == ['lo']
hook = HOME / 'record-hook.py'
hook.write_text('''import json, sys
from pathlib import Path
line = sys.stdin.read()
with Path(sys.argv[1]).open('a') as f: f.write(line.strip()+'\\n')
print(json.dumps({'hookSpecificOutput': {'hookEventName':'PreToolUse','permissionDecision':'allow'}}))
''')
(HOME / 'hooks.json').write_text(json.dumps({'hooks': {'PreToolUse': [{'hooks': [{
    'type': 'command', 'command': f'/usr/bin/python3 {hook} {OUT}/codex-hooks.jsonl', 'timeout': 10,
}]}]}}))
config = '''model = "gpt-5.4"
model_provider = "s0b"
approval_policy = "never"
sandbox_mode = "danger-full-access"
[features]
hooks = true
shell_snapshot = false
apply_patch_freeform = true
[model_providers.s0b]
name = "S0b loopback stub"
base_url = "http://127.0.0.1:18081/v1"
wire_api = "responses"
requires_openai_auth = false
'''
config += f'''[mcp_servers.s0b]
command = "/usr/bin/python3"
args = ["{OUT}/mcp-stub.py"]
'''
(HOME / 'config.toml').write_text(config)
(OUT / 'codex-config.toml').write_text(config)
scenarios = [
    ('exec_command', {'cmd': 'printf s0b-codex', 'workdir': str(WORK)}),
    ('exec_command', {'cmd': "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: /tmp/s0b-codex-work/proof.txt\n+s0b\n*** End Patch\nPATCH", 'workdir': str(WORK)}),
    ('mcp__s0b__echo', {'text': 's0b-codex-echo'}),
]
step = 0


class Stub(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        global step
        assert self.path == '/v1/responses', self.path
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        with (OUT / 'codex-model-requests.jsonl').open('a') as f:
            f.write(json.dumps({'path': self.path, 'tools': request.get('tools'),
                'tool_results': [m for m in request.get('input', [])
                                 if m.get('type', '').endswith('_call_output')]})+'\n')
        if step < len(scenarios):
            name, args = scenarios[step]
            item = ({'type': 'custom_tool_call', 'input': args} if name == 'apply_patch' else
                    {'type': 'function_call', 'arguments': json.dumps(args)})
            item.update(id='item-'+str(step), call_id='call-'+str(step), name=name, status='completed')
            if name == 'mcp__s0b__echo':
                item.update(name='echo', namespace='mcp__s0b')
        else:
            item = {'id': 'msg-final', 'type': 'message', 'role': 'assistant', 'status': 'completed',
                    'content': [{'type': 'output_text', 'text': 'S0b done.', 'annotations': []}]}
        response = {'id': 'resp-'+str(step), 'object': 'response', 'status': 'completed', 'output': [item],
                    'usage': {'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2}}
        events = [
            {'type': 'response.created', 'response': {**response, 'status': 'in_progress', 'output': []}},
            {'type': 'response.output_item.added', 'output_index': 0, 'item': item},
            {'type': 'response.output_item.done', 'output_index': 0, 'item': item},
            {'type': 'response.completed', 'response': response},
        ]
        with (OUT / 'codex-model-responses.jsonl').open('a') as f:
            f.write(json.dumps(events)+'\n')
        step += 1
        data = ''.join('event: '+e['type']+'\ndata: '+json.dumps(e)+'\n\n' for e in events).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


server = http.server.ThreadingHTTPServer(('127.0.0.1', 18081), Stub)
threading.Thread(target=server.serve_forever, daemon=True).start()
env = {'HOME': str(HOME), 'CODEX_HOME': str(HOME), 'PATH': '/usr/local/bin:/usr/bin:/bin', 'NO_COLOR': '1'}
(OUT / 'codex-runtime.json').write_text(json.dumps({
    'version': subprocess.check_output([str(BIN), '--version'], env=env, text=True).strip(),
    'sha256': hashlib.sha256(BIN.read_bytes()).hexdigest(),
    'interfaces': os.listdir('/sys/class/net'), 'environment': env,
}, indent=2)+'\n')
err = (OUT / 'codex-stderr.log').open('w')
p = subprocess.Popen([str(BIN), 'app-server'], env=env, cwd=WORK,
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err)
lines = queue.Queue()


def reader():
    for line in p.stdout:
        lines.put(line.decode().rstrip('\n'))
    lines.put(None)


threading.Thread(target=reader, daemon=True).start()
wire = (OUT / 'codex-frames.jsonl').open('w')


def record(direction, line):
    wire.write(json.dumps({'direction': direction, 'line': line})+'\n')
    wire.flush()


def send(m):
    line = json.dumps(m)
    record('stdin', line)
    p.stdin.write((line+'\n').encode())
    p.stdin.flush()


def wait(predicate):
    until = time.monotonic()+90
    while time.monotonic() < until:
        try:
            line = lines.get(timeout=1)
        except queue.Empty:
            continue
        if line is None:
            raise RuntimeError('Codex exited '+str(p.poll()))
        record('stdout', line)
        m = json.loads(line)
        if predicate(m):
            if 'error' in m:
                raise RuntimeError(m['error'])
            return m
    raise TimeoutError('Codex did not answer')


def rpc(i, method, params):
    send({'id': i, 'method': method, 'params': params})
    return wait(lambda m: m.get('id') == i)['result']


try:
    rpc(1, 'initialize', {'clientInfo': {'name': 's0b', 'version': '1.0.19'},
                           'capabilities': {'experimentalApi': True}})
    send({'method': 'initialized', 'params': {}})
    listing = rpc(2, 'hooks/list', {'cwds': [str(WORK)]})
    hooks = listing['data'][0]['hooks']
    assert len(hooks) == 1, listing
    rpc(3, 'config/batchWrite', {'edits': [{'keyPath': 'hooks.state', 'mergeStrategy': 'upsert',
        'value': {h['key']: {'trusted_hash': h['currentHash']} for h in hooks}}], 'reloadUserConfig': True})
    listing = rpc(4, 'hooks/list', {'cwds': [str(WORK)]})
    assert all(h['trustStatus'] == 'trusted' for h in listing['data'][0]['hooks']), listing
    thread = rpc(5, 'thread/start', {'cwd': str(WORK), 'model': 'gpt-5.4',
        'modelProvider': 's0b', 'approvalPolicy': 'never', 'sandbox': 'danger-full-access'})['thread']['id']
    rpc(6, 'turn/start', {'threadId': thread, 'input': [{'type': 'text', 'text': 'Run fixture tools.'}]})
    result = wait(lambda m: m.get('method') == 'turn/completed')
    assert result['params']['turn']['status'] == 'completed', result
    (OUT / 'codex-workspace-after.json').write_text(json.dumps({
        x.name: x.read_text() for x in WORK.iterdir() if x.is_file()
    }, indent=2)+'\n')
    print('G4 capture complete', flush=True)
finally:
    p.terminate()
    try:
        p.wait(timeout=10)
    except subprocess.TimeoutExpired:
        p.kill()
        p.wait()
    server.shutdown()
    wire.close()
    err.close()
