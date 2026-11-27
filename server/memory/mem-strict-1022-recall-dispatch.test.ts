// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.22 mem-strict r8 (ASTRA f443268f73 / cb88b8fe82 / 674acab22b, server/index.ts awaitRecall): the 101x row ('memory recall skipped
// ... reason=budget wait=300'). Boots the real server (index.ts) with a fake ACP engine and sends the owner a turn whose recall takes
// 1 s (testing/recall-slow-preload.mjs holds the real build that long, as a loaded machine does). The dispatch step waits for it through
// its own awaitRecall (withRecallBudget(early, RECALL_WAIT_MS), unchanged): it must use the recall, never log the budget skip.
// Synthetic fixture text only; loopback only, no network.
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "../testing/cleanup.ts";
import { prepareFixtureRecall } from "../testing/recall-ready-fixture.ts";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
const GROK_MCP_READY = { FAKE_ACP_MCP_READY: "1", FAKE_ACP_MCP_READY_METHOD: "_x.ai/mcp_initialized", FAKE_ACP_MCP_LIST: "all:ready" };
const DESKTOP_SECRET = "c0ffee00c0ffee22".repeat(4);
const SLOW_MS = 1000;
const PORT = 28800 + Math.floor(Math.random() * 10_000);

describe("overlapped recall through the real dispatch step: a 1 s recall is waited for (101x reason=budget wait=300)", () => {
  let child: ChildProcess, home = "", stderr = "";
  const api = (method: string, path: string, body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest({ host: "127.0.0.1", port: PORT, path, method, agent: false, headers: { connection: "close", "x-murage-surface": "desktop", "x-murage-surface-secret": DESKTOP_SECRET, ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}) } }, res => {
      let text = ""; res.setEncoding("utf8"); res.on("data", c => { text += c; });
      res.on("end", () => { let parsed: any = text; try { parsed = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode ?? 0, body: parsed }); });
    });
    req.on("error", reject); if (data) req.write(data); req.end();
  });
  const waitUntil = async (predicate: () => Promise<boolean>, timeout: number, what: string) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await predicate()) return; await new Promise(r => setTimeout(r, 100)); }
    throw new Error(`${what}. stderr tail:\n${stderr.slice(-3000)}`);
  };
  beforeAll(async () => {
    chmodSync(FAKE_CLI, 0o755);
    home = mkdtempSync(join(tmpdir(), "murage-recall-dispatch-"));
    const { prepareMemoryMeterFixture } = await import("./testing/native-meter-fixture.ts");
    prepareMemoryMeterFixture(process.env.MURAGE_FIXTURE_IMPORT_ROOT ?? home);
    const nativeMeter = process.env.MURAGE_ENGINE_EXCLUSION_PATH;
    if (!nativeMeter) throw new Error("Fixture native I/O meter was not prepared");
    mkdirSync(join(home, ".murage"), { recursive: true });
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({ engineDiscovery: "explicit", instances: {
      recallProbe: { driver: "grokAgent", environment: { ...GROK_MCP_READY, FAKE_ACP_MODE: "happy" }, config: { cli: FAKE_CLI, fullAuto: true } } } }));
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, MURAGE_ENGINE_EXCLUSION_PATH: nativeMeter, MURAGE_PORT: String(PORT),
      MURAGE_DEV_DESKTOP_SECRET: DESKTOP_SECRET, NODE_ENV: "test", MURAGE_TEST_RECALL_SLOW_MS: String(SLOW_MS) };
    if (process.env.PATH) env.PATH = process.env.PATH;
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    const preload = ["--import", pathToFileURL(join(SERVER_DIR, "testing", "recall-slow-preload.mjs")).href,
      "--import", "data:text/javascript,globalThis[Symbol.for('murage.hostPower.testUnwrapped')]=true;",
      "--import", pathToFileURL(join(SERVER_DIR, "testing", "recall-ready-preload.mjs")).href];
    child = spawn(process.execPath, [...preload, join(SERVER_DIR, "index.ts")], { windowsHide: true, cwd: join(SERVER_DIR, ".."), env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.on("data", c => { stderr += c; }); child.stderr!.on("data", c => { stderr += c; });
    await waitUntil(async () => { if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}:\n${stderr.slice(-3000)}`); try { return (await api("GET", "/api/health")).status === 200; } catch { return false; } }, 30_000, "server never came up");
  }, 60_000);
  afterAll(async () => { if (child) await waitForExit(child, { signal: "SIGTERM" }); if (home) await removeTempDir(home); });

  it("the owner's turn waits for its 1 s recall and uses it: no budget skip, the engine answers", async () => {
    for (const existing of (await api("GET", "/api/bots")).body.bots) await api("PATCH", `/api/bots/${existing.id}`, { hidden: true, ...(existing.chiefOfStaff ? { chiefOfStaff: false } : {}) });
    const bot = (await api("POST", "/api/bots")).body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { name: "SlowRecall", modelSelection: { instanceId: "recallProbe", model: "fake-model" } })).status).toBe(200);
    const ready = (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id);
    await prepareFixtureRecall(join(home, ".murage"), bot.id, ready.threadId);
    // One turn decides: the budget skip line (dispatch gave up on its recall), or `settled` (its recall was waited for and used). A turn
    // whose early recall was rebuilt afresh because another connection committed meanwhile (index.ts authorityMoved, e.g. the memory
    // worker) never reaches the wait and decides nothing; at most 5 turns are sent to get a deciding one.
    const outcomes: Array<{ skipped: string[]; settled: boolean }> = [];
    for (let n = 1; n <= 5; n++) {
      const start = stderr.length;
      expect((await api("POST", `/api/bots/${bot.id}/messages`, { text: `hello ${n}` })).status).toBe(202);
      await waitUntil(async () => {
        const current = (await api("GET", "/api/bots")).body.bots.find((b: any) => b.id === bot.id);
        return !current.busy && current.messages.filter((m: any) => m.kind === "text" && m.role === "bot" && m.text === "hello from fake acp").length >= n;
      }, 30_000, `the engine never answered turn ${n}`);
      await new Promise(r => setTimeout(r, SLOW_MS + 200));
      const turn = stderr.slice(start);
      // the fixture reached this turn's overlapped recall
      expect(turn).toContain(`RECALL_SLOW_PRELOAD delayed ms=${SLOW_MS}`);
      const outcome = { skipped: turn.match(/memory recall skipped thread=\S+ engine=\S+ reason=budget wait=\d+/g) ?? [], settled: turn.includes("RECALL_SLOW_PRELOAD settled") };
      outcomes.push(outcome);
      if (outcome.skipped.length || outcome.settled) break;
    }
    // the outcome: dispatch waited for its 1 s recall (index.ts awaitRecall) and used it; the turn did not go out without it
    expect(outcomes.at(-1)).toEqual({ skipped: [], settled: true });
  }, 240_000);
});
