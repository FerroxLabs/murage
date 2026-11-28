// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: fix + witness = q1022-heldrest-opus; send fence = memory revoke fence (send-fence.ts); room write check = index.ts
// fenceRoomContextWithoutReceipt (this lane); rulings = MAIN (2026-11-25T15:47:42Z item 4, GATE-1022).
// 1.0.22 heldrest C (Astra 4a2e066ed8 High), W-REVOKE-ROOM-MODE: as W-REVOKE-ROOM (the send fence refuses every memory-carrying room
// prompt from the second message on), and the stored memory mode really changes (memory_meta, setMemoryMode) once, while the room LAST
// RESORT is resetting its session (resetRoomMemberSession). That reaches every room mode check of the last resort in turn (the reset's
// own check, prepareRoomMemory, the last resort's reset block, validateRoomSubmission). The last resort sends only the owner's message, so
// the mode change must not refuse it: the turn answers, with no card (before, it ended with "no longer available").
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-murage.ts";

const firstQuestion = "Fixture opening question";
const secondQuestion = "Fixture follow-up question";

it("W-REVOKE-ROOM-MODE: a memory mode change during the room last resort's session reset still answers the owner's message (no card)", async () => {
  const session = await launchVerificationServer(process.env, undefined, {
    turnLog: { replies: ["Fixture first reply.", "Fixture follow-up reply."] },
    instrumentationSource: `
      globalThis[Symbol.for('murage.hostPower.testUnwrapped')]=true;
      const {registerHooks}=await import('node:module'),path=await import('node:path');
      const marker=path.join(process.env.MURAGE_DATA_DIR,'hro-revoked');
      const revoked='(hroExists('+JSON.stringify(marker)+'))';
      registerHooks({load(url,context,next){
        const result=next(url,context);
        let source=String(result.source);
        if(url.endsWith('/server/memory/send-fence.ts')){
          const anchor='if (built.parts.length && built.parts.every(part => part.lineageOf.length > 0 && part.lineageOf.every(ref => ref.kind === "none"))) return;';
          if(source.split(anchor).length!==2)throw new Error('send fence anchor missing');
          source='import {existsSync as hroExists} from "node:fs";'+source.replace(anchor,anchor+'if'+revoked+'throw Object.assign(new Error("MEMORY_CONTEXT_REVOKED"),{fence:{state:"withheld",reason:"deny-line"}});');
          return {...result,source};
        }
        if(url.endsWith('/server/index.ts')){
          // the room write check: every row it judged at the write now reads revoked
          const anchor='if(verbatim.some(id=>now.checked.has(id)&&!allowed.has(id)))throw new Error("MEMORY_CONTEXT_REVOKED");';
          if(source.split(anchor).length!==2)throw new Error('room write check anchor missing');
          source=source.replace(anchor,'if('+revoked+'&&verbatim.length>0||verbatim.some(id=>now.checked.has(id)&&!allowed.has(id)))throw new Error("MEMORY_CONTEXT_REVOKED");');
          // the owner's memory mode really changes once, while the room last resort resets its session
          const reset='const resetRoomMemberSession = async () => {\\n    shellSessions.retire(threadId, instance.instanceId);';
          if(source.split(reset).length!==2)throw new Error('room reset anchor missing');
          source=source.replace(reset,reset+'if('+revoked+'&&roomLastResort&&!hroExists('+JSON.stringify(marker+'.mode')+')){hroFired('+JSON.stringify(marker+'.mode')+',memoryState().mode);hroSetMode(memoryState().mode==="off"?"capture":"off");}');
          source='import {existsSync as hroExists,appendFileSync as hroFired} from "node:fs";import {setMemoryMode as hroSetMode} from "./memory/repository.ts";'+source;
          return {...result,source};
        }
        return result;
      }});
    `,
  });
  try {
    const { secret } = await (await fetch(`${session.info.url}/api/desktop-secret`)).json() as { secret: string };
    const headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret, "content-type": "application/json" };
    const api = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`${session.info.url}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      expect(r.ok, `${method} ${path}: ${r.status}`).toBe(true); return r.json() as Promise<any>;
    };
    const { bot } = await api("POST", "/api/bots", { name: "Fixture revoke" });
    const { group } = await api("POST", "/api/groups", { name: "Fixture room", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } });
    const rows = async () => ((await api("GET", `/api/threads/${group.threadId}/messages?limit=100`)).messages ?? []) as any[];
    const settled = (reply: string) => expect.poll(async () => JSON.stringify(await rows()), { timeout: 60_000, interval: 500 })
      .toMatch(new RegExp(`${reply}|couldn't start this reply|no longer available`));
    // the owner types in the room on the desktop (POST /api/groups/:id/messages)
    await api("POST", `/api/groups/${group.id}/messages`, { threadId: group.threadId, text: firstQuestion });
    await settled("Fixture first reply");
    writeFileSync(join(session.info.dataDir, "hro-revoked"), "");
    await api("POST", `/api/groups/${group.id}/messages`, { threadId: group.threadId, text: secondQuestion });
    await settled("Fixture follow-up reply");
    await new Promise(resolve => setTimeout(resolve, 1000));
    const all = await rows();
    const at = all.findIndex(m => m.role === "user" && m.text === secondQuestion);
    const after = all.slice(at + 1);
    const log = readFileSync(session.info.logPath, "utf8");
    console.log(`HRO-C ROOM rows=${JSON.stringify(after.map(m => [m.role, m.kind, String(m.text ?? m.tool?.name ?? "").slice(0, 90)]))}\n`
      + log.split("\n").filter(l => /context revoked|re-prepar|ends with a card|without recalled memory|continuation reset|refus/.test(l)).slice(0, 16).join("\n") + "\n");
    expect(at, JSON.stringify(all.map(m => [m.role, m.kind, String(m.text ?? "").slice(0, 60)]))).toBeGreaterThanOrEqual(0);
    // the behaviour: the owner's follow-up is answered by the engine, with no card
    expect(after.filter(m => m.role === "bot" && m.kind === "text" && m.text === "Fixture follow-up reply."), "the follow-up is answered").toHaveLength(1);
    expect(JSON.stringify(after)).not.toMatch(/couldn't start this reply|no longer available|MEMORY_CONTEXT_REVOKED/);
    // the whole memory-carrying ladder was refused first, and the answer came from the room last resort
    expect(log).toMatch(/re-preparing \(2 of 2, room member/);
    expect(log).toMatch(/starting turn without recalled memory thread=\S+ route=room/);
    // the stored mode really changed during the last resort's reset (the marker holds the mode it changed from)
    const from = readFileSync(join(session.info.dataDir, "hro-revoked.mode"), "utf8");
    expect(log).toMatch(new RegExp(`reason=room-memory-${from === "off" ? "capture" : "off"} last-resort`));
    // only the revoked context was dropped: the answered prompt carries the owner's words and none of the earlier lines
    const prompts = readFileSync(session.fixtureTurnLogPath, "utf8").trim().split("\n").map(line => String(JSON.parse(line).prompt ?? JSON.stringify(JSON.parse(line))));
    const last = prompts[prompts.length - 1]!;
    expect(last).toContain(secondQuestion);
    expect(last).not.toContain(firstQuestion);
  } finally { await session.close(); }
}, 150_000);
