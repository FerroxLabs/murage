// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: fix + witness = q1022-heldrest-opus; send fence = memory revoke fence (send-fence.ts); floor ladder = q1022-ctxrevoke-race;
// rulings = MAIN (2026-11-25T15:47:42Z item 4).
// 1.0.22 heldrest C, the direct twin of W-REVOKE-ROOM-MODE (Astra 4a2e066ed8 class): from the second message on, the send fence refuses
// every memory-carrying prompt (the first dispatch, the rebuild and the last resort, which replays recent lines), so the turn reaches the
// message-only floor. The stored memory mode then really changes (memory_meta, setMemoryMode) once, while the FLOOR is set up (right after
// memory.assemble). The floor sends only the owner's message, so the mode change must not refuse it: the turn answers, with no card.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlMurage } from "../scripts/control-murage.ts";

const firstQuestion = "Fixture opening question";
const secondQuestion = "Fixture follow-up question";

it("W-REVOKE-FLOOR-MODE: a memory mode change while the message-only floor is set up still answers the owner's message (no card)", async () => {
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
          // one real mode change, landing while the floor (opts.memoryFloor) is set up; the marker keeps the mode it changed from
          source='import {existsSync as cxrExists,writeFileSync as cxrWrite} from "node:fs";import {setMemoryMode as hroSetMode} from "./memory/repository.ts";'+source.replace(anchor,anchor+'if(opts?.memoryFloor&&cxrExists('+JSON.stringify(marker)+')&&!cxrExists('+JSON.stringify(modeMarker)+')){cxrWrite('+JSON.stringify(modeMarker)+',memoryState().mode);hroSetMode(memoryState().mode==="off"?"capture":"off");}');
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
    const { bot } = await post("/api/bots", { name: "Fixture revoke floor" });
    await post(`/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: firstQuestion });
    expect((await runControlMurage(["wait", "--bot", bot.id, "--timeout", "30"], { env }) as any).status).toBe("settled");
    writeFileSync(join(session.info.dataDir, "hro-revoked"), "");
    await post(`/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: secondQuestion });
    await runControlMurage(["wait", "--bot", bot.id, "--timeout", "60"], { env });
    const messages = (await runControlMurage(["messages", "--bot", bot.id, "--limit", "80"], { env }) as any).messages as any[];
    const at = messages.findIndex(m => m.role === "bot" && m.kind === "text" && m.text === "Fixture first reply.");
    const after = messages.slice(at + 1);
    const log = readFileSync(session.info.logPath, "utf8");
    console.log(`HRO-C FLOOR rows=${JSON.stringify(after.map(m => [m.role, m.kind, String(m.text ?? m.tool?.name ?? "").slice(0, 90)]))}\n`
      + log.split("\n").filter(l => /context revoked|re-prepar|ends with a card|without recalled memory/.test(l)).slice(0, 12).join("\n") + "\n");
    expect(at, JSON.stringify(messages.map(m => [m.role, m.kind, String(m.text ?? "").slice(0, 60)]))).toBeGreaterThanOrEqual(0);
    // the mode change really landed on the floor (its marker is written only there), and the floor was the attempt that answered
    expect(existsSync(join(session.info.dataDir, "cxr-mode")), "the floor met the mode change").toBe(true);
    // the behaviour: the owner's message is answered by the engine, with no card
    expect(after.filter(m => m.role === "bot" && m.kind === "text" && m.text === "Fixture follow-up reply."), "the follow-up is answered").toHaveLength(1);
    expect(JSON.stringify(after)).not.toMatch(/couldn't start this reply|no longer available|MEMORY_CONTEXT_REVOKED/);
    const prompts = readFileSync(session.fixtureTurnLogPath, "utf8").trim().split("\n").map(line => String(JSON.parse(line).prompt ?? JSON.stringify(JSON.parse(line))));
    const last = prompts[prompts.length - 1]!;
    expect(last).toContain(secondQuestion);
    expect(last).not.toContain(firstQuestion);
  } finally { await session.close(); }
}, 150_000);
