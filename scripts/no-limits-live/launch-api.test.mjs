import { expect, it } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeTempDirSync } from '../../server/testing/cleanup.ts';
import { fileURLToPath } from 'node:url';
import { launchLive } from './run.mjs';
it('owns its server and safely reloads a legacy fixture without a live profile',async()=>{
  const out=mkdtempSync(join(tmpdir(),'gnl-launch-api-'));
  let f;
  try {
    f=await launchLive(out,[{id:'claude',driver:'claudeAgent',path:fileURLToPath(new URL('./launchers/claude.mjs',import.meta.url))}]);
    await f.client.connect();
    const bot=await f.client.bot('Legacy fixture',{id:'claude',model:'sonnet'},f.work,'unlimited');
    const fromPhone=await f.client.api('GET',`/api/bots/${bot.id}`,undefined,f.phoneHeaders);
    expect(fromPhone.bot.id).toBe(bot.id);
    const firstPid=f.child.pid;
    await f.prepareLegacyBot(bot.id);
    expect(f.child.pid).not.toBe(firstPid);
    const current=(await f.client.api('GET',`/api/bots/${bot.id}`)).bot;
    expect(current.permissionExplicit).toBeUndefined();
    expect(current).toMatchObject({autoApprove:true,fullAccess:true,noLimits:true});
    // App-denial preparation now uses a stopped fixture plus the owner review API.
    const { policy } = await f.client.api('GET', `/api/bots/${bot.id}/access`);
    await f.restart(data => {
      const file = join(data, 'bots.json'), bots = JSON.parse(readFileSync(file, 'utf8'));
      const saved = bots.find(row => row.id === bot.id);
      saved.connectedAppAccess = { ...policy, allowWrites: true, grants: [], requests: [], denials: [{
        id: 'fixture-denial', toolkit: 'gmail', accountId: 'fixture-account', tools: ['GMAIL_SEND_EMAIL'],
        ops: ['write'], source: 'request-denied', at: Date.now(), revision: policy.revision,
      }] };
      writeFileSync(file, JSON.stringify(bots));
    });
    await f.client.api('PUT', `/api/bots/${bot.id}/access`, {
      action: 'configure', revision: policy.revision, mode: 'restricted', allowWrites: true, grants: [],
    });
    const denied=await f.client.api('GET',`/api/bots/${bot.id}/access`);
    expect(denied.policy.denials).toEqual(expect.arrayContaining([expect.objectContaining({source:'request-denied'})]));
    writeFileSync(join(out,'verification.json'),JSON.stringify({firstPid,pid:f.child.pid,dataDir:f.data,restarts:f.restarts,profile:current.id,legacy:true})+'\n');
  }finally{
    await f?.client.disconnect();await f?.close();if(f)expect(existsSync(f.root)).toBe(false);
    removeTempDirSync(out);
  }
},90000);
