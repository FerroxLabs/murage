"""Credential-free stdio MCP echo server; transport peer only, not Hermes code."""
import json, sys
for line in sys.stdin:
    message=json.loads(line)
    if 'id' not in message:continue
    method=message['method']
    if method=='initialize':
        result={'protocolVersion':message['params']['protocolVersion'],'capabilities':{'tools':{}},'serverInfo':{'name':'s0','version':'1'}}
    elif method=='tools/list':
        result={'tools':[{'name':'echo','description':'Echo isolated fixture text','inputSchema':{'type':'object','properties':{'text':{'type':'string'}},'required':['text']}}]}
    elif method=='tools/call':result={'content':[{'type':'text','text':message['params']['arguments']['text']}],'isError':False}
    else:result={}
    print(json.dumps({'jsonrpc':'2.0','id':message['id'],'result':result}),flush=True)
