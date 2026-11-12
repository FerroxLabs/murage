import { expect, it } from 'vitest';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchLive } from './run.mjs';
it('owns its server and safely reloads a legacy fixture without a live profile',async()=>{
  const out=mkdtempSync(resolve('scripts/no-limits-live/evidence/launch-'));
  let f;
  try {
    f=await launchLive(out,[{id:'claude',driver:'claudeAgent',path:fileURLToPath(new URL('./fakes/claude.mjs',import.meta.url))}]);
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
    await f.prepareAppDenial(bot.id,'request-denied');
    const denied=await f.client.api('GET',`/api/bots/${bot.id}/access`);
    expect(denied.policy.denials).toEqual(expect.arrayContaining([expect.objectContaining({source:'request-denied'})]));
    writeFileSync(join(out,'verification.json'),JSON.stringify({firstPid,pid:f.child.pid,dataDir:f.data,restarts:f.restarts,profile:current.id,legacy:true})+'\n');
  }finally{
    await f?.client.disconnect();await f?.close();if(f)expect(existsSync(f.root)).toBe(false);
    // Keep only bounded evidence and the owned server log.
  }
},90000);
