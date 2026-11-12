// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { prepareHistoricalTestFixtures } from './prepare-historical-test-fixtures.mjs';
import { removeTempDirSync } from '../server/testing/cleanup.ts';
it('stages exact historical bytes despite export-ignore and never substitutes current source', () => {
  const root=mkdtempSync(join(tmpdir(),'historical-fixture-test-'));
  try {
    const repo=join(root,'repo'),out=join(root,'fixtures');mkdirSync(repo);mkdirSync(out);
    const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
    git('init','-q');mkdirSync(join(repo,'server'));
    writeFileSync(join(repo,'.gitattributes'),'/server export-ignore\n');writeFileSync(join(repo,'server/inspector.ts'),'export const version = 101;\n');
    git('add','.');git('-c','user.name=fixture','-c','user.email=fixture@example.test','commit','-qm','released');const revision=git('rev-parse','HEAD');
    writeFileSync(join(repo,'server/inspector.ts'),'export const version = 999;\n');git('add','.');git('-c','user.name=fixture','-c','user.email=fixture@example.test','commit','-qm','current');
    prepareHistoricalTestFixtures({repository:repo,destination:out,pins:{'.v101-ref':revision}});
    expect(readFileSync(join(out,'.v101-ref/server/inspector.ts'),'utf8')).toBe('export const version = 101;\n');
    expect(readFileSync(join(out,'.v101-ref/.fixture-revision'),'utf8').trim()).toBe(revision);
    expect(()=>prepareHistoricalTestFixtures({repository:repo,destination:out,pins:{'.v101-ref':'0'.repeat(40)}})).toThrow('absent');
    expect(()=>prepareHistoricalTestFixtures({repository:repo,destination:out,pins:{'.git':revision}})).toThrow('Invalid');
  } finally {removeTempDirSync(root);}
});
