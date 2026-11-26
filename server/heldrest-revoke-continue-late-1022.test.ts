// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: fix + witness = q1022-ctxrevoke-race; late-handback fixture engine = server/testing/fake-late-terminal-driver.ts; rulings = MAIN
// (2026-11-25T15:47:42Z item 4, GATE-1022).
// 1.0.22 heldrest C, late-write ladder (submissionBoundary.acceptedBy): an engine that hands its turn id back first and writes later (the
// ACP and Codex shape) is refused at that late write from the second message on, at every memory-carrying send: the first dispatch, the
// rebuild and the last resort (which still replays the recent lines). The owner's turn must still answer, from their message alone.
// Each attempt is held at its late write (session gate, taken per attempt) and released only after it was handed back and accepted, so
// every refusal arrives through the accepted-turn path, never the dispatch catch: the fence refuses only the engine's own late write.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-murage.ts";

const firstQuestion = "Fixture opening question";
const secondQuestion = "Fixture follow-up question";
const isReply = (m: any) => m.role === "bot" && m.kind === "text" && m.text === "Hello from late";

it.skipIf(process.platform === "win32")("W-REVOKE-CONTINUE-LATE: a late write refused at every memory-carrying send still answers the owner's message (no card)", async () => {
  const session = await launchVerificationServer(process.env, undefined, {
    instrumentationSource: `
      globalThis[Symbol.for('murage.hostPower.testUnwrapped')]=true;
      const fs=await import('node:fs'),{registerHooks}=await import('node:module'),path=await import('node:path');
      const dir=process.env.MURAGE_DATA_DIR,marker=path.join(dir,'cxr-revoked');
      registerHooks({load(url,context,next){
        const result=next(url,context);
        if(!url.endsWith('/server/memory/send-fence.ts'))return result;
        let source=String(result.source);
        const anchor='if (built.parts.length && built.parts.every(part => part.lineageOf.length > 0 && part.lineageOf.every(ref => ref.kind === "none"))) return;';
        if(source.split(anchor).length!==2)throw new Error('send fence anchor missing');
        source='import {existsSync as cxrExists} from "node:fs";'+source.replace(anchor,anchor+'if(cxrExists('+JSON.stringify(marker)+')&&String(new Error().stack).includes("fake-late-terminal-driver"))throw Object.assign(new Error("MEMORY_CONTEXT_REVOKED"),{fence:{state:"withheld",reason:"deny-line"}});');
        return {...result,source};
      }});
      const {BUILT_IN_DRIVERS}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/drivers/builtIn.ts")).href)});
      const {makeLateTerminalDriver}=await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-late-terminal-driver.ts")).href)});
      BUILT_IN_DRIVERS.push(makeLateTerminalDriver({ fencedDefaults: true }));
      const file=path.join(dir,'config.json'),cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.late={driver:'fakeLateTerminal',environment:{FAKE_LATE_HANDBACK:'1',FAKE_LATE_GATE_EACH:'1',FAKE_LATE_SESSION_GATE:path.join(dir,'late-gate'),FAKE_LATE_DUMP:path.join(dir,'late-dump'),FAKE_LATE_DUMP_FRAME:'1'}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    `,
  });
  let pump: ReturnType<typeof setInterval> | undefined;
  try {
    const { secret } = await (await fetch(`${session.info.url}/api/desktop-secret`)).json() as { secret: string };
    const headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret, "content-type": "application/json" };
    const api = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`${session.info.url}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      expect(r.ok, `${method} ${path}: ${r.status}`).toBe(true); return r.json() as Promise<any>;
    };
    const { bot } = await api("POST", "/api/bots", { name: "Fixture late revoke", modelSelection: { instanceId: "late", model: "late-1" } });
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
    const rows = async () => ((await api("GET", `/api/threads/${bot.threadId}/messages?limit=100`)).messages ?? []) as any[];
    const busy = async () => (await api("GET", "/api/bots?messages=0")).bots.find((b: any) => b.id === bot.id)?.busy === true;
    // release each held attempt once it has waited two polls (handed back and accepted), never before
    const gate = join(session.info.dataDir, "late-gate");
    let seen = "", polls = 0, released = 0;
    pump = setInterval(() => {
      const id = existsSync(`${gate}.waiting`) ? readFileSync(`${gate}.waiting`, "utf8") : "";
      if (!id || existsSync(gate)) { polls = 0; return; }
      if (id !== seen) { seen = id; polls = 0; }
      if (++polls >= 3) { writeFileSync(gate, ""); released++; polls = 0; }
    }, 100);
    // the owner types on the desktop (POST /api/bots/:id/messages): the first exchange is the context a later last resort replays
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: firstQuestion });
    await expect.poll(async () => (await rows()).filter(isReply).length, { timeout: 30_000 }).toBe(1);
    await expect.poll(busy, { timeout: 10_000 }).toBe(false);
    writeFileSync(join(session.info.dataDir, "cxr-revoked"), "");
    await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: secondQuestion });
    await expect.poll(async () => (await rows()).filter(isReply).length + (await busy() ? 0 : 10), { timeout: 60_000, interval: 500 }).toBeGreaterThanOrEqual(10);
    await new Promise(resolve => setTimeout(resolve, 1000));
    const all = await rows();
    const at = all.findIndex(m => m.role === "user" && m.text === secondQuestion);
    const after = all.slice(at + 1);
    const log = readFileSync(session.info.logPath, "utf8");
    clearInterval(pump);
    const dumped = readFileSync(join(session.info.dataDir, "late-dump"), "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => row.threadId === bot.threadId);
    writeFileSync("/tmp/hro-probe.out", `HRO-C LATE released=${released} rows=${JSON.stringify(after.map(m => [m.role, m.kind, String(m.text ?? m.tool?.name ?? "").slice(0, 90)]))} dump=${JSON.stringify(dumped.map(r => [r.prompt ? "prompt" : "attempt", String(r.frame ?? "").slice(-160)]))}\n`
      + log.split("\n").filter(l => /context revoked|re-prepar|ends with a card|without recalled memory|refus/.test(l)).slice(0, 16).join("\n") + "\n");
    expect(at, JSON.stringify(all.map(m => [m.role, m.kind, String(m.text ?? "").slice(0, 60)]))).toBeGreaterThanOrEqual(0);
    // the behaviour: the owner's follow-up is answered by the engine, with no card
    expect(after.filter(isReply), "the follow-up is answered").toHaveLength(1);
    expect(JSON.stringify(after)).not.toMatch(/couldn't start this reply|no longer available|MEMORY_CONTEXT_REVOKED/);
    // only the revoked context was dropped: the written prompt carries the owner's words and none of the earlier lines
    const written = dumped.filter(row => row.prompt);
    expect(written).toHaveLength(2);
    expect(written[1].frame).toContain(secondQuestion);
    expect(written[1].frame).not.toContain(firstQuestion);
  } finally { clearInterval(pump); await session.close(); }
}, 150_000);
