// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// WARM-FUIGO-1022 Murage side, design-1022-grokwarm r2 B3 "the id is captured with the frame's first byte" (r3.4 (3c)(i),
// carried cell W-FG2 (j) / M-FG8): with `warm.acpReuse` ON, a frame whose first byte reached Murage before the next turn
// adopted the process and whose newline arrived after it is stale for that turn, whatever its own `_meta` says. One row per
// frame shape (SITES.md S1, the stdout line splitter that picks the owner): an ask that names no prompt (it would read as
// "this turn's, unproven" and get a denied row) and a status frame with a null id (it would read as status and keep the
// process fit). Real ACP core, real pool, fake ACP processes counted by FAKE_ACP_SPAWN_LOG; the client's answer to the
// fixture's ask is read back from FAKE_ACP_LATE_REPLY_LOG. The split frame reaches Murage in three reads (turn 1's end, then
// two during turn 2), and the read that ends it also carries one frame of turn 2's own prompt, which must still act.
// No mock of the code under test.
// The flag module is loaded at run time, so on a build without it the cells still run through the same driver.
import { execFileSync } from "node:child_process";
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

type FlagModule = { setWarmAcpReuseSource(features: () => unknown): void };
const flagPath = "../warm-acp-reuse-flag.ts";
const flagModule = existsSync(new URL(flagPath, import.meta.url)) ? await import(flagPath) as FlagModule : null;

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
const SESSION = "fake-acp-session";
const THREAD = "t-fuigo-split";
/** Shaped like Fuigo: pooled sessions on, MCP readiness announced. */
const SUPPORT: AcpSupport = {
  driverKind: "fuigoAgent",
  fluxReach: () => "elsewhere" as const,
  displayName: "Split Test",
  models: { default: "m-one", options: [{ id: "m-one", label: "One" }] },
  defaultCli: "fake-split",
  nativeSource: "split.acp",
  loginNote: "never reached",
  spawnArgs: (_config, turn) => ["agent", ...(turn.model ? ["-m", turn.model] : []), "stdio"],
  pickAuthMethod: (methods) => methods[0]?.id ?? null,
  authFailure: "continue",
  isAuthenticated: () => true,
  mcpReadyNotification: "_fuigo/mcp_initialized",
  pooledSessions: true,
};
const Driver = createAcpDriver(SUPPORT);
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
describe.skipIf(process.platform === "win32")("WARM-FUIGO-1022 B3 first byte: a frame split across the handoff (fake ACP CLI, real pool)", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder;
  let scratch: string;
  let spawnLog: string;
  let replyLog: string;
  let infoLines: string[] = [];
  let infoSpy: ReturnType<typeof vi.spyOn> | undefined;
  const spawns = () => (existsSync(spawnLog) ? readFileSync(spawnLog, "utf8").split("\n").filter(Boolean).map(Number) : []);
  const replies = () => (existsSync(replyLog) ? readFileSync(replyLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { result?: any; error?: any }) : []);
  const staleLines = () => infoLines.filter((line) => line.startsWith(`acp frame-stale-prompt thread=${THREAD}`));
  /** One turn; returns at its end, or as soon as it opened a card (a card that waits for the owner would hold the turn). */
  const turn = async (input: Omit<SendTurnInput, "threadId" | "cwd">) => {
    const { turnId } = await instance!.adapter.sendTurn({ cwd: fixtureBotFolder(), threadId: THREAD, ...input });
    await recorder.until((event) => (event.type === "turn.completed" || event.type === "request.opened") && event.turnId === turnId);
    const events = recorder.events.filter((event) => event.turnId === turnId);
    const done = events.find((event) => event.type === "turn.completed") as Extract<RuntimeEvent, { type: "turn.completed" }> | undefined;
    if (done) await instance!.adapter.awaitTurnTeardown?.(THREAD, turnId);
    return { turnId, done, events, cards: events.filter((event) => event.type === "request.opened") };
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "murage-fuigo-split-"));
    spawnLog = join(scratch, "spawns.log");
    replyLog = join(scratch, "replies.log");
    process.env.FAKE_ACP_SPAWN_LOG = spawnLog;
    process.env.FAKE_ACP_LATE_REPLY_LOG = replyLog;
    process.env.FAKE_ACP_MCP_READY = "1";
    process.env.MURAGE_ACP_POOL = "1";
    process.env.FAKE_ACP_PROMPT_SCOPE = "1";
    flagModule?.setWarmAcpReuseSource(() => ({ warmAcpReuse: true }));
    infoLines = [];
    infoSpy = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => { infoLines.push(args.map(String).join(" ")); });
  });
  afterEach(async () => {
    flagModule?.setWarmAcpReuseSource(() => undefined);
    for (const name of ["FAKE_ACP_SPAWN_LOG", "FAKE_ACP_LATE_REPLY_LOG", "FAKE_ACP_MCP_READY", "MURAGE_ACP_POOL", "FAKE_ACP_PROMPT_SCOPE", "FAKE_ACP_PSCOPE_SPLIT"]) delete process.env[name];
    infoSpy?.mockRestore();
    recorder?.stop();
    const pids = spawns();
    await instance?.dispose();
    instance = undefined;
    await until(() => pids.every((pid) => !alive(pid)), "every engine process to exit");
    resetAcpMcpReadinessForTests();
    await removeTempDir(scratch);
  });

  /** Turn 1 leaves half a frame on the wire; turn 2 adopts the process and the frame's newline arrives during turn 2. */
  const splitAcrossHandoff = async (shape: "request" | "status" | "replay" | "foreign-status") => {
    process.env.FAKE_ACP_PSCOPE_SPLIT = shape;
    instance = await Driver.create({ instanceId: "warm-fuigo-split", displayName: "Split", environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
    recorder = recordEvents(instance.adapter);
    const first = await turn({ text: "one" });
    expect(first.done).toMatchObject({ ok: true });
    const second = await turn({ text: "two", resumeCursor: SESSION });
    // turn 2 really ran on turn 1's process (generation 2), so the frame's newline reached turn 2's owner
    expect(spawns(), "turn 2 reused turn 1's process").toHaveLength(1);
    return second;
  };
  /** Turn 3: a process the split frame marked unfit in turn 2 was not parked, so turn 3 spawns. */
  const thirdSpawned = async () => {
    const third = await turn({ text: "three", resumeCursor: SESSION });
    expect(third.done).toMatchObject({ ok: true });
    return spawns().length === 2;
  };

  // WM-B3s/request: an ask with no prompt id, begun in turn 1, completed in reused turn 2. It is not turn 2's work: answered
  // cancelled, no card, NO denied row in turn 2 (logged only, as another dispatch's frame is), and the process is retired.
  // Base dev/1022 (no prompt scope): the ask is answered but the process stays pooled and turn 3 reuses it, RED at "spawned".
  // Mutant MB-3s (the owner is read at the newline, the r2 code): the ask reads as turn 2's unproven work and turn 2 shows a
  // denied row, RED at "no denied row". Null mutants REVERT / NOOP / DROP: mutants.tsv.
  it("WM-B3s/request an ask begun before the handoff never shows in the reused turn", async () => {
    const second = await splitAcrossHandoff("request");
    expect(second.cards, "WM-B3s no card").toEqual([]);
    expect({ text: JSON.stringify(second.events).includes("SPLIT CURRENT TEXT"), ok: (second.done as { ok?: unknown } | undefined)?.ok }, "WM-B3s/request current frame kept").toEqual({ text: true, ok: true });
    const denied = second.events.filter((event) => event.type === "item.completed" && String((event as { itemId?: string }).itemId).startsWith("pscope-denied-"));
    // the ask is answered cancelled and leaves no denied row; one assertion, because which shows first depends on the read
    expect({ outcomes: replies().map((r) => r.result?.outcome?.outcome), denied }, "WM-B3s no denied row").toEqual({ outcomes: ["cancelled"], denied: [] });
    expect(JSON.stringify(second.events)).not.toContain("Ask begun before the handoff");
    // above: the frame of turn 2's own prompt in the same read as the split frame's newline still acts (no false stale)
    // and turn 2 completes; one assertion, because a false stale drops the text or the prompt result depending on the read
    expect(await thirdSpawned(), "WM-B3s/request spawned").toBe(true);
    expect(staleLines(), "WM-B3s/request one stale frame").toEqual([expect.stringMatching(/kind=request .*id=before-handoff$/)]);
  });

  // WM-B3s/status: a status-shaped frame (null id, available_commands_update) begun in turn 1 and completed in reused turn 2
  // still counts as stale (it was not sent for turn 2): the process is marked unfit and turn 3 spawns.
  // Base dev/1022 (no prompt scope): the process stays pooled and turn 3 reuses it, RED at "spawned".
  // Mutant MB-3s: the frame reads as status, the process stays fit, RED at "spawned".
  it.each(["status", "replay", "foreign-status"] as const)("WM-B3s/%s an update begun before handoff retires the process", async (shape) => {
    const second = await splitAcrossHandoff(shape);
    expect({ text: JSON.stringify(second.events).includes("SPLIT CURRENT TEXT"), ok: (second.done as { ok?: unknown } | undefined)?.ok }, "WM-B3s/status current frame kept").toEqual({ text: true, ok: true });
    // (turn 2 completing is part of the assertion above: a false stale drops its text or its prompt result)
    expect(await thirdSpawned(), "WM-B3s/status spawned").toBe(true);
    expect(staleLines(), "WM-B3s/update one stale frame").toEqual([expect.stringMatching(/kind=update .*id=before-handoff$/)]);
  });

  // Control (guard, not a witness): the same two turns with no split frame keep the process fit, so turn 3 reuses it.
  it("control: with nothing split across the handoff the reused process stays fit", async () => {
    instance = await Driver.create({ instanceId: "warm-fuigo-split", displayName: "Split", environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
    recorder = recordEvents(instance.adapter);
    await turn({ text: "one" });
    await turn({ text: "two", resumeCursor: SESSION });
    expect(await thirdSpawned()).toBe(false);
    expect(staleLines()).toEqual([]);
  });
});
