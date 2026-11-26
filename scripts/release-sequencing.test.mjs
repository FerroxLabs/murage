import { expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import * as guard from './release-guard.mjs';
const env={GITHUB_REPOSITORY:'o/r',GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'2'};
const stage={name:'Stage and verify the release assets',status:'completed',conclusion:'success',run_id:123,run_attempt:2};
const assemble={name:'Release the verified assets',status:'in_progress',run_id:123,run_attempt:2,steps:[{name:'Probe release token before builds',status:'completed',conclusion:'success'}]};
function runner(snapshots) {
 const calls=[];
 return {calls,run:(command,args)=>{
  calls.push([command,args]);
  const jobs = [snapshots.shift()].flat();
  return {status:0,stdout:'HTTP/2.0 200 OK\r\n\r\n'+JSON.stringify({total_count:jobs.length,jobs})};
 }};
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
it('reports the current attempt CI failure when staging was skipped', () => {
 const jobs = parse(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')).jobs;
 const ci = {...stage, name: jobs['ci-gate'].name, conclusion: 'failure'};
 const skipped = {...stage, conclusion: 'skipped'};
 const f = runner([[skipped, ci]]);
 expect(() => guard.waitForReleaseBarrier('stage', env, f.run, 2))
   .toThrow('stage skipped after CI gate failure; release stopped');
 const stale = runner([[skipped, {...ci, run_attempt: 1}]]);
 expect(() => guard.waitForReleaseBarrier('stage', env, stale.run, 2))
   .toThrow('stage skipped; release stopped');
});
// Production entry: the `run:` text of the release.yml assemble wait-stage step, executed by sh from the
// repo root exactly as the runner does, with only the jobs API faked by a gh executable on PATH. SITES.md
// lists every site; each row below drives one. Asserts the diagnostic line and the process exit status.
const root = new URL('..', import.meta.url).pathname;
const release = parse(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
const waitStep = release.jobs.assemble.steps.filter(s => /release-guard\.mjs wait-stage/.test(s.run ?? ''));
const SITES = [
 ['release.yml assemble wait-stage step (workflow run: text)', () => waitStep[0]?.run],
 ['release-guard.mjs command dispatch wait-stage', () => 'node scripts/release-guard.mjs wait-stage'],
];
function waitStageCli(run, jobs) {
 const dir = mkdtempSync(join(tmpdir(), 'rseq-'));
 try {
  writeFileSync(join(dir, 'jobs.json'), JSON.stringify({total_count: jobs.length, jobs}));
  writeFileSync(join(dir, 'gh'), '#!/bin/sh\nprintf "HTTP/2.0 200 OK\\r\\n\\r\\n"\ncat "$JOBS_FILE"\n');
  chmodSync(join(dir, 'gh'), 0o755);
  const r = spawnSync('sh', ['-c', run], {
   cwd: root, encoding: 'utf8', timeout: 20000,
   env: {PATH: `${dir}:${process.env.PATH}`, JOBS_FILE: join(dir, 'jobs.json'), GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2'},
  });
  return {status: r.status, stderr: r.stderr};
 } finally { rmSync(dir, {recursive: true, force: true}); }
}
it('release.yml has exactly one wait-stage step, in the assemble job', () => {
 expect(waitStep).toHaveLength(1);
 expect(waitStep[0].run.trim()).toBe('node scripts/release-guard.mjs wait-stage');
 expect(JSON.stringify(release.jobs).split('release-guard.mjs wait-stage')).toHaveLength(2);
});
it.each(SITES)('wait-stage exits 1 naming the CI gate when staging was skipped by a failed gate: %s', (_n, runOf) => {
 const run = runOf();
 const ciName = release.jobs['ci-gate'].name;
 const skipped = {...stage, conclusion: 'skipped'};
 const ci = {...stage, name: ciName, conclusion: 'failure'};
 const hit = waitStageCli(run, [skipped, ci]);
 expect(hit.stderr).toContain('::error::stage skipped after CI gate failure; release stopped');
 expect(hit.status).toBe(1);
 const stale = waitStageCli(run, [skipped, {...ci, run_attempt: 1}]);
 expect(stale.stderr).toContain('::error::stage skipped; release stopped');
 expect(stale.stderr).not.toContain('CI gate failure');
 expect(stale.status).toBe(1);
 const failed = waitStageCli(run, [{...stage, conclusion: 'failure'}]);
 expect(failed.stderr).toContain('::error::stage failed; release stopped');
 expect(failed.status).toBe(1);
 const ok = waitStageCli(run, [stage]);
 expect(ok.status).toBe(0);
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
it('artifact-only releases keep the build gates and cannot start the release writer', () => {
 const workflow = parse(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
 const { prepare, preflight, assemble, stage } = workflow.jobs;
 const mode = prepare.steps.find(step => step.id === 'mode');
 const writeMode = "needs.prepare.outputs.artifact_only == 'false'";
 expect(workflow.on.workflow_dispatch.inputs.artifact_only).toMatchObject({ type: 'boolean', default: false });
 expect(mode.env.ARTIFACT_ONLY).toBe("${{ inputs.artifact_only || github.ref == 'refs/heads/rel/1.0.21-cand0' }}");
 expect(prepare.outputs.artifact_only).toBe('${{ steps.mode.outputs.artifact_only }}');
 expect(assemble.if).toBe(`needs.prepare.outputs.should_release == 'true' && ${writeMode}`);
 expect(preflight.steps.at(-1).if).toBe(writeMode);
 expect(stage.needs).toEqual(['prepare', 'ci-gate', 'mac', 'mac-x64', 'windows', 'linux']);
 expect(mode.env.PRIVATE_REPO).toBe('${{ github.event.repository.private }}');
 const dir = mkdtempSync(join(tmpdir(), 'release-mode-'));
 const output = join(dir, 'output');
 const selectMode = (artifactOnly, publish, privateRepo) => spawnSync('bash', ['-e', '-c', mode.run], {
  encoding: 'utf8',
  env: { ...process.env, ARTIFACT_ONLY: artifactOnly, PUBLISH: publish, PRIVATE_REPO: privateRepo, GITHUB_OUTPUT: output },
 });
 try {
  expect(selectMode('true', 'true', 'true')).toMatchObject({
   status: 1, stdout: expect.stringContaining('artifact-only runs cannot publish'),
  });
  expect(selectMode('true', 'false', 'false')).toMatchObject({
   status: 1, stdout: expect.stringContaining('artifact-only runs require a private repository'),
  });
  expect(selectMode('true', 'false', 'true').status).toBe(0);
  expect(selectMode('false', 'true', 'false').status).toBe(0);
  expect(readFileSync(output, 'utf8')).toBe('artifact_only=true\nartifact_only=false\n');
 } finally {
  rmSync(dir, { recursive: true, force: true });
 }
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
// Option A (Sean 2026-11-18T06:42Z): 1.0.19 signs as 1.0.18 shipped; controller-admitted signing + SAC
// qualification are the first post-release item. The SAC stage gate and its extraction artifact are gone,
// so this pins what is left of the sequence: stage waits for CI and every signed platform build, runs no
// SAC gate, and the sole release writer still starts from prepare alone with the same narrow permissions.
it('G-B stage waits for CI and every platform build, runs no SAC gate, and assemble stays the sole narrow writer', () => {
 const jobs=parse(readFileSync(new URL('../.github/workflows/release.yml',import.meta.url),'utf8')).jobs;
 expect(jobs.stage.needs).toEqual(['prepare','ci-gate','mac','mac-x64','windows','linux']);
 expect(JSON.stringify(jobs.stage)).not.toMatch(/windows-sac-stage-gate|sac-extract-stage|MURAGE_WINDOWS_SAC_/);
 expect(jobs.stage.permissions?.contents).not.toBe('write');
 expect(jobs.assemble.needs).toEqual(['prepare']);
 expect(jobs.assemble.permissions).toEqual({contents:'write',actions:'read'});
});
