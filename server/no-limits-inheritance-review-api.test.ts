// SPDX-License-Identifier: AGPL-3.0-or-later
// Actual server installs the live inheritance reader over synthetic saved bots.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { launchVerificationServer, runControlMurage } from '../scripts/control-murage.ts';

it('review server preserves stored Ask and Auto below owner No limits', async () => {
  const fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const fs = await import('node:fs'); const path = await import('node:path');
    const {Store} = await import(${JSON.stringify(new URL('./store.ts', import.meta.url).href)});
    const {botPermissionMode} = await import(${JSON.stringify(new URL('./routine-permissions.ts', import.meta.url).href)});
    const {autoVerdict} = await import(${JSON.stringify(new URL('./auto-approve.ts', import.meta.url).href)});
    const store = new Store();
    const chief = store.createBot({name:'Review owner Full access'}, {seedMessages:false});
    store.setChiefOfStaff(chief.id, undefined, 'workspace');
    store.patchBot(chief.id, {autoApprove:true,fullAccess:true,noLimits:false,permissionExplicit:true});
    const followers = [false,true].map(autoApprove => {
      const bot=store.createBot({name:'Review fallback '+autoApprove},{seedMessages:false});
      store.patchBot(bot.id,{autoApprove,fullAccess:false,noLimits:false,permissionExplicit:false});
      return store.bot(bot.id);
    });
    const timer=setInterval(()=>{const file=path.join(process.env.MURAGE_DATA_DIR,'inheritance-observed.json');fs.writeFileSync(file+'.next',JSON.stringify(
      followers.map(bot=>({storedAuto:bot.autoApprove,mode:botPermissionMode(bot),verdict:autoVerdict(bot,'Bash','echo fixture',{fullAccessOrigin:'owner'})}))
    ));fs.renameSync(file+'.next',file);},50); timer.unref();
  ` });
  const evidence = process.env.GNL_ENGINE_EVIDENCE;
  try {
    const doctor = await runControlMurage(['doctor', '--url', fixture.info.url]);
    expect(doctor).toMatchObject({ ok: true });
    // The doctor answered from the started server, after its inheritance reader
    // was installed; wait for a fresh sample from that exact process.
    const file = join(fixture.info.dataDir, 'inheritance-observed.json');
    writeFileSync(file, '[]');
    await expect.poll(() => JSON.parse(readFileSync(file, 'utf8')).length).toBe(2);
    const observed = JSON.parse(readFileSync(file, 'utf8'));
    if (evidence) {
      mkdirSync(evidence, {recursive:true});
      writeFileSync(join(evidence,'inheritance-review.json'),JSON.stringify({fixture:fixture.info,doctor,observed},null,2)+'\n');
    }
    expect(observed.map((row: any) => row.mode)).toEqual(['ask','auto']);
    expect(observed[0].verdict.approve).toBeNull();
    expect(observed[1].verdict.approve).not.toBeNull();
  } finally {
    if (evidence) writeFileSync(join(evidence,'inheritance-server.log'),readFileSync(fixture.info.logPath));
    await fixture.close();
  }
}, 120000);
