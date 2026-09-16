// B35 packaged attention consumer only. Source checks do not run this journey.
import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync,openSync,closeSync,readSync,realpathSync,rmSync,readdirSync,lstatSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {userInfo} from 'node:os';
import {runCommand,setupKeychain,cleanupKeychain,guiBackupFixtureBot} from './mac-installed-backup-qualification-lib.mjs';
import {redactSecretsInLine,readSafeLogTail} from '../electron/diagnostics.mjs';
const DIR=path.dirname(fileURLToPath(import.meta.url)),REPO=path.dirname(DIR),C=JSON.parse(readFileSync(path.join(DIR,'mac-attention-contract.json'),'utf8'));
const phase=process.argv[2],args=process.argv.slice(3),hash=b=>createHash('sha256').update(b).digest('hex');
if(phase==='plan'){console.log(JSON.stringify(C,null,2));process.exit(0);}
if(!['admit','prepare','run','cleanup'].includes(phase))throw Error('phase: plan|admit|prepare|run|cleanup');
if(process.platform!=='darwin'||process.arch!=='arm64'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted'||process.env.HOME!=='/Users/runner'||userInfo().username!=='runner'||process.env.MURAGE_B35_NATIVE_CONFIRM!=='disposable-packaged-attention')throw Error('EPHEMERAL_HOSTED_MAC_ONLY');
if(!path.isAbsolute(process.env.RUNNER_TEMP??''))throw Error('RUNNER_TEMP_REQUIRED');
const ROOT=path.join(process.env.RUNNER_TEMP,'murage-b35-native'),E=path.join(ROOT,'evidence'),STATE=path.join(ROOT,'state.json');
mkdirSync(E,{recursive:true,mode:0o700});
const save=s=>writeFileSync(STATE,JSON.stringify(s,null,2)+'\n',{mode:0o600}),load=()=>JSON.parse(readFileSync(STATE,'utf8'));
const receipt=[];const record=(step,value={})=>{receipt.push({at:new Date().toISOString(),phase,step,...value});writeFileSync(path.join(E,phase+'.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});};
const check=(ok,label)=>{if(!ok)throw Object.assign(Error(label),{gate:label});};
const run=(cmd,argv,options={})=>runCommand(cmd,argv,{...options,timeout:options.timeout??30000});
const must=(result,label)=>{check(result.code===0,label);return result.stdout;};
const pause=ms=>new Promise(r=>setTimeout(r,ms));let stopping=false;process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
const until=async(fn,ms,label)=>{const end=Date.now()+ms;let last;while(!stopping&&Date.now()<end){last=await fn();if(last)return last;await pause(250);}record('wait-failed',{label,last});check(false,label);};
const ps=()=>must(run('/bin/ps',['-axo','pid=,command=']),'PROCESS_INVENTORY').split('\n').flatMap(line=>{const m=/^\s*(\d+)\s+(.*)$/.exec(line);return m?[{pid:Number(m[1]),command:m[2]}]:[];});
const systemIdentity=name=>{const result=ax(0,{op:'systemApplication',name});record('system-application-identity',{name,result});check(result.ok,'SYSTEM_BUNDLE_'+name);check(result.running.every(row=>row.bundlePath===result.bundlePath&&row.executablePath===result.executablePath&&Number.isInteger(row.pid)&&row.pid>0),'SYSTEM_IDENTITY_'+name);check(result.running.length<=1,'SYSTEM_PROCESS_AMBIGUOUS_'+name);return result;};
const systemPid=name=>{const result=systemIdentity(name);check(result.running.length===1,'SYSTEM_PROCESS_'+name);return result.running[0].pid;};
async function admitSystemApplication(name){
 const before=systemIdentity(name);
 if(before.running.length===0){
  // Launch the installed Apple session service once through LaunchServices, only on the gated disposable runner.
  const opened=run('/usr/bin/open',['-g','-a',before.bundlePath]);record('system-application-open',{name,code:opened.code});check(opened.code===0,'SYSTEM_OPEN_'+name);
  await until(()=>systemIdentity(name).running.length===1,15000,'SYSTEM_PROCESS_'+name);
 }
 return systemPid(name);
}
const ax=(pid,command,options={})=>{const result=run('/usr/bin/osascript',['-l','JavaScript',path.join(DIR,'mac-attention-ax.jxa'),JSON.stringify({pid,...command})],{timeout:options.timeout??20000});let value;try{value=JSON.parse(result.stdout.trim());}catch{value={ok:false,error:'osascript',code:result.code,stderr:redactSecretsInLine(result.stderr).slice(-800)};}return value;};
const tree=(pid,label)=>{const result=ax(pid,{op:'tree'});writeFileSync(path.join(E,label+'.ax.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});check(result.ok,'AX_TREE_'+label);return result;};
// A Settings transition may temporarily refuse AX messaging. Read only; never repeat a mutation.
async function settingsTree(pid,label){
 const deadline=Date.now()+15000;let result=null,attempt=0;
 while(!stopping&&Date.now()<deadline){
  const remaining=deadline-Date.now();if(remaining<=0)break;
  result=ax(pid,{op:'tree',settingsReadiness:true},{timeout:remaining});
  writeFileSync(path.join(E,label+'.ax.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
  record('settings-tree-read',{pid,label,attempt:++attempt,result:{ok:result.ok,error:result.error??null,code:result.code??null,attribute:result.attribute??null,visited:result.visited??null,elapsedMs:result.elapsedMs??null}});
  if(result.ok===true)return result;
  if(result.error!=='AX-read'||result.code!==-25204)break;
  const wait=Math.min(250,deadline-Date.now());if(wait>0)await pause(wait);
 }
 check(false,'AX_TREE_'+label);
}
const texts=t=>t.elements.flatMap(n=>[...n.names,typeof n.value==='string'?n.value:'']).filter(Boolean);
const shot=label=>{const file=path.join(E,label+'.png');must(run('/usr/sbin/screencapture',['-x',file]),'SCREENSHOT_'+label);return path.basename(file);};
async function press(pid,label,roles=['AXButton'],extra={}){
 let last,queries=0;
 try{await until(()=>{last=ax(pid,{op:'count',label,roles,...extra});queries++;return last.ok&&last.count===1;},15000,'UNIQUE_'+label);}
 catch(error){record('selector-query-failed',{pid,label,roles,queries,result:last??null});throw error;}
 if(label==='Send message'){const enabled=ax(pid,{op:'state',label,roles,...extra});record('send-enabled',{pid,result:enabled});check(enabled.ok&&enabled.enabled===true,'SEND_ENABLED');}
 const result=ax(pid,{op:'press',label,roles,...extra,...(label==='Send message'?{requireEnabled:true}:{})});record('press',{pid,label,result});check(result.ok,'PRESS_'+label);
}
function key(pid,value){const result=ax(pid,{op:'key',key:value});check(result.ok,'KEY_'+value);}
function state(pid,label,roles=['AXCheckBox'],extra={}){const value=ax(pid,{op:'state',label,roles,...extra});check(value.ok,'STATE_'+label);return value;}
const bool=value=>[true,1,'1'].includes(value)?true:[false,0,'0'].includes(value)?false:null;
async function checkbox(pid,label,target){let before=state(pid,label,['AXCheckBox'],{prefix:true}),current=bool(before.value);check(current!==null,'CHECKBOX_VALUE_'+label);if(current!==target)await press(pid,label,['AXCheckBox'],{prefix:true});const after=state(pid,label,['AXCheckBox'],{prefix:true});check(bool(after.value)===target,'CHECKBOX_READBACK_'+label);}
async function dnd(s,target){
 const pid=systemPid('ControlCenter');let observed=ax(pid,{op:'dndState'});
 record('dnd-control',{stage:'before-open',observed});
 try{
  // Read an already-open panel rather than toggling its menubar item closed.
  // Opening Control Center is navigation; pressing its Focus tile changes DND.
  if(!observed.ok&&observed.error==='AX-dnd-match'&&observed.count===0){
   await press(pid,'Control Center',['AXMenuBarItem']);
   await until(()=>{observed=ax(pid,{op:'dndState'});if(!observed.ok&&observed.count!==0)check(false,'DND_CONTROL_AMBIGUOUS');return observed.ok;},15000,'DND_CONTROL_AVAILABLE');
  }
  record('dnd-control',{stage:'before-toggle',observed});
  check(observed.ok&&typeof observed.value==='boolean','DND_STATE_UNREADABLE');
  const before=observed.value;
  if(s.originalDnd===undefined){s.originalDnd=before;s.originalDndEvidence=observed;save(s);}
  if(target!==undefined&&before!==target){
   s.dndMutationStarted=true;save(s);
   const pressed=ax(pid,{op:'pressDnd',expectedValue:before});record('dnd-toggle',{before,target,result:pressed});check(pressed.ok,'DND_PRESS');
   await until(()=>{observed=ax(pid,{op:'dndState'});if(!observed.ok&&observed.count!==0)check(false,'DND_CONTROL_AMBIGUOUS');return observed.ok&&observed.value===target;},15000,'DND_READBACK');
  }else observed=ax(pid,{op:'dndState'});
  check(observed.ok&&typeof observed.value==='boolean'&&(target===undefined||observed.value===target),'DND_READBACK');
  const actual=observed.value;record('dnd',{before,actual,target:target??null,observed});shot('dnd-'+String(actual));return actual;
 }catch(error){
  record('dnd-control-failed',{observed,error:error.message});
  // Preserve the actual panel/roles/values on an unfamiliar OS surface.
  writeFileSync(path.join(E,'dnd-'+phase+'-failed.ax.json'),JSON.stringify(ax(pid,{op:'tree'}),null,2)+'\n',{mode:0o600});throw error;
 }finally{key(pid,'escape');key(pid,'escape');}
}

function asarRead(file,name){const fd=openSync(file,'r');try{const head=Buffer.alloc(16);readSync(fd,head,0,16,0);const headerSize=head.readUInt32LE(4),length=head.readUInt32LE(12);check(head.readUInt32LE(0)===4&&length>0&&length+8<=headerSize,'ASAR_HEADER');const bytes=Buffer.alloc(length);readSync(fd,bytes,0,length,16);let entry={files:JSON.parse(bytes.toString()).files};for(const part of name.split('/'))entry=entry.files?.[part];check(entry&&!entry.unpacked&&/^\d+$/.test(entry.offset),'ASAR_ENTRY_'+name);const out=Buffer.alloc(entry.size);readSync(fd,out,0,out.length,8+headerSize+Number(entry.offset));return out;}finally{closeSync(fd);}}
async function admit(){
 check(args.length===3&&args.every(path.isAbsolute),'ARTIFACT_ARGUMENTS');check(!existsSync(STATE),'STATE_ALREADY_EXISTS');const [zip,gatesPath,sumsPath]=args;
 const s={root:ROOT,evidence:E,private:path.join(ROOT,'private'),appDir:path.join(ROOT,'app'),data:path.join(ROOT,'data'),userData:path.join(ROOT,'userData'),tmp:path.join(ROOT,'tmp'),runId:randomBytes(8).toString('hex')};for(const d of [s.private,s.appDir,s.data,s.userData,s.tmp])mkdirSync(d,{mode:0o700});save(s);
 const zipHash=hash(readFileSync(zip)),gates=JSON.parse(readFileSync(gatesPath,'utf8'));check(zipHash===C.zipSha256&&gates.sourceSha===C.artifactSource&&readFileSync(sumsPath,'utf8').includes(zipHash),'ARTIFACT_IDENTITY');
 must(run('/usr/bin/ditto',['-x','-k',zip,s.appDir],{timeout:120000}),'EXTRACT');s.app=realpathSync.native(path.join(s.appDir,'Murage.app'));s.exe=path.join(s.app,'Contents/MacOS/Murage');save(s);check(!/AppTranslocation/.test(s.app),'NO_TRANSLOCATION');check(run('/usr/bin/xattr',['-p','com.apple.quarantine',s.app]).code!==0,'NO_QUARANTINE');
 must(run('/usr/bin/codesign',['--verify','--deep','--strict',s.app],{timeout:120000}),'SIGNATURE');const policy=run('/usr/sbin/spctl',['-a','-vv','-t','exec',s.app],{timeout:120000});check(policy.code===0&&/accepted/.test(policy.stderr+policy.stdout),'SPCTL');must(run('/usr/bin/xcrun',['stapler','validate',s.app],{timeout:120000}),'STAPLER');
 const sig=run('/usr/bin/codesign',['-dv','--verbose=4',s.app]);check(sig.code===0&&new RegExp('TeamIdentifier='+C.team).test(sig.stderr)&&gates.appTeam===C.team,'TEAM');const exe=gates.inventory.find(row=>row.path==='Contents/MacOS/Murage');check(hash(readFileSync(s.exe))===exe?.sha256,'EXECUTABLE_RECEIPT');
 for(const f of ['electron/main.mjs','electron/preload.cjs','electron/approval-notification.mjs'])check(hash(asarRead(path.join(s.app,'Contents/Resources/app.asar'),f))===C.attentionInputHashes[f],'PACKAGED_SOURCE_'+f);
 const wav=path.join(s.app,'Contents/Resources/murage-approval.wav');check(hash(readFileSync(wav))===C.attentionInputHashes['electron/resources/murage-approval.wav'],'PACKAGED_SOUND_RESOURCE');
 check(must(run('/bin/launchctl',['managername']),'MANAGER').trim()==='Aqua','AQUA');
 // Fail before the long app journey when OS observation/control is unavailable.
 for(const name of ['NotificationCenter','ControlCenter'])tree(await admitSystemApplication(name),'prerequisite-'+name);
 await dnd(s,undefined);
 const isolated=setupKeychain({runner:run,exists:existsSync,persist:value=>{s.keychainIsolation=value;save(s);},keychain:path.join(s.private,'b35.keychain-db'),password:randomBytes(32).toString('hex')});check(isolated.ok,'KEYCHAIN_ISOLATION');
 record('admitted',{source:C.artifactSource,zipSha256:zipHash,exeSha256:exe.sha256,team:C.team,aqua:true,systemProcesses:true,originalDnd:s.originalDnd,soundResourceSha256:hash(readFileSync(wav)),audibility:'NOT_ESTABLISHED'});s.admitted=true;save(s);
}
async function prepare(){
 const s=load();check(s.admitted&&!s.prepared,'PREPARE_STATE');for(const [f,sha] of Object.entries(C.reusedSourcePins))check(hash(readFileSync(path.join(REPO,f)))===sha,'REUSED_SOURCE_'+f);
 const source=readFileSync(path.join(REPO,'server/testing/fake-claude-cli.ts'),'utf8'),anchor='  if (mode === "ask-user-question" || fixtureRequested(promptText(prompt), "__fixture_ask_user_question__")) {';check(source.split(anchor).length===2,'FAKE_PEER_ANCHOR');
 const injection=`  if (mode === "b35-native-permission") { void (async()=>{
 const match=/B35_NATIVE_PHASE:([a-z]+)-([a-f0-9]{16})/.exec(promptText(prompt));if(!match)throw Error("B35_PHASE_MISSING");const phase=match[1],dir=process.env.MURAGE_B35_CONTROL!;if(!["banner","private","mute","quiet","dnd"].includes(phase))throw Error("B35_PHASE_DENIED");
 writeFileSync(dir+"/started-"+phase+".json",JSON.stringify({phase,pid:process.pid,at:Date.now()}),{flag:"wx",mode:0o600});const deadline=Date.now()+60000;while(!existsSync(dir+"/release-"+phase)){if(Date.now()>deadline)throw Error("B35_GATE_TIMEOUT");await new Promise(r=>setTimeout(r,100));}
 const reply=await callPermissionPromptTool({tool_name:"Bash",input:{command:"B35_SYNTHETIC_NO_EXECUTION_"+phase+"_"+match[2]},tool_use_id:"b35-"+phase,permission_suggestions:[{type:"addRules",behavior:"allow",destination:"session",rules:[{toolName:"Bash"}]}]});if(!reply)throw Error("B35_PERMISSION_MISSING");
 writeFileSync(dir+"/decision-"+phase+".json",JSON.stringify({phase,decision:JSON.parse(reply)}),{flag:"wx",mode:0o600});out({type:"assistant",message:{content:[{type:"text",text:"Synthetic decision recorded; no action executed."}]}});out({type:"result",is_error:false,stop_reason:"end_turn",total_cost_usd:0,usage:{input_tokens:1,output_tokens:1}});turnRunning=false;finishIfDone();})().catch(()=>process.exit(73));return; }\n`;
 s.peer=path.join(s.private,'permission-peer.ts');writeFileSync(s.peer,source.replace(anchor,injection+anchor),{mode:0o700});s.cli=path.join(s.private,'permission-cli.mjs');
 const wrapper=`#!${process.execPath}\nimport {spawn} from 'node:child_process';const child=spawn(${JSON.stringify(process.execPath)},['--experimental-strip-types',${JSON.stringify(s.peer)},...process.argv.slice(2)],{stdio:'inherit',env:process.env});for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));child.on('close',code=>process.exit(code??74));child.on('error',()=>process.exit(74));\n`;writeFileSync(s.cli,wrapper,{mode:0o700});
 s.control=path.join(s.private,'control');mkdirSync(s.control,{mode:0o700});const modelSelection={instanceId:'attention-fixture',model:'claude-sonnet-5'},seed=guiBackupFixtureBot({id:'bot',threadId:'thread',name:'Fixture',notifications:true,autoApprove:false,resumeCursors:{}});
 s.bots=Object.fromEntries(['observer','banner','private','mute','quiet','dnd'].map(kind=>{const id='b35-'+kind+'-'+s.runId,threadId='thread-'+kind+'-'+s.runId,name='B35 '+kind+' '+s.runId;return[kind,{...seed,id,threadId,name,modelSelection,tasks:[{...seed.tasks[0],threadId,title:'B35 '+kind,modelSelection,autoApprove:false,alwaysAllow:[]}]}];}));
 const minute=d=>d.toISOString().slice(11,16),now=Date.now();s.notifications={attention:true,completion:false,failures:false,previewContent:true,quietHours:{enabled:false,start:minute(new Date(now-3600000)),end:minute(new Date(now+3600000)),timeZone:'UTC'}};
 writeFileSync(path.join(s.data,'config.json'),JSON.stringify({engineDiscovery:'explicit',profile:{name:'B35 qualification',email:'qualification@example.invalid'},features:{browser:false},notifications:s.notifications,instances:{'attention-fixture':{driver:'claudeAgent',displayName:'B35 synthetic permission peer',enabled:true,config:{cli:s.cli,fullAuto:false},environment:{FAKE_CLAUDE_MODE:'b35-native-permission',MURAGE_B35_CONTROL:s.control}}}}),{mode:0o600});
 writeFileSync(path.join(s.data,'bots.json'),JSON.stringify(Object.values(s.bots)),{mode:0o600});writeFileSync(path.join(s.data,'groups.json'),'[]',{mode:0o600});writeFileSync(path.join(s.data,'routines.json'),JSON.stringify({version:1,routines:[],runs:[]}),{mode:0o600});
 s.prepared=true;save(s);record('prepared',{runId:s.runId,canonicalTrigger:'real app composer -> packaged server -> existing synthetic permission MCP',bots:Object.fromEntries(Object.entries(s.bots).map(([k,b])=>[k,{id:b.id,threadId:b.threadId,name:b.name}])),paidCalls:0});
}
let active;
const api=async(s,route)=>{check(route.startsWith('/api/'),'READ_PATH');const res=await fetch('http://127.0.0.1:'+s.port+route,{signal:AbortSignal.timeout(5000),redirect:'error'});check(res.ok,'READ_API_'+res.status);return res.json();};
function ownedServerGeneration(log,entry){
 let current=null;
 for(const line of log.split(/\r?\n/)){
  const fork=/^\[[^\]]+\] fork (.+) port=(\d+)$/.exec(line);
  if(fork){const port=Number(fork[2]);current=fork[1]===entry&&port>0&&port<=65535?{generation:line,port,pid:null}:null;continue;}
  if(/^\[[^\]]+\] exited /.test(line)){current=null;continue;}
  const spawn=/^\[[^\]]+\] spawned pid=(\d+)$/.exec(line);
  if(current&&spawn)current.pid=Number(spawn[1]);
 }
 return current&&Number.isInteger(current.pid)&&current.pid>0?current:null;
}
async function selectBot(s,kind){const b=s.bots[kind];await press(s.pid,b.name,['AXButton','AXCheckBox'],{prefix:true,scopeName:'Bots and navigation'});await until(()=>{const t=ax(s.pid,{op:'count',roles:['AXTextArea','AXTextField'],label:'Message '+b.name});return t.ok&&t.count===1;},10000,'SELECTED_'+kind);}
async function settings(s,changes){await press(s.pid,'App settings');await settingsTree(s.pid,'notification-settings-ready');for(const [label,on] of Object.entries(changes))await checkbox(s.pid,label,on);await press(s.pid,'Save notifications');const prefs=await until(async()=>{const observed=(await api(s,'/api/config')).notifications;return Object.entries(changes).every(([label,on])=>(label==='Needs your attention'?observed.attention:label==='Show notification previews'?observed.previewContent:observed.quietHours?.enabled)===on)?observed:false;},10000,'PREFERENCES_CONFIRMED');record('preferences',{prefs});await press(s.pid,'Close settings');}
// Read the owner-authorized desktop projection. AX does not expose request IDs.
function inboxObservation(t,sourceLabel){
 const nodes=t.elements,logicalText=elements=>{const out=[];let parent=null,value='';const flush=()=>{if(parent!==null){const finished=value.trim();if(finished)out.push(finished);}parent=null;value='';};for(const node of elements){if(node.role==='AXStaticText'&&typeof node.value==='string'){if(parent===node.parent)value+=node.value;else{flush();parent=node.parent;value=node.value;}}else flush();}flush();return out;},all=[...texts(t),...logicalText(nodes)],under=(node,index)=>{let parent=node.parent,steps=0;while(parent>=0){check(++steps<=64,'INBOX_AX_ANCESTRY');if(parent===index)return true;const p=nodes.find(n=>n.index===parent);check(p,'INBOX_AX_PARENT');parent=p.parent;}return false;};
 check(!all.some(x=>/Displayed items may be stale|could not load|Use Refresh to check|Inbox is unavailable/i.test(x)),'INBOX_ERROR_OR_STALE');
 if(all.some(x=>x.includes('Updating Inbox')))return null;
 if(!all.some(x=>/^While you were away: .* matching items\.$/.test(x)))return null;
 check(all.includes('Page 1 of 1'),'INBOX_COMPLETE_PAGE');
 const lists=nodes.filter(n=>n.role==='AXList'&&n.names.includes('Inbox items'));check(lists.length===1,'INBOX_UNIQUE_LIST');
 const rows=nodes.filter(n=>n.parent===lists[0].index).map(row=>{const elements=[row,...nodes.filter(n=>under(n,row.index))];return[...texts({elements}),...logicalText(elements)];});
 const matches=rows.filter(row=>row.includes(sourceLabel));check(matches.length<=1,'INBOX_AMBIGUOUS_REQUEST');
 if(!matches.length)return{settled:true,pending:false,sourceLabel};
 check(matches[0].includes('Approval requested')&&matches[0].includes('Pending')&&matches[0].includes('Open request'),'INBOX_EXACT_PENDING_ROW');
 return{settled:true,pending:true,sourceLabel,row:matches[0]};
}
const inboxSource=(s,kind)=>[s.bots[kind].name,s.bots[kind].tasks.find(t=>t.threadId===s.bots[kind].threadId)?.title].filter(Boolean).join(' · ');
async function openPendingInbox(s){
 const buttons=tree(s.pid,'tools-selector').elements.filter(n=>n.role==='AXPopUpButton'&&n.names.some(x=>/^Tools(?:,|$)/.test(x)));check(buttons.length===1,'TOOLS_UNIQUE');
 await press(s.pid,buttons[0].names.find(x=>/^Tools(?:,|$)/.test(x)),['AXPopUpButton']);await press(s.pid,'Pending approvals',['AXMenuItem'],{prefix:true});
}
async function readPendingInbox(s,kind){return inboxObservation(tree(s.pid,'pending-'+kind),inboxSource(s,kind));}
async function pending(s,kind,ms=10000){
 // A new dialog mount clears the previous result; a settled page is a fresh read.
 await openPendingInbox(s);
 try{return await until(()=>readPendingInbox(s,kind),ms,'INBOX_SETTLED_'+kind);}
 finally{await press(s.pid,'Close Inbox');}
}
async function exactRequestCard(s,kind){
 const action='B35_SYNTHETIC_NO_EXECUTION_'+kind+'_'+s.runId;
 await until(()=>texts(tree(s.pid,'exact-card-'+kind)).some(x=>x.includes(action)),10000,'EXACT_CARD_'+kind);
 for(const label of ['Deny','Allow once']){const control=state(s.pid,label,['AXButton']);check(control.enabled===true,'REQUEST_DECISION_ENABLED_'+label);}
}

const notice=(s,label)=>{const t=tree(systemPid('NotificationCenter'),label);return{tree:t,text:texts(t).join('\n')};};
async function sampleNoBanner(s,marker,kind){const samples=[];for(let i=0;i<4;i++){check(!stopping,'STOPPED');const n=notice(s,kind+'-'+i);samples.push({at:new Date().toISOString(),present:n.text.includes(marker),screenshot:shot(kind+'-'+i)});await pause(3000);}record(kind+'-absence',{marker,samples,windowMs:12000});check(samples.every(x=>!x.present),kind.toUpperCase()+'_BANNER_PRESENT');check((await pending(s,kind)).pending,'PENDING_PRESERVED_'+kind);}
async function resolveDeny(s,kind){
 await selectBot(s,kind);await exactRequestCard(s,kind);check((await pending(s,kind)).pending,'PENDING_BEFORE_DENY_'+kind);
 await press(s.pid,'Deny');await until(()=>existsSync(path.join(s.control,'decision-'+kind+'.json')),10000,'DECISION_'+kind);
 const decision=JSON.parse(readFileSync(path.join(s.control,'decision-'+kind+'.json'),'utf8'));check(decision.decision?.behavior==='deny','DENY_ONLY_'+kind);
 await until(async()=>!(await pending(s,kind)).pending,10000,'RESOLVED_'+kind);record('denied',{kind,decision});
}
function triggerMessages(value){const rows=Array.isArray(value)?value:value?.messages;check(Array.isArray(rows),'THREAD_MESSAGES_SHAPE');return rows;}
function receivedTrigger(before,after,expected){
 const known=new Set(before.map(m=>m.id)),fresh=after.filter(m=>m.role==='user'&&m.kind==='text'&&!known.has(m.id));
 if(!fresh.length)return null;check(fresh.length===1&&fresh[0].text===expected,'EXACT_RECEIVED_TRIGGER');return fresh[0];
}
async function triggerFailureEvidence(s,kind){
 const evidence={kind,threadId:s.bots[kind].threadId,logs:[]};
 try{const rows=triggerMessages(await api(s,'/api/threads/'+s.bots[kind].threadId+'/messages'));const name='trigger-'+kind+'-messages.txt';writeFileSync(path.join(E,name),redactSecretsInLine(JSON.stringify(rows.slice(-20))).slice(-20000),{mode:0o600});evidence.messages=name;}catch(error){evidence.messagesUnavailable=error.gate??error.code??error.name;}
 const keep=(file,name)=>{const tail=readSafeLogTail(file,20000);if(!tail){evidence.logs.push({name,unavailable:true});return;}writeFileSync(path.join(E,name),redactSecretsInLine(tail.tail),{mode:0o600});evidence.logs.push({name,bytes:tail.bytes,redacted:true});};
 try{keep(path.join(s.userData,'logs/server.log'),'trigger-'+kind+'-server.log');const native=path.join(s.data,'native');if(existsSync(native)&&!lstatSync(native).isSymbolicLink()&&realpathSync(native).startsWith(realpathSync(s.data)+path.sep)){for(const name of readdirSync(native).filter(n=>n.endsWith('.ndjson')).sort().slice(-4))keep(path.join(native,name),'trigger-'+kind+'-'+name);}else evidence.nativeUnavailable=true;}catch(error){evidence.logsUnavailable=error.code??error.name;}
 record('trigger-failure-evidence',evidence);
}
async function trigger(s,kind){
 const b=s.bots[kind],marker=kind==='private'?'Your attention is needed.':b.name;
 try{
  check(!notice(s,'before-'+kind).text.includes(marker),'NATIVE_MARKER_PREEXISTS_'+kind);await selectBot(s,kind);
  const expected='B35_NATIVE_PHASE:'+kind+'-'+s.runId,before=triggerMessages(await api(s,'/api/threads/'+b.threadId+'/messages'));
  const typed=ax(s.pid,{op:'type',roles:['AXTextArea','AXTextField'],label:'Message '+b.name,text:expected});record('composer-entry',{kind,result:typed});check(typed.ok,'COMPOSER_'+kind);await press(s.pid,'Send message');
  const startedDeadline=Date.now()+15000;
  const received=await until(async()=>receivedTrigger(before,triggerMessages(await api(s,'/api/threads/'+b.threadId+'/messages')),expected),Math.max(0,startedDeadline-Date.now()),'RECEIVED_TRIGGER_'+kind);record('received-trigger',{kind,threadId:b.threadId,message:received});
  await until(()=>existsSync(path.join(s.control,'started-'+kind+'.json')),Math.max(0,startedDeadline-Date.now()),'SYNTHETIC_STARTED_'+kind);await selectBot(s,'observer');
  // Open while the peer is held, before the post-release notification window.
  await openPendingInbox(s);const beforeRelease=await until(()=>readPendingInbox(s,kind),10000,'INBOX_BEFORE_RELEASE_'+kind);check(!beforeRelease.pending,'PENDING_PREEXISTS_'+kind);
  writeFileSync(path.join(s.control,'release-'+kind),'release',{flag:'wx',mode:0o600});
  const pendingDeadline=Date.now()+15000;
  const item=await until(async()=>{await press(s.pid,'Refresh');const observed=await until(()=>readPendingInbox(s,kind),Math.max(0,pendingDeadline-Date.now()),'INBOX_REFRESHED_'+kind);return observed.pending?observed:null;},Math.max(0,pendingDeadline-Date.now()),'CANONICAL_PENDING_'+kind);
  await press(s.pid,'Close Inbox');record('canonical-request',{kind,botId:b.id,threadId:b.threadId,item,identity:'unique source row; exact action is checked on the conversation card'});return{marker,item};
 }catch(error){try{await triggerFailureEvidence(s,kind);}catch{}throw error;}
}

async function journey(){
 const s=load();check(s.prepared&&!s.journeyStarted,'JOURNEY_ONCE');s.journeyStarted=true;save(s);const timer=setTimeout(()=>{stopping=true;},C.scriptMinutes*60000);
 try{
  // Prerequisites are repeated immediately before launch, not replaced by prior source checks.
  for(const name of ['NotificationCenter','ControlCenter'])tree(systemPid(name),'ready-'+name);await dnd(s,false);
  const fd=openSync(path.join(s.private,'app.log'),'wx',0o600);active=spawn(s.exe,[],{env:{HOME:process.env.HOME,PATH:path.dirname(process.execPath)+':/usr/bin:/bin',TMPDIR:s.tmp,MURAGE_DATA_DIR:s.data,MURAGE_USER_DATA:s.userData},stdio:['ignore',fd,fd]});closeSync(fd);active.unref();s.pid=active.pid;save(s);
  await until(()=>{const r=ax(s.pid,{op:'manual'});return r.ok;},15000,'MANUAL_AX');
  await until(async()=>{
   const log=path.join(s.userData,'logs/server.log');if(!existsSync(log))return false;
   const expectedEntry=s.app+'/Contents/Resources/server/index.js';
   const found=ownedServerGeneration(readFileSync(log,'utf8'),expectedEntry);if(!found)return false;s.port=found.port;
   let health;
   try{health=await api(s,'/api/health');}catch(error){record('server-not-ready',{port:s.port,error:error.name,code:error.cause?.code??null});return false;}
   const after=ownedServerGeneration(readFileSync(log,'utf8'),expectedEntry);if(JSON.stringify(after)!==JSON.stringify(found))return false;
   const processes=ps(),owned=processes.find(row=>row.pid===found.pid&&row.command.startsWith(s.app+'/Contents/'));
   const main=processes.find(row=>row.pid===s.pid&&row.command.startsWith(s.app+'/Contents/'));
   record('server-health-identity',{port:s.port,loggedPid:found.pid,healthApp:health.app??null,healthPid:health.pid??null,ownedBundle:Boolean(owned),ownedMain:Boolean(main)});
   check(health.app==='murage'&&health.pid===found.pid&&Boolean(owned)&&Boolean(main),'OWNED_SERVER_HEALTH_IDENTITY');
   record('server-ready',{port:s.port,pid:health.pid});return true;
  },30000,'OWNED_SERVER_READY');save(s);
  const instances=(await api(s,'/api/instances')).instances;check(instances.length===1&&instances[0].instanceId==='attention-fixture'&&instances[0].driverKind==='claudeAgent'&&instances[0].models.options.some(x=>x.id==='claude-sonnet-5'),'SYNTHETIC_INSTANCE_IDENTITY');
  const roster=(await api(s,'/api/bots?messages=0')).bots;check(Object.values(s.bots).every(b=>roster.some(x=>x.id===b.id&&x.threadId===b.threadId)),'OWNED_DATA_DIR');
  await press(s.pid,'App settings');const t=await settingsTree(s.pid,'notification-settings');if(texts(t).some(x=>x==='Request notification permission'))await press(s.pid,'Request notification permission');
  await until(()=>{const rendered=texts(tree(s.pid,'notification-permission-requested'));check(!rendered.some(x=>x.includes('Notification permission is blocked.')),'RENDERER_NOTIFICATION_PERMISSION_DENIED');check(!rendered.some(x=>x.includes('Notification permission controls are unavailable')),'RENDERER_NOTIFICATION_PERMISSION_UNAVAILABLE');return rendered.some(x=>x.includes('Notification permission is granted.'));},10000,'RENDERER_NOTIFICATION_PERMISSION');await press(s.pid,'Close settings');
  for(const kind of ['banner','private','mute','quiet','dnd']){
   check(!stopping,'SCRIPT_DEADLINE');if(kind==='private')await settings(s,{'Show notification previews':false});if(kind==='mute')await settings(s,{'Show notification previews':true,'Needs your attention':false});if(kind==='quiet')await settings(s,{'Needs your attention':true,'Quiet hours':true});if(kind==='dnd'){await settings(s,{'Quiet hours':false});await dnd(s,true);}
   const {marker,item}=await trigger(s,kind);
   if(['banner','private'].includes(kind)){
    const observed=await until(()=>{const n=notice(s,'waiting-'+kind);if(n.text.includes(marker))return n;const permission=ax(systemPid('NotificationCenter'),{op:'allowNotificationPermission'});if(permission.ok)record('OS-notification-consent',permission);return false;},20000,'NATIVE_BANNER_'+kind);shot('visible-'+kind);
    if(kind==='private')check(!observed.text.includes(s.bots[kind].name)&&!observed.text.includes('B35_SYNTHETIC_NO_EXECUTION_private_'),'PRIVATE_PREVIEW');
    if(kind==='banner'){const clicked=ax(systemPid('NotificationCenter'),{op:'pressNotification',marker});record('native-click',clicked);check(clicked.ok,'NATIVE_CLICK');await until(()=>{const n=ax(s.pid,{op:'count',roles:['AXTextArea','AXTextField'],label:'Message '+s.bots[kind].name});return n.ok&&n.count===1;},10000,'CLICK_EXACT_THREAD');await exactRequestCard(s,kind);shot('native-click-exact-thread');const current=await pending(s,kind,5000);check(current.pending&&current.sourceLabel===item.sourceLabel&&!existsSync(path.join(s.control,'decision-'+kind+'.json')),'CLICK_NOT_APPROVAL');}
    record('native-banner',{kind,marker,sourceLabel:item.sourceLabel,requestId:null,visible:true});
   }else await sampleNoBanner(s,marker,kind);
   await resolveDeny(s,kind);if(kind==='dnd')await dnd(s,false);
  }
  s.machineChecksComplete=true;save(s);record('machine-complete',{sound:{resourceVerified:true,requestedNativeSound:'murage-approval.wav',audibility:'NOT_ESTABLISHED',reason:'No identified human listener or supported system-audio capture receipt'},permissionDeniedOS:'NOT_EXERCISED',otherOperatingSystems:'NOT_EXERCISED',fullB35Acceptance:false});
 }finally{clearTimeout(timer);}
}
async function cleanup(){
 if(!existsSync(STATE)){record('cleanup',{status:'NOT_STARTED'});return;}const s=load();let dndRestored=s.originalDnd===undefined&&!s.dndMutationStarted;try{if(s.originalDnd!==undefined)dndRestored=(await dnd(s,s.originalDnd))===s.originalDnd;}catch(e){record('DND-restore-failed',{error:e.message});}
 if(s.pid)try{key(s.pid,'quit');}catch{}
 await pause(1000);const owned=ps().filter(p=>p.command.includes(s.app+'/')||p.command.includes(s.private+path.sep));for(const p of owned)if(p.pid!==process.pid)try{process.kill(p.pid,'SIGTERM');}catch{}
 let ownedProcessesGone=false;try{await until(()=>ps().filter(p=>p.pid!==process.pid&&(p.command.includes(s.app+'/')||p.command.includes(s.private+path.sep))).length===0,15000,'OWNED_PROCESSES_EXIT');ownedProcessesGone=true;}catch(error){record('process-cleanup-failed',{error:error.message});}
 const keychain=s.keychainIsolation?cleanupKeychain({runner:run,state:s.keychainIsolation,exists:existsSync}):{ok:true};
 if(existsSync(path.join(s.private,'app.log')))writeFileSync(path.join(E,'app-redacted.log'),redactSecretsInLine(readFileSync(path.join(s.private,'app.log'),'utf8')).slice(-20000),{mode:0o600});
 const result={ownedProcessesGone,dndRestored,keychain,machineChecksComplete:s.machineChecksComplete===true,audioAudibility:'NOT_ESTABLISHED',fullB35Acceptance:false};record('cleanup',result);check(ownedProcessesGone&&dndRestored&&keychain.ok,'CLEANUP_POSTCONDITIONS');
 for(const dir of [s.private,s.appDir,s.data,s.userData,s.tmp]){check(dir.startsWith(ROOT+path.sep),'CLEANUP_PATH');rmSync(dir,{recursive:true,force:true});}save({...s,cleanupComplete:true});
}
try{await({admit,prepare,run:journey,cleanup})[phase]();record('phase-complete');}catch(error){record('phase-failed',{gate:error.gate??null,error:redactSecretsInLine(error.message)});try{shot('failed-'+phase);}catch{}process.exitCode=1;}
