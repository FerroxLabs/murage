// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PIP-FLUX-SCHEMA (1.0.18): today's Flux router answers 502/422 to the flat response_format json_schema that `--json-schema` makes
// Fuigo send. A reflection routed to Flux runs without the flag, with the schema as a JSON-only instruction at the end of its prompt;
// the host validator stays the gate, a parse or schema miss gets one more run, then the miss stands. Every other route is unchanged.
// The recording stub stands in for the engine; nothing here reaches a provider.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { headlessArgv, headlessTextOnlyTurn as unscopedHeadlessTextOnlyTurn, reflectionRoutesToFlux, schemaPromptInstruction, type HeadlessEngineConfig } from "./headless-text-only.ts";
import { gateRun, parseHeadlessMessages, parseJsonAnswer, type GateObservation, type TempRoot, type TextOnlyTurnInput } from "../memory/pip-transport.ts";
import { captureMemoryUsage, type MemoryUsageReport } from "../memory/extract.ts";
import type { ProviderTurnRoute } from "../provider-routing.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { fixedPrompt } from "../memory/fixed-prompt.ts";
import { openLearningGate, type OpenLearningGate } from "../testing/open-learning-gate.ts";

import { withRetryReservation } from "../testing/retry-reservation.ts";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { readMemoryLearning, updateMemoryLearning } from "../memory/learning-policy.ts";
const headlessTextOnlyTurn:typeof unscopedHeadlessTextOnlyTurn=(...args)=>withRetryReservation(()=>unscopedHeadlessTextOnlyTurn(...args));
beforeEach(()=>{closeDatabase();mkdirSync(DATA_DIR,{recursive:true});const db=database();db.exec("DELETE FROM memory_scope_bindings WHERE subject_id IN ('extract-budget','continuity-budget','learning-spend')");updateMemoryLearning(db,{callsPerMinute:60},readMemoryLearning(db).revision);});
const posix = describe.skipIf(process.platform === "win32");
const STUB = fileURLToPath(new URL("../testing/pip-stub-cli.mjs", import.meta.url));
const SCHEMA = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } }, additionalProperties: false };
let base: string, out: string, etc: string, home: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "pip-flux-schema-"));
  out = join(base, "rec.jsonl"); etc = join(base, "etc"); home = join(base, "home");
  mkdirSync(etc); mkdirSync(home);
});
afterEach(() => removeTempDirSync(base));

const preflight = () => ({ etcRoot: etc, home, grokHome: join(home, ".grok"), platform: "linux" as const, mdmDir: null, claudeManagedPath: join(base, "no-managed.json") });
const cfg = (scenario: string, extra: Partial<HeadlessEngineConfig> = {}): HeadlessEngineConfig => ({
  engine: "fuigo", cli: process.execPath, cliPrefixArgs: [STUB, `--stub=${scenario}`, `--stub-out=${out}`], tmpBase: join(base, "tmp"),
  pathValue: "/usr/bin:/bin", fluxKey: "flux-test-key", preflight: preflight(), postResultGraceMs: 3000, ...extra,
});
const input = (over: Partial<TextOnlyTurnInput> = {}, gate: OpenLearningGate = openLearningGate("continuity")): TextOnlyTurnInput => ({
  system: fixedPrompt("SYS"), text: "USER", model: "model-1", outputSchema: SCHEMA, signal: new AbortController().signal,
  maxOutputTokens: 2000, maxOutputBytes: 12 * 1024, context: { botId: "bot", runId: "run1", family: "lived", attempt: 1 }, ...over,
  transport: { ...over.transport, gate },
});
type Rec = { argv: string[]; env: Record<string, string>; prompt: string | null; pid: number; stdin?: string };
const records = (): Rec[] => existsSync(out) ? readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.argv && r.stdin === undefined) : [];
const openaiRoute: ProviderTurnRoute = { connectionId: "conn-a", preset: "openai", protocol: "openai", baseUrl: "http://127.0.0.1:49999/v1", apiKey: "route-key-1", model: "route-model", revision: "r1" };
const fluxRoute: ProviderTurnRoute = { ...openaiRoute, connectionId: "conn-f", preset: "flux", model: "flux-auto" };
const grokParent = () => { const parent = join(base, "grok-parent"); mkdirSync(parent, { recursive: true }); writeFileSync(join(parent, "auth.json"), "{}"); return parent; };
const argvTail = (T: string) => ["--prompt-file", `${T}/prompt.txt`, "--debug-file", `${T}/debug.log`];
const FLUX_PROMPT = `SYS\n\nUSER\n\n${schemaPromptInstruction(SCHEMA)}`;

