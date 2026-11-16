// Decode only the release rig's explicit instructions. Unknown instructions
// fail qualification rather than returning a plausible text-only completion.
export function releasePlan(value){
 const text=typeof value==='string'?value:Array.isArray(value)?value.map(x=>x.text??'').join('\n'):JSON.stringify(value);
 const tool=(tool,input)=>({kind:'tool',tool,input});
 let steps=[];
 const off=/GNL_FEATURE_OFF (browser|app-integration|host-computer) ([A-Za-z0-9-]+)/.exec(text);
 if(off)return {id:'release-off',steps:[{kind:'off',feature:off[1],token:off[2]}]};
 const field=/Use exactly the ([\w_]+) tool once with this input: ([\s\S]*?)\. Do not substitute/.exec(text);
 // A resumed transport can prepend quoted history. The current explicit
 // command segment is last; its delimiter excludes room/webhook footers.
 const shell=[...text.matchAll(/Run exactly(?: this shell command once)?: ([\s\S]*?)(?:\. If denied, stop\.|$)/g)].at(-1)?.[1]
  ?? /Run this action once: ([\s\S]*?)\. If interrupted/.exec(text)?.[1];
 const url=/https?:\/\/127\.0\.0\.1:\d+\/[^\s,]+/.exec(text)?.[0]?.replace(/[.]+$/,'');
 if(field){steps.push(tool(field[1],JSON.parse(field[2])));}
 else if(shell)steps.push(tool('Bash',{command:shell}));
 else if(/file editing tool|Edit notes\.txt/.test(text))steps.push(tool('Write',{file_path:'notes.txt',content:'edited by engine\n'}));
 else if(/Use create_bot/.test(text)){
  const match=/named '([^']+)' with instance_id ([\w-]+) and model ([\w./-]+)/.exec(text);
  if(!match)throw Error('Release seat instruction malformed');
  steps.push(tool('create_bot',{name:match[1],section:match[1],lead:true,role:'Fixture worker',instructions:'Use owned fixture files',model_selection:{instanceId:match[2],model:match[3].replace(/\.$/,'')}}));
 }else if(/Read again with offset 12000/.test(text)&&url){steps.push(tool('agent_browser_open',{url}),tool('agent_browser_read',{url,length:12000,raw:true}),{...tool('agent_browser_read',{offset:12000}),savedRead:true},tool('Bash',{command:`curl '${url}' -o page.txt`}),...['cd .','ls',`curl '${url}' -o copy.txt`,`python3 -c "from pathlib import Path; print(len(Path('copy.txt').read_text()))"`].map(command=>tool('Bash',{command})),{kind:'text',text:'END-13342'});
 }else if(/browser|navigate/.test(text)&&url){steps.push(tool('agent_browser_open',{url}),tool('agent_browser_snapshot',{}),tool('agent_browser_close',{}));}
 else if(/Python tool operation/.test(text))steps.push(tool('Bash',{command:`python3 -c "import shutil as s; s.rmtree('/')"`}));
 else if(/S3_TWO_QUESTIONS|S3_QUESTION_WITH_INSTRUCTION|question tool/.test(text)){
  const count=text.includes('S3_TWO_QUESTIONS')?2:1;
  steps=Array.from({length:count},(_,i)=>({kind:'question',tool:'ask_user',input:{question:text.includes('INSTRUCTION')?'Choose an option. Quoted data: rm -rf ~':text.includes('question tool')?'Choose a fixture color':`S3 question ${i+1}`,choices:['red','blue']}}));
 }else if(text.includes('S3_EMAIL'))steps.push(tool('email_send',{to:['fixture@example.test'],subject:'rm -rf ~ is quoted text',text:'S3 fake email fixture'}));
 else if(text.includes('S3_SAVED_APP:')){const token=/S3_SAVED_APP:([A-Za-z0-9_-]+)/.exec(text)[1];const fixture=JSON.parse(Buffer.from(token,'base64url').toString());steps.push({...tool('GMAIL_SEND_EMAIL',{accountId:'fixture-account',to:'fixture@example.test',body:'inert fixture'}),fixture:{savedApp:fixture}});}
 else if(text.includes('S3_WEBHOOK_ROOM:')){const token=/S3_WEBHOOK_ROOM:([A-Za-z0-9_-]+)/.exec(text)[1];const fixture=JSON.parse(Buffer.from(token,'base64url').toString());steps.push({...tool('propose_routine_action',{routine_id:fixture.routineId,action:'run_now'}),fixture:{room:fixture}});}
 else if(/S3_PROJECT_ROUTINE|S3_ROOM_WEBHOOK_ACTION|S3_QUEUED_SEND/.test(text))steps.push(tool('Bash',{command:'printf fixture > action.done'}));
 else if(text.includes('S3_HOLD'))steps.push({kind:'delay',ms:1500},tool('Bash',{command:'printf fixture > action.done'}));
 // A wake includes the original routine prompt. Consume the delivered reply
 // before considering its original delegation, so it cannot delegate again.
 else if(text.includes('S3_PEER_REPLY'))steps.push({kind:'text',text:'S3_PEER_REPLY'});
 else if(/S3_DELEGATE ([\w-]+)/.test(text))steps.push(tool('delegate_bot',{bot_id:/S3_DELEGATE ([\w-]+)/.exec(text)[1],message:'S3_PEER_REPLY'}));
 else if(/literal text "rm -rf ~"/.test(text))steps.push(tool('delegate_bot',{bot_id:/send bot ([\w-]+)/.exec(text)?.[1],message:'rm -rf ~'}));
 else if(/phrase to remember/.test(text))steps.push(tool('memory_save',{text:'rm -rf ~',evidence:[{quote:'rm -rf ~'}],idempotencyKey:'gnl-quoted-memory'}));
 else if(text.includes('rm -rf ~'))steps.push({kind:'text',text:'Acknowledged the quoted text: rm -rf ~'});
 else if(/host computer/.test(text))steps.push(tool('local_computer_consent',{}));
 else throw Error('Release fake received an unimplemented scenario instruction');
 if(field&&url&&text.includes('First use a browser tool to read '))steps.unshift(tool('agent_browser_open',{url}));
 if(/question tool/.test(text))steps.push({kind:'text',text:'Chosen: blue'});
 return {id:'release-native',steps};
}
