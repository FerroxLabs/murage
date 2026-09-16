import {createHash} from 'node:crypto';
import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {userInfo} from 'node:os';
export const NC_BUNDLE_ID='com.apple.notificationcenterui';
export const NC_PLIST='/System/Library/LaunchAgents/com.apple.notificationcenterui.plist';
export const NC_APP='/System/Library/CoreServices/NotificationCenter.app';
const NC_EXE=NC_APP+'/Contents/MacOS/NotificationCenter';
const requireValue=(ok,code)=>{if(!ok)throw Error(code);};
const validServiceIdentity=id=>id&&/^com\.apple\.notificationcenterui(?:\.agent)?$/.test(id.label)&&id.plist===NC_PLIST&&id.executable===NC_EXE&&id.bundleId===NC_BUNDLE_ID&&id.appleSignatureVerified===true;
export function notificationDisabledOverride(output,label){
 requireValue(typeof output==='string'&&output.includes('disabled services = {'),'NC_DISABLED_UNREADABLE');
 const matches=[];
 for(const line of output.split(/\r?\n/)){
  const entry=/^\s*"([^"\r\n]+)"\s*=>\s*(.*?)\s*$/.exec(line);
  if(entry&&entry[1]===label)matches.push(entry[2]);
  else if(line.includes(JSON.stringify(label)))throw Error('NC_DISABLED_ENTRY_UNRECOGNIZED');
 }
 requireValue(matches.length<=1,'NC_DISABLED_AMBIGUOUS');
 if(!matches.length)return null;
 requireValue(['true','false','enabled','disabled'].includes(matches[0]),'NC_DISABLED_VALUE_UNRECOGNIZED');
 return matches[0]==='true'||matches[0]==='disabled';
}
export function notificationServiceState(run,uid,identity){
 requireValue(validServiceIdentity(identity),'NC_SERVICE_IDENTITY_REQUIRED');const label=identity.label;
 const domain='gui/'+uid,target=domain+'/'+label;
 const disabled=run('/bin/launchctl',['print-disabled',domain],{timeout:5000});requireValue(disabled.code===0,'NC_DISABLED_UNREADABLE');
 const value=notificationDisabledOverride(disabled.stdout,label);
 const printed=run('/bin/launchctl',['print',target],{timeout:5000});
 if(printed.code!==0){requireValue(printed.code===113&&printed.stderr.includes('Could not find service "'+label+'"')&&printed.stderr.includes(String(uid)),'NC_JOB_UNREADABLE');return{disabled:value,loaded:false,pid:null};}
 const text=printed.stdout;requireValue(text.startsWith(target+' = {')&&/^\s*path = \/System\/Library\/LaunchAgents\/com\.apple\.notificationcenterui\.plist\s*$/m.test(text)&&/^\s*program = \/System\/Library\/CoreServices\/NotificationCenter\.app\/Contents\/MacOS\/NotificationCenter\s*$/m.test(text),'NC_JOB_IDENTITY');
 const pids=[...text.matchAll(/^\s*pid = ([0-9]+)\s*$/gm)];requireValue(pids.length<=1,'NC_JOB_PID_AMBIGUOUS');return{disabled:value,loaded:true,pid:pids.length?Number(pids[0][1]):null};
}
export function verifyNotificationServiceIdentity(run,{readFile=readFileSync,stat=lstatSync,realpath=realpathSync.native}={}){
 const s=stat(NC_PLIST);requireValue(s.isFile()&&!s.isSymbolicLink()&&s.uid===0&&!(s.mode&0o022)&&s.size>0&&s.size<=65536&&realpath(NC_PLIST)===NC_PLIST,'NC_PLIST_OWNERSHIP');
 const converted=run('/usr/bin/plutil',['-convert','json','-o','-',NC_PLIST],{timeout:5000});requireValue(converted.code===0,'NC_PLIST_UNREADABLE');let plist;try{plist=JSON.parse(converted.stdout);}catch{throw Error('NC_PLIST_UNREADABLE');}
 requireValue(typeof plist.Label==='string'&&/^com\.apple\.notificationcenterui(?:\.agent)?$/.test(plist.Label)&&(plist.Program??plist.ProgramArguments?.[0])===NC_EXE,'NC_PLIST_IDENTITY');
 const bundle=run('/usr/bin/plutil',['-extract','CFBundleIdentifier','raw','-o','-',NC_APP+'/Contents/Info.plist'],{timeout:5000});requireValue(bundle.code===0&&bundle.stdout.trim()===NC_BUNDLE_ID,'NC_BUNDLE_IDENTITY');
 const signed=run('/usr/bin/codesign',['--verify','--strict','-R','=anchor apple',NC_APP],{timeout:15000});requireValue(signed.code===0,'NC_APPLE_SIGNATURE');
 return{label:plist.Label,plist:NC_PLIST,executable:NC_EXE,bundleId:NC_BUNDLE_ID,plistSha256:createHash('sha256').update(readFile(NC_PLIST)).digest('hex'),appleSignatureVerified:true};
}
function hostGuard(run,uid){
 requireValue(process.platform==='darwin'&&process.arch==='arm64'&&process.env.GITHUB_ACTIONS==='true'&&process.env.RUNNER_ENVIRONMENT==='github-hosted'&&process.env.HOME==='/Users/runner'&&userInfo().username==='runner'&&uid===process.getuid()&&uid>0,'NC_DISPOSABLE_HOST_REQUIRED');
 requireValue(run('/bin/launchctl',['managername'],{timeout:5000}).stdout.trim()==='Aqua','NC_AQUA_REQUIRED');
}
export async function prepareNotificationCenter({run,uid,persist,record,prior,guard=hostGuard,identity=verifyNotificationServiceIdentity,pause=ms=>new Promise(r=>setTimeout(r,ms))}){
 guard(run,uid);requireValue(!prior,'NC_PRIOR_ADMISSION_EXISTS');const id=identity(run);record('notification-service-identity',{identity:id});const before=notificationServiceState(run,uid,id);record('notification-service-before',{identity:id,before});
 requireValue(!(before.loaded&&!before.pid),'NC_PREEXISTING_STOPPED_JOB');
 requireValue(before.loaded||before.disabled===true,'NC_UNLOADED_STATE_UNEXPECTED');
 const state={version:1,uid,identity:id,before,enableAttempted:false,bootstrapAttempted:false,ready:false,restored:false};persist(state);
 const mutate=(flag,args)=>{state[flag]=true;persist(state);const result=run('/bin/launchctl',args,{timeout:10000});record('notification-service-command',{action:args[0],code:result.code});requireValue(result.code===0,'NC_'+args[0].toUpperCase()+'_FAILED');};
 const target='gui/'+uid+'/'+id.label;
 if(before.disabled===true)mutate('enableAttempted',['enable',target]);
 if(!before.loaded)mutate('bootstrapAttempted',['bootstrap','gui/'+uid,NC_PLIST]);
 let observed=notificationServiceState(run,uid,id);
 if(!observed.pid&&state.bootstrapAttempted){const started=run('/bin/launchctl',['kickstart','-p',target],{timeout:10000});record('notification-service-command',{action:'kickstart-without-k',code:started.code});requireValue(started.code===0,'NC_KICKSTART_FAILED');}
 const deadline=Date.now()+15000;
 while(Date.now()<deadline){observed=notificationServiceState(run,uid,id);if(observed.loaded&&observed.pid&&observed.disabled!==true)break;await pause(250);}
 requireValue(observed.loaded&&Number.isInteger(observed.pid)&&observed.pid>0&&observed.disabled!==true,'NC_REGISTERED_PID_REQUIRED');
 const proc=run('/bin/ps',['-p',String(observed.pid),'-o','uid=,comm='],{timeout:5000}),parts=proc.stdout.trim().split(/\s+/);requireValue(proc.code===0&&parts.length===2&&parts[0]===String(uid)&&parts[1]===NC_EXE,'NC_REGISTERED_PROCESS_IDENTITY');
 state.ready=true;state.readyPid=observed.pid;state.after=observed;persist(state);record('notification-service-ready',{label:id.label,pid:observed.pid,loaded:true,disabled:observed.disabled});return state;
}
export async function restoreNotificationCenter({run,uid,state,persist,record,guard=hostGuard,identity=verifyNotificationServiceIdentity,pause=ms=>new Promise(r=>setTimeout(r,ms))}){
 if(!state)return{ok:true,changed:false,reason:'NOT_ADMITTED'};
 guard(run,uid);requireValue(state.version===1&&state.uid===uid&&validServiceIdentity(state.identity),'NC_RESTORE_IDENTITY');
 const id=identity(run);requireValue(id.plistSha256===state.identity.plistSha256&&id.label===state.identity.label,'NC_RESTORE_PLIST_CHANGED');
 const domain='gui/'+uid,target=domain+'/'+id.label,before=state.before;let now=notificationServiceState(run,uid,id);
 requireValue(before.loaded||state.bootstrapAttempted||!now.loaded,'NC_RESTORE_UNOWNED_JOB');
 // Only a job absent before this task can be removed. Never kill a pre-existing process.
 if(!before.loaded&&state.bootstrapAttempted&&now.loaded){state.bootoutAttempted=true;persist(state);const stopped=run('/bin/launchctl',['bootout',target],{timeout:10000});record('notification-service-command',{action:'restore-bootout',code:stopped.code});requireValue(stopped.code===0,'NC_RESTORE_BOOTOUT_FAILED');}
 if(state.enableAttempted){requireValue(before.disabled===true,'NC_RESTORE_DISABLED_PREIMAGE');now=notificationServiceState(run,uid,id);if(now.disabled!==true){const disabled=run('/bin/launchctl',['disable',target],{timeout:5000});record('notification-service-command',{action:'restore-disable',code:disabled.code});requireValue(disabled.code===0,'NC_RESTORE_DISABLE_FAILED');}}
 const deadline=Date.now()+5000;for(;;){now=notificationServiceState(run,uid,id);if(now.loaded===before.loaded&&now.disabled===before.disabled)break;if(Date.now()>=deadline)throw Error('NC_RESTORE_READBACK');await pause(100);}
 requireValue(!before.loaded||now.pid===before.pid,'NC_PREEXISTING_PID_CHANGED');
 state.restored=true;state.restoreAfter=now;persist(state);record('notification-service-restored',{before,after:now});return{ok:true,changed:state.enableAttempted||state.bootstrapAttempted,before,after:now};
}
