// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: B2 recall-reader-crash. Native replay consumer owner: new3-g5; MAIN integrates.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { proofWorld } from './session-proof-world.ts';

it('a killed dispatch captures no assistant output and excludes its input from the next retained native context', async () => {
  const w = await proofWorld('claude', 'none', `
    process.env.FAKE_CLAUDE_DUMP_LOG = (await import('node:path')).join(process.env.MURAGE_DATA_DIR,'fixture-prompts.jsonl');
    const {registerHooks:crashHooks}=await import('node:module');
    crashHooks({load(url,ctx,next){const result=next(url,ctx);
      if(!url.endsWith('/server/memory/session-proof.ts'))return result;
      return {...result,source:String(result.source)+\`
        import {existsSync as crashExists,unlinkSync as crashUnlink} from 'node:fs';
        import {join as crashJoin} from 'node:path';
        import {DATA_DIR as crashData} from '../config.ts';
        setSessionProofCommitFaultForTest(()=>{const flag=crashJoin(crashData,'fixture-crash');
          if(crashExists(flag)){crashUnlink(flag);process.kill(process.pid,'SIGKILL');}});
      \`};
    }});
  `);
  try {
    const bot = await w.bot();
    await w.acceptedTurn(bot, 'First accepted fixture input.');
    await w.acceptedTurn(bot, 'Second accepted fixture input.');
    const old = w.session(bot.threadId);
    const before = w.read(db => db.prepare('SELECT up_to FROM memory_session_checks WHERE thread_id=? AND native_session=?').get(bot.threadId, old)?.up_to);
    expect(before).toBeGreaterThan(0);
    const killed = 'Private never submitted fixture input.';
    writeFileSync(join(w.fixture.info.dataDir, 'fixture-crash'), 'fixture');
    await w.api('POST', `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: killed });
    await expect.poll(() => w.fixture.child.signalCode, { timeout: 15_000 }).toBe('SIGKILL');
    const input = w.read(db => db.prepare('SELECT id FROM messages WHERE thread_id=? AND text=?').get(bot.threadId, killed));
    expect(input).toBeTruthy();
    const next = 'Accepted fixture input after the crash.';
    const captures = () => w.read(db => Number(db.prepare(`SELECT count(*) AS n FROM memory_sources s
      JOIN messages m ON m.thread_id=s.thread_id AND m.id=s.message_id
      WHERE m.thread_id=? AND s.speaker!='owner'
      AND m.rowid>(SELECT rowid FROM messages WHERE thread_id=? AND id=?)
      AND m.rowid<COALESCE((SELECT rowid FROM messages WHERE thread_id=? AND text=?),9223372036854775807)`)
      .get(bot.threadId, bot.threadId, input!.id, bot.threadId, next)!.n));
    expect(captures()).toBe(0);
    expect(w.read(db => db.prepare('SELECT up_to FROM memory_session_checks WHERE thread_id=? AND native_session=?').get(bot.threadId, old)?.up_to)).toBe(before);
    await w.fixture.restart(); await w.login();
    await w.acceptedTurn(bot, next);
    expect(w.session(bot.threadId)).toBe(old);
    expect(captures()).toBe(0);
    const prompts = readFileSync(join(w.fixture.info.dataDir, 'fixture-prompts.jsonl'), 'utf8');
    expect(prompts).toContain('Accepted fixture input after the crash.');
    expect(prompts).not.toContain(killed);
    const kept = w.read(db => ({
      base: db.prepare('SELECT proof FROM send_replay_sessions WHERE thread_id=?').all(bot.threadId),
      delta: db.prepare('SELECT kind,node_key,json FROM send_replay_session_nodes WHERE thread_id=?').all(bot.threadId),
    }));
    expect(kept.base.length).toBeGreaterThan(0);
    expect(JSON.stringify(kept)).not.toContain(String(input!.id));
  } finally { await w.fixture.close(); }
}, 180_000);