describe("which reflections go to Flux (the same test as the Flux Memory overlay)", () => {
  it("a flux preset on any engine, or native Fuigo with a Flux key; nothing else", () => {
    expect(reflectionRoutesToFlux({ providerRoute: fluxRoute }, { engine: "grok" })).toBe(true);
    expect(reflectionRoutesToFlux({ providerRoute: fluxRoute }, { engine: "fuigo" })).toBe(true);
    expect(reflectionRoutesToFlux({}, { engine: "fuigo", fluxKey: "k" })).toBe(true);
    expect(reflectionRoutesToFlux({ providerRoute: openaiRoute }, { engine: "fuigo", fluxKey: "k" })).toBe(false);
    expect(reflectionRoutesToFlux({}, { engine: "grok", fluxKey: "k" })).toBe(false);
    expect(reflectionRoutesToFlux({}, { engine: "fuigo" })).toBe(false);
  });
  it("the argv drops only the --json-schema pair; the default argv is the A.1 one", () => {
    const temp: TempRoot = { root: "/T", work: "/T/work", home: "/T/home", promptFile: "/T/prompt.txt", debugFile: "/T/debug.log" };
    const full = headlessArgv(temp, "m", SCHEMA);
    expect(full).toEqual(headlessArgv(temp, "m", SCHEMA, false));
    const i = full.indexOf("--json-schema");
    expect(full[i + 1]).toBe(JSON.stringify(SCHEMA));
    expect(headlessArgv(temp, "m", SCHEMA, true)).toEqual([...full.slice(0, i), ...full.slice(i + 2)]);
  });
  it("the instruction carries the schema itself and asks for JSON only", () => {
    const text = schemaPromptInstruction(SCHEMA);
    expect(text).toContain(JSON.stringify(SCHEMA));
    expect(text).toMatch(/one JSON object and nothing else/);
  });
});

describe("the gate reads a schema-in-prompt answer from the result text, through the same validator", () => {
  const INIT = JSON.stringify({ type: "system", subtype: "init", tools: [], mcp_servers: [] });
  const res = (text: string) => JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text });
  const obs = (stdout: string, extra: Partial<GateObservation> = {}): GateObservation => ({ parsed: parseHeadlessMessages(stdout), homeNewFiles: [], cwdNewFiles: [], exited: true, outputSchema: SCHEMA, engine: "fuigo", ...extra });
  it("a valid object passes; a fenced one passes; a wrong one is a schema miss; prose is no answer", () => {
    expect(gateRun(obs(`${INIT}\n${res('{"ok":true}')}`, { schemaInPrompt: true }))).toEqual({ state: "validated", structured: { ok: true } });
    expect(gateRun(obs(`${INIT}\n${res('```json\n{"ok":false}\n```')}`, { schemaInPrompt: true }))).toEqual({ state: "validated", structured: { ok: false } });
    expect(gateRun(obs(`${INIT}\n${res('{"ok":"yes"}')}`, { schemaInPrompt: true }))).toMatchObject({ state: "refused", reason: "bad-output", detail: "schema:$.ok: type" });
    expect(gateRun(obs(`${INIT}\n${res('{"ok":true,"x":1}')}`, { schemaInPrompt: true }))).toMatchObject({ state: "refused", detail: "schema:$.x: additionalProperties" });
    expect(gateRun(obs(`${INIT}\n${res("ok: true")}`, { schemaInPrompt: true }))).toMatchObject({ state: "refused", detail: "no-structured-output" });
    expect(gateRun(obs(`${INIT}\n${res("[1]")}`, { schemaInPrompt: true }))).toMatchObject({ state: "refused", detail: "schema:$: type" });
  });
  it("without the flag Fuigo and Grok text stays refused, as before", () => {
    for (const engine of ["fuigo", "grok"] as const) expect(gateRun(obs(`${INIT}\n${res('{"ok":true}')}`, { engine }))).toMatchObject({ state: "refused", detail: "no-structured-output" });
  });
  it("parseJsonAnswer takes the object or one fenced object, nothing else", () => {
    expect(parseJsonAnswer(' {"a":1} ')).toEqual({ a: 1 });
    expect(parseJsonAnswer('```\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonAnswer('Here: {"a":1}')).toBeUndefined();
    expect(parseJsonAnswer('```json\n{"a":1}\n```\nmore')).toBeUndefined();
  });
});

