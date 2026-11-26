// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.22 (MAIN-RULING learning-send-transports :56): the PIP Fuigo/Grok transport never holds the learning gate's write lock across its
// prompt file write or its CLI launch. The gate decides and commits the release first; the prompt file and the spawn follow in the same
// synchronous turn. Each row enters through headlessTextOnlyTurn (the transport pip-reflect runs) with the real gate, the real temp root
// and the real stub CLI; spawnCli and the counted writeFileSync are passed through and only observed (and, in the slow row, delayed).
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { headlessTextOnlyTurn } from "../drivers/headless-text-only.ts";
import { fixtureBotFolder } from "../testing/bot-folder-fixture.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { fixedPrompt } from "./fixed-prompt.ts";
import { learningGate, learningSendHoldSamples, sampleLearningFence, type LearningGate } from "./learning-send.ts";
import type { TextOnlyTurnInput } from "./pip-transport.ts";

/** What the transport saw at each observed step, in order. */
interface Seen { step: "prompt-write" | "spawn"; inTransaction: boolean; released: number; promptOnDisk?: string }
const seen: Seen[] = [];
const hooks: { gate?: LearningGate; spawnDelayMs: number; failPromptWrite?: Error } = { spawnDelayMs: 0 };
const PROMPT_MARK = "zqholdspawn the owner prefers tea";

vi.mock("../counted-fs.ts", async original => {
  const real = await original<typeof import("../counted-fs.ts")>();
  const writeFileSync = ((path: unknown, data: unknown, options?: unknown) => {
    if (typeof path === "string" && path.endsWith("prompt.txt") && String(data).includes(PROMPT_MARK)) {
      seen.push({ step: "prompt-write", inTransaction: database().isTransaction, released: hooks.gate?.released ?? -1 });
      if (hooks.failPromptWrite) throw hooks.failPromptWrite;
    }
    return (real.writeFileSync as (...a: unknown[]) => void)(path, data, options);
  }) as typeof real.writeFileSync;
  return { ...real, writeFileSync };
});
vi.mock("../procs.ts", async original => {
  const real = await original<typeof import("../procs.ts")>();
  return { ...real, spawnCli: vi.fn((...args: Parameters<typeof real.spawnCli>) => {
    const env = (args[2] as { env?: Record<string, string | undefined> } | undefined)?.env ?? {};
    // HOME is the attempt's temp home (or its root): the prompt file sits in the root
    const file = env.HOME ? [join(String(env.HOME), "prompt.txt"), join(String(env.HOME), "..", "prompt.txt")].find(f => existsSync(f)) : undefined;
    seen.push({ step: "spawn", inTransaction: database().isTransaction, released: hooks.gate?.released ?? -1, promptOnDisk: file ? readFileSync(file, "utf8") : undefined });
    // A loaded host: the fork itself is slow. Busy, not awaited, exactly as a slow spawn blocks the event loop.
    const until = performance.now() + hooks.spawnDelayMs;
    while (performance.now() < until) { /* spin */ }
    return real.spawnCli(...args);
  }) };
});
const { spawnCli } = await import("../procs.ts");

const STUB = fileURLToPath(new URL("../testing/pip-stub-cli.mjs", import.meta.url));
let dir = "";
beforeEach(() => {
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); database();
  seen.length = 0; hooks.gate = undefined; hooks.spawnDelayMs = 0; hooks.failPromptWrite = undefined; vi.mocked(spawnCli).mockClear();
  dir = mkdtempSync(join(tmpdir(), "pip-hold-spawn-")); mkdirSync(join(dir, "etc")); mkdirSync(join(dir, "home"));
});
afterEach(() => { vi.restoreAllMocks(); closeDatabase(); removeTempDirSync(dir); });

const cfg = () => ({
  engine: "fuigo" as const, cli: process.execPath, cliPrefixArgs: [STUB, "--stub=ok", `--stub-out=${join(dir, "rec.jsonl")}`], tmpBase: join(dir, "tmp"),
  pathValue: "/usr/bin:/bin", fluxKey: "flux-test-key", postResultGraceMs: 3000,
  preflight: { etcRoot: join(dir, "etc"), home: join(dir, "home"), grokHome: join(dir, "home", ".grok"), platform: "linux" as const, mdmDir: null, claudeManagedPath: join(dir, "no-managed.json") },
});
const turn = (g: LearningGate): TextOnlyTurnInput => ({ cwd: fixtureBotFolder(),
  system: fixedPrompt("SYS"), text: PROMPT_MARK, model: "model-x", signal: new AbortController().signal, maxOutputTokens: 1500, maxOutputBytes: 12 * 1024,
  outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } }, additionalProperties: false },
  context: { botId: "b", runId: randomUUID(), family: "lived", attempt: 1 }, transport: { fence: () => "none", gate: g },
} as TextOnlyTurnInput);
const gateWith = (checks?: ReadonlyArray<() => void>) => { const g = learningGate("reflection", sampleLearningFence(), {}, checks ? { checks } : {}); hooks.gate = g; return g; };

