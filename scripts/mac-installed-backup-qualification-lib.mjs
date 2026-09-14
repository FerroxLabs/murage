// Pure, injectable helpers for scripts/mac-installed-backup-qualification.mjs.
// No top-level side effects: synthetic tests exercise these without a runner,
// Keychain, launchd or the packaged app.
import {spawnSync} from "node:child_process";

export const COMMAND_MAX_BUFFER=16*1024*1024;
const code=error=>typeof error?.code==="string"&&/^[A-Z][A-Z0-9_]{0,60}$/.test(error.code)?error.code:error?"COMMAND_ERROR":null;
/** Bounded, never-throwing command primitive. stdout, stderr and status are kept
 * for success AND failure (codesign/spctl report on stderr when they succeed). */
export function runCommand(command,argv,{input,timeout=120000,env,spawn=spawnSync}={}){
  let result;
  try{result=spawn(command,argv,{input,timeout,env,encoding:"utf8",stdio:["pipe","pipe","pipe"],maxBuffer:COMMAND_MAX_BUFFER});}
  catch(error){return{code:null,signal:null,stdout:"",stderr:"",timedOut:false,error:code(error)};}
  return{code:typeof result.status==="number"?result.status:null,signal:result.signal??null,stdout:String(result.stdout??""),stderr:String(result.stderr??""),timedOut:result.error?.code==="ETIMEDOUT",error:code(result.error)};
}

export const SECURITY="/usr/bin/security";
export const KEYCHAIN_OWNER="murage-installed-qualification";
export const KEYCHAIN_STEPS=["created","unlocked","settings","searchList","default"];
const unquote=line=>line.trim().replace(/^"|"$/g,"");
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function readKeychainState(runner){
  const current=runner(SECURITY,["default-keychain","-d","user"]),list=runner(SECURITY,["list-keychains","-d","user"]);
  if(current.code!==0||list.code!==0)return null;
  return{defaultKeychain:unquote(current.stdout),searchList:list.stdout.split("\n").map(unquote).filter(Boolean)};
}
export const planKeychainIsolation=({keychain})=>({version:1,owner:KEYCHAIN_OWNER,keychain,original:null,preexisting:null,completed:[]});
/** Original default + search list and task path are persisted BEFORE the first
 * mutation; each completed step is persisted after it succeeds. The password is
 * stdin-only (`security -i`) and redacted from any returned diagnostic. */
export function setupKeychain({runner,persist,exists,keychain,password}){
  const state=planKeychainIsolation({keychain}),redact=text=>String(text??"").split(password).join("<redacted>").slice(0,300);
  const original=readKeychainState(runner);if(!original){persist(state);return{ok:false,failed:"read-original",state};}
  state.original=original;state.preexisting=exists(keychain);persist(state);
  if(state.preexisting)return{ok:false,failed:"keychain-preexisting",state};
  const interactive=(step,command)=>()=>{const r=runner(SECURITY,["-i"],{input:`${command} -p "${password}" "${keychain}"\n`});return{...r,ok:r.code===0&&r.stderr.trim()===""&&(step!=="created"||exists(keychain))};};
  const direct=argv=>()=>{const r=runner(SECURITY,argv);return{...r,ok:r.code===0};};
  const steps={created:interactive("created","create-keychain"),unlocked:interactive("unlocked","unlock-keychain"),settings:direct(["set-keychain-settings",keychain]),searchList:direct(["list-keychains","-d","user","-s",keychain]),default:direct(["default-keychain","-d","user","-s",keychain])};
  for(const step of KEYCHAIN_STEPS){
    const r=steps[step]();if(!r.ok)return{ok:false,failed:step,code:r.code,stderr:redact(r.stderr),state};
    state.completed=[...state.completed,step];persist(state);
  }
  return{ok:true,state};
}
/** Attempts every applicable restoration regardless of earlier failures, then
 * re-reads and verifies; ok only when every required postcondition holds. */
export function cleanupKeychain({runner,state,exists}){
  if(!state||state.owner!==KEYCHAIN_OWNER||typeof state.keychain!=="string")return{ok:false,reason:"no-owned-state",results:[],verified:null};
  if(!state.original)return{ok:true,reason:"no-mutation",results:[],verified:null};
  const {original,keychain}=state,results=[];
  const attempt=(step,argv)=>{const r=runner(SECURITY,argv);results.push({step,code:r.code,stderr:String(r.stderr??"").slice(0,300)});};
  attempt("restore-search-list",["list-keychains","-d","user","-s",...original.searchList]);
  attempt("restore-default",["default-keychain","-d","user","-s",original.defaultKeychain]);
  if(!state.preexisting&&exists(keychain))attempt("delete-task-keychain",["delete-keychain",keychain]);
  const after=readKeychainState(runner);
  const verified={stateReadable:Boolean(after),searchListRestored:Boolean(after)&&same(after.searchList,original.searchList),defaultRestored:Boolean(after)&&after.defaultKeychain===original.defaultKeychain,taskKeychainAbsent:state.preexisting?false:!exists(keychain),taskKeychainNotSearched:Boolean(after)&&!after.searchList.includes(keychain)};
  return{ok:Object.values(verified).every(Boolean),results,verified};
}

export const SETTINGS_ENTRY_LABEL="App settings";
/** Admits the Settings entry only when the captured AX snapshot contains exactly
 * one AXButton whose name/title/description is exactly the source label
 * (src/components/Sidebar.tsx:2135-2136,2153). Never guesses. */
export function admitSettingsEntry(snapshot,label=SETTINGS_ENTRY_LABEL){
  if(!Array.isArray(snapshot))return{ok:false,reason:"snapshot-invalid",count:0};
  const named=snapshot.filter(entry=>entry&&Array.isArray(entry.names)&&entry.names.includes(label)),buttons=named.filter(entry=>entry.role==="AXButton");
  if(buttons.length===1)return{ok:true,label,roles:["AXButton"],count:1};
  return{ok:false,reason:buttons.length>1?"duplicate":named.length?"wrong-role":"absent",count:buttons.length,otherRoles:[...new Set(named.map(entry=>entry.role))].filter(role=>role!=="AXButton")};
}
