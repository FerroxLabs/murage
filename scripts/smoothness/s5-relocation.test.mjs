// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchVerificationServer, runControlMurage } from '../control-murage.ts';
import { turnFromLog } from '../scale/rig-config.mjs';
import { stats } from '../scale/stats.mjs';
import { judgeRow } from './smooth-config.mjs';
import { loadBudgets } from './smooth-gate.mjs';

let fixture, results;
const evidenceDir = resolve(process.env.S5_EVIDENCE_DIR || '.planning/s5-evidence');
beforeAll(async () => {
  mkdirSync(evidenceDir, { recursive: true });
  // Deliberately exclude the suite's JS addon stub: this regression requires the real native relocation helper.
  const env = { ...process.env }; delete env.MURAGE_ENGINE_EXCLUSION_PATH;
  fixture = await launchVerificationServer(env, undefined, { instrumentationSource: 'process.env.MURAGE_TURN_TRACE="1";' });
  const url = fixture.info.url;
  const created = await runControlMurage(['new-bot', '--name', 'Relocation fixture', '--url', url]);
  const bot = { id: created.bot.id, threadId: created.bot.activeTaskId };
  await fixture.stop();
  const moduleUrl = file => JSON.stringify(pathToFileURL(resolve(file)).href);
  const seed = `
    import { mkdirSync, symlinkSync } from 'node:fs'; import { join } from 'node:path';
    import { stageSkillWrite, applyStagedSkillWrite } from ${moduleUrl('server/skills.ts')};
    import { taskWorkspacePath } from ${moduleUrl('server/workspace.ts')};
    const bot=${JSON.stringify(bot.id)}, thread=${JSON.stringify(bot.threadId)};
    const staged=stageSkillWrite(bot,{action:'create',source:'learn:fixture',files:[{path:'SKILL.md',content:'---\\nname: checked-method\\ndescription: Check a result\\n---\\nCheck the synthetic result.\\n'}]});
    if(staged.error)throw Error(staged.error);
    const applied=applyStagedSkillWrite(bot,staged.id,{expectedSha256:staged.sha256});if(applied.error)throw Error(applied.error);
    const desk=taskWorkspacePath(process.env.MURAGE_DATA_DIR,bot,thread);
    for(const dir of ['.claude/skills','.agents/skills','.grok/skills']){
      mkdirSync(join(desk,dir),{recursive:true});
      symlinkSync(join('/Users/fixture/old-root/workspaces',bot,'threads',thread,'.murage-procedures','a'.repeat(64),'skills/checked-method'),join(desk,dir,'checked-method'),'dir');
    }
  `;
  execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', seed], {
    env: { ...env, HOME: fixture.info.dataDir, MURAGE_DATA_DIR: fixture.info.dataDir }, encoding: 'utf8', timeout: 30000,
  });
  await fixture.restart();
  const turns = [];
  for (let i=0;i<5;i++) {
    const start = readFileSync(fixture.info.logPath, 'utf8').length;
    await runControlMurage(['send','--bot',bot.id,'--text',`Check the synthetic result ${i}.`,'--url',url]);
    const wait = await runControlMurage(['wait','--bot',bot.id,'--timeout','30','--url',url]);
    const messages = await runControlMurage(['messages','--bot',bot.id,'--limit','10','--url',url]);
    const turn = turnFromLog(readFileSync(fixture.info.logPath,'utf8').slice(start), bot.threadId);
    turns.push({ ...turn, wait, messages });
  }
  results = { scenarios: { longThread: {
    firstText: stats(turns.map(t=>t.firstText)), resumed: turns.slice(1).filter(t=>t.resumed===true).length,
    failed: turns.filter(t=>t.outcome!=='ok'||t.wait.status!=='settled').length,
  } } };
  writeFileSync(join(evidenceDir,'s5-results.json'), JSON.stringify({ ...results, turns, fixture:fixture.info },null,2)+'\n');
  writeFileSync(join(evidenceDir,'server.log'),readFileSync(fixture.info.logPath));
}, 180000);
afterAll(async()=>{if(fixture)await fixture.close();});
for(const id of ['S5.firstText','S5.resumed','S5.failed'])it(`${id}: old-root links pass the unchanged rig budget`, { tags: ['perf-budget'] }, ()=>{
  const row = loadBudgets().rows.find(row=>row.id===id);
  expect(judgeRow(row,results)).toMatchObject({ pass:true });
});
