// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// q1024-fuigobump: the bundled Fuigo (scripts/prepare-fuigo.mjs FUIGO_VERSION) decides whether prompt-scoped warm reuse
// can turn on. From 1.0.48 Fuigo's initialize answer advertises `fuigo/promptScope: 1` (core.ts promptScopeAdvertised),
// so with `warm.acpReuse` ON a Fuigo process is parked and reused with every prompt carrying its own id; with the flag
// OFF (its default, flip owned by MAIN) nothing changes from 1.0.43: no prompt id is sent and no frame is classified.
// The engine's initialize answer is the REAL one captured from each release binary (__fixtures__/fuigo-init), replayed by
// the fake ACP CLI (FAKE_ACP_INIT_CAPTURE). Real ACP core, real pool, processes counted by FAKE_ACP_SPAWN_LOG, prompts
// read back whole from FAKE_ACP_RPC_FULL_LOG. No mock of the code under test.
import { chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FUIGO_VERSION } from "../../../scripts/prepare-fuigo.mjs";
import { ensureDirs } from "../../config.ts";
import type { ProviderInstance, SendTurnInput } from "../../contracts.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordAdmittedEvents as recordEvents, type EventRecorder } from "../../testing/admitted-events.ts";
import { fixtureBotFolder } from "../../testing/bot-folder-fixture.ts";
import { setWarmAcpReuseSource } from "../warm-acp-reuse-flag.ts";
import { createAcpDriver, resetAcpMcpReadinessForTests, type AcpSupport } from "./core.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
const capturePath = (version: string) => fileURLToPath(new URL(`./__fixtures__/fuigo-init/initialize-${version}.json`, import.meta.url));
const SESSION = "fake-acp-session";
/** Shaped like the Fuigo row: pooled sessions on, MCP readiness announced. */
const Driver = createAcpDriver({
  driverKind: "fuigoAgent",
  fluxReach: () => "elsewhere" as const,
  displayName: "Fuigo Bump Test",
  models: { default: "m-one", options: [{ id: "m-one", label: "One" }] },
  defaultCli: "fake-fuigo-bump",
  nativeSource: "fuigobump.acp",
  loginNote: "never reached",
  spawnArgs: (_config, turn) => ["agent", ...(turn.model ? ["-m", turn.model] : []), "stdio"],
  pickAuthMethod: (methods) => methods[0]?.id ?? null,
  authFailure: "continue",
  isAuthenticated: () => true,
  mcpReadyNotification: "_fuigo/mcp_initialized",
  pooledSessions: true,
} satisfies AcpSupport);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };
async function until(check: () => boolean, what: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// The opt-in ACP pool is off on Windows (acpPoolingEnabled): there every ACP turn is its own process already.
describe.skipIf(process.platform === "win32")("bundled Fuigo prompt scope gates warm reuse (real captured initialize, real pool)", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder;
  let scratch: string;
  let spawnLog: string;
  let rpcLog: string;
  let infoLines: string[] = [];
  let infoSpy: ReturnType<typeof vi.spyOn> | undefined;
  const spawns = () => (existsSync(spawnLog) ? readFileSync(spawnLog, "utf8").split("\n").filter(Boolean).map(Number) : []);
  const prompts = () => (existsSync(rpcLog) ? readFileSync(rpcLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { method: string; params: any }) : [])
    .filter((row) => row.method === "session/prompt");
  const turn = async (input: Omit<SendTurnInput, "threadId" | "cwd">) => {
    const { turnId } = await instance!.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-fuigobump", ...input });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    await instance!.adapter.awaitTurnTeardown?.("t-fuigobump", turnId);
    return recorder.events.find((event) => event.type === "turn.completed" && event.turnId === turnId);
  };
  /** Two turns on one thread, the engine answering initialize with `version`'s real capture. */
  const twoTurns = async (version: string, acpReuse: boolean | undefined) => {
    process.env.FAKE_ACP_INIT_CAPTURE = capturePath(version);
    setWarmAcpReuseSource(() => (acpReuse === undefined ? {} : { warmAcpReuse: acpReuse }));
    instance = await Driver.create({ instanceId: "fuigobump", displayName: "Fuigo Bump", environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
    recorder = recordEvents(instance.adapter);
    expect(await turn({ text: "one" })).toMatchObject({ ok: true });
    expect(await turn({ text: "two", resumeCursor: SESSION })).toMatchObject({ ok: true });
    return { spawned: spawns().length, promptIds: prompts().map((row) => row.params?._meta?.promptId ?? null) };
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "murage-fuigobump-"));
    spawnLog = join(scratch, "spawns.log");
    rpcLog = join(scratch, "rpc-full.log");
    process.env.FAKE_ACP_SPAWN_LOG = spawnLog;
    process.env.FAKE_ACP_RPC_FULL_LOG = rpcLog;
    process.env.FAKE_ACP_MCP_READY = "1";
    process.env.MURAGE_ACP_POOL = "1";
    infoLines = [];
    infoSpy = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => { infoLines.push(args.map(String).join(" ")); });
  });
  afterEach(async () => {
    setWarmAcpReuseSource(() => undefined);
    for (const name of ["FAKE_ACP_SPAWN_LOG", "FAKE_ACP_RPC_FULL_LOG", "FAKE_ACP_MCP_READY", "MURAGE_ACP_POOL", "FAKE_ACP_INIT_CAPTURE", "FAKE_ACP_RAW_IN_LOG"]) delete process.env[name];
    infoSpy?.mockRestore();
    recorder?.stop();
    const pids = spawns();
    await instance?.dispose();
    instance = undefined;
    await until(() => pids.every((pid) => !alive(pid)), "every engine process to exit");
    resetAcpMcpReadinessForTests();
    await removeTempDir(scratch);
  });

  // W-PIN: every version move brings the real initialize capture of the release it bundles (a new release can change the
  // capability set this gate reads), and the bundled release advertises prompt scope.
  it("W-PIN the bundled Fuigo's real initialize capture is present and advertises prompt scope", () => {
    expect(existsSync(capturePath(FUIGO_VERSION)), `capture the initialize answer of fuigo ${FUIGO_VERSION}`).toBe(true);
    const capture = JSON.parse(readFileSync(capturePath(FUIGO_VERSION), "utf8"));
    expect(capture.result._meta.agentVersion).toBe(FUIGO_VERSION);
    expect(capture.result.agentCapabilities._meta["fuigo/promptScope"], "W-PIN bundled release advertises prompt scope").toBe(1);
  });

  // W-ON: `warm.acpReuse` ON with the bundled release: turn 2 adopts turn 1's parked process and every prompt carries its
  // own id. On 1.0.43 (no capability) the process is never parked, so turn 2 spawns. Mutants: promptScopeAdvertised
  // false, the prompt-scoped park dropped, prompt ids never minted (the reused turn's frames then carry no id of its own,
  // so the process is retired) -> RED at "W-ON reused".
  it("W-ON flag ON: the bundled Fuigo's process is reused, every prompt carrying its own prompt id", async () => {
    const run = await twoTurns(FUIGO_VERSION, true);
    expect(run.spawned, "W-ON reused").toBe(1);
    expect(run.promptIds.filter((id) => typeof id === "string" && id.length > 0), "W-ON prompt ids").toHaveLength(2);
    expect(new Set(run.promptIds).size).toBe(2);
    expect(infoLines.filter((line) => line.startsWith("acp frame-stale-prompt"))).toEqual([]);
  });

  // W-OFF (guard): flag unwritten (the shipped default) with the bundled release that advertises prompt scope: prompts are
  // exactly as on 1.0.43, with no prompt id and no frame classified. Mutant: the flag dropped from the Fuigo eligibility
  // (core.ts scopedFuigoRequested) -> RED at "W-OFF no prompt id".
  it("W-OFF flag unwritten: the bundled Fuigo's prompts carry no prompt id (prompt scope stays gated)", async () => {
    const run = await twoTurns(FUIGO_VERSION, undefined);
    expect(run.promptIds, "W-OFF no prompt id").toEqual([null, null]);
    expect(infoLines.filter((line) => line.startsWith("acp frame-stale-prompt"))).toEqual([]);
  });

  // W-CAP (control): flag ON with the real 1.0.43 capture (no capability): never parked for prompt-scoped reuse, so turn 2
  // spawns and no prompt id is sent. Mutant: promptScopeAdvertised true for any answer (ids sent to an engine that never
  // stamps frames) -> RED at "W-CAP no prompt id".
  it("W-CAP flag ON with a release that does not advertise prompt scope (real 1.0.43 capture): no reuse, no prompt id", async () => {
    const run = await twoTurns("1.0.43", true);
    expect(run.spawned, "W-CAP not reused").toBe(2);
    expect(run.promptIds, "W-CAP no prompt id").toEqual([null, null]);
  });

  // W-WIRE (guard, Fuigo 1.0.47 drops JSON array lines, payloads with embedded line breaks and lines over 64 MiB): every
  // line Murage writes to the bundled Fuigo is one JSON object, a prompt with line breaks included. Read on the raw stdin
  // bytes before any parse. Mutants: engineJsonLine batches ([value]) or pretty-prints -> RED at "W-WIRE one object per line".
  it("W-WIRE every line Murage writes to Fuigo is a single JSON object, a multi-line prompt included", async () => {
    const rawLog = join(scratch, "raw-in.log");
    process.env.FAKE_ACP_RAW_IN_LOG = rawLog;
    process.env.FAKE_ACP_INIT_CAPTURE = capturePath(FUIGO_VERSION);
    instance = await Driver.create({ instanceId: "fuigobump-wire", displayName: "Fuigo Bump", environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
    recorder = recordEvents(instance.adapter);
    await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-fuigobump-wire", text: "line one\nline two\r\nline three" });
    const raw = () => (existsSync(rawLog) ? readFileSync(rawLog, "utf8").split("\n").filter(Boolean).map((row) => JSON.parse(row) as string) : []);
    await until(() => raw().some((line) => line.includes("session/prompt")), "the prompt line", 3_000).catch(() => undefined);
    const shape = (line: string) => { try { const value = JSON.parse(line); return value !== null && typeof value === "object" && !Array.isArray(value) ? "object" : "other"; } catch { return "unparsed"; } };
    const lines = raw();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.map(shape), "W-WIRE one object per line").toEqual(lines.map(() => "object"));
    expect(lines.every((line) => Buffer.byteLength(line) < 64 * 1024 * 1024)).toBe(true);
    const prompt = lines.map((line) => JSON.parse(line)).find((value) => value.method === "session/prompt");
    expect(JSON.stringify(prompt?.params?.prompt), "W-WIRE prompt text intact").toContain("line one\\nline two\\r\\nline three");
  });

  // W-BIG (Fuigo 1.0.47 drops a client line over 64 MiB unread, so its request would never be answered): a prompt over the
  // limit never reaches the engine and the turn ends with the visible reason instead of waiting. Base: the line is written.
  // Mutant: the ACP line cap removed (approval-delivery.ts) -> RED at "W-BIG never written".
  it("W-BIG a prompt line over 64 MiB is never written to Fuigo; the turn ends with the reason", async () => {
    const rawLog = join(scratch, "raw-in-big.log");
    process.env.FAKE_ACP_RAW_IN_LOG = rawLog;
    process.env.FAKE_ACP_INIT_CAPTURE = capturePath(FUIGO_VERSION);
    instance = await Driver.create({ instanceId: "fuigobump-big", displayName: "Fuigo Bump", environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
    recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-fuigobump-big", text: "x".repeat(64 * 1024 * 1024 + 1) });
    const sizesNow = () => (existsSync(rawLog) ? readFileSync(rawLog, "utf8").split("\n").filter(Boolean).map((row) => Buffer.byteLength(JSON.parse(row) as string)) : []);
    // Bounded: the turn ends (refused) or the oversized line reaches the engine (base), whichever comes first. The wait
    // never throws, so a refusal that is dropped (no turn end) still fails at the assertions below, not at a timeout.
    await until(() => recorder.events.some((event) => event.type === "turn.completed" && event.turnId === turnId) || sizesNow().some((bytes) => bytes > 64 * 1024 * 1024), "the turn to end or the line to arrive", 20_000).catch(() => undefined);
    const sizes = sizesNow();
    expect(sizes.filter((bytes) => bytes > 64 * 1024 * 1024), "W-BIG never written").toEqual([]);
    const events = recorder.events.filter((event) => event.turnId === turnId);
    expect(events.find((event) => event.type === "turn.completed"), "W-BIG turn ends not ok").toMatchObject({ ok: false });
    expect(JSON.stringify(events), "W-BIG reason shown").toContain("too large for the engine");
  });
});
