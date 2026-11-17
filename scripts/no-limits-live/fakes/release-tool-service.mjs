import {createInterface} from 'node:readline';
import {realpathSync,writeFileSync,appendFileSync,readFileSync} from 'node:fs';
import {sep,join} from 'node:path';
import {hashInput} from '../oracle-class.mjs';
import {requireGatedHandle} from '../gated-handle.mjs';
export async function runFake(gatedHandle){
 const {createMountedTools,executeReleased}=requireGatedHandle(gatedHandle);
// Inert-provider MCP service: real allowed filesystem operations in the owned
// release workspace, never a host shell or a paid provider.
const app=process.env.GNL_SAVED_APP_FIXTURE==='1';
const appTool={name:'GMAIL_SEND_EMAIL',description:'Deliver to the inert fixture outbox',inputSchema:{type:'object',properties:{accountId:{type:'string'},to:{type:'string'},body:{type:'string'}},required:['accountId','to','body'],additionalProperties:false}};
const out=m=>process.stdout.write(JSON.stringify(m)+'\n');
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line),reply=result=>out({jsonrpc:'2.0',id:m.id,result});
 if(m.method==='initialize')reply({protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'Release tools',version:'1'}});
 else if(m.method==='tools/list')reply({tools:[...(app?[appTool]:[]),{name:'shell',description:'Run an owned fixture shell operation',inputSchema:{type:'object',properties:{command:{type:'string'},cwd:{type:'string'}},required:['command','cwd']}},{name:'Write',description:'Write an owned fixture file',inputSchema:{type:'object',properties:{file_path:{type:'string'},content:{type:'string'},cwd:{type:'string'}},required:['file_path','content','cwd']}},{name:'write',description:'Write fixture text',inputSchema:{type:'object',properties:{text:{type:'string'},cwd:{type:'string'}},required:['text']}}]});
 else if(m.method==='tools/call'){
  try{
   const input=m.params.arguments,root=realpathSync(process.env.NOLIM_FIXTURE_ROOT);
   if(!/[/\\]nolim-live-/.test(root))throw Error('Owned release root required');
   if(m.params.name==='GMAIL_SEND_EMAIL'){
    if(!app||hashInput(input)!==hashInput({accountId:'fixture-account',to:'fixture@example.test',body:'inert fixture'}))throw Error('Exact inert app input required');
    const bots=JSON.parse(readFileSync(join(process.env.GNL_APP_DATA_DIR,'bots.json'),'utf8'));
    const bot=bots.find(b=>b.id===process.env.GNL_APP_BOT),denial=bot?.connectedAppAccess?.denials?.find(d=>d.accountId===input.accountId&&d.tools?.includes('GMAIL_SEND_EMAIL'));
    if(!denial||bot.composio===false)throw Error('Persisted app fixture rule absent');
    appendFileSync(join(process.env.S3_STATE_DIR,'app-actions.ndjson'),JSON.stringify({id:process.env.GNL_APP_SCENARIO,ruleId:denial.id,executed:true,tool:'GMAIL_SEND_EMAIL',input})+'\n');
    reply({content:[{type:'text',text:'Inert fixture outbox delivery completed'}]});return;
   }
   if(m.params.name==='write'){appendFileSync(join(root,'field-actions.ndjson'),JSON.stringify({text:input.text})+'\n');reply({content:[{type:'text',text:'Fixture field action completed'}]});return;}
   const cwd=realpathSync(input.cwd??process.cwd());
   if(!cwd.startsWith(root+sep))throw Error('Fixture workspace required');process.chdir(cwd);
   const ok=executeReleased({tool:m.params.name==='shell'?'Bash':m.params.name,input},true);
   reply({content:[{type:'text',text:ok?'Fixture action completed':'Fixture action failed'}],isError:!ok});
  }catch{reply({content:[{type:'text',text:'Fixture action refused'}],isError:true});}
 }else if(m.id!==undefined)reply({});
});

}
