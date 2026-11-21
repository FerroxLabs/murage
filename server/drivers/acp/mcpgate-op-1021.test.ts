// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: ACP driver mounted MCP gate (acp/core.ts, the bound-mount list wait). Consumer: direct-turn ledger lease (ledger-refusal.ts),
// which alone decides between a refusal row and a confirmed Stop (JOINT RULING STOP-VS-REFUSAL).
// 1.0.20 ctxrev cause 3 (fix round): the mounted gate re-reads the engine's `_fuigo/mcp/list` inside the turn window. These witnesses
// pin what that wait must do on the engine's real wire (fake ACP engine process, real fenced submit): an unanswered read never ends
// a recoverable wait nor erases a negative list, a Stop never turns a due refusal into a silent cancel, a failed server is not
// waited for, and no read runs past the window. A server never proven ready still refuses the turn (fail closed).
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { recordEvents } from "../../testing/events.ts";
import { fixtureMountTurn } from "../../testing/mcp-admission-fixture.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { createAcpDriver, resetAcpMcpReadinessForTests, type AcpSupport } from "./core.ts";
import * as native from "../engine-input.ts";
import * as trace from "../native.ts";

const CLI = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
const support: AcpSupport = {
  driverKind: "fuigoAgent", displayName: "Gate ACP", defaultCli: CLI, nativeSource: "mcpgate-op.acp",
  models: { default: "", options: [] }, loginNote: "fixture", spawnArgs: () => [],
  pickAuthMethod: () => null, authFailure: "continue", isAuthenticated: () => true,
  pooledSessions: true, mcpListMethod: "_fuigo/mcp/list",
  fluxReach: () => "elsewhere",
};
const REFUSAL_LINE = "I stopped this turn because some of its context is no longer available.";
let root: string, instance: ProviderInstance | undefined;
let wire: any[];
beforeEach(() => {
  resetAcpMcpReadinessForTests();
  ensureDirs(); chmodSync(CLI, 0o755);
  root = mkdtempSync(join(tmpdir(), "mcpgate-op-"));
  vi.stubEnv("MURAGE_ACP_POOL", "1");
  vi.stubEnv("FAKE_ACP_RPC_LOG", join(root, "rpc.jsonl"));
  wire = [];
  const submit = native.fencedSubmit;
  // Observation only: every frame still goes through the real fenced submit.
  vi.spyOn(native, "fencedSubmit").mockImplementation((turn, write, serialized, validate) =>
    submit(turn, () => {
      if (serialized) wire.push(JSON.parse(serialized));
      return write();
    }, serialized, validate));
});
afterEach(async () => {
  await instance?.dispose(); instance = undefined;
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await removeTempDir(root);
});
async function create(extra: Partial<AcpSupport> = {}) {
  instance = await createAcpDriver({ ...support, ...extra }).create({ instanceId: "mcpgate-op", displayName: "Gate ACP", enabled: true,
    environment: { HOME: root }, config: { cli: CLI, fullAuto: false } });
  return recordEvents(instance.adapter);
}
const mounted = () => fixtureMountTurn({ threadId: "mcpgate-op-mounted", cwd: root, text: "hello",
  warmIdentity: { botId: "mcpgate-op-bot", audience: "owner", decidedOwner: true },
  integrations: { agents: { command: process.execPath, args: ["-e", "process.stdin.resume()"], env: {} } } });
/** The engine's own log of what it was asked (the fake engine writes one line per request, answered or not). */
const listReads = () => readFileSync(join(root, "rpc.jsonl"), "utf8").split("\n").filter(line => line.includes("_fuigo/mcp/list")).length;
const prompts = () => wire.filter(row => row.method === "session/prompt");
const refusalLines = (records: { events: any[] }) => records.events.filter(event => event.type === "runtime.error" && event.message === REFUSAL_LINE);
const completion = (records: Awaited<ReturnType<typeof create>>, turnId: string) => records.until(e => e.type === "turn.completed" && e.turnId === turnId, 40_000);

