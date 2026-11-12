"""Offline evidence checks, not a test of Murage's future identity implementation."""
import hashlib, json, pathlib, re
root=pathlib.Path(__file__).resolve().parent
def read(name):return json.loads((root/name).read_text())
provenance=read('PROVENANCE.json')
for name,digest in provenance['files'].items():
    assert hashlib.sha256((root/name).read_bytes()).hexdigest()==digest, name
wire=[json.loads(line) for line in (root/'frames.jsonl').read_text().splitlines()]
frames=read('tool-frames.json')
for e in frames:
    original=wire[e['wireLine']-1]
    assert original['direction']=='stdout' and original['scenario']==e['scenario']
    assert json.loads(original['line'])==e['frame']
scenarios=read('scenarios.json'); observations=read('observations.json')
assert len(observations)==len(scenarios)==36
assert len(frames)==106
assert set(read('free-tools.json')) <= {s['tool'] for s in scenarios}
assert {s['tool'] for s in scenarios}==set(read('free-tools.json'))|{'terminal','execute_code','mcp__s0__echo'}
for s in scenarios:
    obs=next(o for o in observations if o['scenario']==s['id'])
    start=json.loads(wire[obs['startWireLine']-1]['line'])['params']['update']
    end=json.loads(wire[obs['endWireLine']-1]['line'])['params']['update']
    assert start['sessionUpdate']=='tool_call'
    assert end['sessionUpdate']=='tool_call_update' and end['toolCallId']==start['toolCallId']
    assert end['status'] in ('completed','failed') and 'title' not in end
    assert re.match('^'+re.escape(s['tool'])+'(?:: |$)',start['title']),s['id']
    assert (start['title'],start['kind'],'rawInput' in start)==(obs['title'],obs['kind'],obs['hasRawInput'])
    asks=[e for e in frames if e['scenario']==s['id'] and e['frame']['method']=='session/request_permission']
    assert [a['wireLine'] for a in asks]==obs['askWireLines']
    for a in asks:
        call=a['frame']['params']['toolCall']; raw=call['rawInput']
        assert call['toolCallId'] != start['toolCallId']
        if raw.get('command','').endswith(' (plugin approval rule)'):
            message=json.loads(raw['description'])
            assert message=={'murage':1,'v':1,'tool':s['tool'],'input':s['input'],'truncated':False}
            assert a['wireLine']<obs['startWireLine']
        if call['kind']=='edit':
            assert raw=={'tool':s['tool'],'arguments':s['input']}
            assert obs['startWireLine']<a['wireLine']<obs['endWireLine']
    if s['tool'] in ('terminal','execute_code','write_file','patch'):
        assert 'rawInput' not in start
    if s['id']=='mcp':assert start['rawInput']==s['input']
for mode in ('accept_edits','dont_ask'):
    for tool in ('write','patch'):
        obs=next(o for o in observations if o['scenario']==tool+'-'+mode)
        assert obs['status']=='completed' and obs['askWireLines']==[]
for ident in ('write-file','patch','patch-v4a','write-repeat','write-default','patch-default','write-denied'):
    assert len(next(o for o in observations if o['scenario']==ident)['askWireLines'])==1
state=read('workspace-after.json')
assert all(state[m+'.txt']=='after\n' for m in ('accept_edits','dont_ask','default'))
assert state['edit.txt']=='second\n' and state['v4a.txt']=='v4a' and 'denied.txt' not in state
assert read('runtime.json')['interfaces']==['lo']
assert 'v0.22.2' in read('runtime.json')['version_stdout']
# The checked-in Murage hook bytes are exactly the base's program, with its constant expanded.
repo=root.parents[3]
source=(repo/'server/drivers/acp/hermes.ts').read_text()
expected=source.split('export const HERMES_ASK_HOOK_SOURCE = `',1)[1].split('`;\n',1)[0].replace('${HERMES_ASK_MESSAGE_CAP}',str(16*1024))
assert (root/'ask-hook.cjs').read_text()==expected
print(f'PASS: {len(provenance["files"])} file hashes; 36 scenarios; 22 tool names; 106 real frames; approval ordering and edit effects')