posix("Flux-routed reflection on the stub engine", () => {
  it("native Fuigo with a Flux key: no --json-schema in argv, the schema at the end of the prompt, the text answer validated", async () => {
    const r = await headlessTextOnlyTurn(input(), cfg("text-result"));
    expect(r.verdict).toEqual({ state: "validated", structured: { ok: true } });
    expect(JSON.parse(r.text)).toEqual({ ok: true });
    const [rec] = records();
    const T = rec.env.HOME;
    expect(rec.argv).not.toContain("--json-schema");
    expect(rec.argv.slice(-4)).toEqual(argvTail(T));
    expect(rec.argv).toContain("--verbatim");
    expect(rec.prompt).toBe(FLUX_PROMPT);
    expect(rec.env.FUIGO_CONFIG).toBeDefined(); // the Flux Memory overlay is unchanged
    expect(records()).toHaveLength(1);
  });
  it("a flux preset route on Grok runs the same way", async () => {
    const r = await headlessTextOnlyTurn(input({ providerRoute: fluxRoute }), cfg("text-fenced", { engine: "grok", parentGrokHome: grokParent() }));
    expect(r.verdict).toEqual({ state: "validated", structured: { ok: true } });
    expect(records()[0].argv).not.toContain("--json-schema");
    expect(records()[0].prompt).toBe(FLUX_PROMPT);
  });
  it("non-Flux routes keep the A.1 argv and the plain prompt, and get no retry", async () => {
    const r = await headlessTextOnlyTurn(input({ providerRoute: openaiRoute }), cfg("ok"));
    expect(r.verdict.state).toBe("validated");
    const [rec] = records();
    expect(rec.argv.slice(-6)).toEqual(["--json-schema", JSON.stringify(SCHEMA), ...argvTail(rec.env.HOME)]);
    expect(rec.prompt).toBe("SYS\n\nUSER");
    const miss = await headlessTextOnlyTurn(input({ providerRoute: openaiRoute }), cfg("text-bad"));
    expect(miss.verdict).toMatchObject({ state: "refused", reason: "bad-output", detail: "no-structured-output" });
    const grok = await headlessTextOnlyTurn(input(), cfg("ok", { engine: "grok", parentGrokHome: grokParent() }));
    expect(grok.verdict.state).toBe("validated");
    expect(records()).toHaveLength(3);
    expect(records()[2].argv).toContain("--json-schema");
    expect(records()[2].prompt).toBe("SYS\n\nUSER");
  });
  it("a reply that is not JSON gets one more run, and that run's answer is admitted", async () => {
    const gate = openLearningGate("continuity");
    const r = await headlessTextOnlyTurn(input({}, gate), cfg("text-bad-then-ok"));
    expect(r.verdict).toEqual({ state: "validated", structured: { ok: true } });
    expect(records()).toHaveLength(2);
    expect(records().every((x) => !x.argv.includes("--json-schema") && x.prompt === FLUX_PROMPT)).toBe(true);
    expect(gate.sent).toBe(2); // each run is released through the call's gate
    expect(r.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
  });
  it("two misses in a row: one retry only, then the existing miss", async () => {
    const bad = await headlessTextOnlyTurn(input(), cfg("text-bad"));
    expect(bad.verdict).toEqual({ state: "refused", reason: "bad-output", detail: "no-structured-output", counted: true });
    expect(bad.text).toBe("");
    expect(records()).toHaveLength(2);
    const wrong = await headlessTextOnlyTurn(input(), cfg("text-wrong-schema"));
    expect(wrong.verdict).toMatchObject({ state: "refused", reason: "bad-output", detail: "schema:$.ok: required" });
    expect(records()).toHaveLength(4);
  });
  it("a miss that is not a parse or schema miss is not retried", async () => {
    expect((await headlessTextOnlyTurn(input(), cfg("cancelled"))).verdict).toMatchObject({ detail: "cancelled" });
    expect((await headlessTextOnlyTurn(input(), cfg("tool-call"))).verdict).toMatchObject({ state: "unsupported", reason: "tools" });
    expect(records()).toHaveLength(2);
  });
  it("both runs settle once, as their sum", async () => {
    const reports: MemoryUsageReport[] = [];
    const r = await captureMemoryUsage((u) => reports.push(u), () => headlessTextOnlyTurn(input(), cfg("text-bad")));
    expect(r.verdict).toMatchObject({ detail: "no-structured-output" });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ prompt_tokens: 20, completion_tokens: 10, engineRun: true });
    const one: MemoryUsageReport[] = [];
    await captureMemoryUsage((u) => one.push(u), () => headlessTextOnlyTurn(input(), cfg("text-result")));
    expect(one[0]).toMatchObject({ prompt_tokens: 10, completion_tokens: 5, engineRun: true });
  });
  it("a second run released and stopped before any output: cancelled, child and temp root gone, both sides keep the reservation", async () => {
    const controller = new AbortController(), gate = openLearningGate("continuity");
    const reports: MemoryUsageReport[] = [];
    const run = captureMemoryUsage((u) => reports.push(u), () => headlessTextOnlyTurn(input({ signal: controller.signal }, gate), cfg("text-bad-then-sleep")));
    const settled = run.then(() => "resolved", (e: Error) => e.name);
    for (let i = 0; i < 200 && records().length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    expect(records()).toHaveLength(2);
    controller.abort();
    expect(await settled).toBe("cancelled");
    expect(gate.sent).toBe(2);
    expect(reports).toHaveLength(1);
    // the second run's tokens are unknown: no side is replaced by run one's figure alone
    expect(reports[0].prompt_tokens).toBeUndefined();
    expect(reports[0].completion_tokens).toBeUndefined();
    expect(reports[0].engineRun).toBe(true);
    const pid = records()[1].pid;
    expect(() => process.kill(pid, 0)).toThrow();
    expect(existsSync(join(base, "tmp")) ? readdirSync(join(base, "tmp")) : []).toEqual([]);
  }, 30_000);
});

