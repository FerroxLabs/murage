// SPDX-License-Identifier: AGPL-3.0-or-later
// Recall construction producer owner: recall-scope; fixture consumer: c4-misc-a2.
// MAIN RULING INT-CONFLICT-DEFAULT: fixture setup waits for real structural
// preparation before testing continuation. All issued-access checks stay live.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isMainThread } from 'node:worker_threads';
if (isMainThread) {
  const { Store } = await import('../store.ts');
  const { DATA_DIR } = await import('../config.ts');
  const { maintainRecallViewSlice, prepareRecallContext, resolveRecallView, waitForRecallConstructionIdleForTest } = await import('../memory/recall-view.ts');
  const { threadHumanPrincipal } = await import('../human-principals.ts');
  let roster, seen, working=false;
  const finish=Store.prototype.finishSharingBoot;
  Store.prototype.finishSharingBoot=function(...args) { const result=finish.apply(this,args);roster=this;return result; };
  const directory=dirname(DATA_DIR);
  setInterval(async()=>{
    if (!roster || working) return;
    let command;
    try { command=JSON.parse(readFileSync(join(directory,'recall-ready-control.json'),'utf8')); } catch { return; }
    if (!command || command.seq===seen) return;
    seen=command.seq;working=true;
    try {
      await waitForRecallConstructionIdleForTest(roster);
      const binding={botId:command.botId,threadId:command.threadId,humanPrincipal:threadHumanPrincipal(command.threadId),notOwnerAudience:false};
      try { resolveRecallView(binding,roster); }
      catch(error) {
        if (!(error instanceof Error) || error.message!=='MEMORY_RECALL_UNAVAILABLE') throw error;
        await waitForRecallConstructionIdleForTest(roster);
        await prepareRecallContext(command.botId,command.threadId,roster);
      }
      // Fixture consumer owner: c4-misc-a3; projection producer: recall-scope.
      // Seeding unrelated history also queues real projection changes. Drain
      // this reader's bounded maintenance slices before timing its turn, so
      // mandatory pins are actually available rather than a last-resort reply.
      const ready=resolveRecallView(binding,roster);
      while (!maintainRecallViewSlice(ready.handle)) await new Promise(resolve=>setImmediate(resolve));
      resolveRecallView(binding,roster);
      writeFileSync(join(directory,'recall-ready-result.json'),JSON.stringify({seq:command.seq,ready:true}));
    } catch(error) {
      writeFileSync(join(directory,'recall-ready-result.json'),JSON.stringify({seq:command.seq,error:error instanceof Error?error.stack:String(error)}));
    } finally { working=false; }
  },10).unref();
}
