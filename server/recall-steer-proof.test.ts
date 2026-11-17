// Producer/consumer owner: recall-s1s2i. Steer write consumer owner: fence-pending-b.
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {expect,it,vi} from 'vitest';
import {steerWithQuoteLineage} from './steer-lineage.ts';

it('G-D6 behavior: an unknown task and undefined cursor never steer a no-receipt session',async()=>{
 // Exercise the actual route predicate, including its missing-task branch,
 // then the production steer gate with a write-observing adapter.
 const source=readFileSync(new URL('./index.ts',import.meta.url),'utf8');
 const at=source.indexOf('const steerSessionHolds = (): boolean => {');
 expect(at).toBeGreaterThan(0);
 const end=source.indexOf('// Only an engine',at);
 const code=ts.transpileModule(source.slice(at,end)+'\nreturn steerSessionHolds;', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const proof=vi.fn(()=>({kind:'fresh',reason:'no-session-lineage'}));
 const deps={steerSessionTainted:()=>false,answer:undefined,answerTurnLive:()=>true,directRuns:new Map(),threadId:'fixture-unknown',memoryDispatches:new Map(),
  currentAtStart:{id:'fixture-bot',modelSelection:{instanceId:'fixture-engine'}},store:{taskByThread:()=>undefined},proveRetainedSession:proof,
  LineageAllowance:{steer:()=>({})},sessionKeyOf:()=>({}),preparationLineageAudience:()=>({}),threadHumanPrincipal:()=>({}),turnAudienceIsOwner:()=>true,sessionHadFrame:()=>undefined,database:()=>({}),retainedSessionInvalid:()=>false};
 const holds=new Function(...Object.keys(deps),code)(...Object.values(deps)) as ()=>boolean;
 expect(holds()).toBe(false);
 const write=vi.fn(()=>true);
 // MAIN RULING 1115-RECALL-S1S2H-ITEMS E: the production gate refuses a false hold with this fixed exception.
 const delivery=await steerWithQuoteLineage({steer:write} as never,'fixture-unknown','Queued fixture line',holds(),{holds,lineage:undefined}).catch(error=>{expect(error.message).toBe('MEMORY_CONTEXT_REVOKED');return 'refused';});
 expect(delivery).not.toBe('steer');expect(write).not.toHaveBeenCalled();expect(proof).not.toHaveBeenCalled();
});