posix("between-run Stop", () => {
  it("an abort from the first completed run's usage prevents a second spawn", async () => {
    const controller = new AbortController();
    const reports: MemoryUsageReport[] = [];
    const r = await captureMemoryUsage(u => reports.push(u), () => headlessTextOnlyTurn(input({
      signal: controller.signal, transport: { hooks: { onUsage: () => controller.abort() } },
    }), cfg("text-bad")));
    expect(controller.signal.aborted).toBe(true);
    expect(r.verdict).toMatchObject({ state: "refused", detail: "no-structured-output" });
    expect(records()).toHaveLength(1);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ prompt_tokens: 10, completion_tokens: 5 });
  });
});

posix("concurrent Flux usage capture", () => {
  it("each turn reports only its own sum to its own sink", async () => {
    const otherOut = join(base, "other.jsonl");
    const a: MemoryUsageReport[] = [], b: MemoryUsageReport[] = [];
    const [miss, valid] = await Promise.all([
      captureMemoryUsage(u => a.push(u), () => headlessTextOnlyTurn(input(), cfg("text-bad"))),
      captureMemoryUsage(u => b.push(u), () => headlessTextOnlyTurn(input({ context: { botId: "other", runId: "run2", family: "lived", attempt: 1 } }),
        cfg("text-result", { cliPrefixArgs: [STUB, "--stub=text-result", `--stub-out=${otherOut}`] }))),
    ]);
    expect(miss.verdict).toMatchObject({ state: "refused", detail: "no-structured-output" });
    expect(valid.verdict.state).toBe("validated");
    expect(records()).toHaveLength(2);
    expect(readFileSync(otherOut, "utf8").trim().split("\n")).toHaveLength(1);
    expect(a).toHaveLength(1); expect(b).toHaveLength(1);
    expect(a[0]).toMatchObject({ prompt_tokens: 20, completion_tokens: 10 });
    expect(b[0]).toMatchObject({ prompt_tokens: 10, completion_tokens: 5 });
  });
});
