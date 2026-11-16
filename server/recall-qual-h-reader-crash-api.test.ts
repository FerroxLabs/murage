// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-qual-h. Reader-proof consumer owner: recall-prod-y; recovery consumer owner: recall-prod-x; MAIN integrates.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { proofWorld } from './session-proof-world.ts';

for (const withdraw of [false, true]) it(`reader SIGKILL with owed capture: ${withdraw ? 'real withdrawal resets' : 'healthy native cursor survives'}`, async () => {
  const url = (file: string) => JSON.stringify(pathToFileURL(join(process.cwd(), file)).href);
  const w = await proofWorld('claude', 'none', `
    const readerFs=await import('node:fs'),readerPath=await import('node:path');
    const {IoBudget:ReaderIoBudget}=await import(${url('server/io-budget.ts')});
    const readerAdmit=ReaderIoBudget.prototype.admit;
    ReaderIoBudget.prototype.admit=function(...args){if(args[0]==='BG'&&readerFs.existsSync(readerPath.join(process.env.MURAGE_DATA_DIR,'qualification-hold-bg')))return null;return readerAdmit.apply(this,args);};
    const {registerHooks:readerHooks}=await import('node:module');
    readerHooks({load(url,context,next){const result=next(url,context);if(!url.endsWith('/server/memory/session-proof.ts'))return result;
      return {...result,source:String(result.source)+${JSON.stringify(`
        import {existsSync as qualificationExists,unlinkSync as qualificationUnlink,writeFileSync as qualificationWrite} from 'node:fs';
        import {join as qualificationJoin} from 'node:path';
        import {DATA_DIR as qualificationData} from '../config.ts';
        setSessionProofCommitFaultForTest(()=>{
          const flag=qualificationJoin(qualificationData,'qualification-reader-crash');
          if(!qualificationExists(flag))return;
          qualificationUnlink(flag);
          const pending=database().prepare("SELECT count(*) AS n FROM memory_jobs WHERE status NOT IN ('complete','cancelled','failed')").get().n;
          qualificationWrite(qualificationJoin(qualificationData,'qualification-reader-cut.json'),JSON.stringify({pending}));
          process.kill(process.pid,'SIGKILL');
        });
      `)}};
    }});
  `);
  try {
    const bot = await w.bot();
    await w.acceptedTurn(bot, 'First captured fixture reply.');
    await w.acceptedTurn(bot, 'Second captured fixture reply.');
    const old = w.session(bot.threadId);
    expect(old).toBeTruthy();
    const before = w.read(db => db.prepare('SELECT up_to FROM memory_session_checks WHERE thread_id=? AND native_session=?').get(bot.threadId, old));
    expect(before).toBeTruthy();
    const source = w.read(db => db.prepare("SELECT s.id FROM memory_sources s JOIN memory_jobs j ON j.source_id=s.id AND j.source_revision=s.revision AND j.stage='capture' WHERE s.thread_id=? AND s.kind='text' AND s.speaker!='owner' AND j.status='complete' ORDER BY s.rowid LIMIT 1").get(bot.threadId));
    expect(source).toBeTruthy();
    const hold = join(w.fixture.info.dataDir, 'qualification-hold-bg');
    writeFileSync(hold, 'fixture');
    writeFileSync(join(w.fixture.info.dataDir, 'qualification-reader-crash'), 'fixture');
    await w.api('POST', `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: 'Crash before the reader checkpoint commits.' });
    await expect.poll(() => w.fixture.child.signalCode, { timeout: 15_000 }).toBe('SIGKILL');
    const cut = join(w.fixture.info.dataDir, 'qualification-reader-cut.json');
    expect(existsSync(cut)).toBe(true);
    expect(JSON.parse(readFileSync(cut, 'utf8')).pending).toBeGreaterThan(0);
    expect(w.read(db => db.prepare('SELECT up_to FROM memory_session_checks WHERE thread_id=? AND native_session=?').get(bot.threadId, old)?.up_to)).toBe(before!.up_to);
    await w.fixture.restart();
    await w.login();
    if (withdraw) await w.api('POST', '/api/memory/action', { action: 'forget', kind: 'source', id: String(source!.id) });
    unlinkSync(hold);
    const start = w.log().length;
    await w.acceptedTurn(bot, 'A full accepted reply after the reader crash.').catch(async error => {
      const eventsFile = join(w.fixture.info.dataDir, 'events', `${bot.threadId}.ndjson`);
      const events = existsSync(eventsFile) ? readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => {
        const event = JSON.parse(line);
        return { type: event.type, turn: event.turnId, item: event.itemType, bytes: Buffer.byteLength(event.text ?? ''), ok: event.ok, reason: event.stopReason };
      }) : [];
      console.error(JSON.stringify({ withdraw, snapshot: w.read(db => ({
        messages: db.prepare("SELECT id,role,text,json_extract(json,'$.turnId') AS turn_id,json_extract(json,'$.turnTerminal') AS terminal FROM messages WHERE thread_id=? ORDER BY rowid").all(bot.threadId),
        jobs: db.prepare('SELECT s.message_id,j.status,j.error FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id WHERE s.thread_id=?').all(bot.threadId),
        memory: db.prepare('SELECT mode,policy_revision,deletion_epoch FROM memory_meta').get(),
      })), events, state: await w.api('GET', '/api/bots?messages=0') }));
      throw error;
    });
    if (withdraw) {
      expect(w.session(bot.threadId)).not.toBe(old);
      expect(w.log().slice(start)).toContain('memory continuation reset');
    } else {
      expect(w.session(bot.threadId)).toBe(old);
      expect(w.log().slice(start)).not.toContain('memory continuation reset');
    }
  } finally { await w.fixture.close(); }
}, 180_000);
