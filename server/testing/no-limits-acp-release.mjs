#!/usr/bin/env node
// Isolated native protocol fixture. Tool input is logged, never executed.
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
if(process.argv.includes('--version')){console.log('1.0.0');process.exit(0);}
let prompt;
createInterface({input:process.stdin}).on('line',line=>{
 const frame=JSON.parse(line);if(process.env.NLSYM_ACP_LOG)appendFileSync(process.env.NLSYM_ACP_LOG,line+'\n');
 if(frame.method==='initialize')send({id:frame.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});
 else if(frame.method==='session/new')send({id:frame.id,result:{sessionId:'release',modes:{currentModeId:'normal',availableModes:[{id:'normal'}]}}});
 else if(frame.method==='session/prompt'){
  prompt=frame.id;
  if(process.env.NLSYM_ACP_HOLD==='1'){send({method:'session/update',params:{sessionId:'release',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'fixture ready'}}}});return;}
  const toolCall=JSON.parse(process.env.NLSYM_ACP_CALL);
  send({id:900,method:'session/request_permission',params:{sessionId:'release',toolCall,options:[{optionId:'allow',kind:'allow_once'},{optionId:'deny',kind:'reject_once'}]}});
 }else if(frame.id===900)send({id:prompt,result:{stopReason:'end_turn'}});
 else if(frame.id)send({id:frame.id,result:{}});
});
