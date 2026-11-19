// SPDX-License-Identifier: AGPL-3.0-or-later
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {expect,it} from 'vitest';
import config from '../vite.config.ts';
import {removeTempDirSync} from '../server/testing/cleanup.ts';

it('a runner without CI cannot silently write a missing snapshot',()=>{
 const root=mkdtempSync(join(tmpdir(),'truth-no-update-'));
 try {
  writeFileSync(join(root,'vite.config.mjs'),`export default {test:{update:${JSON.stringify(config.test.update)},include:['*.test.mjs']}}`);
  writeFileSync(join(root,'missing.test.mjs'),"import {expect,it} from 'vitest';it('snapshot',()=>expect({policy:'wipe-only'}).toMatchSnapshot());");
  // Resolve Vitest from the job's dependency copy while keeping fixture data isolated.
  const moduleRoot=resolve('node_modules');
  // Vitest resolves a test's import relative to the temporary test file.
  symlinkSync(moduleRoot,join(root,'node_modules'),'junction');
  const env={...process.env};delete env.CI;
  const run=(...args)=>spawnSync(process.execPath,[resolve('node_modules/vitest/vitest.mjs'),'run','--root',root,'--config',join(root,'vite.config.mjs'),...args],{env,encoding:'utf8'});
  const snapshot=join(root,'__snapshots__/missing.test.mjs.snap');
  const missing=run();expect(missing.status,missing.stdout+missing.stderr).toBe(1);expect(existsSync(snapshot)).toBe(false);
  const record=run('--update');expect(record.status,record.stdout+record.stderr).toBe(0);
  const bytes=readFileSync(snapshot,'utf8');expect(bytes).toContain('wipe-only');
  const stable=run();expect(stable.status,stable.stdout+stable.stderr).toBe(0);expect(readFileSync(snapshot,'utf8')).toBe(bytes);
 }finally{removeTempDirSync(root);}
},45_000);
