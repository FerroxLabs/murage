import type { Routine } from "./routines";
export interface ProcedureVersion {
  revision:string|null; description:string; createdAt:string|number;
  origin?:string; rollbackOf?:string; sha256?:string; text?:string;
}
export interface ProcedureHistory {
  currentRevision:string|null; current?:ProcedureVersion;
  revisions:ProcedureVersion[]; expectedUpdatedAt?:number;
}
export type HistoryRequest=(path:string,init?:RequestInit)=>Promise<any>;
export interface HistorySource { load():Promise<ProcedureHistory>; restore(history:ProcedureHistory,target:ProcedureVersion):Promise<void> }
export function skillHistorySource(request:HistoryRequest,botId:string,name:string,scope:{kind:"global"}|{kind:"task";threadId:string|null}):HistorySource {
  const base=`/api/bots/${encodeURIComponent(botId)}/skills/${encodeURIComponent(name)}`;
  const thread=()=>{if(scope.kind==="task"&&!scope.threadId)throw new Error("Select a task to inspect its audience. Global history was not opened.");return scope.kind==="task"?scope.threadId:undefined;};
  return {
    load:()=>{const threadId=thread();return request(`${base}/history${threadId?`?threadId=${encodeURIComponent(threadId)}`:""}`);},
    restore:async(history,target)=>{const threadId=thread();if(!history.currentRevision||!target.revision)throw Error("Current version is unavailable");await request(`${base}/rollback`,{method:"POST",body:JSON.stringify({expectedRevision:history.currentRevision,targetRevision:target.revision,...(threadId?{threadId}:{})})});},
  };
}
export function routineHistory(routine:Routine):ProcedureHistory {
  const entries=(routine.instructionHistory??[]).map(item=>({revision:item.id,description:item.prompt,text:item.prompt,createdAt:item.createdAt,origin:item.author,rollbackOf:item.rollbackOf}));
  return {currentRevision:routine.instructionRevision??null,current:entries.find(item=>item.revision===routine.instructionRevision),revisions:entries.filter(item=>item.revision!==routine.instructionRevision),expectedUpdatedAt:routine.updatedAt};
}
export function routineHistorySource(request:HistoryRequest,id:string,onRestored:(routine:Routine)=>void):HistorySource {
  return {load:async()=>{const result=await request("/api/routines");const routine=(result.routines as Routine[]).find(item=>item.id===id);if(!routine)throw Error("This routine is no longer available");return routineHistory(routine);},
    restore:async(history,target)=>{if(!history.currentRevision||!target.revision||history.expectedUpdatedAt===undefined)throw Error("Current instruction version is unavailable");const result=await request(`/api/routines/${encodeURIComponent(id)}/instructions/rollback`,{method:"POST",body:JSON.stringify({expectedRevision:history.currentRevision,expectedUpdatedAt:history.expectedUpdatedAt,targetRevision:target.revision})});onRestored(result.routine);}};
}
export function versionOrigin(origin?:string):string {
  return ({owner:"Owner-authored",learned:"Learned",evaluated:"Evaluated improvement",rollback:"Restored version",imported:"Imported",unknown:"Origin not recorded"} as Record<string,string>)[origin??""]??"Origin not recorded";
}
export interface HistoryState { phase:"idle"|"loading"|"ready"|"failed"; history:ProcedureHistory|null; busy:boolean; conflict:boolean; error:string; notice:string }
export function createHistoryStore(source:HistorySource) {
  let state:HistoryState={phase:"idle",history:null,busy:false,conflict:false,error:"",notice:""},generation=0;
  const listeners=new Set<()=>void>();
  const set=(patch:Partial<HistoryState>)=>{state={...state,...patch};listeners.forEach(listener=>listener());};
  const load=async()=>{const token=++generation;set({phase:"loading",error:""});try{const history=await source.load();if(token===generation)set({phase:"ready",history,conflict:false});}catch(error){if(token===generation)set({phase:"failed",error:error instanceof Error?error.message:String(error)});}};
  return {subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},getSnapshot:()=>state,load,
    restore:async(target:ProcedureVersion)=>{
      if(state.busy||state.conflict||state.phase!=="ready"||!state.history?.currentRevision||!target.revision||target.revision===state.history.currentRevision)return;
      const history=state.history,token=++generation;set({busy:true,error:"",notice:""});
      try{await source.restore(history,target);if(token!==generation)return;set({notice:"Version restored for future tasks."});await load();}
      catch(error){if(token===generation)set({conflict:typeof error==="object"&&error!==null&&"status" in error&&error.status===409,error:typeof error==="object"&&error!==null&&"status" in error&&error.status===409?"This procedure changed or its supporting evidence is no longer available. Refresh versions before choosing again.":error instanceof Error?error.message:String(error)});}
      finally{set({busy:false});}
    }};
}
