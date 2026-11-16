// Inert in-process engine for qualifying ingress wiring. It requests one
// fixed operation and records the product's receipt. The origin control may
// opt into one fixed, harmless shell write in its isolated fixture folder.
import { randomUUID } from 'node:crypto';
import {requireGatedHandle} from '../gated-handle.mjs';
export function createGateDriver(gatedHandle){
const {executeOrigin}=requireGatedHandle(gatedHandle);
return {
  driverKind:'gnlFake',metadata:{displayName:'G-NL inert fixture'},
  models:{default:'fixture',options:[{id:'fixture',label:'Fixture'}]},
  decodeConfig:raw=>raw??{},defaultConfig:()=>({}),
  async create(input) {
    const listeners=new Set(),active=new Map(),sources=new Map();
    const emit=e=>{const source=sources.get(e.turnId);const event={eventId:randomUUID(),provider:'gnlFake',providerInstanceId:input.instanceId,createdAt:new Date().toISOString(),...e};for(const fn of [...listeners])fn(event,source);if(e.type==='turn.completed')sources.delete(e.turnId);};
    const fixedOperation=input.config?.fixedOperation==='origin';
    const fixedCwd=fixedOperation&&typeof input.config?.fixedCwd==='string'?input.config.fixedCwd:undefined;
    const command=fixedOperation?'printf fixture > action.done':'printf fixture';
    const finish=(threadId,entry,allowed)=>{
      if(allowed&&fixedOperation)executeOrigin(command,entry.cwd);
      emit({type:'item.completed',itemType:'tool',itemId:entry.requestId,tool:'Bash',ok:allowed,threadId,turnId:entry.turnId});
      active.delete(threadId);emit({type:'turn.completed',ok:true,threadId,turnId:entry.turnId});
    };
    const instance={instanceId:input.instanceId,driverKind:'gnlFake',displayName:input.displayName,enabled:input.enabled,
      models:{default:'fixture',options:[{id:'fixture',label:'Fixture'}]},snapshot:async()=>({state:'available',version:'fixture'}),
      adapter:{provider:'gnlFake',capabilities:{sessionModelSwitch:'unsupported',fencedWrites:true,agentsMcp:true},
        async sendTurn(turn) {
          const turnId=randomUUID(),requestId=randomUUID(),entry={turnId,requestId,cwd:fixedCwd??turn.cwd};active.set(turn.threadId,entry);sources.set(turnId,turn.sourceContext);
          emit({type:'turn.started',threadId:turn.threadId,turnId});
          setTimeout(()=>{
            if(active.get(turn.threadId)!==entry)return;
            try{turn.beforeSubmit?.();}catch{active.delete(turn.threadId);emit({type:'turn.completed',ok:false,stopReason:'submission_refused',threadId:turn.threadId,turnId});return;}
            emit({type:'item.started',itemType:'tool',itemId:requestId,title:'Bash',toolIdentity:{name:'Bash'},input:{command,cwd:entry.cwd},threadId:turn.threadId,turnId});
            emit({type:'request.opened',requestType:'permission',tool:'Bash',summary:'Fixed inert fixture operation',
              toolCall:{name:'Bash',input:{command,cwd:entry.cwd}},requestId,threadId:turn.threadId,turnId});
          },25);
          return {turnId};
        },
        async respondToRequest(threadId,requestId,answer) {
          const entry=active.get(threadId);if(!entry||entry.requestId!==requestId)return 'unavailable';
          finish(threadId,entry,answer.behavior==='allow');return 'applied';
        },
        async interruptTurn(threadId) {const entry=active.get(threadId);if(entry){active.delete(threadId);emit({type:'turn.completed',ok:false,stopReason:'interrupted',threadId,turnId:entry.turnId});}},
        hasSession:()=>false,onEvent:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},stopAll:async()=>{active.clear();sources.clear();},
      },dispose:async()=>{listeners.clear();active.clear();sources.clear();},
    };
    const delivered=new Map();
    instance.decisionAdapter={
      async respondToRequest(threadId,requestId,answer,options) {
        const key=`${threadId}/${requestId}/${options.answerId}`,value=JSON.stringify(answer);
        if(delivered.has(key))return {state:delivered.get(key)===value?'already':'failed'};
        const result=await instance.adapter.respondToRequest(threadId,requestId,answer);
        if(result!=='applied')return {state:'failed'};
        delivered.set(key,value);return {state:'accepted'};
      },
      interruptTurn:threadId=>instance.adapter.interruptTurn(threadId),
    };
    return instance;
  },
};

}
