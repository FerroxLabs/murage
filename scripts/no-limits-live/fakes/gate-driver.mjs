// Inert in-process engine for qualifying ingress wiring. It requests one
// fixed operation and records the product's receipt; it never executes it.
import { randomUUID } from 'node:crypto';
export const gateDriver={
  driverKind:'gnlFake',metadata:{displayName:'G-NL inert fixture'},
  models:{default:'fixture',options:[{id:'fixture',label:'Fixture'}]},
  decodeConfig:raw=>raw??{},defaultConfig:()=>({}),
  async create(input) {
    const listeners=new Set(),active=new Map();
    const emit=e=>{for(const fn of [...listeners])fn({eventId:randomUUID(),provider:'gnlFake',providerInstanceId:input.instanceId,createdAt:new Date().toISOString(),...e});};
    const finish=(threadId,entry,allowed)=>{
      emit({type:'item.completed',itemType:'tool',itemId:entry.requestId,tool:'Bash',ok:allowed,threadId,turnId:entry.turnId});
      active.delete(threadId);emit({type:'turn.completed',ok:true,threadId,turnId:entry.turnId});
    };
    const instance={instanceId:input.instanceId,driverKind:'gnlFake',displayName:input.displayName,enabled:input.enabled,
      models:{default:'fixture',options:[{id:'fixture',label:'Fixture'}]},snapshot:async()=>({state:'available',version:'fixture'}),
      adapter:{provider:'gnlFake',capabilities:{sessionModelSwitch:'unsupported',fencedWrites:true,agentsMcp:true},
        async sendTurn(turn) {
          const turnId=randomUUID(),requestId=randomUUID(),entry={turnId,requestId};active.set(turn.threadId,entry);
          emit({type:'turn.started',threadId:turn.threadId,turnId});
          setTimeout(()=>{
            if(active.get(turn.threadId)!==entry)return;
            try{turn.beforeSubmit?.();}catch{active.delete(turn.threadId);emit({type:'turn.completed',ok:false,stopReason:'submission_refused',threadId:turn.threadId,turnId});return;}
            emit({type:'item.started',itemType:'tool',itemId:requestId,title:'Bash',toolIdentity:{name:'Bash'},threadId:turn.threadId,turnId});
            emit({type:'request.opened',requestType:'permission',tool:'Bash',summary:'Fixed inert fixture operation',
              toolCall:{name:'Bash',input:{command:'printf fixture',cwd:turn.cwd}},requestId,threadId:turn.threadId,turnId});
          },25);
          return {turnId};
        },
        async respondToRequest(threadId,requestId,answer) {
          const entry=active.get(threadId);if(!entry||entry.requestId!==requestId)return 'unavailable';
          finish(threadId,entry,answer.behavior==='allow');return 'applied';
        },
        async interruptTurn(threadId) {const entry=active.get(threadId);if(entry){active.delete(threadId);emit({type:'turn.completed',ok:false,stopReason:'interrupted',threadId,turnId:entry.turnId});}},
        hasSession:()=>false,onEvent:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},stopAll:async()=>active.clear(),
      },dispose:async()=>{listeners.clear();active.clear();},
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
