// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { launchVerificationServer } from '../scripts/control-murage.ts';
import { openSse, type SseRecorder } from './testing/sse.ts';

// Both sides are owned by acp-stop-retire: inert ACP peer and real HTTP/card consumer.
const endings = ['Stop','settle','crash','restart','second Stop','late answer'] as const;
it.each((['question','approval'] as const).flatMap(kind => endings.map(ending => ({kind,ending}))))('G-NL $kind pending card: $ending leaves one terminal card on desktop and phone', async ({kind,ending}) => {
  const fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    process.env.NODE_ENV = 'test';
    globalThis[Symbol.for('murage.hostPower.testUnwrapped')] = true;
    const fs = await import('node:fs'); const path = await import('node:path');
    const directory = path.join(process.env.MURAGE_DATA_DIR, 'retirement'); fs.mkdirSync(directory, {recursive:true});
    const cp = (await import('node:child_process')).default;
    const spawn = cp.spawn;
    cp.spawn = function(command,args,options) {
      const child = spawn(command,args,options);
      if (!args?.some(arg => arg.endsWith('acp-stop-retire-peer.mjs'))) return child;
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = function(chunk,...rest) {
        let frame; try {frame=JSON.parse(String(chunk));} catch {return write(chunk,...rest);}
        if (frame.id===900 && fs.existsSync(path.join(directory,'hold-answer'))) {
          fs.appendFileSync(path.join(directory,'held'),'write\\n');
          const callback=rest.find(value=>typeof value==='function');
          const timer=setInterval(()=>{
            if (!fs.existsSync(path.join(directory,'late-receipt'))) return;
            clearInterval(timer); callback?.(null);
          },20); timer.unref();
          return false;
        }
        return write(chunk,...rest);
      };
      return child;
    };
    (await import('node:module')).syncBuiltinESMExports();
    const { createAcpDriver } = await import(${JSON.stringify(new URL('./drivers/acp/core.ts', import.meta.url).href)});
    const { BUILT_IN_DRIVERS } = await import(${JSON.stringify(new URL('./drivers/builtIn.ts', import.meta.url).href)});
    BUILT_IN_DRIVERS.push(createAcpDriver({ driverKind:'retirementFixture', displayName:'Fixture', defaultCli:process.execPath,
      models:{default:'fixture',options:[{id:'fixture',label:'Fixture'}]}, nativeSource:'fixture', loginNote:'fixture',
      spawnArgs:()=>[${JSON.stringify(fileURLToPath(new URL('./testing/acp-stop-retire-peer.mjs', import.meta.url)))}],
      pickAuthMethod:()=>null, isAuthenticated:()=>true, authFailure:'continue', fluxReach:()=> 'elsewhere' }));
    const file = path.join(process.env.MURAGE_DATA_DIR,'config.json');
    const cfg = JSON.parse(fs.readFileSync(file,'utf8'));
    cfg.instances.retirement={driver:'retirementFixture',environment:{RETIRE_FIXTURE_DIR:directory,RETIRE_FIXTURE_KIND:${JSON.stringify(kind)}},config:{cli:process.execPath,fullAuto:false}};
    fs.writeFileSync(file,JSON.stringify(cfg));
  ` });
  let headers: Record<string,string> = {};
  const api = async (method: string, path: string, body?: unknown, extra = headers) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { 'content-type':'application/json', ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    return {status:response.status, body:await response.json() as any};
  };
  const connect = async () => {
    const proof = await api('GET','/api/desktop-secret');
    headers = {'x-murage-surface':'desktop','x-murage-surface-secret':proof.body.secret};
  };
  // The companion carries the paired owner's launch proof on phone reads.
  const phone = {'x-test-bare-loopback':'1','x-murage-companion':'1','x-murage-companion-token':'c'.repeat(64)};
  const directory = join(fixture.info.dataDir,'retirement');
  const streams: SseRecorder[] = [];
  try {
    await connect();
    {
      writeFileSync(join(directory,'ending'),'');
      const created = await api('POST','/api/bots',{name:'Fixture',modelSelection:{instanceId:'retirement',model:'fixture'}});
      expect(created.status).toBe(201);
      const bot = created.body.bot;
      streams.push(await openSse(fixture.info.url+'/api/events',headers),await openSse(fixture.info.url+'/api/events',phone));
      await Promise.all(streams.map(stream=>stream.until(frame=>frame.kind==='hello')));
      expect((await api('PATCH',`/api/bots/${bot.id}`,{autoApprove:false,autoReview:'off',computer:'off'})).status).toBe(200);
      expect((await api('POST',`/api/bots/${bot.id}/messages`,{threadId:bot.threadId,text:'Fixture'})).status).toBe(202);
      const messages = async (extra = headers) => (await api('GET',`/api/threads/${bot.threadId}/messages`,undefined,extra)).body.messages as any[];
      const nativeRows = () => {
        const db = new DatabaseSync(join(fixture.info.dataDir,'messages.db'),{readOnly:true});
        try { return db.prepare("SELECT chat_message_id FROM approval_records WHERE source_kind='engine' AND thread_id=?").all(bot.threadId); }
        finally { db.close(); }
      };
      // MAIN RULING INT-CONFLICT-DEFAULT observed display consumers: join the
      // private execution record to its public message, whose tool can be masked.
      const engineCards = async () => {
        const ids = new Set(nativeRows().map(row=>row.chat_message_id));
        return (await messages()).filter(m=>m.card && ids.has(m.id));
      };
      await expect.poll(async () => (await engineCards()).length,{timeout:30000}).toBe(1);
      const opened = (await engineCards())[0]!;
      const durable = () => {
        const db = new DatabaseSync(join(fixture.info.dataDir,'messages.db'),{readOnly:true});
        try { return db.prepare('SELECT state,delivery FROM approval_records WHERE thread_id=? AND chat_message_id=?').all(bot.threadId,opened.id); }
        finally { db.close(); }
      };
      expect(durable()).toEqual([{state:'open',delivery:'none'}]);
      await Promise.all(streams.map(stream=>stream.until(frame=>frame.kind==='message' && frame.threadId===bot.threadId && frame.message?.id===opened.id)));
      expect(opened.card.requestId).toBeUndefined();
      expect(opened.card.requestHandle).toBe(`${kind === 'question' ? 'q' : 'p'}.${opened.id}`);
      expect(opened.card.answered).toBeFalsy();
      expect((await messages(phone)).find(m=>m.id===opened.id)?.card.answered).toBeFalsy();
      let answering: ReturnType<typeof api> | undefined;
      if (ending === 'late answer') {
        writeFileSync(join(directory,'hold-answer'),'');
        answering = api('POST',`/api/threads/${bot.threadId}/respond`,{requestHandle:opened.card.requestHandle,action:kind==='approval'?'allow':'answer',...(kind==='question'?{answers:[{questionHandle:'q.0',optionHandles:['o.0.0']}]}:{})});
        await expect.poll(()=>existsSync(join(directory,'held')),{timeout:5000}).toBe(true);
      }
      const stop = () => api('POST',`/api/bots/${bot.id}/interrupt`,{threadId:bot.threadId});
      if (ending === 'restart') {
        // Abrupt app death leaves the durable pending ask for the real boot sweep.
        for (const stream of streams) stream.close();
        const closed = once(fixture.child,'close'); fixture.child.kill('SIGKILL'); await closed;
        expect(durable()).toEqual([{state:'open',delivery:'none'}]);
        await fixture.restart(); await connect();
      } else if (ending === 'settle' || ending === 'crash') writeFileSync(join(directory,'ending'),ending);
      else {
        expect((await stop()).status).toBe(200);
        if (ending === 'second Stop') expect((await stop()).status).toBe(200);
        if (ending === 'late answer') {
          const late = await api('POST',`/api/threads/${bot.threadId}/respond`,{requestHandle:opened.card.requestHandle,action:kind==='approval'?'allow':'answer',...(kind==='question'?{answers:[{questionHandle:'q.0',optionHandles:['o.0.0']}]}:{})});
          expect(late.status).toBe(409);
        }
      }
      await expect.poll(async () => Boolean((await messages()).find(m=>m.id===opened.id)?.card.answered),{timeout:15000}).toBe(true);
      // MAIN RULING INT-CONFLICT-DEFAULT observed display consumers: count
      // the native request cards by their durable execution records. Other
      // informational cards must expose no live request handle.
      const cards = await engineCards();
      expect(nativeRows()).toHaveLength(1);
      expect((await messages()).filter(m=>m.card && m.id!==opened.id).every(m=>!m.card.requestHandle)).toBe(true);
      const terminal = durable();
      expect(terminal).toHaveLength(1);
      // MAIN RULING INT-CONFLICT-DEFAULT: registered cancellation retires an unconfirmed answer as cancelled (8bfe905cabf).
      expect(terminal[0]!.state).toBe(ending === 'restart' ? 'expired' : 'cancelled');
      expect(terminal[0]!.delivery).not.toBe('pending');
      expect(cards).toHaveLength(1);
      expect(cards[0].card.answered).not.toMatch(/Allowed|^allow$|^answer$/);
      const remoteMessages = await messages(phone);
      expect(remoteMessages.filter(m=>m.card && m.id!==opened.id).every(m=>!m.card.requestHandle)).toBe(true);
      const remote = remoteMessages.filter(m=>m.id===opened.id && m.card);
      expect(remote).toHaveLength(1);
      expect(remote[0].card.answered).toBe(cards[0].card.answered);
      expect(remote[0].card.expired).toBe(cards[0].card.expired);
      if (ending !== 'restart') {
        // Both connected clients receive the terminal patch, so an already
        // visible card settles without requiring a phone or desktop refresh.
        const delivered = await Promise.all(streams.map(stream=>stream.until(frame=>frame.kind==='message.patch' && frame.threadId===bot.threadId && frame.message?.id===opened.id && frame.message?.card?.answered===cards[0].card.answered)));
        for (const frame of delivered) expect(frame.message.card.answered).toBe(cards[0].card.answered);
      }
      if (answering) {
        expect((await answering).status).toBeGreaterThanOrEqual(400);
        writeFileSync(join(directory,'late-receipt'),'');
        await new Promise(resolve=>setTimeout(resolve,100));
        expect((await messages()).find(m=>m.id===opened.id)?.card.answered).toBe(cards[0].card.answered);
        expect(existsSync(join(directory,'replies.jsonl'))).toBe(false);
      }
      await stop();
      expect(durable()).toEqual(terminal);
    }
  } catch (error) {
    console.error('Fixture assertion',error);
    console.error('Fixture ending',kind,ending,readFileSync(fixture.info.logPath,'utf8').slice(-7000));
    throw error;
  } finally { for (const stream of streams) stream.close(); await fixture.close(); }
}, 180000);
