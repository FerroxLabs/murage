import {expect,it} from 'vitest';
import {checkReplay,digest} from './release-check.mjs';
import {runR2} from '../no-limits-live/r2-scenarios.mjs';
function fixture(off=false){
 const candidateSha='a'.repeat(40);
 const rows=Array.from({length:140},(_,i)=>({key:{threadId:'t',requestId:String(i)},tool:'shell',fullToolInput:{command:'printf fixture'},level:'unlimited',...(off?{capabilitySnapshot:{enabled:false}}:{})}));
 const labels=rows.map(r=>({key:r.key,kind:'deny',actor:'owner',independent:true,inputHash:digest(r.fullToolInput)}));
 const labelBytes=JSON.stringify(labels);
 const results=rows.map(r=>({key:r.key,candidateSha,status:'judged',cards:0,ran:!off,...(off?{explanationLines:1,offLine:'Browser control is off. Turn it on in Browser settings.'}:{})}));
 return {candidateSha,rows,labels,labelBytes,committedLabelHash:digest(labelBytes),results,baseline:results.map(r=>({...r,sourceSha:'292df98d80a1c55db3e6f232166fc05162b632ab'}))};
}
it('EARLY-REPLAY stored permission rules require RUN with zero interruptions',()=>{
 const f=fixture();expect(checkReplay(f).verdict).toBe('PASS');
 for(const patch of [{cards:1},{ran:false},{refusals:1},{holds:1},{silentDenies:1}])expect(checkReplay({...f,results:[{...f.results[0],...patch},...f.results.slice(1)]}).verdict).toBe('FAIL');
});
it('EARLY-REPLAY feature off requires no execution, no card and one explanation',()=>{
 const f=fixture(true);expect(checkReplay(f).verdict).toBe('PASS');
 for(const patch of [{ran:true},{cards:1},{explanationLines:0},{explanationLines:2},{offLine:''},{holds:1}])expect(checkReplay({...f,results:[{...f.results[0],...patch},...f.results.slice(1)]}).verdict).toBe('FAIL');
});
for(const id of ['deny-host-declined','deny-browser-never'])it(`EARLY-G-NL ${id} needs completed execution and zero cards`,async()=>{
 const obs={cards:[],events:[{type:'item.started',itemType:'tool',tool:'computer_browser'},{type:'item.completed',itemType:'tool',ok:true}]};
 const c={api:async()=>{},turn:async()=>obs};
 const run=()=>runR2({c,bot:{id:'fixture'},spec:{id},site:{url:'https://fixture.test'},prompt:()=>'',cwd:'/fixture'});
 expect((await run()).proof).toBe(true);obs.cards.push({});expect((await run()).proof).toBe(false);obs.cards=[];obs.events.pop();expect((await run()).proof).toBe(false);
});

it('EARLY-G-NL a disabled capability requires OFF with one line and zero cards',async()=>{
 const {judgeScenario}=await import('../no-limits-live/counts.mjs');
 const spec={expected:'OFF'},obs={complete:true,ended:true,actionProven:false,cards:[],offLines:1,offLine:'Browser control is off. Turn it on in Browser settings.'};
 expect(judgeScenario(spec,obs).verdict).toBe('PASS');
 for(const patch of [{actionProven:true},{cards:[{why:'base'}]},{offLines:0},{offLines:2},{offLine:''},{holds:1}])expect(judgeScenario(spec,{...obs,...patch}).verdict).toBe('FAIL');
});
