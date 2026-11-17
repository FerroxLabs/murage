import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import * as guard from './release-guard.mjs';
const env={GITHUB_REPOSITORY:'o/r',GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'2'};
const stage={name:'Stage and verify the release assets',status:'completed',conclusion:'success',run_id:123,run_attempt:2};
const assemble={name:'Release the verified assets',status:'in_progress',run_id:123,run_attempt:2,steps:[{name:'Probe release token before builds',status:'completed',conclusion:'success'}]};
function runner(snapshots) {
 const calls=[];
 return {calls,run:(command,args)=>{calls.push([command,args]);return {status:0,stdout:'HTTP/2.0 200 OK\r\n\r\n'+JSON.stringify({total_count:1,jobs:[snapshots.shift()]})};}};
}
it('probe and stage barriers query only this run attempt',()=>{
 for(const [kind,job] of [['probe',assemble],['stage',stage]]) {
  const f=runner([job]); guard.waitForReleaseBarrier(kind,env,f.run,2);
  expect(f.calls[0][1]).toContain('repos/o/r/actions/runs/123/attempts/2/jobs?per_page=100&page=1');
 }
});
it('waits for the probe step to finish before opening the build gate',()=>{
 const f=runner([{...assemble,steps:[]},assemble]);
 guard.waitForReleaseBarrier('probe',env,f.run,2); expect(f.calls).toHaveLength(2);
});
it.each(['failure','cancelled','skipped'])('failed probe never opens the build gate: %s',conclusion=>{
 const f=runner([{...assemble,steps:[{...assemble.steps[0],conclusion}]}]);
 expect(()=>guard.waitForReleaseBarrier('probe',env,f.run,2)).toThrow(/probe/);
});
it.each(['failure','cancelled','skipped'])('failed staging never reaches download/upload: %s',conclusion=>{
 const f=runner([{...stage,conclusion}]);
 expect(()=>guard.waitForReleaseBarrier('stage',env,f.run,2)).toThrow(/stage/);
});
it('stale attempt and missing probe fail closed after a bounded wait',()=>{
 const f=runner([{...assemble,run_attempt:1},{...assemble,steps:[]}]);
 expect(()=>guard.waitForReleaseBarrier('probe',env,f.run,2)).toThrow(/timed out/);
});
it('release DAG starts the sole writer early and all platforms wait for its probe',()=>{
 const jobs=parse(readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8')).jobs;
 expect(jobs.assemble.needs).toEqual(['prepare']);
 const commands=jobs.assemble.steps.map(s=>s.run);
 expect(commands.indexOf('node scripts/release-guard.mjs probe-prepared')).toBeGreaterThan(1);
 expect(commands.indexOf('node scripts/release-guard.mjs probe-prepared')).toBeLessThan(commands.indexOf('node scripts/release-guard.mjs wait-stage'));
 expect(jobs.preflight.needs).toEqual(['prepare']);
 expect(jobs.preflight.steps.at(-1).run).toBe('node scripts/release-guard.mjs wait-probe');
 for(const id of ['mac','mac-x64','windows','linux']) expect(jobs[id].needs).toContain('preflight');
 expect(jobs.stage.needs).toEqual(expect.arrayContaining(['ci-gate','mac','mac-x64','windows','linux']));
 expect(jobs['abort-on-ci-failure']).toBeUndefined();
 expect(jobs.linux.permissions).toEqual({contents:'read'});
});

it('G-B publish waits for its independent extraction in this exact attempt', () => {
 const extraction = {...stage, name:'Fresh SAC extraction for publish'};
 const f=runner([{...extraction,status:'in_progress'},extraction]);
 guard.waitForReleaseBarrier('extract-publish',env,f.run,2);
 expect(f.calls).toHaveLength(2);
 expect(f.calls[0][1]).toContain('repos/o/r/actions/runs/123/attempts/2/jobs?per_page=100&page=1');
});
it.each(['failure','cancelled','skipped'])('G-B extraction %s stops publish', conclusion => {
 const f=runner([{...stage,name:'Fresh SAC extraction for publish',conclusion}]);
 expect(()=>guard.waitForReleaseBarrier('extract-publish',env,f.run,2)).toThrow(/extract-publish/);
});
it('G-B stage carries its protected pins and consumes the stage artifact', () => {
 const jobs=parse(readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8')).jobs;
 const gate=jobs.stage.steps.find(step=>step.run==='node scripts/windows-sac-stage-gate.mjs');
 expect(gate.env.SHA).toBe('${{ needs.prepare.outputs.sha }}');
 expect(gate.env.MURAGE_WINDOWS_SAC_CANDIDATE_SHA256).toBe('${{ vars.MURAGE_WINDOWS_SAC_CANDIDATE_SHA256 }}');
 expect(jobs.stage.steps.some(step=>step.with?.name==='sac-extract-stage-${{ github.run_attempt }}')).toBe(true);
 expect(jobs.assemble.needs).toEqual(['prepare']);
 expect(jobs.assemble.permissions).toEqual({contents:'write',actions:'read'});
});
