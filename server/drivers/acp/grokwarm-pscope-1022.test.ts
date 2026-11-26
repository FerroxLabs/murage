// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// design-1022-grokwarm r2 sections B1/B3/B4b (Side M, GROKWARM-1022 builder): with `warm.acpReuse` ON and an engine whose
// initialize answer advertises `fuigo/promptScope: 1` (the Fuigo 1.0.48 shape, recorded here by the fake ACP CLI's
// FAKE_ACP_PROMPT_SCOPE mode until Side F hands over its fixture), every dispatch carries its own prompt id, every frame
// is classified by it, a stale frame on a reused process never acts, and a process is parked only when its turn ended quiet.
// Flag OFF preserves today's pool. Flag ON requires the Fuigo capability. A MOUNTED process is retired before handoff
// whatever both flags say until the per-turn relay admission (B5) ships (guard, contract C1).
// Real ACP core, real pool, fake ACP processes counted by FAKE_ACP_SPAWN_LOG; the client's answers to the fixture's asks
// are read back from FAKE_ACP_LATE_REPLY_LOG. No mock of the code under test.
import { fileURLToPath as fixtureFilePath } from "node:url";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance, RuntimeEvent, SendTurnInput } from "../../contracts.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordAdmittedEvents as recordEvents, type EventRecorder } from "../../testing/admitted-events.ts";
import { fixtureBotFolder } from "../../testing/bot-folder-fixture.ts";
import { createAcpDriver, resetAcpMcpReadinessForTests, type AcpSupport } from "./core.ts";
const s2rFlagPath = "../warm-s2r-flag.ts", reuseFlagPath = "../warm-acp-reuse-flag.ts";
const s2rFlag = existsSync(new URL(s2rFlagPath, import.meta.url)) ? await import(s2rFlagPath) as { setWarmS2rSource(f: () => unknown): void } : null;
const reuseFlag = existsSync(new URL(reuseFlagPath, import.meta.url)) ? await import(reuseFlagPath) as { setWarmAcpReuseSource(f: () => unknown): void; warmAcpReuseOn(): boolean } : null;

