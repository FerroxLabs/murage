// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.20 T1/B2 (hunt-turnerr): a turn whose setup failed inside Murage (the delete check `wipe-guard-invalid-turn`, a detached engine
// instance `instance_not_attached`) ended at once with a red card reading the raw code and "pick another model", and the turn was lost.
// Real server, fixture engine with fenced writes: the preload makes the engine's next sendTurn call(s) throw the code before the engine
// submits anything, as the real delete-check start does inside the exec driver's sendTurn (drivers/murage-exec-wipe.ts), so the submission
// boundary proves the turn unwritten and the same catch in server/index.ts handles it. Recoverable codes
// prepare the turn once more and it is answered; a code that repeats, or one that is not recoverable, ends with ONE Murage line (no raw
// code, no engine name, no "pick another model"), the code kept under the row's technical details only.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

import { murageStartFailureLine } from "../shared/murage-start-failure.ts";
let fixture: VerificationServer, headers: Record<string, string>;
const at = (name: string) => join(fixture.info.dataDir, name);
const href = (file: string) => JSON.stringify(pathToFileURL(join(process.cwd(), file)).href);
const ok = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await response.json() as any;
  if (response.status < 200 || response.status > 299) throw new Error(`${method} ${path} answered ${response.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
};
const lines = (name: string) => existsSync(at(name)) ? readFileSync(at(name), "utf8").split("\n").filter(Boolean) : [];
const submissions = (threadId: string) => lines("dump").map(line => JSON.parse(line)).filter(row => row.threadId === threadId && !row.prompt).length;
const botIdle = async (botId: string) => (await ok("GET", "/api/bots?messages=0")).bots.find((bot: any) => bot.id === botId)?.busy !== true;
const botMessages = async (threadId: string) => ((await ok("GET", `/api/threads/${threadId}/messages?limit=200`)).messages as any[]).filter(message => message.role === "bot");
const newBot = async (name: string) => {
  const bot = (await ok("POST", "/api/bots", { name, modelSelection: { instanceId: "fenced", model: "late-1" } })).bot as { id: string; threadId: string };
  await ok("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
  return bot;
};
const settled = async (botId: string) => {
  await expect.poll(async () => await botIdle(botId), { timeout: 30000 }).toBe(true);
  await new Promise(resolve => setTimeout(resolve, 1500));
};

describe.skipIf(process.platform === "win32")("1.0.20 T1/B2: a turn whose setup failed inside Murage", () => {
  beforeAll(async () => {
    fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
      const fs=await import('node:fs'); const path=await import('node:path');
      const {BUILT_IN_DRIVERS}=await import(${href("server/drivers/builtIn.ts")});
      const {makeLateTerminalDriver}=await import(${href("server/testing/fake-late-terminal-driver.ts")});
      const dir=process.env.MURAGE_DATA_DIR; const at=name=>path.join(dir,name);
      const {murageStartFailureLine}=await import(${href("shared/murage-start-failure.ts")});
      const driver=makeLateTerminalDriver(); const create=driver.create.bind(driver);
      // setup-arm "<code> <n>": the next n sendTurn calls throw <code> before the engine submits anything, as a failed setup does
      driver.create=async input=>{
        const instance=await create(input); const send=instance.adapter.sendTurn.bind(instance.adapter);
        instance.adapter.sendTurn=async turn=>{
          if(fs.existsSync(at('setup-arm'))){
            const [code,left]=fs.readFileSync(at('setup-arm'),'utf8').split(' ');
            if(Number(left)>1)fs.writeFileSync(at('setup-arm'),code+' '+(Number(left)-1)); else fs.rmSync(at('setup-arm'),{force:true});
            fs.appendFileSync(at('setup-thrown'),turn.threadId+'\\n');
            // "wrapped:<code>": the exec driver's plainGuardFailure (murage-exec-wipe.ts): the plain line is the message, the code rides along
            if(code.startsWith('wrapped:')) throw Object.assign(new Error(murageStartFailureLine('wipe-guard')),{code:code.slice(8)});
            throw new Error(code);
          }
          return send(turn);
        };
        return instance;
      };
      BUILT_IN_DRIVERS.push(driver);
      const file=at('config.json');const cfg=JSON.parse(fs.readFileSync(file,'utf8'));
      cfg.instances.fenced={driver:'fakeLateTerminal',environment:{FAKE_LATE_DUMP:at('dump'),FAKE_LATE_FENCED_WRITES:'1'}};
      fs.writeFileSync(file,JSON.stringify(cfg));
    ` });
    const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  }, 90000);
  afterAll(async () => { await fixture?.close(); });

  // [code, how many sendTurn calls throw it, answered?, sendTurn calls that threw]
  it.each([
    ["wipe-guard-invalid-turn", 1, true, 1],
    ["instance_not_attached", 1, true, 1],
    // P9 (1.0.24): the exec driver wraps its guard failures (plain line in the message, code in .code): the retry reads the code
    ["wrapped:wipe-path-probe-failed", 1, true, 1],
    ["invalid_attachment", 1, true, 1],
    ["wipe-guard-invalid-turn", 2, false, 2],
    ["wrapped:wipe-path-probe-failed", 2, false, 2],
    ["invalid_attachment", 2, false, 2],
    // not retried: the engine may still be running its previous reply
    ["provider_stop_unconfirmed", 1, false, 1],
    // MAIN ruling: an engine's or provider's own bare code is NOT Murage's: it keeps its own text (and so its own card, with Models)
    ["invalid_api_key", 1, false, 1],
    ["usage_limit_reached", 1, false, 1],
    ["rate_limit_exceeded", 1, false, 1],
    ["model_not_found", 1, false, 1],
  ] as const)("%s thrown %i time(s)", async (code, times, answered, made) => {
    const murageOwn = /^(?:wipe-guard-|wrapped:wipe-|instance_not_attached$|provider_stop_unconfirmed$|invalid_attachment$)/.test(code);
    const bareCode = code.replace(/^wrapped:/, "");
    const bot = await newBot(`Setup ${bareCode} ${times}`);
    await settled(bot.id);
    const before = submissions(bot.threadId), rowsBefore = (await botMessages(bot.threadId)).length;
    writeFileSync(at("setup-arm"), `${code} ${times}`);
    await ok("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text: "please look at this" });
    // the first throw has happened; a second one only follows when the turn was prepared again (so a base that never retries is RED at the
    // sendTurn-call count below, not by a timeout waiting for the arm to be used up)
    await expect.poll(() => lines("setup-thrown").filter(line => line === bot.threadId).length, { timeout: 30000 }).toBeGreaterThan(0);
    await settled(bot.id);
    rmSync(at("setup-arm"), { force: true });
    // the fixture engine's own "engine limit:" activity row comes with every bot here (nativecrash-llr-1019.test.ts excludes it the same way)
    const rows = (await botMessages(bot.threadId)).slice(rowsBefore).filter(row => !String(row.tool?.name ?? "").startsWith("engine limit:"));
    const log = readFileSync(fixture.info.logPath, "utf8").split("\n").filter(line => line.includes(bot.threadId));
    console.log("T1-SETUP", code, times, submissions(bot.threadId) - before, JSON.stringify(rows.map(row => [row.kind, row.text ?? row.tool?.name, row.tool?.errorDetails])));
    expect(lines("setup-thrown").filter(line => line === bot.threadId)).toHaveLength(made);
    expect(submissions(bot.threadId) - before).toBe(answered ? 1 : 0);
    // the owner never reads a raw internal code, in any row
    if (murageOwn) for (const row of rows) expect(String(row.text ?? "") + String(row.tool?.name ?? "")).not.toMatch(/wipe-guard-|wipe-root-|wipe-path-|instance_not_attached|provider_stop_unconfirmed|invalid_attachment|^error:|Send it again/i);
    if (answered) {
      expect(rows.filter(row => row.kind === "text" && row.text === "Hello from late")).toHaveLength(1);
      expect(rows.filter(row => row.kind === "activity" && row.tool?.ok === false)).toHaveLength(0);
      // nothing else but the reply and, as on every rebuild of a proven-unwritten turn, at most Murage's own left-out note
      expect(rows.filter(row => !(row.kind === "text" || row.memoryNote === "without-memory"))).toEqual([]);
      expect(log.some(line => line.includes(`[turn] setup failed in Murage on thread ${bot.threadId} (${code.startsWith("wrapped:") ? murageStartFailureLine("wipe-guard") : code}); preparing it once more`))).toBe(true);
    } else {
      expect(rows.filter(row => row.kind === "text")).toHaveLength(0);
      const cards = rows.filter(row => row.kind === "activity" && row.tool?.ok === false);
      // the engine's code is shown as it came, never under Murage's line; nothing re-prepared it (made === 1 above)
      expect(cards.map(row => row.tool.name)).toEqual([murageOwn ? murageStartFailureLine(bareCode) : `error: ${code}`]);
      expect(String(cards[0].tool.errorDetails)).toContain(bareCode);
      if (!murageOwn) for (const row of rows) expect(String(row.text ?? "") + String(row.tool?.name ?? "")).not.toContain("Murage couldn");
    }
  }, 120000);
});
