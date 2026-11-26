// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.22 idle gate (the owner's release gate 05c): a booted server that nobody uses writes under the idle budget. After a five minute
// warm-up, thirty idle minutes print no `[io-budget] writing ... (budget N)` line. Real server (server/index.ts), fake engines, real
// timers: the watchdog's own stderr line is the evidence, exactly what the gate greps. The test also names the files that changed in
// each minute (a size and mtime walk of the home, read-only), so a failing minute says which writer it was.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeEngineImportArgs, powerBlockTestEnv } from "./testing/power-block-test.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PORT = 18000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const MINUTE = 60_000;
/** The gate's shape: 5 minutes of warm-up, then 30 judged idle minutes. The env overrides are for a lane's quick look only. */
const WARMUP_MINUTES = Number(process.env.IDLE_WITNESS_WARMUP_MINUTES ?? 5);
const IDLE_MINUTES = Number(process.env.IDLE_WITNESS_MINUTES ?? 30);
/** Kilobytes of text in each warm-up message: the search index and the conversation rows are that much bigger. */
const TEXT_KB = Number(process.env.IDLE_WITNESS_TEXT_KB ?? 400);
const FAKE_CLI = join(SERVER_DIR, "testing", "fake-acp-cli.ts");
/** The fixture desktop proof: 64 hex characters, the same in the server's environment and in every request of the warm-up. */
const DESKTOP_PROOF = "ab".repeat(32);
const DESKTOP_HEADERS = { "x-murage-surface": "desktop", "x-murage-surface-secret": DESKTOP_PROOF };

/** The watchdog's judged minutes as the server published them: the `io-minute` facts of .murage/health/server.current.ndjson (one per
 *  judged tick, io-budget.ts onSample -> recordFact; the health publisher appends them once a minute). */
function judgedMinutes(home: string): Array<{ idle: boolean; intervalMs: number; chargedBytes: number; budgetBytes: number; discontinuity: boolean }> {
  let text = "";
  try { text = readFileSync(join(home, ".murage", "health", "server.current.ndjson"), "utf8"); } catch { return []; }
  const facts: Array<{ idle: boolean; intervalMs: number; chargedBytes: number; budgetBytes: number; discontinuity: boolean }> = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { for (const fact of JSON.parse(line).facts ?? []) if (fact.kind === "io-minute") facts.push(fact); } catch { /* a line still being appended */ }
  }
  return facts;
}

function walk(root: string): Map<string, string> {
  const seen = new Map<string, string>();
  const visit = (dir: string, depth: number) => {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const path = join(dir, name);
      try {
        const stat = lstatSync(path);
        if (stat.isDirectory()) { if (depth < 8) visit(path, depth + 1); }
        else if (stat.isFile()) seen.set(path.slice(root.length + 1), `${stat.size}@${Math.round(stat.mtimeMs)}`);
      } catch { /* gone between the listing and the stat */ }
    }
  };
  visit(root, 0);
  return seen;
}

