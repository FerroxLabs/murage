// STOP-FENCE test harness (scaffolding only; no product code). Fake ACP engine that logs every method it receives and holds chosen replies on gate files.
import { safeWipeSync } from "../../testing/safe-wipe.mjs";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { ProviderInstance } from "../../contracts.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

export type StopAction = "interrupt" | "reset" | "stopAll" | "dispose";
export const STOP_ACTIONS: readonly StopAction[] = ["interrupt", "reset", "stopAll", "dispose"];

export interface FakeEngine { root: string; cli: string; gate(name: string): string; open(name: string): void; started(): boolean; methods(): string[]; hold(name: string): boolean; }

// `--version` waits on gate "version" (marker "version-probing"); any other start is a spawn (marker "started") speaking line-delimited JSON-RPC on stdio.
// An ACP method listed in `holdMethods` announces "held-<method>" and waits on gate "<method>" before replying. Every received method is appended to `methods.log`.
export interface EngineOpts { errorOn?: string[]; exitOn?: string[]; nullOn?: string[]; mcpList?: boolean; reply?: boolean }
export function makeFakeEngine(holdMethods: string[] = [], holdVersion = false, opts: EngineOpts = {}): FakeEngine {
  const root = mkdtempSync(join(tmpdir(), "stop-fence-"));
  const cli = join(root, "engine.mjs");
  writeFileSync(cli, `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const R = ${JSON.stringify(root)}, HOLD = new Set(${JSON.stringify(holdMethods)}), ERR = new Set(${JSON.stringify(opts.errorOn ?? [])}), EXIT = new Set(${JSON.stringify(opts.exitOn ?? [])}), NUL = new Set(${JSON.stringify(opts.nullOn ?? [])}), REPLY = ${JSON.stringify(opts.reply === true)};
if (process.argv.includes("--stubborn")) process.on("SIGTERM", () => {});
const wait = async name => { while (!existsSync(R + "/gate-" + name)) await new Promise(r => setTimeout(r, 20)); };
if (process.argv.includes("--version")) {
  writeFileSync(R + "/version-probing", "x");
  ${holdVersion ? `await wait("version");` : ""}
  console.log("1.19.4"); process.exit(0);
}
writeFileSync(R + "/started", "x");
const out = o => process.stdout.write(JSON.stringify(o) + "\\n");
createInterface({ input: process.stdin }).on("line", async line => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (!m.method) return;
  appendFileSync(R + "/methods.log", m.method + "\\n");
  if (HOLD.has(m.method)) { writeFileSync(R + "/held-" + m.method.replace(/\\//g, "_"), "x"); await wait(m.method.replace(/\\//g, "_")); }
  if (EXIT.has(m.method)) process.exit(1);
  if (NUL.has(m.method)) { out({ jsonrpc: "2.0", id: m.id, result: null }); return; }
  if (ERR.has(m.method)) { out({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "fixture failure" } }); return; }
  if (m.method === "initialize") out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
  else if (m.method === "session/new") out({ jsonrpc: "2.0", id: m.id, result: { sessionId: "s1" } });
  else if (m.method === "_fixture/mcp_list") out({ jsonrpc: "2.0", id: m.id, result: { servers: [{ name: "agents", session: { status: "pending" } }] } });
  else if (m.method === "session/prompt") { if (REPLY) out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } } }); out({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } }); }
  else if (m.id !== undefined) out({ jsonrpc: "2.0", id: m.id, result: {} });
});
setInterval(() => {}, 1000);
`);
  chmodSync(cli, 0o755);
  return {
    root, cli,
    gate: name => join(root, `gate-${name}`),
    open: name => writeFileSync(join(root, `gate-${name}`), "open"),
    started: () => existsSync(join(root, "started")),
    methods: () => (existsSync(join(root, "methods.log")) ? readFileSync(join(root, "methods.log"), "utf8").split("\n").filter(Boolean) : []),
    hold: name => existsSync(join(root, `held-${name.replace(/\//g, "_")}`)),
  };
}

export function fixtureSupport(engine: FakeEngine, extra: Partial<AcpSupport> = {}): AcpSupport {
  return { driverKind: "opencodeGo", displayName: "Fixture", defaultCli: engine.cli, nativeSource: "fixture", loginNote: "fixture",
    models: { default: "p/m", options: [{ id: "p/m", label: "Fixture" }] }, spawnArgs: () => ["acp"], pickAuthMethod: () => null, isAuthenticated: () => true, authFailure: "continue", ...extra };
}

export async function createFixture(engine: FakeEngine, extra: Partial<AcpSupport> = {}): Promise<ProviderInstance> {
  return createAcpDriver(fixtureSupport(engine, extra)).create({ instanceId: "stop-fence", displayName: "Fixture", enabled: true, environment: {}, config: { cli: engine.cli, fullAuto: false } });
}

export async function applyStop(instance: ProviderInstance, action: StopAction, threadId: string): Promise<void> {
  if (action === "interrupt") await instance.adapter.interruptTurn(threadId);
  else if (action === "reset") await instance.adapter.resetSession?.(threadId);
  else if (action === "stopAll") await instance.adapter.stopAll?.();
  else await instance.dispose();
}

export const waitFor = (fn: () => void) => vi.waitFor(fn, { timeout: 10_000 });
export const cleanupEngine = (e: FakeEngine) => safeWipeSync(e.root);
