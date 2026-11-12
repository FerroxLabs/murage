import {expect,it} from 'vitest';
import {GATE_FILES,gateResult} from './verify-gate.mjs';
const report=()=>({success:true,testResults:GATE_FILES.map(file=>({name:'/work/'+file,status:'passed',assertionResults:[{status:'passed'}]}))});
it('B3 the mandatory gate requires all twenty HANDOFF S1 files and every assertion passing',()=>{
 expect(GATE_FILES).toHaveLength(20);expect(new Set(GATE_FILES).size).toBe(20);
 expect(gateResult(report()).complete).toBe(true);
 for(const file of GATE_FILES){
  const missing=report();missing.testResults=missing.testResults.filter(r=>!r.name.endsWith(file));expect(gateResult(missing).complete,file).toBe(false);
  for(const state of ['failed','pending','skipped']){const bad=report();bad.testResults.find(r=>r.name.endsWith(file))!.assertionResults[0].status=state;expect(gateResult(bad).complete,file+' '+state).toBe(false);}
 }
 const empty=report();empty.testResults[0].assertionResults=[];expect(gateResult(empty).complete).toBe(false);
});
