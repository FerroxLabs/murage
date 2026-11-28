// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: fix + witness = q1022-heldrest-opus; send fence = memory revoke fence (send-fence.ts); rulings = MAIN (2026-11-25T15:47:42Z item 4).
// 1.0.22 heldrest C (GitHub #43): a context revoked during dispatch never ends an owner's own typed turn. The fixture marks every stored
// line as revoked at the send fence from the second message on (a revoke landing between preparation and the write, each time): the first
// dispatch, the rebuild and the last resort (which still replays the conversation's recent lines) are all refused with nothing written.
// The turn must still answer, from the owner's message alone, with no "couldn't start" / "no longer available" card.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlMurage } from "../scripts/control-murage.ts";

const firstQuestion = "Fixture opening question";
const secondQuestion = "Fixture follow-up question";

it("W-REVOKE-CONTINUE: a context revoked at every memory-carrying send still answers the owner's message (no card)", async () => {
  const session = await launchVerificationServer(process.env, undefined, {
    turnLog: { replies: ["Fixture first reply.", "Fixture follow-up reply."] },
    instrumentationSource: `
      globalThis[Symbol.for('murage.hostPower.testUnwrapped')]=true;
      const {registerHooks}=await import('node:module'),path=await import('node:path');
      const marker=path.join(process.env.MURAGE_DATA_DIR,'hro-revoked');
      registerHooks({load(url,context,next){
        const result=next(url,context);
        if(!url.endsWith('/server/memory/send-fence.ts'))return result;
        let source=String(result.source);
        const anchor='if (built.parts.length && built.parts.every(part => part.lineageOf.length > 0 && part.lineageOf.every(ref => ref.kind === "none"))) return;';
        if(source.split(anchor).length!==2)throw new Error('send fence anchor missing');
        source='import {existsSync as hroExists} from "node:fs";'+source.replace(anchor,anchor+'if(hroExists('+JSON.stringify(marker)+'))throw Object.assign(new Error("MEMORY_CONTEXT_REVOKED"),{fence:{state:"withheld",reason:"deny-line"}});');
        return {...result,source};
      }});
    `,
  });
  const env = { MURAGE_URL: session.info.url };
  try {
    // the owner types on the desktop (POST /api/bots/:id/messages, the app's own route): fresh human words, owner audience
    const { secret } = await (await fetch(`${session.info.url}/api/desktop-secret`)).json() as { secret: string };
    const headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret, "content-type": "application/json" };
    const post = async (path: string, body: unknown) => {
      const r = await fetch(`${session.info.url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
      expect(r.ok, `POST ${path}: ${r.status}`).toBe(true); return r.json() as Promise<any>;
    };
    const { bot } = await post("/api/bots", { name: "Fixture revoke" });
    await post(`/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: firstQuestion });
    expect((await runControlMurage(["wait", "--bot", bot.id, "--timeout", "30"], { env }) as any).status).toBe("settled");
    writeFileSync(join(session.info.dataDir, "hro-revoked"), "");
    await post(`/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: secondQuestion });
    await runControlMurage(["wait", "--bot", bot.id, "--timeout", "60"], { env });
    const messages = (await runControlMurage(["messages", "--bot", bot.id, "--limit", "80"], { env }) as any).messages as any[];
    // the messages command lists the bot side only: the follow-up's rows are those after the first reply
    const at = messages.findIndex(m => m.role === "bot" && m.kind === "text" && m.text === "Fixture first reply.");
    const after = messages.slice(at + 1);
    const log = readFileSync(session.info.logPath, "utf8");
    console.log(`HRO-C rows=${JSON.stringify(after.map(m => [m.role, m.kind, m.provenance, String(m.text ?? m.tool?.name ?? "").slice(0, 90)]))}\n`
      + log.split("\n").filter(l => /context revoked|re-preparing|ends with a card|without recalled memory|dispatch preparation failed/.test(l)).slice(0, 12).join("\n"));
    expect(at, JSON.stringify(messages.map(m => [m.role, m.kind, String(m.text ?? "").slice(0, 60)]))).toBeGreaterThanOrEqual(0);
    // the behaviour: the owner's message is answered by the engine
    expect(after.filter(m => m.role === "bot" && m.kind === "text" && m.text === "Fixture follow-up reply."), "the follow-up is answered").toHaveLength(1);
    expect(JSON.stringify(after)).not.toMatch(/couldn't start this reply|no longer available|MEMORY_CONTEXT_REVOKED/);
    // only the revoked context was dropped: the answered prompt carries the owner's words and none of the earlier lines
    const prompts = readFileSync(session.fixtureTurnLogPath, "utf8").trim().split("\n").map(line => String(JSON.parse(line).prompt ?? JSON.stringify(JSON.parse(line))));
    if (process.env.HRO_PROBE) writeFileSync(process.env.HRO_PROBE, prompts.map(p => p.slice(0, 600)).join("\n----\n") + "\n====\n" + log.split("\n").filter(l => /memory|turn|fence|refus/.test(l)).slice(-40).join("\n"));
    const last = prompts[prompts.length - 1]!;
    expect(last).toContain(secondQuestion);
    expect(last).not.toContain(firstQuestion);
  } finally { await session.close(); }
}, 150_000);

// Astra precheck 9ee1a3d849 High: a last resort refused at SETUP, before its prompt is built (here the memory-mode check, as when the owner
// switches memory mode while it is being prepared), must still owe the floor. The first dispatch and both rebuilds are refused at the send
// fence as above; the last resort is refused once at the mode check (index.ts, the check right after memory.assemble); the floor re-reads
// the mode and is sent.
it("W-REVOKE-CONTINUE-SETUP: a last resort refused at setup (memory mode changed) still answers the owner's message (no card)", async () => {
  const session = await launchVerificationServer(process.env, undefined, {
    turnLog: { replies: ["Fixture first reply.", "Fixture follow-up reply."] },
    instrumentationSource: `
      globalThis[Symbol.for('murage.hostPower.testUnwrapped')]=true;
      const {registerHooks}=await import('node:module'),path=await import('node:path');
      const marker=path.join(process.env.MURAGE_DATA_DIR,'hro-revoked'),modeMarker=path.join(process.env.MURAGE_DATA_DIR,'cxr-mode');
      registerHooks({load(url,context,next){
        const result=next(url,context);
        let source=String(result.source);
        if(url.endsWith('/server/memory/send-fence.ts')){
          const anchor='if (built.parts.length && built.parts.every(part => part.lineageOf.length > 0 && part.lineageOf.every(ref => ref.kind === "none"))) return;';
          if(source.split(anchor).length!==2)throw new Error('send fence anchor missing');
          source='import {existsSync as hroExists} from "node:fs";'+source.replace(anchor,anchor+'if(hroExists('+JSON.stringify(marker)+'))throw Object.assign(new Error("MEMORY_CONTEXT_REVOKED"),{fence:{state:"withheld",reason:"deny-line"}});');
          return {...result,source};
        }
        if(url.endsWith('/server/index.ts')){
          const anchor='const assembleStats = memoryDone&&trace.enabled ? memoryStatsSnapshot() : undefined;';
          if(source.split(anchor).length!==2)throw new Error('mode check anchor missing');
          // one mode change, landing while the last resort is set up: thrown exactly as the mode check right below throws it
          source='import {existsSync as cxrExists,rmSync as cxrRm} from "node:fs";'+source.replace(anchor,anchor+'if(memoryLastResort&&cxrExists('+JSON.stringify(modeMarker)+')){cxrRm('+JSON.stringify(modeMarker)+');throw Object.assign(new Error("MEMORY_CONTEXT_REVOKED"),{code:"MEMORY_CONTEXT_REVOKED"});}');
          return {...result,source};
        }
        return result;
      }});
    `,
  });
  const env = { MURAGE_URL: session.info.url };
  try {
    const { secret } = await (await fetch(`${session.info.url}/api/desktop-secret`)).json() as { secret: string };
    const headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret, "content-type": "application/json" };
    const post = async (path: string, body: unknown) => {
      const r = await fetch(`${session.info.url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
      expect(r.ok, `POST ${path}: ${r.status}`).toBe(true); return r.json() as Promise<any>;
    };
    const { bot } = await post("/api/bots", { name: "Fixture revoke setup" });
    await post(`/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: firstQuestion });
    expect((await runControlMurage(["wait", "--bot", bot.id, "--timeout", "30"], { env }) as any).status).toBe("settled");
    writeFileSync(join(session.info.dataDir, "hro-revoked"), "");
    writeFileSync(join(session.info.dataDir, "cxr-mode"), "");
    await post(`/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: secondQuestion });
    await runControlMurage(["wait", "--bot", bot.id, "--timeout", "60"], { env });
    const messages = (await runControlMurage(["messages", "--bot", bot.id, "--limit", "80"], { env }) as any).messages as any[];
    const at = messages.findIndex(m => m.role === "bot" && m.kind === "text" && m.text === "Fixture first reply.");
    const after = messages.slice(at + 1);
    const log = readFileSync(session.info.logPath, "utf8");
    writeFileSync("/tmp/hro-probe.out", `HRO-C SETUP rows=${JSON.stringify(after.map(m => [m.role, m.kind, String(m.text ?? m.tool?.name ?? "").slice(0, 90)]))}\n`
      + log.split("\n").filter(l => /context revoked|re-prepar|ends with a card|without recalled memory/.test(l)).slice(0, 12).join("\n") + "\n");
    expect(at, JSON.stringify(messages.map(m => [m.role, m.kind, String(m.text ?? "").slice(0, 60)]))).toBeGreaterThanOrEqual(0);
    // the mode change really landed on the last resort (its marker is consumed only there)
    expect(existsSync(join(session.info.dataDir, "cxr-mode")), "the last resort met the mode change").toBe(false);
    // the behaviour: the owner's message is answered by the engine, with no card
    expect(after.filter(m => m.role === "bot" && m.kind === "text" && m.text === "Fixture follow-up reply."), "the follow-up is answered").toHaveLength(1);
    expect(JSON.stringify(after)).not.toMatch(/couldn't start this reply|no longer available|MEMORY_CONTEXT_REVOKED/);
    const prompts = readFileSync(session.fixtureTurnLogPath, "utf8").trim().split("\n").map(line => String(JSON.parse(line).prompt ?? JSON.stringify(JSON.parse(line))));
    const last = prompts[prompts.length - 1]!;
    expect(last).toContain(secondQuestion);
    expect(last).not.toContain(firstQuestion);
  } finally { await session.close(); }
}, 150_000);
