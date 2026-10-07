// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Production runner with an offline process boundary: no sockets or engine binary.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { claudeTextOnlyTurn, headlessTextOnlyTurn } from "./headless-text-only.ts";
import { spawnCli, awaitCliTreeStopped } from "../procs.ts";
import { withContinuityInferenceLease } from "../memory/extract.ts";
import { DATA_DIR } from "../config.ts";
import { database } from "../database.ts";
import type { TextOnlyTurnInput } from "../memory/pip-transport.ts";

vi.mock("../procs.ts", async original => ({ ...await original<typeof import("../procs.ts")>(), spawnCli: vi.fn(), awaitCliTreeStopped: vi.fn() }));
vi.mock("../memory/pip-reaper.ts", async original => ({ ...await original<typeof import("../memory/pip-reaper.ts")>(), registerChild: async (pid: number) => ({ pid, startTime: "fixture", registeredAt: Date.now() }) }));
let base: string;
beforeEach(() => { mkdirSync(DATA_DIR, { recursive: true }); base = mkdtempSync(join(tmpdir(), "pip-audit2-runner-")); vi.mocked(awaitCliTreeStopped).mockReset(); vi.mocked(awaitCliTreeStopped).mockResolvedValue(true); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); });
const input = (signal = new AbortController().signal): TextOnlyTurnInput => ({ system: "SYSTEM", text: "You are reliable. ".repeat(1800), model: "fixture", outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }, signal, maxOutputBytes: 12000, maxOutputTokens: 3000, context: { botId: "fixture", family: "lived", runId: "run", attempt: 1 } });
function fixture(onOutput?: (child: EventEmitter) => void, debug?: string, outputTokens = 13) {
  let recorded: { argv: string[]; prompt: string } | undefined;
  vi.mocked(spawnCli).mockImplementation((_cli, argv) => {
    const child = Object.assign(new EventEmitter(), { pid: 999777, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    const after = (flag: string) => argv[argv.indexOf(flag) + 1];
    recorded = { argv: [...argv], prompt: argv.includes("--prompt-file") ? readFileSync(after("--prompt-file"), "utf8") : "" };
    if (debug && argv.includes("--debug-file")) writeFileSync(after("--debug-file"), debug);
    queueMicrotask(() => {
      child.stdout.write(JSON.stringify({ type: "system", subtype: "init", tools: [], mcp_servers: [] }) + "\n");
      child.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", structured_output: { ok: true }, usage: { input_tokens: 11, output_tokens: outputTokens } }) + "\n");
      if (onOutput) onOutput(child); else child.emit("close");
    });
    return child as never;
  });
  return () => recorded!;
}
const run = (i: TextOnlyTurnInput) => { mkdirSync(join(base, "etc"), { recursive: true }); return headlessTextOnlyTurn(i, { engine: "fuigo", cli: "fixture", tmpBase: join(base, "tmp"), pathValue: "/fixture", fluxKey: "fixture-key", preflight: { platform: "linux", home: base, etcRoot: join(base, "etc"), mdmDir: null, claudeManagedPath: join(base, "absent") } }); };

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
  expect((await run(i)).verdict.state).toBe("validated");
  expect(record().argv).toContain("--verbatim"); expect(record().prompt).toBe(i.system + "\n\n" + i.text);
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
  const i = input(abort.signal); i.transport = { hooks: { onUsage } };
  await expect(run(i)).rejects.toMatchObject({ name: "cancelled" });
  expect(onUsage).toHaveBeenCalledWith({ inputTokens: 11, outputTokens: 4001 });
});