describe("1.0.22 idle gate: a booted, unused server writes under the idle budget", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";
  let stdout = "";

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "idle-ordfiles-"));
    mkdirSync(join(home, ".murage"), { recursive: true });
    chmodSync(FAKE_CLI, 0o755);
    writeFileSync(join(home, ".murage", "config.json"), JSON.stringify({ instances: {
      happy: { driver: "grokAgent", environment: { FAKE_ACP_MCP_READY: "1", FAKE_ACP_MCP_READY_METHOD: "_x.ai/mcp_initialized" }, config: { cli: FAKE_CLI, fullAuto: true } },
    } }));
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, MURAGE_PORT: String(PORT), MURAGE_DEV_DESKTOP_SECRET: DESKTOP_PROOF };
    if (process.env.PATH) env.PATH = process.env.PATH;
    child = spawn(process.execPath, [...fakeEngineImportArgs(), join(SERVER_DIR, "index.ts")], {
      windowsHide: true, cwd: join(SERVER_DIR, ".."), env: { ...env, ...powerBlockTestEnv() }, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr!.on("data", chunk => { stderr += chunk; });
    child.stdout!.on("data", chunk => { stdout += chunk; });
    const deadline = Date.now() + 120_000;
    for (;;) {
      try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr.slice(-4000)}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr.slice(-4000)}`);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }, 150_000);

  afterAll(async () => {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    if (home) await removeTempDir(home);
  });

  it(`prints no over-budget writing line in ${IDLE_MINUTES} idle minutes after a ${WARMUP_MINUTES} minute warm-up`, async () => {
    const lines = () => `${stderr}\n${stdout}`.split("\n").filter(line => /\[io-budget\] writing .*\(budget \d+/.test(line));
    const started = Date.now();
    // The warm-up is real use, as on the owner's computer: conversations with replies, then one of them deleted. All of it is over
    // before the warm-up ends; the judged minutes that follow have no turn, no request and no owner.
    const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...DESKTOP_HEADERS }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };
    const bots: string[] = [];
    for (let b = 0; b < 3; b++) {
      const created = (await api("POST", "/api/bots")).body.bot;
      bots.push(created.id);
      for (let turn = 1; turn <= 4; turn++) {
        const words = Array.from({ length: Math.ceil(TEXT_KB * 1024 / 9) }, (_, at) => `w${b}${turn}x${(at * 2654435761 % 1_000_003).toString(36)}`).join(" ");
        expect((await api("POST", `/api/bots/${created.id}/messages`, { text: `idle gate ${b}.${turn}: ${words}` })).status).toBe(202);
        const deadline = Date.now() + 60_000;
        for (;;) {
          const bot = (await api("GET", "/api/bots")).body.bots.find((item: { id: string }) => item.id === created.id);
          if (bot && !bot.busy && bot.messages.filter((m: { role: string; kind: string }) => m.role === "bot" && m.kind === "text").length >= turn) break;
          if (Date.now() > deadline) throw new Error(`warm-up turn ${b}.${turn} never settled: ${stderr.slice(-2000)}`);
          await new Promise(resolve => setTimeout(resolve, 250));
        }
      }
    }
    // the deletion is the warm-up's last act, 20 s before it ends: what it leaves owed (the search index's merge and scrub of the removed
    // text, the log's scrub) is background work of the idle minutes that follow
    expect(Date.now() - started, "the warm-up's use took longer than the warm-up").toBeLessThan(WARMUP_MINUTES * MINUTE - 25_000);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, WARMUP_MINUTES * MINUTE - 20_000 - (Date.now() - started))));
    expect((await api("DELETE", `/api/bots/${bots[0]}`)).status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, Math.max(0, WARMUP_MINUTES * MINUTE - (Date.now() - started))));
    const warm = lines().length;
    const judgedWarm = judgedMinutes(home).length;
    let before = walk(home);
    const changed: string[] = [];
    for (let minute = 1; minute <= IDLE_MINUTES; minute++) {
      await new Promise(resolve => setTimeout(resolve, MINUTE));
      expect(child.exitCode, `the server stopped in idle minute ${minute}: ${stderr.slice(-2000)}`).toBeNull();
      const after = walk(home);
      const names: string[] = [];
      for (const [path, mark] of after) if (before.get(path) !== mark) names.push(`${path} ${before.get(path) ?? "new"} -> ${mark}`);
      if (names.length) changed.push(`minute ${minute}: ${names.slice(0, 40).join(" | ")}`);
      before = after;
    }
    const over = lines().slice(warm);
    console.info(`[idle-witness] files changed per idle minute:\n${changed.join("\n") || "none"}`);
    console.info(`[idle-witness] over-budget lines after warm-up: ${over.length} (in the warm-up: ${warm})\n${lines().map(line => line.slice(0, 260) + " ... " + line.slice(-420)).join("\n")}`);
    expect(over.map(line => line.slice(0, 600)), `files changed:\n${changed.join("\n")}`).toEqual([]);
    // Liveness: no line means nothing unless the watchdog judged these minutes. Every judged tick publishes one io-minute fact; the
    // idle window holds one per minute (the last may not be published yet, and the first boundary may fall just before the window):
    // each a whole idle minute against the idle budget. A watchdog whose timer died, or that skips its ticks, publishes none.
    const judged = judgedMinutes(home).slice(judgedWarm);
    console.info(`[idle-witness] judged minutes in the idle window: ${judged.length} ${JSON.stringify(judged.map(fact => [fact.idle, fact.intervalMs, fact.chargedBytes, fact.budgetBytes, fact.discontinuity]))}`);
    const whole = judged.filter(fact => fact.idle === true && fact.budgetBytes === 1024 * 1024 && fact.intervalMs >= 55_000 && fact.intervalMs <= 65_000);
    expect(whole.length, `whole idle minutes the watchdog judged, of ${IDLE_MINUTES}`).toBeGreaterThanOrEqual(IDLE_MINUTES - 2);
    // and the facts agree with the lines: no judged idle minute charged more than its budget
    expect(judged.filter(fact => fact.idle === true && fact.chargedBytes > fact.budgetBytes)).toEqual([]);
  }, (WARMUP_MINUTES + IDLE_MINUTES + 3) * MINUTE);
});
