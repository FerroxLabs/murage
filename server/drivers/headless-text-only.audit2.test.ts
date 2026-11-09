import { fixtureBotFolder } from "../testing/bot-folder-fixture.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Production runner with an offline process boundary: no sockets or engine binary.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { claudeTextOnlyTurn, headlessTextOnlyTurn } from "./headless-text-only.ts";
import { spawnCli, awaitCliTreeStopped } from "../procs.ts";
import { captureMemoryUsage, type MemoryUsageReport, withContinuityInferenceLease } from "../memory/extract.ts";
import { DATA_DIR } from "../config.ts";
import { database } from "../database.ts";
import type { TextOnlyTurnInput } from "../memory/pip-transport.ts";
import { openLearningGate } from "../testing/open-learning-gate.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { withRetryReservation } from "../testing/retry-reservation.ts";
import { fixedPrompt } from "../memory/fixed-prompt.ts";

vi.mock("../procs.ts", async original => ({ ...await original<typeof import("../procs.ts")>(), spawnCli: vi.fn(), awaitCliTreeStopped: vi.fn() }));
vi.mock("../memory/pip-reaper.ts", async original => ({ ...await original<typeof import("../memory/pip-reaper.ts")>(), registerChild: async (pid: number) => ({ pid, startTime: "fixture", registeredAt: Date.now() }) }));
let base: string;
beforeEach(() => { mkdirSync(DATA_DIR, { recursive: true }); base = mkdtempSync(join(tmpdir(), "pip-audit2-runner-")); vi.mocked(awaitCliTreeStopped).mockReset(); vi.mocked(awaitCliTreeStopped).mockResolvedValue(true); });
afterEach(() => { removeTempDirSync(base); });
const input = (signal = new AbortController().signal): TextOnlyTurnInput => ({ cwd: fixtureBotFolder(), system: fixedPrompt("SYSTEM"), text: "You are reliable. ".repeat(1800), model: "fixture", outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }, signal, maxOutputBytes: 12000, maxOutputTokens: 3000, context: { botId: "fixture", family: "lived", runId: "run", attempt: 1 }, transport: { gate: openLearningGate("continuity") } });
function fixture(onOutput?: (child: EventEmitter) => void, debug?: string, outputTokens = 13, prose = false) {
  let recorded: { argv: string[]; prompt: string } | undefined;
  vi.mocked(spawnCli).mockImplementation((_cli, argv) => {
    const child = Object.assign(new EventEmitter(), { pid: 999777, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    const after = (flag: string) => argv[argv.indexOf(flag) + 1];
    recorded = { argv: [...argv], prompt: argv.includes("--prompt-file") ? readFileSync(after("--prompt-file"), "utf8") : "" };
    if (debug && argv.includes("--debug-file")) writeFileSync(after("--debug-file"), debug);
    queueMicrotask(() => {
      child.stdout.write(JSON.stringify({ type: "system", subtype: "init", tools: [], mcp_servers: [] }) + "\n");
      child.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", structured_output: prose ? undefined : { ok: true }, result: prose ? "not JSON" : undefined, usage: { input_tokens: 11, output_tokens: outputTokens } }) + "\n");
      if (onOutput) onOutput(child); else child.emit("close");
    });
    return child as never;
  });
  return () => recorded!;
}
const run = (i: TextOnlyTurnInput, fluxKey: string | null = "fixture-key") => { mkdirSync(join(base, "etc"), { recursive: true }); return headlessTextOnlyTurn(fluxKey === null ? { ...i, providerRoute: { connectionId: "fixture", preset: "openai", protocol: "openai", baseUrl: "https://fixture.invalid/v1", apiKey: "fixture", model: i.model, revision: "1" } } : i, { engine: "fuigo", cli: "fixture", tmpBase: join(base, "tmp"), pathValue: "/fixture", fluxKey: fluxKey ?? undefined, preflight: { platform: "linux", home: base, etcRoot: join(base, "etc"), mdmDir: null, claudeManagedPath: join(base, "absent") } }); };

it("15: cancellation retains received usage until adapter termination is processed", async () => {
  const abort = new AbortController();
  fixture(child => { abort.abort(); queueMicrotask(() => child.emit("close")); });
  await expect(withContinuityInferenceLease(lease => lease.request(async () => (await run(input(abort.signal))).text, "system", 3000, abort.signal, [{ role: "user", content: "fixture" }], "continuity", { botId: "fixture", family: "lived" }))).rejects.toMatchObject({ name: "cancelled" });
  const ledger = JSON.parse(String(database().prepare("SELECT intent FROM memory_scope_bindings WHERE id LIKE 'continuity-budget:fixture:%'").get()!.intent));
  expect(ledger.input).toBe(11); expect(ledger.output).toBe(13);
});
it("21: a hook in the debug log refuses the production runner output", async () => {
  fixture(undefined, "executing hook /external/task.sh");
  expect((await run(input())).verdict).toMatchObject({ state: "unsupported", reason: "managed-config", detail: "hook-execution" });
});
it("23: the production runner supplies the complete prompt with verbatim enabled", async () => {
  const record = fixture(), i = input();
  expect((await run(i, null)).verdict.state).toBe("validated");
  expect(record().argv).toContain("--verbatim"); expect(record().prompt).toBe(i.system + "\n\n" + i.text);
  expect(record().argv).toContain("--json-schema");
});
it("23b: a Flux route keeps the complete prompt verbatim and carries the schema at its end, not in --json-schema", async () => {
  const record = fixture(), i = input();
  expect((await run(i)).verdict.state).toBe("validated");
  expect(record().argv).toContain("--verbatim"); expect(record().argv).not.toContain("--json-schema");
  expect(record().prompt.startsWith(i.system + "\n\n" + i.text + "\n\n")).toBe(true);
  expect(record().prompt.endsWith(JSON.stringify(i.outputSchema))).toBe(true);
});

it.each(["fuigo", "grok", "claude"] as const)("3: Windows %s preflight admits reflection", async engine => {
  const record = fixture(undefined, "text-only completed"); vi.mocked(spawnCli).mockClear();
  writeFileSync(join(base, "auth.json"), "{}");
  const cfg = { cli: "fixture", tmpBase: join(base, "tmp"), env: {}, preflight: { platform: "win32" as const, home: base, etcRoot: join(base, "etc"), mdmDir: null, claudeManagedPath: join(base, "absent") } };
  const got = engine === "claude" ? await claudeTextOnlyTurn(input(), cfg) : await headlessTextOnlyTurn(input(), { ...cfg, engine, fluxKey: "fixture-key", parentGrokHome: base });
  expect(got.verdict.state).toBe("validated");
  expect(spawnCli).toHaveBeenCalledOnce(); expect(record()).toBeDefined();
});

it.each([undefined, "executing hook /external/task.sh", "text-only completed"])("21: Claude requires and inspects its requested debug log (%s)", async debug => {
  const record = fixture(undefined, debug);
  const got = await claudeTextOnlyTurn(input(), { cli: "fixture", tmpBase: join(base, "tmp"), env: {}, preflight: { platform: "linux", home: base, etcRoot: join(base, "etc"), mdmDir: null, claudeManagedPath: join(base, "absent") } });
  expect(got.verdict).toMatchObject(debug === undefined ? { state: "refused", detail: "debug-inspection-failed" } : debug.startsWith("executing") ? { state: "unsupported", detail: "hook-execution" } : { state: "validated" });
  const argv = record().argv;
  expect(argv).toContain("--debug-file"); expect(argv[argv.indexOf("--debug-file") + 1]).toMatch(/debug\.log$/);
});

it("27: runner reports overrun to its host before cancellation rejects", async () => {
  const abort = new AbortController(), onUsage = vi.fn();
  fixture(child => { abort.abort(); queueMicrotask(() => child.emit("close")); }, undefined, 4001);
  const i = input(abort.signal); i.transport = { ...i.transport, hooks: { onUsage } };
  await expect(run(i)).rejects.toMatchObject({ name: "cancelled" });
  expect(onUsage).toHaveBeenCalledWith({ inputTokens: 11, outputTokens: 4001 });
});

it("Stop between runs preserves the schema miss and spawns once", async () => {
  const controller = new AbortController();
  fixture(undefined, undefined, 13, true);
  vi.mocked(spawnCli).mockClear();
  const i = input(controller.signal);
  i.transport!.hooks = { onUsage: () => controller.abort() };
  expect((await withRetryReservation(()=>run(i))).verdict).toMatchObject({ state: "refused", detail: "no-structured-output" });
  expect(controller.signal.aborted).toBe(true);
  expect(spawnCli).toHaveBeenCalledOnce();
});

it("concurrent Flux turns isolate their usage sums and output records", async () => {
  const counts: Record<string, number> = {};
  vi.mocked(spawnCli).mockImplementation((_cli, argv) => {
    const model = argv[argv.indexOf("-m") + 1], n = counts[model] = (counts[model] ?? 0) + 1;
    appendFileSync(join(base, `${model}.jsonl`), JSON.stringify(argv) + "\n");
    const child = Object.assign(new EventEmitter(), { pid: 999777, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    setImmediate(() => {
      child.stdout.write(JSON.stringify({ type: "system", subtype: "init", tools: [], mcp_servers: [] }) + "\n");
      child.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: n === 1 ? "not JSON" : '{"ok":true}', usage: { input_tokens: model === "a" ? 11 : 101, output_tokens: model === "a" ? 13 : 103 } }) + "\n");
      child.emit("close", 0);
    });
    return child as never;
  });
  const a: MemoryUsageReport[] = [], b: MemoryUsageReport[] = [];
  const results = await Promise.all([
    captureMemoryUsage(u => a.push(u), () => withRetryReservation(()=>run({ ...input(), model: "a" }))),
    captureMemoryUsage(u => b.push(u), () => withRetryReservation(()=>run({ ...input(), model: "b", context: { ...input().context, runId: "other" } }))),
  ]);
  expect(results.map(r => r.verdict.state)).toEqual(["validated", "validated"]);
  for (const model of ["a", "b"]) expect(readFileSync(join(base, `${model}.jsonl`), "utf8").trim().split("\n")).toHaveLength(2);
  expect(a).toHaveLength(1); expect(b).toHaveLength(1);
  expect(a[0]).toMatchObject({ prompt_tokens: 22, completion_tokens: 26 });
  expect(b[0]).toMatchObject({ prompt_tokens: 202, completion_tokens: 206 });
});