const IDLE_MCP = fixtureFilePath(new URL("../../testing/fake-idle-mcp.mjs", import.meta.url));
const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
const SESSION = "fake-acp-session";
/** Shaped like Fuigo: pooled sessions on, MCP readiness announced. */
const SUPPORT: AcpSupport = {
  driverKind: "fuigoAgent",
  fluxReach: () => "elsewhere" as const,
  displayName: "Pscope Test",
  models: { default: "m-one", options: [{ id: "m-one", label: "One" }] },
  defaultCli: "fake-pscope",
  nativeSource: "pscope.acp",
  loginNote: "never reached",
  spawnArgs: (_config, turn) => ["agent", ...(turn.model ? ["-m", turn.model] : []), "stdio"],
  pickAuthMethod: (methods) => methods[0]?.id ?? null,
  authFailure: "continue",
  isAuthenticated: () => true,
  mcpReadyNotification: "_fuigo/mcp_initialized",
  pooledSessions: true,
};
const Driver = createAcpDriver(SUPPORT);
/** A poolable ACP row that is not Fuigo (MAIN-RULING warm-grok-vs-fuigo: B1 is fuigoAgent only; grokAgent is never pooled at all). */
const OtherRow = createAcpDriver({ ...SUPPORT, driverKind: "pscopeTest" });
const zombie = (pid: number) => {
  try { return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { windowsHide: true, encoding: "utf8" }).trim().startsWith("Z"); }
  catch { try { process.kill(pid, 0); return false; } catch { return true; } }
};
const alive = (pid: number) => {
  try { process.kill(pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  return !zombie(pid);
};
async function until(check: () => boolean, what: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// The opt-in ACP pool is off on Windows (acpPoolingEnabled): there every ACP turn is its own process already.
describe.skipIf(process.platform === "win32")("grokwarm prompt-scoped ACP reuse (fake ACP CLI, real pool)", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder;
  let scratch: string;
  let spawnLog: string;
  let replyLog: string;
  let rpcLog: string;
  let infoLines: string[] = [];
  let infoSpy: ReturnType<typeof vi.spyOn> | undefined;
  const spawns = () => (existsSync(spawnLog) ? readFileSync(spawnLog, "utf8").split("\n").filter(Boolean).map(Number) : []);
  const replies = () => (existsSync(replyLog) ? readFileSync(replyLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { result?: any; error?: any }) : []);
  const calls = (method: string, pid?: number) => (existsSync(rpcLog) ? readFileSync(rpcLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { pid: number; method: string }) : [])
    .filter((row) => row.method === method && (pid === undefined || row.pid === pid));
  const staleLines = () => infoLines.filter((line) => line.startsWith("acp frame-stale-prompt thread=t-pscope"));
  const create = async () => {
    instance = await Driver.create({ instanceId: "grokwarm-pscope", displayName: "Pscope", environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
    recorder = recordEvents(instance.adapter);
  };
  /** One turn; returns at its end, or as soon as it opened a card (a card that waits for the owner would hold the turn). */
  const turn = async (input: Omit<SendTurnInput, "threadId" | "cwd">) => {
    const { turnId } = await instance!.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-pscope", ...input });
    await recorder.until((event) => (event.type === "turn.completed" || event.type === "request.opened") && event.turnId === turnId);
    const events = recorder.events.filter((event) => event.turnId === turnId);
    const done = events.find((event) => event.type === "turn.completed") as Extract<RuntimeEvent, { type: "turn.completed" }> | undefined;
    if (done) await instance!.adapter.awaitTurnTeardown?.("t-pscope", turnId);
    return { turnId, done, events, cards: events.filter((event) => event.type === "request.opened") };
  };
  const text = (events: RuntimeEvent[]) => JSON.stringify(events);
  const flags = (acpReuse: boolean | undefined, s2r?: boolean) => {
    reuseFlag?.setWarmAcpReuseSource(() => ({ ...(acpReuse === undefined ? {} : { warmAcpReuse: acpReuse }), ...(s2r === undefined ? {} : { warmS2r: s2r }) }));
    s2rFlag?.setWarmS2rSource(() => ({ ...(s2r === undefined ? {} : { warmS2r: s2r }) }));
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "murage-grokwarm-pscope-"));
    spawnLog = join(scratch, "spawns.log");
    replyLog = join(scratch, "replies.log");
    process.env.FAKE_ACP_SPAWN_LOG = spawnLog;
    process.env.FAKE_ACP_LATE_REPLY_LOG = replyLog;
    rpcLog = join(scratch, "rpc.log");
    process.env.FAKE_ACP_RPC_LOG = rpcLog;
    process.env.FAKE_ACP_MCP_READY = "1";
    process.env.MURAGE_ACP_POOL = "1";
    infoLines = [];
    infoSpy = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => { infoLines.push(args.map(String).join(" ")); });
  });
  afterEach(async () => {
    reuseFlag?.setWarmAcpReuseSource(() => undefined);
    s2rFlag?.setWarmS2rSource(() => undefined);
    for (const name of ["FAKE_ACP_SPAWN_LOG", "FAKE_ACP_LATE_REPLY_LOG", "FAKE_ACP_RPC_LOG", "FAKE_ACP_RPC_FULL_LOG", "FAKE_ACP_MODE", "FAKE_ACP_MCP_READY", "MURAGE_ACP_POOL", "MURAGE_ACP_CROSS_THREAD_SPARE", "FAKE_ACP_PROMPT_SCOPE", "FAKE_ACP_PSCOPE_TURN2", "FAKE_ACP_PSCOPE_AT", "FAKE_ACP_PSCOPE_BACKGROUND"]) delete process.env[name];
    infoSpy?.mockRestore();
    recorder?.stop();
    const pids = spawns();
    await instance?.dispose();
    instance = undefined;
    await until(() => pids.every((pid) => !alive(pid)), "every engine process to exit");
    resetAcpMcpReadinessForTests();
    await removeTempDir(scratch);
  });

  /** Turn 1 on a fresh prompt-scoped process, turn 2 on the same (reused) process with the fixture's scripted frames. */
  const twoTurns = async (script: string, deferReuse = false) => {
    process.env.FAKE_ACP_PROMPT_SCOPE = "1";
    process.env.FAKE_ACP_PSCOPE_TURN2 = script;
    flags(true);
    await create();
    const first = await turn({ text: "one" });
    expect(first.done).toMatchObject({ ok: true });
    const second = await turn({ text: "two", resumeCursor: SESSION });
    // turn 2 really ran on turn 1's process (generation 2): one process so far
    // (WM-B2/B2d defer this: a mutant that lets the stale frame act also ends the reuse, and must fail at the behaviour assertion)
    if (!deferReuse) expect(spawns(), "turn 2 reused turn 1's process").toHaveLength(1);
    return Object.assign(second, { reusedProcess: spawns().length === 1 });
  };
  /** Turn 3: a process marked unfit in turn 2 was not parked, so turn 3 spawns. */
  const thirdSpawned = async () => {
    const third = await turn({ text: "three", resumeCursor: SESSION });
    expect(third.done).toMatchObject({ ok: true });
    return spawns().length === 2;
  };

  // WM-B2 (B3 iii, generation 2): turn 1's id on a request_permission written during reused turn 2: answered cancelled,
  // no card, logged frame-stale-prompt, and the process is not parked again.
  // Mutant MB-2 (classification off): the ask opens a card under turn 2, RED at the "no card" assertion.
  it("WM-B2 a stale request during a reused turn is cancelled with no card and the process is retired", async () => {
    const second = await twoTurns("stale-request", true);
    expect(second.cards, "WM-B2 no card").toEqual([]);
    expect(second.done).toMatchObject({ ok: true });
    expect(replies().map((r) => r.result?.outcome?.outcome), "WM-B2 cancelled reply").toEqual(["cancelled"]);
    expect(staleLines().some((line) => line.includes("kind=request") && line.includes("generation=reused"))).toBe(true);
    expect(await thirdSpawned()).toBe(true);
    expect(second.reusedProcess, "WM-B2 reused turn 1's process").toBe(true);
  });

  // WM-B2d (B3 i, Fable H2 / Astra H2): a drain turn with a new id whose originPromptId is turn 1's sends an ask and text
  // during turn 2: cancelled, no card, the text is not in turn 2, unfit. Mutant MB-2d (an internal turn counts as current
  // by itself): the drain's ask opens a card, RED at the "no card" assertion.
  it("WM-B2d a drain turn rooted in the earlier prompt never acts in the reused turn", async () => {
    const second = await twoTurns("drain", true);
    expect(second.cards, "WM-B2d no card").toEqual([]);
    expect(text(second.events)).not.toContain("STALE DRAIN TEXT");
    expect(text(second.events), "WM-B2d turn two reply").toContain("turn two reply");
    expect(replies().map((r) => r.result?.outcome?.outcome), "WM-B2d cancelled reply").toEqual(["cancelled"]);
    expect(await thirdSpawned()).toBe(true);
    expect(second.reusedProcess, "WM-B2d reused turn 1's process").toBe(true);
  });

  // WM-B3 (Fable M2): an acting request with no id and one with a null id on generation 2: both denied, no card, one
  // denied-tool row each in the turn, unfit. Mutant MB-3 (a missing key is accepted as current): RED at the "no card" assertion.
  // Mutant MB-3r (the denied row is never written; Fable b3d38873ee M4): RED at the "denied rows" assertion.
  it("WM-B3 a request with a missing or null prompt id is denied with a denied row, never a card", async () => {
    const second = await twoTurns("missing,null");
    expect(second.cards, "WM-B3 no card").toEqual([]);
    expect(replies().map((r) => r.result?.outcome?.outcome)).toEqual(["cancelled", "cancelled"]);
    const denied = second.events.filter((event) => event.type === "item.completed" && String((event as { itemId?: string }).itemId).startsWith("pscope-denied-"));
    expect(denied.map((event) => (event as { ok?: boolean }).ok), "WM-B3 denied rows").toEqual([false, false]);
    expect(await thirdSpawned()).toBe(true);
  });

  // WM-B3u (B3 ii closed list): after handoff a frame of an unknown kind with a null id never acts and marks the process unfit.
  // Mutant MB-3u (any null-id notification is status): the process stays fit and turn 3 reuses it, RED at the "spawned" assertion.
  it("WM-B3u an unknown frame kind with a null id is not status: the process is retired", async () => {
    await twoTurns("unknown");
    expect(await thirdSpawned(), "WM-B3u spawned").toBe(true);
    expect(staleLines().some((line) => line.includes("kind=update"))).toBe(true);
  });

  // Control for WM-B3u: a kind on the closed status list with a null id is status, so the process stays fit and is reused.
  it("control: a status frame with a null id keeps the process fit", async () => {
    await twoTurns("status");
    expect(await thirdSpawned()).toBe(false);
    expect(staleLines()).toEqual([]);
  });

  // WM-B4 (B3 iii): a turn-1 agent_message_chunk written during reused turn 2 is not in turn 2's reply.
  // Mutant MB-4 (stale frames dropped only for requests): the text reaches turn 2, RED at the "not in turn 2" assertion.
  it("WM-B4 stale update text never reaches the reused turn's reply", async () => {
    const second = await twoTurns("stale-text");
    expect(text(second.events), "WM-B4 not in turn 2").not.toContain("STALE TURN ONE TEXT");
    expect(text(second.events)).toContain("turn two reply");
    expect(await thirdSpawned()).toBe(true);
  });

  // WM-B3g (C2 (2a), generation 1): turn 1 on a fresh process receives a frame its prompt id does not cover: handled as
  // today on that cold process, which is marked unfit and never handed off; turn 2 spawns and resumes via session/load.
  // Mutant MB-3g (the check runs from generation 2 only): turn 2 reuses the process, RED at the "spawned" assertion.
  it("WM-B3g a generation-1 frame outside the prompt id marks the process unfit before any handoff", async () => {
    process.env.FAKE_ACP_PROMPT_SCOPE = "1";
    process.env.FAKE_ACP_PSCOPE_TURN2 = "unknown";
    process.env.FAKE_ACP_PSCOPE_AT = "1";
    flags(true);
    await create();
    const first = await turn({ text: "one" });
    expect(first.done).toMatchObject({ ok: true });
    const second = await turn({ text: "two", resumeCursor: SESSION });
    expect(second.done).toMatchObject({ ok: true });
    expect(spawns().length, "WM-B3g spawned").toBe(2);
    expect(staleLines().some((line) => line.includes("generation=first"))).toBe(true);
  });

  // WM-B4q (B4b, Astra H3): turn 1 ends with background work still live (background: 1), or with no count at all:
  // not parked, turn 2 spawns. Mutant MB-4q (park ignores the background count): turn 2 reuses, RED at the "spawned" assertion.
  it.each(["1", "absent"])("WM-B4q a turn that did not end quiet (background=%s) is not parked", async (background) => {
    process.env.FAKE_ACP_PROMPT_SCOPE = "1";
    process.env.FAKE_ACP_PSCOPE_BACKGROUND = background;
    flags(true);
    await create();
    await turn({ text: "one" });
    const second = await turn({ text: "two", resumeCursor: SESSION });
    expect(second.done).toMatchObject({ ok: true });
    expect(spawns().length, "WM-B4q spawned").toBe(2);
  });

  // Guard WM-B0 (GREEN on dev/1022, design C4; flag OFF, the default): a prompt-scoped engine whose turn reports no background count is pooled exactly as today.
  // Mutant MB-0 (`warm.acpReuse` default ON): B4b applies, the process is not parked, RED at the "reused" assertion.
  it("guard WM-B0 with no setting written the flag reads OFF and the pool is unchanged", async () => {
    process.env.FAKE_ACP_PROMPT_SCOPE = "1";
    process.env.FAKE_ACP_PSCOPE_BACKGROUND = "absent";
    flags(undefined);
    await create();
    await turn({ text: "one" });
    await turn({ text: "two", resumeCursor: SESSION });
    expect(spawns().length, "WM-B0 reused").toBe(1);
    expect(reuseFlag?.warmAcpReuseOn() ?? false).toBe(false);
    expect(staleLines()).toEqual([]);
  });

  // Guard WM-B1u (GREEN on dev/1022, design C4; mutant MB-1uo): flag OFF on a build without the capability preserves unmounted pooling.
  it("guard WM-B1u flag OFF on a build without prompt scope preserves unmounted pooling", async () => {
    flags(false);
    await create();
    await turn({ text: "one" });
    await turn({ text: "two", resumeCursor: SESSION });
    await turn({ text: "three", resumeCursor: SESSION });
    expect(spawns().length, "WM-B1u reused").toBe(1);
  });

  it("WM-B1-cap a Fuigo build without prompt scope cannot hand off with the flag on", async () => {
    flags(true);
    await create();
    expect((await turn({ text: "one" })).done).toMatchObject({ ok: true });
    expect((await turn({ text: "two", resumeCursor: SESSION })).done).toMatchObject({ ok: true });
    expect(spawns(), "WM-B1-cap unsupported process was retired").toHaveLength(2);
  });

  // Guard WM-B0s (contract C1; GREEN on dev/1022, design C4; mutant MB-0s drops !mounted from poolable): both flags ON and the capability advertised: a MOUNTED process is still retired before
  // handoff in this build (the per-turn relay admission B5 is not built, so no mounted handoff exists); turn 2 spawns.
  it.each([true, false])("guard WM-B0s warm.acpReuse ON, warm.s2r %s: a mounted prompt-scoped process is still retired before handoff (B5 not built)", async (s2r) => {
    process.env.FAKE_ACP_PROMPT_SCOPE = "1";
    flags(true, s2r);
    await create();
    const integrations = { agents: { command: process.execPath, args: [IDLE_MCP], env: { MURAGE_COMMS_TOKEN: `turn-${randomUUID()}` } } };
    expect((await turn({ text: "one", integrations })).done).toMatchObject({ ok: true });
    const [firstPid] = spawns();
    const second = await turn({ text: "two", integrations, resumeCursor: SESSION });
    expect(second.done).toMatchObject({ ok: true });
    expect(spawns(), "WM-B0s spawned").toHaveLength(2);
    await until(() => !alive(firstPid!), "WM-B0s first mounted process to exit");
    if (reuseFlag) expect(infoLines, "WM-B0s retired before handoff").toContain("acp close thread=t-pscope reason=native-no-barrier");
  });

  // B4/B7 on the prompt-scoped path (guards: the existing reset, epoch and Stop paths already hold here; this build adds no
  // ACP-specific memory code, so each cell proves the B3/B4b park rule did not open a way around them).
  /** Turn 1 on a fresh prompt-scoped process that ends quiet, so it is parked; returns its pid. */
  const parkedFirst = async () => {
    process.env.FAKE_ACP_PROMPT_SCOPE = "1";
    flags(true);
    await create();
    expect((await turn({ text: "one" })).done).toMatchObject({ ok: true });
    const [pid] = spawns();
    return pid!;
  };

  // WM-B1 (unmounted, 4 turns): flag ON, prompt-scoped, every turn quiet: turns 2-4 run on turn 1's process.
  // Mutant MB-1q (the quiet mark is never recorded): no turn parks, RED at the "same process" assertion.
  it("WM-B1 four quiet prompt-scoped turns run on one process", async () => {
    const wireLog = join(scratch, "prompts.log");
    process.env.FAKE_ACP_RPC_FULL_LOG = wireLog;
    const pid = await parkedFirst();
    for (const text of ["two", "three", "four"]) expect((await turn({ text, resumeCursor: SESSION })).done).toMatchObject({ ok: true });
    expect(spawns(), "WM-B1 same process").toEqual([pid]);
    expect(calls("session/prompt", pid)).toHaveLength(4);
    const promptIds = readFileSync(wireLog, "utf8").trim().split("\n").map((line) => JSON.parse(line))
      .filter((row) => row.method === "session/prompt").map((row) => row.params?._meta?.promptId);
    expect(new Set(promptIds).size, "WM-B1 distinct wire prompt IDs").toBe(4);
    expect(promptIds.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
  });

  it("WM-B1k a prompt-scoped process cannot be a cross-thread spare", async () => {
    process.env.MURAGE_ACP_CROSS_THREAD_SPARE = "1";
    const pid = await parkedFirst();
    const next = await instance!.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "fixture-other-thread", text: "two", resumeCursor: "fixture-other-session" });
    const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === next.turnId);
    expect(spawns(), "WM-B1k different thread got a new process").toHaveLength(2);
    expect(calls("session/load", pid)).toHaveLength(0);
    expect(done).toMatchObject({ ok: true });
  });
  // Guard WM-B5 (B4 revoked; design C4: GREEN on dev/1022, so a guard with its mutant, not a base-RED witness): memory/edit reset between turns (sessionReset) on a parked prompt-scoped process: turn 2
  // retires it (exit observed) and opens a brand-new session on a new process; the old process gets no second prompt.
  // Mutant MB-5 (adoption ignores sessionReset): turn 2 reuses the parked process, RED at the "spawned" assertion.
  it("guard WM-B5 a reset between turns retires the parked prompt-scoped process; the old process gets no prompt", async () => {
    const pid = await parkedFirst();
    const second = await turn({ text: "two", resumeCursor: SESSION, sessionReset: true });
    expect(second.done).toMatchObject({ ok: true });
    expect(spawns().length, "WM-B5 spawned").toBe(2);
    await until(() => !alive(pid), "the reset process to exit");
    expect(calls("session/prompt", pid)).toHaveLength(1);
    expect(calls("session/new")).toHaveLength(2);
    expect(calls("session/load")).toHaveLength(0);
  });

  // Guard WM-B8 (B7, the whole Stop fence; design C4: GREEN on dev/1022, so a guard with its mutant, not a base-RED witness): Stop on a REUSED prompt-scoped turn: confirmed close, cancelled, the process is
  // gone and the next turn spawns. Mutant MB-8 (park after Stop: the park condition
  // ignores all three Stop signals, stopReason, cancelRequested and the epoch interruptTurn bumps): the stopped process is parked alive, RED at the "stopped process gone" assertion.
  it("guard WM-B8 Stop on a reused prompt-scoped turn confirms the close and the next turn spawns", async () => {
    const pid = await parkedFirst();
    const { turnId } = await instance!.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-pscope", text: "go __fixture_cancel_ack__", resumeCursor: SESSION });
    await recorder.until((event) => event.type === "content.delta" && event.turnId === turnId);
    expect(spawns(), "turn 2 reused").toEqual([pid]);
    await expect(instance!.adapter.interruptTurn("t-pscope", turnId)).resolves.toEqual({ closeConfirmed: true });
    const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(done).toMatchObject({ ok: true, stopReason: "cancelled" });
    expect(alive(pid), "WM-B8 stopped process gone").toBe(false);
    expect((await turn({ text: "three", resumeCursor: SESSION })).done).toMatchObject({ ok: true });
    expect(spawns().length, "WM-B8 spawned").toBe(2);
  });

  // Guard WM-B10 (B4 retireAtEnd; design C4: GREEN on dev/1022, so a guard with its mutant, not a base-RED witness): a memory reset (resetSession) while a prompt-scoped turn runs: the turn completes,
  // its process is never parked (exit observed), and the next turn, though it carries the old cursor, spawns a new process.
  // Mutant MB-10 (park ignores the reset epoch): the reset turn parks its process, RED at the "exit" wait.
  it("guard WM-B10 a memory reset during a prompt-scoped turn: the turn completes and its process is never parked", async () => {
    process.env.FAKE_ACP_PROMPT_SCOPE = "1";
    process.env.FAKE_ACP_MODE = "permission";
    flags(true);
    await create();
    const { turnId } = await instance!.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: "t-pscope", text: "go" });
    const opened = await recorder.until((event) => event.type === "request.opened" && event.turnId === turnId);
    await instance!.adapter.resetSession!("t-pscope");
    await instance!.adapter.respondToRequest("t-pscope", (opened as { requestId: string }).requestId, { behavior: "allow" });
    const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(done).toMatchObject({ ok: true });
    const [pid] = spawns();
    let exited = true;
    try { await until(() => !alive(pid!), "the reset turn's process to exit", 2_000); } catch { exited = false; }
    expect(exited, "WM-B10 never parked").toBe(true);
    delete process.env.FAKE_ACP_MODE;
    expect((await turn({ text: "two", resumeCursor: SESSION })).done).toMatchObject({ ok: true });
    expect(spawns(), "WM-B10 turn 2 spawned").toHaveLength(2);
  });

  // Guard WM-B1g (MAIN-RULING warm-grok-vs-fuigo, B1 = fuigoAgent only; GREEN on dev/1022, so a compatibility guard, not a base-RED witness): a non-Fuigo ACP row with the capability advertised and the
  // flag ON is not prompt-scoped: no turn_completed count is required and its unmounted pool is exactly today's. Mutant MB-1g (the
  // predicate ignores the driver): B4b holds that process to a background count it never sent, RED at the "reused" assertion.
  it("guard WM-B1g a non-Fuigo ACP row is never prompt-scope eligible: its pool is unchanged with the flag ON", async () => {
    process.env.FAKE_ACP_PROMPT_SCOPE = "1";
    process.env.FAKE_ACP_PSCOPE_BACKGROUND = "absent";
    flags(true);
    instance = await OtherRow.create({ instanceId: "grokwarm-otherrow", displayName: "Other row", environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
    recorder = recordEvents(instance.adapter);
    expect((await turn({ text: "one" })).done).toMatchObject({ ok: true });
    expect((await turn({ text: "two", resumeCursor: SESSION })).done).toMatchObject({ ok: true });
    expect(spawns().length, "WM-B1g reused").toBe(1);
  });
});
