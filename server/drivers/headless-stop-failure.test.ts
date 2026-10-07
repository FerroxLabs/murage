// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PIP P2 code audit finding 5: a stop that cannot be confirmed must return uncertain-transport, retain the temp root
// and its credentials, and never hang the adapter. The stop result is forced to "not confirmed" while a real stub
// child is running; the test then kills that child itself.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../procs.ts", async (original) => ({
  ...(await original<typeof import("../procs.ts")>()),
  awaitCliTreeStopped: vi.fn(async () => false),
}));

import { claudeTextOnlyTurn, headlessTextOnlyTurn } from "./headless-text-only.ts";
import type { TextOnlyTurnInput } from "../memory/pip-transport.ts";

const STUB = fileURLToPath(new URL("../testing/pip-stub-cli.mjs", import.meta.url));
const SCHEMA = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } }, additionalProperties: false };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let base: string, out: string, pids: number[];
beforeEach(() => { base = mkdtempSync(join(tmpdir(), "pip-stop-")); out = join(base, "rec.jsonl"); pids = []; mkdirSync(join(base, "etc")); mkdirSync(join(base, "home")); });
afterEach(() => {
  for (const pid of pids) { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  rmSync(base, { recursive: true, force: true });
});
const records = (): Array<{ pid: number; env: Record<string, string> }> =>
  existsSync(out) ? readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.argv && r.stdin === undefined) : [];
const preflight = () => ({ etcRoot: join(base, "etc"), home: join(base, "home"), grokHome: join(base, "home", ".grok"), platform: "linux" as const, mdmDir: null, claudeManagedPath: join(base, "none.json") });
const input = (over: Partial<TextOnlyTurnInput> = {}): TextOnlyTurnInput => ({
  system: "SYS", text: "USER", model: "m", outputSchema: SCHEMA, signal: new AbortController().signal, maxOutputTokens: 2000, maxOutputBytes: 12 * 1024,
  context: { botId: "b", runId: "run1", family: "lived", attempt: 1 }, ...over,
});
const cfg = (scenario: string) => ({ engine: "fuigo" as const, cli: process.execPath, cliPrefixArgs: [STUB, `--stub=${scenario}`, `--stub-out=${out}`], tmpBase: join(base, "tmp"), pathValue: "/usr/bin:/bin", fluxKey: "k", preflight: preflight(), postResultGraceMs: 3000 });
const waitRecord = async () => { for (let i = 0; i < 100 && !records().length; i++) await sleep(50); await sleep(100); pids.push(...records().map((r) => r.pid)); };

describe.skipIf(process.platform === "win32")("an unconfirmed stop settles uncertain-transport instead of hanging", () => {
  it("abort: returns uncertain-transport, keeps the root, and does not wait for a close that may never come", async () => {
    const controller = new AbortController();
    const run = headlessTextOnlyTurn(input({ signal: controller.signal }), cfg("sleep"));
    await waitRecord();
    const [r] = records();
    controller.abort();
    const result = await Promise.race([run, sleep(8000).then(() => "hung" as const)]);
    expect(result).not.toBe("hung");
    expect(result).toMatchObject({ verdict: { state: "uncertain-transport", reason: "abort-exit-not-confirmed" }, text: "" });
    expect(existsSync(r.env.HOME)).toBe(true); // the reaper owns the root now
  });
  it("deadline: the same, with the deadline reason", async () => {
    const run = headlessTextOnlyTurn(input({ transport: { deadlineAt: Date.now() + 400 } }), cfg("sleep"));
    await waitRecord();
    const result = await Promise.race([run, sleep(8000).then(() => "hung" as const)]);
    expect(result).toMatchObject({ verdict: { state: "uncertain-transport", reason: "deadline-exit-not-confirmed" } });
    expect(existsSync(records()[0].env.HOME)).toBe(true);
  });
  it("output over the byte cap with an unconfirmed stop: uncertain, not an indefinite wait", async () => {
    const result = await Promise.race([headlessTextOnlyTurn(input({ maxOutputBytes: 1024 }), cfg("big")), sleep(8000).then(() => "hung" as const)]);
    await waitRecord();
    expect(result).toMatchObject({ verdict: { state: "uncertain-transport", reason: "overflow-exit-not-confirmed" } });
  });
  it("an exception after spawn with an unconfirmed stop keeps the root and the credentials and returns uncertain-transport", async () => {
    const config = join(base, "claude-config"); mkdirSync(config); writeFileSync(join(config, ".credentials.json"), "{}");
    const result = await claudeTextOnlyTurn(input({ transport: { hooks: { onChild: async () => { await sleep(600); throw new Error("persist failed"); } } } }), {
      cli: process.execPath, cliPrefixArgs: [STUB, "--stub=sleep", `--stub-out=${out}`], tmpBase: join(base, "tmp"), env: { PATH: "/usr/bin:/bin" }, credentialsDir: config, preflight: preflight(),
    });
    await waitRecord();
    expect(result).toMatchObject({ verdict: { state: "uncertain-transport", reason: "post-spawn-error-exit-not-confirmed" } });
    const home = records()[0].env.HOME;
    expect(existsSync(join(home, "home", ".credentials.json"))).toBe(true);
  });
});
