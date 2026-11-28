// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: ACP driver mounted MCP gate (acp/core.ts, the bound-mount list wait), lane q1023-winfirst. Consumer: direct-turn ledger lease
// (ledger-refusal.ts), which alone decides between a refusal row and a confirmed Stop (JOINT RULING STOP-VS-REFUSAL).
// 1.0.23 winfirst item (2), MAIN: a first owner turn during setup with a dead or late required mount must not fail with "couldn't
// start": it gets what is ready (or waits bounded) and answers. On a fresh Windows install the agents mount child died at start, the
// relay retired it, and the gate still counted it as required (its list was taken before the wait) and refused the turn. These rows run
// the real driver on the engine's real wire (fake ACP engine process, real mount relay and children, real fenced submit).
import { chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
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

const CLI = fileURLToPath(new URL("../../testing/fake-acp-cli.ts", import.meta.url));
const support: AcpSupport = {
  driverKind: "fuigoAgent", displayName: "Gate ACP", defaultCli: CLI, nativeSource: "winfirst-gate.acp",
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
  root = mkdtempSync(join(tmpdir(), "winfirst-gate-"));
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
  instance = await createAcpDriver({ ...support, ...extra }).create({ instanceId: "winfirst-gate", displayName: "Gate ACP", enabled: true,
    environment: { HOME: root }, config: { cli: CLI, fullAuto: false } });
  return recordEvents(instance.adapter);
}
const ALIVE = ["-e", "process.stdin.resume()"];
/** The agents child of the Windows log: it comes up, then exits with code 1 while the engine still lists it as starting. */
const DIES = ["-e", "process.stdin.resume(); setTimeout(() => process.exit(1), 700)"];
const turnFor = (audience: { audience: "owner" | "non-owner"; decidedOwner: boolean }, agentsArgs: string[]) => fixtureMountTurn({
  threadId: "winfirst-gate-mounted", cwd: root, text: "hello",
  warmIdentity: { botId: "winfirst-gate-bot", ...audience },
  integrations: { agents: { command: process.execPath, args: agentsArgs, env: {} } } });
const OWNER = { audience: "owner" as const, decidedOwner: true };
const UNDECIDED = { audience: "owner" as const, decidedOwner: false };
const prompts = () => wire.filter(row => row.method === "session/prompt");
const refusalLines = (records: { events: any[] }) => records.events.filter(event => event.type === "runtime.error" && event.message === REFUSAL_LINE);
const toldUnavailable = (records: { events: any[] }) => records.events.some(event => event.type === "item.started" && String(event.title ?? "").includes("couldn't use"));
const completion = (records: Awaited<ReturnType<typeof create>>, turnId: string) => records.until(e => e.type === "turn.completed" && e.turnId === turnId, 40_000);

describe("1.0.23 winfirst (2): a first owner turn with a dead or late required mount answers with what is ready", () => {
  // One row per way a required (non-memory) mount can be unproven when the owner's turn reaches the gate.
  const OWNER_ROWS: Array<{ id: string; list: string; recoveryMs: string; agents: string[] }> = [
    { id: "W2-dead", list: "all:initializing", recoveryMs: "8000", agents: DIES },
    { id: "W2-failed", list: "all:error", recoveryMs: "4000", agents: ALIVE },
    { id: "W2-late", list: "all:initializing", recoveryMs: "1500", agents: ALIVE },
    { id: "W2-unnamed", list: JSON.stringify({ "fixture-other": "ready" }), recoveryMs: "1500", agents: ALIVE },
  ];
  for (const row of OWNER_ROWS) {
    it(`${row.id}: the owner's turn is prompted and completes, with no refusal; the bot is told the agents mount is unavailable`, async () => {
      vi.stubEnv("FAKE_ACP_MCP_LIST", row.list);
      vi.stubEnv("MURAGE_MCP_RECOVERY_MS", row.recoveryMs);
      const records = await create();
      const sent = await instance!.adapter.sendTurn(turnFor(OWNER, row.agents));
      const done = (await completion(records, sent.turnId)) as { ok?: boolean };
      expect({ ok: done.ok, refusals: refusalLines(records).length, prompts: prompts().length, told: toldUnavailable(records) })
        .toEqual({ ok: true, refusals: 0, prompts: 1, told: true });
    }, 60_000);
  }
  it("W2-dead-bounded: the dead mount ends the wait as soon as the relay retires it, not at the window's end", async () => {
    vi.stubEnv("FAKE_ACP_MCP_LIST", "all:initializing");
    vi.stubEnv("MURAGE_MCP_RECOVERY_MS", "20000");
    const records = await create();
    const startedAt = Date.now();
    const sent = await instance!.adapter.sendTurn(turnFor(OWNER, DIES));
    const done = (await completion(records, sent.turnId)) as { ok?: boolean };
    expect({ ok: done.ok, prompts: prompts().length, fast: Date.now() - startedAt < 15_000 }).toEqual({ ok: true, prompts: 1, fast: true });
  }, 60_000);
  // Only the decided owner lets a dead required mount go (MAIN S14; Astra de2de9f7cc High): any other audience is still refused, as on base.
  it("G-undecided-dead: a turn whose owner audience is not decided is still refused when its required agents mount dies during the wait", async () => {
    vi.stubEnv("FAKE_ACP_MCP_LIST", "all:initializing");
    vi.stubEnv("MURAGE_MCP_RECOVERY_MS", "4000");
    const records = await create();
    const sent = await instance!.adapter.sendTurn(turnFor(UNDECIDED, DIES));
    expect(await completion(records, sent.turnId)).toMatchObject({ ok: false, stopReason: "memory-refused" });
    expect(prompts()).toEqual([]);
  }, 60_000);
  // Guards (fail closed): only a decided owner turn retires a mount that is still alive; every other audience keeps the refusal.
  for (const row of [{ id: "G-undecided-failed", list: "all:error" }, { id: "G-undecided-late", list: "all:initializing" }]) {
    it(`${row.id}: a turn whose owner audience is not decided is still refused for a live required mount that is not ready`, async () => {
      vi.stubEnv("FAKE_ACP_MCP_LIST", row.list);
      vi.stubEnv("MURAGE_MCP_RECOVERY_MS", "1500");
      const records = await create();
      const sent = await instance!.adapter.sendTurn(turnFor(UNDECIDED, ALIVE));
      expect(await completion(records, sent.turnId)).toMatchObject({ ok: false, stopReason: "memory-refused" });
      expect(prompts()).toEqual([]);
    }, 60_000);
  }
  it("W2-silent: an engine that never answers the list leaves only the mounts' own markers; the owner's turn retires the unproven agents mount and answers", async () => {
    vi.stubEnv("FAKE_ACP_MCP_LIST", "all:initializing");
    vi.stubEnv("FAKE_ACP_MCP_LIST_UNANSWERED", "1+");
    vi.stubEnv("MURAGE_MCP_RECOVERY_MS", "1500");
    const records = await create();
    const sent = await instance!.adapter.sendTurn(turnFor(OWNER, ALIVE));
    const done = (await completion(records, sent.turnId)) as { ok?: boolean };
    expect({ ok: done.ok, refusals: refusalLines(records).length, prompts: prompts().length, told: toldUnavailable(records) })
      .toEqual({ ok: true, refusals: 0, prompts: 1, told: true });
  }, 60_000);
  it("G-undecided-silent: the same silent engine still refuses a turn whose owner audience is not decided", async () => {
    vi.stubEnv("FAKE_ACP_MCP_LIST", "all:initializing");
    vi.stubEnv("FAKE_ACP_MCP_LIST_UNANSWERED", "1+");
    vi.stubEnv("MURAGE_MCP_RECOVERY_MS", "1500");
    const records = await create();
    const sent = await instance!.adapter.sendTurn(turnFor(UNDECIDED, ALIVE));
    expect(await completion(records, sent.turnId)).toMatchObject({ ok: false, stopReason: "memory-refused" });
  }, 60_000);
  // 1.0.24 winfirst (MAIN: owner turns pass; memory not ready = answer without memory, never write past the fence; ASTRA/FABLE
  // ce3846560b High core.ts:7866/:7872): a decided owner turn whose memory mount is not proven is prompted and answers WITHOUT memory,
  // the bot told; any other audience is still refused. Plain "murage-memory" name (a driver kind other than Fuigo keeps it), one row per
  // way memory can be unproven at the gate, including the High's: the engine never answers the list and the memory child wrote its ready
  // marker, then exited (the relay dropped it; that marker must not count as memory being there).
  // q1024-weakfix (AUDIT-WEAK winfirst): the marker path (MURAGE_MCP_LISTED_FILE) is only handed to a mount when the driver waits on
  // listed marks (mcpListedWait or a ready notification). Without that the old child died on a write to `undefined` and never wrote
  // a marker, so the row did not exercise "marked, then dropped". The child now records, in its proof file (argv[1]), whether it was
  // given a path and whether the marker exists after it wrote it; the row's test asserts "marked:true".
  const MARKS_THEN_DIES = ["-e", "const fs = require('node:fs'); const f = process.env.MURAGE_MCP_LISTED_FILE; if (!f) { fs.writeFileSync(process.argv[1], 'no-marker-path'); process.exit(3); } fs.writeFileSync(f, String(Date.now())); fs.writeFileSync(process.argv[1], 'marked:' + fs.existsSync(f)); process.stdin.resume(); setTimeout(() => process.exit(1), 50)"];
  const proofPath = (row: { id: string }) => join(root, `marker-proof-${row.id}.txt`);
  const markerRows = new Set(["dead-marker-silent", "dead-marker-silent-alone"]);
  const proofOf = (row: { id: string }) => (existsSync(proofPath(row)) ? readFileSync(proofPath(row), "utf8") : "child never ran");
  const MEMORY_ROWS: Array<{ id: string; list: string; unanswered?: string; memory: string[]; withAgents?: boolean; recoveryMs?: string; readyNotification?: boolean }> = [
    { id: "failed", list: "all:error", memory: ALIVE },
    { id: "late", list: "all:initializing", memory: ALIVE },
    { id: "silent", list: "all:initializing", unanswered: "1+", memory: ALIVE },
    { id: "dead", list: "all:initializing", memory: DIES, recoveryMs: "4000" },
    { id: "dead-listed-ready", list: JSON.stringify({ "murage-memory": "ready", agents: "failed" }), memory: ["-e", "process.stdin.resume(); setTimeout(() => process.exit(1), 50)"], withAgents: true },
    { id: "dead-marker-silent", list: "all:initializing", unanswered: "1+", memory: MARKS_THEN_DIES, withAgents: true },
    // Memory alone (guard rows only: base already ran the owner's turn here). With no ready notification this support never waits on an
    // aggregate signal, so the silent gate refuses on its own outcome; the next row goes through the engine's ready notification wait.
    { id: "dead-marker-silent-alone", list: "all:initializing", unanswered: "1+", memory: MARKS_THEN_DIES },
    // The engine's list still says memory is ready, but the relay let it go (its child exited) and nothing else is unproven.
    { id: "dead-listed-ready-alone", list: JSON.stringify({ "murage-memory": "ready" }), memory: ["-e", "process.exit(1)"] },
    // The engine's own ready notification wait (core.ts waitMcpReady): with memory the only mount and already let go, it reads "ready".
    { id: "dead-ready-wait", list: "all:initializing", unanswered: "1+", memory: ["-e", "process.exit(1)"], readyNotification: true },
  ];
  const memoryTurn = (audience: typeof OWNER, row: typeof MEMORY_ROWS[number]) => fixtureMountTurn({
    threadId: "winfirst-gate-memory", cwd: root, text: "hello", warmIdentity: { botId: "winfirst-gate-bot", ...audience },
    integrations: { memory: { command: process.execPath, args: markerRows.has(row.id) ? [...row.memory, proofPath(row)] : row.memory, env: {} }, ...(row.withAgents ? { agents: { command: process.execPath, args: ALIVE, env: {} } } : {}) } });
  const stubRow = (row: typeof MEMORY_ROWS[number]) => {
    vi.stubEnv("FAKE_ACP_MCP_LIST", row.list);
    if (row.unanswered) vi.stubEnv("FAKE_ACP_MCP_LIST_UNANSWERED", row.unanswered);
    vi.stubEnv("MURAGE_MCP_RECOVERY_MS", row.recoveryMs ?? "1500");
  };
  const toldMemory = (records: { events: any[] }) => records.events.some(event => event.type === "item.started" && /^Murage couldn't use the (.+, |.+ and )?memory( and .+|, .+)? for this reply\.$/.test(String(event.title ?? "")));
  for (const row of MEMORY_ROWS.filter(row => !["dead-marker-silent-alone", "dead-listed-ready-alone", "dead-ready-wait"].includes(row.id))) {
    it(`W4-owner-memory-${row.id}: a decided owner turn whose memory mount is not proven answers without memory, the bot told`, async () => {
      stubRow(row);
      const records = await create({ driverKind: "winfirstGateTest", ...(markerRows.has(row.id) ? { mcpListedWait: true } : {}) });
      const sent = await instance!.adapter.sendTurn(memoryTurn(OWNER, row));
      const done = (await completion(records, sent.turnId)) as { ok?: boolean };
      if (markerRows.has(row.id)) expect(proofOf(row), "the memory child must have written its ready marker before it was dropped").toBe("marked:true");
      expect({ ok: done.ok, refusals: refusalLines(records).length, prompts: prompts().length, toldMemory: toldMemory(records) })
        .toEqual({ ok: true, refusals: 0, prompts: 1, toldMemory: true });
    }, 60_000);
  }
  for (const row of MEMORY_ROWS.filter(row => ["failed", "silent", "dead", "dead-listed-ready", "dead-marker-silent", "dead-marker-silent-alone", "dead-listed-ready-alone", "dead-ready-wait"].includes(row.id))) {
    it(`G-undecided-memory-${row.id}: a turn whose owner audience is not decided is still refused without its memory`, async () => {
      stubRow(row);
      const records = await create({ driverKind: "winfirstGateTest", ...(markerRows.has(row.id) ? { mcpListedWait: true } : {}), ...(row.readyNotification ? { mcpReadyNotification: "_fuigo/mcp_initialized" } : {}) });
      const sent = await instance!.adapter.sendTurn(memoryTurn(UNDECIDED, row));
      const done = (await completion(records, sent.turnId)) as { ok?: boolean; stopReason?: string };
      if (markerRows.has(row.id)) expect(proofOf(row), "the memory child must have written its ready marker before it was dropped").toBe("marked:true");
      expect({ ok: done.ok, stopReason: done.stopReason, prompts: prompts().length }).toEqual({ ok: false, stopReason: "memory-refused", prompts: 0 });
    }, 60_000);
  }
  // Fuigo mounts memory under a per-turn murage-memory-<hex> alias (the Windows first turn's engine). The engine asks memory_search during
  // the turn: past the fence nothing reaches the retired memory child (it records every frame it is given).
  it("W4-fuigo-memory-fence: a decided owner Fuigo turn whose memory mount failed answers, the bot told, and not one frame of its memory_search reaches memory", async () => {
    const childLog = join(root, "memory-child.log");
    vi.stubEnv("FAKE_ACP_MCP_LIST", "all:error");
    vi.stubEnv("FAKE_ACP_MODE", "memory-search");
    vi.stubEnv("FAKE_ACP_MCP_TIMEOUT_MS", "3000");
    vi.stubEnv("MURAGE_MCP_RECOVERY_MS", "1500");
    const records = await create();
    const sent = await instance!.adapter.sendTurn(fixtureMountTurn({
      threadId: "winfirst-gate-fuigo", cwd: root, text: "MSEARCH: weekly report", warmIdentity: { botId: "winfirst-gate-bot", ...OWNER },
      integrations: { memory: { command: process.execPath, args: ["-e", "process.stdin.on('data', d => require('node:fs').appendFileSync(process.argv[1], d))", childLog], env: {} } } }));
    const done = (await completion(records, sent.turnId)) as { ok?: boolean };
    const reached = existsSync(childLog) ? readFileSync(childLog, "utf8").split("\n").filter(line => line.includes("jsonrpc")).length : 0;
    expect({ ok: done.ok, refusals: refusalLines(records).length, prompts: prompts().length, toldMemory: toldMemory(records), memoryCalls: reached })
      .toEqual({ ok: true, refusals: 0, prompts: 1, toldMemory: true, memoryCalls: 0 });
  }, 60_000);
  it("G-undecided-fuigo-memory: the same failed Fuigo memory alias still refuses a turn whose owner audience is not decided", async () => {
    vi.stubEnv("FAKE_ACP_MCP_LIST", "all:error");
    vi.stubEnv("MURAGE_MCP_RECOVERY_MS", "1500");
    const records = await create();
    const sent = await instance!.adapter.sendTurn(fixtureMountTurn({
      threadId: "winfirst-gate-fuigo", cwd: root, text: "hello", warmIdentity: { botId: "winfirst-gate-bot", ...UNDECIDED },
      integrations: { memory: { command: process.execPath, args: ALIVE, env: {} } } }));
    const done = (await completion(records, sent.turnId)) as { ok?: boolean; stopReason?: string };
    expect({ ok: done.ok, stopReason: done.stopReason, prompts: prompts().length }).toEqual({ ok: false, stopReason: "memory-refused", prompts: 0 });
  }, 60_000);
});
