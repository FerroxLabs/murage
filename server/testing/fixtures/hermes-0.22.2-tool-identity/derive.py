"""Extract real wire frames and observations; never manufactures ACP events."""
import json, pathlib
root=pathlib.Path(__file__).resolve().parent
scenarios=json.loads((root/'scenarios.json').read_text())
events=[]
for line_number,line in enumerate((root/'frames.jsonl').read_text().splitlines(),1):
    record=json.loads(line)
    message=json.loads(record['line'])
    if record['direction']!='stdout':continue
    params=message.get('params',{})
    update=params.get('update',{})
    if message.get('method')=='session/request_permission' or update.get('sessionUpdate') in ('tool_call','tool_call_update'):
        events.append({'scenario':record['scenario'],'wireLine':line_number,'frame':message})
profile=[]
for scenario in scenarios:
    rows=[e for e in events if e['scenario']==scenario['id']]
    starts=[e for e in rows if e['frame']['method']=='session/update' and e['frame']['params']['update']['sessionUpdate']=='tool_call']
    assert len(starts)==1,(scenario['id'],len(starts))
    start=starts[0]['frame']['params']['update']
    ends=[e for e in rows if e['frame']['method']=='session/update' and e['frame']['params']['update'].get('toolCallId')==start['toolCallId'] and e['frame']['params']['update']['sessionUpdate']=='tool_call_update']
    assert len(ends)==1,scenario['id']
    asks=[e for e in rows if e['frame']['method']=='session/request_permission']
    profile.append({'scenario':scenario['id'],'tool':scenario['tool'],'title':start['title'],'kind':start['kind'],'hasRawInput':'rawInput' in start,'status':ends[0]['frame']['params']['update']['status'],'startWireLine':starts[0]['wireLine'],'endWireLine':ends[0]['wireLine'],'askWireLines':[a['wireLine'] for a in asks]})
for name,value in [('tool-frames.json',events),('observations.json',profile)]:
    (root/name).write_text(json.dumps(value,indent=2,ensure_ascii=False)+'\n')
print(f'{len(scenarios)} scenarios; {len(events)} real tool/permission frames extracted')