describe("1.0.20 ctxrev cause 3: the mounted gate's list wait", () => {
  it("A1 a negative list followed by silence stays negative: the aggregate ready signal does not admit the missing mount", async () => {
    // Read 1 names only another server (the mount is missing); the engine then announces all servers initialized; every later
    // list read goes unanswered. Before: the gate's own read timed out, states were null and the aggregate admitted the prompt.
    vi.stubEnv("FAKE_ACP_MCP_LIST", JSON.stringify({ "fixture-other": "ready" }));
    vi.stubEnv("FAKE_ACP_MCP_LIST_UNANSWERED", "2+");
    vi.stubEnv("FAKE_ACP_MCP_READY", "1");
    vi.stubEnv("MURAGE_MCP_RECOVERY_MS", "4000");
    const records = await create({ mcpReadyNotification: "_fuigo/mcp_initialized" });
    const sent = await instance!.adapter.sendTurn(mounted());
    expect(await completion(records, sent.turnId)).toMatchObject({ ok: false, stopReason: "memory-refused" });
    expect(refusalLines(records)).toHaveLength(1);
    expect(prompts()).toEqual([]);
    expect(listReads()).toBeGreaterThan(1);
  }, 60_000);

  it("A2 one unanswered read inside the window does not end a recoverable wait: the server that comes up is used", async () => {
    // Read 1 says initializing, read 2 times out, the server is ready from 2.5 s on. Before: the timeout broke the wait and the
    // turn was refused on the stale list.
    vi.stubEnv("FAKE_ACP_MCP_LIST", "all:ready");
    vi.stubEnv("FAKE_ACP_MCP_LIST_READY_AFTER_MS", "2500");
    vi.stubEnv("FAKE_ACP_MCP_LIST_UNANSWERED", "2");
    const records = await create();
    const sent = await instance!.adapter.sendTurn(mounted());
    expect(await completion(records, sent.turnId)).toMatchObject({ ok: true });
    expect(refusalLines(records)).toEqual([]);
    expect(prompts()).toHaveLength(1);
    expect(listReads()).toBeGreaterThan(2);
  }, 60_000);

  it("A3 a Stop during the wait with the mount still not ready reaches the refusal, never a silent cancel", async () => {
    // The ledger (not the driver) decides whether a confirmed Stop hides the row; the driver must hand it the refusal.
    vi.stubEnv("FAKE_ACP_MCP_LIST", "all:initializing");
    vi.stubEnv("MURAGE_MCP_RECOVERY_MS", "10000");
    const records = await create();
    const sent = await instance!.adapter.sendTurn(mounted());
    await vi.waitFor(() => expect(listReads()).toBeGreaterThan(1), { timeout: 15_000, interval: 50 });
    const stopping = instance!.adapter.interruptTurn!("mcpgate-op-mounted");
    expect(await completion(records, sent.turnId)).toMatchObject({ ok: false, stopReason: "memory-refused" });
    await stopping;
    expect(refusalLines(records)).toHaveLength(1);
    expect(prompts()).toEqual([]);
  }, 60_000);

  it("A4 no read runs past the window: a busy engine that stops answering is refused at the window, not 3 s later", async () => {
    vi.stubEnv("FAKE_ACP_MCP_LIST", "all:initializing");
    vi.stubEnv("FAKE_ACP_MCP_LIST_UNANSWERED", "2+");
    vi.stubEnv("MURAGE_MCP_RECOVERY_MS", "2000");
    const records = await create();
    const sent = await instance!.adapter.sendTurn(mounted());
    await vi.waitFor(() => expect(listReads()).toBeGreaterThan(0), { timeout: 15_000, interval: 20 });
    const firstReadAt = Date.now();
    expect(await completion(records, sent.turnId)).toMatchObject({ ok: false, stopReason: "memory-refused" });
    // the window is at most 2 s from the gate's first read; an unbounded last read would add up to its full 3 s
    expect(Date.now() - firstReadAt).toBeLessThan(2_800);
    expect(prompts()).toEqual([]);
  }, 60_000);

  it("A5 a server the engine reports failed is refused at once, with no wait for a server that will not come", async () => {
    vi.stubEnv("FAKE_ACP_MCP_LIST", "all:error");
    const records = await create();
    const startedAt = Date.now();
    const sent = await instance!.adapter.sendTurn(mounted());
    expect(await completion(records, sent.turnId)).toMatchObject({ ok: false, stopReason: "memory-refused" });
    expect(listReads()).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(8_000);
    expect(prompts()).toEqual([]);
  }, 60_000);

  it("A6 guard: a server still starting when the window ends keeps the fail-closed refusal after a bounded wait", async () => {
    vi.stubEnv("FAKE_ACP_MCP_LIST", "all:initializing");
    vi.stubEnv("MURAGE_MCP_RECOVERY_MS", "1500");
    const records = await create();
    const sent = await instance!.adapter.sendTurn(mounted());
    expect(await completion(records, sent.turnId)).toMatchObject({ ok: false, stopReason: "memory-refused" });
    expect(listReads()).toBeGreaterThan(2);
    expect(prompts()).toEqual([]);
  }, 60_000);

  it("A7 an oversized frame after a Stop during the wait, with the mount still not ready, reaches the refusal, never a silent cancel", async () => {
    // Read 2 goes unanswered and the engine writes one frame over the limit 1.2 s into it; the Stop lands at the start of read 2 and
    // the engine outlives its SIGTERM by 4 s (the close is not yet confirmed), so the driver's overflow handler runs after the Stop
    // while the gate still waits on that read. Before: the overflow settled the turn cancelled at once and the due refusal never
    // reached the ledger.
    vi.stubEnv("FAKE_ACP_MCP_LIST", "all:initializing");
    vi.stubEnv("FAKE_ACP_MCP_LIST_UNANSWERED", "2+");
    vi.stubEnv("FAKE_ACP_MCP_LIST_OVERSIZE_AT", "2:1200");
    vi.stubEnv("FAKE_ACP_TERM", "linger");
    vi.stubEnv("FAKE_ACP_TERM_MS", "4000");
    vi.stubEnv("MURAGE_MCP_RECOVERY_MS", "10000");
    // Observation only: the driver's own native record of the overflow, still written by the real appendNative.
    const overflows: number[] = [];
    const append = trace.appendNative;
    vi.spyOn(trace, "appendNative").mockImplementation((threadId, entry, size) => {
      if ((entry.msg as { frameOverflow?: unknown } | null)?.frameOverflow) overflows.push(Date.now());
      return append(threadId, entry, size);
    });
    const records = await create();
    const sent = await instance!.adapter.sendTurn(mounted());
    await vi.waitFor(() => expect(listReads()).toBeGreaterThan(1), { timeout: 15_000, interval: 20 });
    const stoppedAt = Date.now();
    const stopping = instance!.adapter.interruptTurn!("mcpgate-op-mounted").catch(error => error);
    expect(await completion(records, sent.turnId)).toMatchObject({ ok: false, stopReason: "memory-refused" });
    // the overflow handler ran after the Stop and before the gate settled the turn
    expect(overflows).toHaveLength(1);
    expect(overflows[0]).toBeGreaterThan(stoppedAt);
    await stopping;
    expect(refusalLines(records)).toHaveLength(1);
    expect(prompts()).toEqual([]);
  }, 60_000);

  it("A8 a Stop All during the wait, with the mount still not ready, reaches the refusal at once, not at the window's end", async () => {
    // Stop All asks every turn to stop without an interrupt. The gate no longer settles cancelled on the engine's end (A3, A7), so it
    // must itself wake on any asked Stop. Before: it kept reading a closed engine until the 10 s window, then refused.
    vi.stubEnv("FAKE_ACP_MCP_LIST", "all:initializing");
    vi.stubEnv("MURAGE_MCP_RECOVERY_MS", "10000");
    const records = await create();
    const sent = await instance!.adapter.sendTurn(mounted());
    await vi.waitFor(() => expect(listReads()).toBeGreaterThan(1), { timeout: 15_000, interval: 20 });
    const stoppedAt = Date.now();
    const stopping = instance!.adapter.stopAll!().catch(error => error);
    expect(await completion(records, sent.turnId)).toMatchObject({ ok: false, stopReason: "memory-refused" });
    // at most one 250 ms pause and one 3 s read after the Stop
    expect(Date.now() - stoppedAt).toBeLessThan(7_000);
    await stopping;
    expect(refusalLines(records)).toHaveLength(1);
    expect(prompts()).toEqual([]);
  }, 60_000);
});