describe.skipIf(process.platform === "win32")("PIP Fuigo/Grok: the write lock is never held across the prompt write or the CLI launch", () => {
  it("H1 the prompt file is written after the gate committed its release, outside the transaction", async () => {
    const g = gateWith();
    const r = await headlessTextOnlyTurn(turn(g), cfg());
    expect(r.verdict.state).toBe("validated");
    const write = seen.find(s => s.step === "prompt-write");
    expect(write, "the prompt file was written through the counted writeFileSync").toBeDefined();
    expect(write!.inTransaction, "the prompt file write ran inside BEGIN IMMEDIATE").toBe(false);
    expect(write!.released, "the prompt file was written before the gate released the call").toBe(1);
  });
  it("H2 the CLI is launched after the gate committed its release, outside the transaction, with the prompt already on disk", async () => {
    const g = gateWith();
    const r = await headlessTextOnlyTurn(turn(g), cfg());
    expect(r.verdict.state).toBe("validated");
    const steps = seen.map(s => s.step);
    expect(steps, "the prompt is written before the launch").toEqual(["prompt-write", "spawn"]);
    const spawn = seen[1]!;
    expect(spawn.inTransaction, "spawnCli ran inside BEGIN IMMEDIATE").toBe(false);
    expect(spawn.released, "the CLI was launched before the gate released the call").toBe(1);
    expect(spawn.promptOnDisk ?? "", "the CLI was launched before its prompt file held the words").toContain(PROMPT_MARK);
  });
  it("H3 a slow launch (a loaded host) does not lengthen the gate's hold: the T18e sample stays under 50 ms with an 80 ms fork", async () => {
    hooks.spawnDelayMs = 80;
    const g = gateWith();
    const before = learningSendHoldSamples().length;
    const r = await headlessTextOnlyTurn(turn(g), cfg());
    expect(r.verdict.state).toBe("validated");
    expect(g.released).toBe(1);
    const samples = learningSendHoldSamples().slice(before);
    expect(samples).toHaveLength(1);
    expect(samples[0]!, "the learning gate held BEGIN IMMEDIATE across the CLI launch").toBeLessThan(50);
  });
  it("H4 a COMMIT that fails after the release launches nothing: the same commit-failed error, no prompt file, no process, no root", async () => {
    const g = gateWith();
    const db = database(), exec = db.exec.bind(db);
    let failed = false;
    vi.spyOn(db, "exec").mockImplementation(sql => {
      if (sql === "COMMIT" && !failed && new Error().stack?.includes("releaseTransaction")) { failed = true; throw new Error("commit fixture"); }
      return exec(sql);
    });
    await expect(headlessTextOnlyTurn(turn(g), cfg())).rejects.toMatchObject({ name: "memory-send-commit-failed" });
    expect(failed).toBe(true);
    expect(g.released, "a failed COMMIT after the release still counts as released").toBe(1);
    expect(vi.mocked(spawnCli), "a CLI was launched for a release whose COMMIT failed").not.toHaveBeenCalled();
    expect(seen.filter(s => s.step === "prompt-write")).toEqual([]);
    expect(existsSync(join(dir, "tmp")) ? readdirSync(join(dir, "tmp")) : []).toEqual([]);
  });
  it("H5 (guard) a gate that refuses at the send writes and launches nothing", async () => {
    let calls = 0;
    const g = gateWith([() => { if (++calls > 1) throw new Error("moved"); }]);
    await expect(headlessTextOnlyTurn(turn(g), cfg())).rejects.toBeDefined();
    expect(g.released).toBe(0);
    expect(g.refused).toBe(true);
    expect(seen).toEqual([]);
    expect(vi.mocked(spawnCli)).not.toHaveBeenCalled();
  });
  it("H6 (guard) a prompt write that fails after the release surfaces that same error, counts as released and launches nothing", async () => {
    const boom = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    hooks.failPromptWrite = boom;
    const g = gateWith();
    await expect(headlessTextOnlyTurn(turn(g), cfg())).rejects.toBe(boom);
    expect(g.released).toBe(1);
    expect(vi.mocked(spawnCli)).not.toHaveBeenCalled();
    expect(existsSync(join(dir, "tmp")) ? readdirSync(join(dir, "tmp")) : []).toEqual([]);
  });
});

