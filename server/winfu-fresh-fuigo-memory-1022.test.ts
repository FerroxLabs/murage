// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.22 winfu: on a fresh install, the first Fuigo turn that reads memory over HTTP must reply. The shipped build ended it with
// "Murage couldn't start this reply. Send it again." (a ledger refusal checking:not-built, then the re-prepared turn refused at the
// consuming HTTP door). Through the real server, the real Fuigo (ACP) driver, its bound memory mount and the real memory proxy:
// the fake engine calls memory_search on the mount it was handed, exactly as Fuigo does.
//
// Owners: witness = q1022-winfu-opus; fake ACP engine = server/testing/fake-acp-cli.ts (its memory-search mode).
// Needs a POSIX host (the fake CLI is a shebang script).
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { VerificationServer } from "../scripts/control-murage.ts";
import { launchMemoryVerificationServer as launchVerificationServer } from "./testing/memory-verification-fixture.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const RETAINED_PRELOAD_URL = pathToFileURL(join(SERVER_DIR, "testing", "claude-retained-session-preload.mjs")).href;
const COULD_NOT_START = /couldn.t start this reply/i;

const instrumentation = `
  await import(${JSON.stringify(RETAINED_PRELOAD_URL)});
  const fs=await import('node:fs');const path=await import('node:path');
  const dir=process.env.MURAGE_DATA_DIR;
  const cfgFile=path.join(dir,'config.json');const cfg=JSON.parse(fs.readFileSync(cfgFile,'utf8'));
  fs.mkdirSync(path.join(process.env.HOME,'.fuigo'),{recursive:true});fs.writeFileSync(path.join(process.env.HOME,'.fuigo','auth.json'),'{}');
  const acp=(env)=>({driver:'fuigoAgent',displayName:'Fuigo fixture',environment:{FAKE_ACP_MODE:'memory-search',FAKE_ACP_MCP_READY:'1',FAKE_ACP_MEMORY_LOG:path.join(dir,'acp-memory.log'),...env},config:{cli:${JSON.stringify(FAKE_ACP)}}});
  cfg.instances['winfu-acp']=acp({});
  // the mounts announced ready 6 s after they were handed over
  cfg.instances['winfu-slow']=acp({FAKE_ACP_MCP_READY_DELAY_MS:'6000'});
  // the store's first Fuigo turn (it runs first): the engine lists every mount as still starting past the turn's 3 s window, and they come
  // up at 9 s; the turn waits for them and replies (G does too: a guard for the real HTTP memory path, not the box's trigger)
  cfg.instances['winfu-gate']=acp({FAKE_ACP_MCP_READY_DELAY_MS:'9000',FAKE_ACP_MCP_LIST:'all:ready',FAKE_ACP_MCP_LIST_READY_AFTER_MS:'9000'});
  fs.writeFileSync(cfgFile,JSON.stringify(cfg));
`;

let fixture: VerificationServer;
let memoryCalls = 0;
let headers: Record<string, string> = {};
const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let parsed: any = null; try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, body: parsed, text };
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitUntil(check: () => unknown | Promise<unknown>, what: string, ms = 60_000) {
  const end = Date.now() + ms;
  while (!(await check())) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(100); }
}
const serverLog = () => (existsSync(fixture.info.logPath) ? readFileSync(fixture.info.logPath, "utf8") : "");

describe.skipIf(process.platform === "win32")("winfu: a fresh store's first Fuigo turn that reads memory over HTTP", () => {
  beforeAll(async () => {
    chmodSync(FAKE_ACP, 0o755);
    fixture = await launchVerificationServer({ MURAGE_MCP_REQUIRED_WAIT_MS: "2000", MURAGE_MCP_RECOVERY_MS: "3000", MURAGE_MCP_RECONNECT_WAIT_MS: "2000" },
      undefined, { instrumentationSource: instrumentation });
    headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await call("GET", "/api/desktop-secret")).body.secret };
  }, 120_000);
  afterAll(async () => { await fixture?.close(); });

  it.each(["winfu-gate", "winfu-acp", "winfu-slow"])("%s: replies with the memory answer, never 'couldn't start this reply'", async (instanceId) => {
    const instance = (await call("GET", "/api/instances")).body.instances.find((entry: any) => entry.instanceId === instanceId);
    expect(instance, "the Fuigo fixture instance").toBeTruthy();
    const model = instance.models.options[0]?.id || instance.models.default || "fixture-model";
    const made = await call("POST", "/api/bots", { name: `Winfu ${instanceId}`, modelSelection: { instanceId, model } });
    expect(made.status, made.text).toBe(201);
    const bot = made.body.bot;
    await call("PATCH", `/api/bots/${bot.id}`, { computer: "off", browser: false, composio: false });
    const text = "MSEARCH: weekly client report";
    const sent = await call("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId });
    expect(sent.status, sent.text).toBe(202);
    let rows: any[] = [];
    await waitUntil(async () => {
      const view = (await call("GET", "/api/bots?messages=60")).body.bots.find((entry: any) => entry.id === bot.id);
      const all: any[] = view?.messages ?? [];
      const at = all.findIndex(row => row.role === "user" && row.text === text);
      rows = at >= 0 ? all.slice(at + 1) : [];
      return view?.busy !== true && rows.some(row => row.role === "bot" && (row.kind === "text" || COULD_NOT_START.test(String(row.tool?.name ?? row.text ?? ""))));
    }, "the first Fuigo turn to end", 90_000);
    const said = rows.map(row => `${row.kind}:${row.text ?? row.tool?.name ?? ""}`);
    const log = serverLog().split("\n").filter(line => /ledger refusal|native fence refusal|context revoked|consuming\]|\[acp\]|mcp gate|re-preparing|dispatch preparation/.test(line));
    expect(said.filter(line => COULD_NOT_START.test(line)), `turn rows ${JSON.stringify(said)}; server log ${JSON.stringify(log)}`).toEqual([]);
    expect(rows.some(row => row.role === "bot" && row.kind === "text" && /memory search answered/.test(row.text)), `turn rows ${JSON.stringify(said)}; server log ${JSON.stringify(log)}`).toBe(true);
    // the reply rests on a real answer from the server's memory route (a JSON body with a hits list), never the proxy's own sentence
    const answers = (existsSync(join(fixture.info.dataDir, "acp-memory.log")) ? readFileSync(join(fixture.info.dataDir, "acp-memory.log"), "utf8") : "")
      .split("\n").filter(Boolean).map(line => JSON.parse(line));
    expect(answers.length, "memory calls answered so far").toBeGreaterThanOrEqual(++memoryCalls);
    expect(answers[memoryCalls - 1], JSON.stringify(answers)).toMatchObject({ hits: expect.any(Number) });
  }, 150_000);
});
