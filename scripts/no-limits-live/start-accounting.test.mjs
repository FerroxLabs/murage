// Runs unchanged on 94413898d: imports only modules that existed at the start.
import { expect, it } from 'vitest';
import { releaseVerdict } from './counts.mjs';
import { scenarios, engineSpecs } from './scenarios.mjs';
it('BLOCK8 start-commit oracle rejects a complete matrix with an unrecorded queue presentation', () => {
 const engines = engineSpecs.map(e => ({id:e.id,status:'PASS'}));
 const rows = engines.flatMap(e=>scenarios.map(s=>({engine:e.id,id:s.id,verdict:'PASS',
  accounting:{verdict:'FAIL',errors:['queue without record']}})));
 const report={engines,rows,errors:[],baselineComparison:{verdict:'PASS'},containment:{container:true,network:'allowlist',probe:{attempted:true,host:'192.0.2.1',blocked:true}}};
 expect(releaseVerdict(report,true)).toBe('FAIL');
});
