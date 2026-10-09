// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// PIP P2 B2: transport pieces that need no process (parser, per-run gate, miss
// map, schema subset, fingerprint, route binding over homeRoot, temp root).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ALLOWED_HOME_NEW, assertSupportedSchema, listFiles, unsupportedSchemaKeyword,
  binaryIdentity, preflightRoute, bindReflectionRoute, buildReflectionEnv, buildIsolationReport, createTempRoot, emptyMissHistory, gateRun, httpVerdict, isReportedOverLimit,
  parseHeadlessMessages, recordMiss, removeTempRoot, routeFingerprint, settleOutputTokens, validateAgainstSchema, type GateObservation,
} from "./pip-transport.ts";
import { applyProviderRoute, type ProviderTurnRoute } from "../provider-routing.ts";

vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), execFile: vi.fn((...args: unknown[]) => { (args.at(-1) as (error: null, stdout: string) => void)(null, "fixture-version"); return {}; }) }));

const SCHEMA = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } }, additionalProperties: false };
const route: ProviderTurnRoute = { connectionId: "conn-a", preset: "openai", protocol: "openai", baseUrl: "http://127.0.0.1:49999/v1", apiKey: "route-key-1", model: "route-model", revision: "r1" };
const line = (o: unknown) => JSON.stringify(o);
const INIT = line({ type: "system", subtype: "init", tools: [], mcp_servers: [] });
const RESULT = line({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 }, structured_output: { ok: true } });
const obs = (stdout: string, over: Partial<GateObservation> = {}): GateObservation =>
  ({ parsed: parseHeadlessMessages(stdout), homeNewFiles: [], cwdNewFiles: [], exited: true, outputSchema: SCHEMA, ...over });

let base: string;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), "pip-b2-t-")); });
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("parseHeadlessMessages", () => {
  it("reads one init line and one result line", () => {
    const p = parseHeadlessMessages(`${INIT}\n${RESULT}\n`);
    expect(p).toMatchObject({ initCount: 1, resultCount: 1, tools: [], mcpServers: [], toolCallLines: 0 });
    expect(p.result).toMatchObject({ subtype: "success", isError: false, usage: { inputTokens: 3, outputTokens: 2 }, structuredOutput: { ok: true } });
  });
  it("never treats a missing or non-array field as empty", () => {
    expect(parseHeadlessMessages(line({ type: "system", subtype: "init", tools: [] })).mcpServers).toBeNull();
    expect(parseHeadlessMessages(line({ type: "system", subtype: "init", tools: "x", mcp_servers: [] })).tools).toBeNull();
    expect(gateRun(obs(line({ type: "system", subtype: "init", tools: [] }) + "\n" + RESULT))).toMatchObject({ state: "refused", detail: "no-init-line" });
  });
  it("counts tool-call lines and tolerates malformed lines", () => {
    const p = parseHeadlessMessages(`${INIT}\nnot json\n${line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } })}\n${RESULT}`);
    expect(p.toolCallLines).toBe(1); expect(p.malformed).toBe(1);
  });
});

describe("per-run gate and the A.6 miss map", () => {
  it("validated only with exit confirmed and a schema-valid body", () => {
    expect(gateRun(obs(`${INIT}\n${RESULT}`))).toEqual({ state: "validated", structured: { ok: true } });
    expect(gateRun(obs(`${INIT}\n${RESULT}`, { exited: false }))).toMatchObject({ state: "uncertain-transport" });
  });
  it("falls back to the result text parsed as JSON for Claude only; Fuigo and Grok must send structured_output (A.1)", () => {
    const r = line({ type: "result", subtype: "success", is_error: false, result: '{"ok":false}' });
    expect(gateRun(obs(`${INIT}\n${r}`, { engine: "claude" }))).toEqual({ state: "validated", structured: { ok: false } });
    for (const engine of ["fuigo", "grok"] as const) expect(gateRun(obs(`${INIT}\n${r}`, { engine }))).toMatchObject({ state: "refused", detail: "no-structured-output" });
    expect(gateRun(obs(`${INIT}\n${r}`))).toMatchObject({ state: "refused", detail: "no-structured-output" });
  });
  describe("Claude StructuredOutput answer tool (CLI 2.1.293 under --json-schema)", () => {
    const SO_INIT = line({ type: "system", subtype: "init", tools: ["StructuredOutput"], mcp_servers: [] });
    const soUse = (id: string, input: unknown = { ok: true }) => line({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "StructuredOutput", input }] } });
    const soRes = (id: string) => line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "Structured output provided successfully" }] } });
    const run = (...lines: string[]) => lines.join("\n");
    const claude = (stdout: string, over: Partial<GateObservation> = {}) => obs(stdout, { engine: "claude", structuredTool: true, ...over });
    it("accepts init [StructuredOutput], one call, its result, and result.structured_output", () => {
      expect(gateRun(claude(run(SO_INIT, soUse("t1"), soRes("t1"), RESULT)))).toEqual({ state: "validated", structured: { ok: true } });
    });
    it("falls back to the single call's input when the result has no structured_output", () => {
      const bare = line({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn" });
      expect(gateRun(claude(run(SO_INIT, soUse("t1", { ok: false }), soRes("t1"), bare)))).toEqual({ state: "validated", structured: { ok: false } });
    });
    it("prefers structured_output over the call input", () => {
      expect(gateRun(claude(run(SO_INIT, soUse("t1", { ok: false }), soRes("t1"), RESULT)))).toEqual({ state: "validated", structured: { ok: true } });
    });
    it("reports the synthetic tool as no tool in the isolation report", () => {
      expect(buildIsolationReport(claude(run(SO_INIT, RESULT))).tools).toEqual([]);
    });
    it("refuses StructuredOutput plus any other tool in the init list", () => {
      const init = line({ type: "system", subtype: "init", tools: ["StructuredOutput", "Bash"], mcp_servers: [] });
      expect(gateRun(claude(run(init, soUse("t1"), soRes("t1"), RESULT)))).toMatchObject({ state: "unsupported", reason: "tools" });
    });
    it("refuses another tool call next to StructuredOutput, in the same message or a separate one", () => {
      const mixed = line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "StructuredOutput", input: { ok: true } }, { type: "tool_use", id: "t2", name: "Read", input: {} }] } });
      expect(gateRun(claude(run(SO_INIT, mixed, soRes("t1"), RESULT)))).toMatchObject({ state: "unsupported", reason: "tools" });
      const other = line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Read", input: {} }] } });
      expect(gateRun(claude(run(SO_INIT, other, soUse("t1"), soRes("t1"), RESULT)))).toMatchObject({ state: "unsupported", reason: "tools" });
    });
    it("refuses a tool_result that answers no StructuredOutput call", () => {
      expect(gateRun(claude(run(SO_INIT, soRes("zz"), soUse("t1"), soRes("t1"), RESULT)))).toMatchObject({ state: "unsupported", reason: "tools" });
    });
    it("refuses two StructuredOutput calls", () => {
      expect(gateRun(claude(run(SO_INIT, soUse("t1"), soRes("t1"), soUse("t2"), soRes("t2"), RESULT)))).toMatchObject({ state: "unsupported", reason: "tools", detail: "multiple-structured-output" });
    });
    it("refuses any MCP server alongside it", () => {
      const init = line({ type: "system", subtype: "init", tools: ["StructuredOutput"], mcp_servers: [{ name: "x" }] });
      expect(gateRun(claude(run(init, soUse("t1"), soRes("t1"), RESULT)))).toMatchObject({ state: "unsupported", reason: "managed-config" });
    });
    it("is not admitted without the schema flag or for other engines", () => {
      const stdout = run(SO_INIT, soUse("t1"), soRes("t1"), RESULT);
      expect(gateRun(obs(stdout, { engine: "claude" }))).toMatchObject({ state: "unsupported", reason: "tools" });
      for (const engine of ["fuigo", "grok"] as const) expect(gateRun(obs(stdout, { engine, structuredTool: true }))).toMatchObject({ state: "unsupported", reason: "tools" });
    });
    it("still accepts an older CLI: empty tools list and a JSON text result", () => {
      const r = line({ type: "result", subtype: "success", is_error: false, result: '{"ok":true}' });
      expect(gateRun(claude(run(INIT, r)))).toEqual({ state: "validated", structured: { ok: true } });
    });
  });
  it("maps each miss to exactly one state", () => {
    const tools = line({ type: "system", subtype: "init", tools: ["Read"], mcp_servers: [] });
    const mcp = line({ type: "system", subtype: "init", tools: [], mcp_servers: ["x"] });
    expect(gateRun(obs(`${tools}\n${RESULT}`))).toMatchObject({ state: "unsupported", reason: "tools" });
    expect(gateRun(obs(`${mcp}\n${RESULT}`))).toMatchObject({ state: "unsupported", reason: "managed-config" });
    const cwd = obs(`${INIT}\n${RESULT}`, { cwdNewFiles: ["CLAUDE.md"] });
    const v1 = gateRun(cwd);
    expect(v1).toMatchObject({ state: "refused", reason: "isolation", counted: true });
    expect(gateRun({ ...cwd, history: recordMiss(emptyMissHistory(), v1) })).toMatchObject({ state: "unsupported", reason: "managed-config" });
    expect(gateRun(obs(`${INIT}\n${RESULT}`, { homeNewFiles: ["sessions/a.json", "config.toml"] })).state).toBe("validated");
    expect(gateRun(obs(`${INIT}\n${RESULT}`, { homeNewFiles: ["hooks/x.sh"] }))).toMatchObject({ state: "refused", reason: "isolation" });
    expect(gateRun(obs(`${INIT}\n${RESULT}`, { overBytes: true }))).toMatchObject({ state: "refused", reason: "bad-output" });
    expect(gateRun(obs(INIT))).toMatchObject({ state: "refused", reason: "bad-output", detail: "no-result-line" });
    const stop = line({ type: "result", subtype: "success", is_error: false, stop_reason: "cancelled", structured_output: { ok: true } });
    expect(gateRun(obs(`${INIT}\n${stop}`))).toMatchObject({ state: "refused", reason: "bad-output" });
  });
  it("max-turns and structured-output retry errors are bad-output", () => {
    for (const subtype of ["error_max_turns", "error_max_structured_output_retries", "error_during_execution"]) {
      const r = line({ type: "result", subtype, is_error: true, errors: [] });
      expect(gateRun(obs(`${INIT}\n${r}`))).toMatchObject({ state: "refused", reason: "bad-output" });
    }
  });
  it("a third no-init-line refusal on one fingerprint becomes unsupported transport", () => {
    let h = emptyMissHistory();
    for (let i = 0; i < 2; i++) { const v = gateRun(obs(RESULT, { history: h })); expect(v).toMatchObject({ state: "refused", detail: "no-init-line" }); h = recordMiss(h, v); }
    expect(gateRun(obs(RESULT, { history: h }))).toMatchObject({ state: "unsupported", reason: "transport" });
  });
});

describe("schema subset and accounting", () => {
  it("validates types, required, additionalProperties, items, enum", () => {
    expect(validateAgainstSchema({ ok: true }, SCHEMA)).toBeNull();
    expect(validateAgainstSchema({}, SCHEMA)).toMatch(/required/);
    expect(validateAgainstSchema({ ok: 1 }, SCHEMA)).toMatch(/type/);
    expect(validateAgainstSchema({ ok: true, x: 1 }, SCHEMA)).toMatch(/additionalProperties/);
    expect(validateAgainstSchema([1, "a"], { type: "array", items: { type: "number" } })).toMatch(/\[1\]/);
    expect(validateAgainstSchema("c", { enum: ["a", "b"] })).toMatch(/enum/);
  });
  it("a schema keyword the host cannot check is refused up front, never silently skipped (audit 13)", () => {
    expect(unsupportedSchemaKeyword(SCHEMA)).toBeNull();
    for (const keyword of [{ $ref: "#/x" }, { format: "email" }, { patternProperties: {} }, { multipleOf: 2 }, { uniqueItems: true }, { if: {} }, { propertyNames: {} }, { contains: {} }]) {
      expect(unsupportedSchemaKeyword({ type: "object", properties: { a: { type: "string", ...keyword } } }), JSON.stringify(keyword)).toMatch(/properties|\$\.a/);
      expect(() => assertSupportedSchema({ type: "string", ...keyword })).toThrow("PIP_SCHEMA_UNSUPPORTED");
    }
    expect(unsupportedSchemaKeyword({ type: "array", items: { $ref: "#" } })).toBe("$[]: $ref");
    expect(() => assertSupportedSchema({ type: "string", title: "T", description: "annotation only" })).not.toThrow();
    // the validator itself refuses to pass a schema it cannot enforce
    expect(validateAgainstSchema("x", { type: "string", format: "email" })).toMatch(/^unsupported:/);
  });
  it("enforces pattern, allOf and not; required and properties use own properties only (audit 13)", () => {
    expect(validateAgainstSchema("abc", { type: "string", pattern: "^a" })).toBeNull();
    expect(validateAgainstSchema("xbc", { type: "string", pattern: "^a" })).toMatch(/pattern/);
    expect(validateAgainstSchema(5, { allOf: [{ type: "number" }, { minimum: 10 }] })).toMatch(/minimum/);
    expect(validateAgainstSchema(5, { not: { type: "number" } })).toMatch(/not/);
    expect(validateAgainstSchema("s", { not: { type: "number" } })).toBeNull();
    expect(validateAgainstSchema({}, { type: "object", required: ["toString"] })).toMatch(/toString: required/);
    expect(validateAgainstSchema({ ok: true }, { type: "object", properties: { constructor: { type: "string" } }, additionalProperties: false })).toMatch(/additionalProperties/);
    expect(validateAgainstSchema({ constructor: "x" }, { type: "object", properties: { constructor: { type: "string" } }, additionalProperties: false })).toBeNull();
    // an inherited key name in the data is not a declared property
    expect(validateAgainstSchema(JSON.parse('{"__proto__":1,"ok":true}'), SCHEMA)).toMatch(/additionalProperties/);
  });
  it("settles at reported usage, else the 3.5 byte estimate, and flags reported over the limit", () => {
    expect(settleOutputTokens(120, 9999)).toBe(120);
    expect(settleOutputTokens(undefined, 350)).toBe(100);
    expect(isReportedOverLimit(2500, 2000)).toBe(true);
    expect(isReportedOverLimit(undefined, 2000)).toBe(false);
  });
  it("socket verdict: length, over cap, not json, schema", () => {
    const o = { finishReason: "stop", content: '{"ok":true}', outputSchema: SCHEMA, maxOutputBytes: 12288, exited: true };
    expect(httpVerdict(o).state).toBe("validated");
    expect(httpVerdict({ ...o, finishReason: "length" })).toMatchObject({ reason: "bad-output", detail: "truncated" });
    expect(httpVerdict({ ...o, maxOutputBytes: 5 })).toMatchObject({ detail: "over-byte-cap" });
    expect(httpVerdict({ ...o, content: "nope" })).toMatchObject({ detail: "not-json" });
    expect(httpVerdict({ ...o, content: '{"ok":3}' })).toMatchObject({ reason: "bad-output" });
    expect(httpVerdict({ ...o, exited: false }).state).toBe("uncertain-transport");
  });
});

describe("gate evidence (audit 7)", () => {
  const bad = (o: unknown) => line(o);
  it("every tool-shaped event is a tool call, including server_tool_use and tool_calls lists", () => {
    for (const event of [
      { type: "assistant", message: { content: [{ type: "server_tool_use", name: "web_search" }] } },
      { type: "assistant", message: { content: [{ type: "mcp_tool_use" }] } },
      { type: "assistant", message: { content: [{ type: "web_search_tool_result" }] } },
      { type: "server_tool_use" }, { type: "assistant", message: { tool_calls: [{ id: "1" }] } }, { type: "assistant", function_call: { name: "x" } },
    ]) expect(gateRun(obs(`${INIT}\n${bad(event)}\n${RESULT}`)), JSON.stringify(event)).toMatchObject({ state: "unsupported", reason: "tools" });
  });
  it("a malformed line refuses the run; so do a result before init and a missing or mistyped is_error", () => {
    expect(gateRun(obs(`${INIT}\nnot json\n${RESULT}`))).toMatchObject({ state: "refused", detail: "malformed-output" });
    expect(gateRun(obs(`${RESULT}\n${INIT}`))).toMatchObject({ state: "refused", detail: "result-before-init" });
    const missing = line({ type: "result", subtype: "success", structured_output: { ok: true } });
    const mistyped = line({ type: "result", subtype: "success", is_error: "false", structured_output: { ok: true } });
    expect(gateRun(obs(`${INIT}\n${missing}`))).toMatchObject({ state: "refused", detail: "invalid-is-error" });
    expect(gateRun(obs(`${INIT}\n${mistyped}`))).toMatchObject({ state: "refused", detail: "invalid-is-error" });
    expect(parseHeadlessMessages(`${INIT}\n${RESULT}`)).toMatchObject({ initSeq: 0, resultSeq: 1 });
  });
  it("new files under the temp root itself (HOME) are inventoried; only debug.log is admitted there", () => {
    const allowed = obs(`${INIT}\n${RESULT}`, { rootNewFiles: ["debug.log"] });
    expect(gateRun(allowed).state).toBe("validated");
    expect(buildIsolationReport(allowed)).toEqual({ mcpServers: [], tools: [], homeNewFiles: ["<root>/debug.log"], cwdNewFiles: [], stopReason: "end_turn", exited: true, initLine: true });
    const v = gateRun(obs(`${INIT}\n${RESULT}`, { rootNewFiles: [".config/x.json"] }));
    expect(v).toMatchObject({ state: "refused", reason: "isolation", missKey: "root:.config/x.json" });
    expect(gateRun(obs(`${INIT}\n${RESULT}`, { rootNewFiles: [".config/x.json"], history: recordMiss(emptyMissHistory(), v) }))).toMatchObject({ state: "unsupported", reason: "managed-config" });
  });
  it("the Fuigo and Grok start-up artifacts are admitted by exact shape, nothing wider", () => {
    const ok = ["docs/user-guide/01-intro.md", "active_sessions.json", "active_sessions.lock", "active_sessions.json.tmp", "sessions/a.json", "logs/x.log", "config.toml", "auth.json"];
    for (const f of ok) expect(DEFAULT_ALLOWED_HOME_NEW.some((re) => re.test(f)), f).toBe(true);
    for (const f of ["docs/other.md", "docs/user-guide/sub/x.md", "docs/user-guide/x.sh", "active_sessions.bak", "hooks/x.sh", "AGENTS.md"]) expect(DEFAULT_ALLOWED_HOME_NEW.some((re) => re.test(f)), f).toBe(false);
  });
  it("an unreadable directory is an inspection failure, never an empty inventory; a missing one is empty", () => {
    expect(listFiles(join(base, "does-not-exist"))).toEqual([]);
    writeFileSync(join(base, "afile"), "x");
    expect(() => listFiles(join(base, "afile"))).toThrow("PIP_INVENTORY");
    mkdirSync(join(base, "root", "home"), { recursive: true }); mkdirSync(join(base, "root", "work")); writeFileSync(join(base, "root", "stray"), "x"); writeFileSync(join(base, "root", "home", "inside"), "x");
    expect(listFiles(join(base, "root"), ["home", "work"])).toEqual(["stray"]);
  });
});

describe("fingerprint and identity", () => {
  const inputs = { instanceId: "i", model: "m", connectionId: "c", connectionRevision: "r1", adapterKind: "fuigoAgent", binaryIdentity: "b", managedConfigIdentity: "x" };
  it("changes with any input", () => {
    const base0 = routeFingerprint(inputs);
    for (const patch of [{ model: "m2" }, { connectionRevision: "r2" }, { binaryIdentity: "b2" }, { managedConfigIdentity: "y" }, { connectionId: null }])
      expect(routeFingerprint({ ...inputs, ...patch })).not.toBe(base0);
    expect(routeFingerprint(inputs)).toBe(base0);
  });
  it("binaryIdentity folds in size, mtime and the version output", async () => {
    const a = await binaryIdentity("/x/bin", { stat: () => ({ size: 1, mtimeMs: 2 }), version: async () => "v1" });
    expect(await binaryIdentity("/x/bin", { stat: () => ({ size: 1, mtimeMs: 2 }), version: async () => "v1" })).toBe(a);
    expect(await binaryIdentity("/x/bin", { stat: () => ({ size: 1, mtimeMs: 3 }), version: async () => "v1" })).not.toBe(a);
    expect(await binaryIdentity("/x/bin", { stat: () => ({ size: 1, mtimeMs: 2 }), version: async () => "v2" })).not.toBe(a);
  });
});

describe("temp root and route binding", () => {
  it("creates a private root with work/, home/ and a per-attempt prompt file, and removes only inside the base", () => {
    const tmp = join(base, "pip-tmp");
    const t = createTempRoot(tmp, "run9", 2, "PROMPT");
    expect(readFileSync(t.promptFile, "utf8")).toBe("PROMPT");
    expect(t.root).toContain("run9-2-");
    if (process.platform !== "win32") expect(statSync(t.root).mode & 0o077).toBe(0);
    expect(createTempRoot(tmp, "run9", 2, "x").root).not.toBe(t.root);
    expect(removeTempRoot(tmp, base)).toBe(false);
    expect(removeTempRoot(tmp, tmp)).toBe(false);
    expect(removeTempRoot(tmp, t.root)).toBe(true);
    expect(existsSync(t.root)).toBe(false);
  });
  it("applyProviderRoute honours homeRoot for Fuigo and Grok without creating retained homes", () => {
    const t = createTempRoot(join(base, "pip-tmp"), "run1", 1, "p");
    const fuigoEnv: NodeJS.ProcessEnv = {};
    const fuigo = applyProviderRoute("fuigoAgent", fuigoEnv, route, { threadId: "run1", homeRoot: t.home });
    expect(fuigoEnv.FUIGO_HOME).toBe(t.home);
    expect(fuigo.model).toBe("murage_selected");
    expect(readFileSync(join(t.home, "config.toml"), "utf8")).toContain("use_leader = false");
    fuigo.cleanup(); expect(existsSync(t.home)).toBe(true); // the temp root lifecycle owns removal
    const g = createTempRoot(join(base, "pip-tmp"), "run2", 1, "p");
    const grokEnv: NodeJS.ProcessEnv = {};
    const grok = applyProviderRoute("grokAgent", grokEnv, route, { threadId: "run2", homeRoot: g.home });
    expect(grokEnv.GROK_HOME).toBe(g.home);
    expect(grok.model).toMatch(/^murage_/);
    expect(readFileSync(join(g.home, "config.toml"), "utf8")).toContain(`[model.${grok.model}]`);
    expect(grokEnv.MURAGE_GROK_PROVIDER_API_KEY).toBe("route-key-1");
  });
  it("bindReflectionRoute returns only what the binding set, and the allowlist adds PATH, HOME and the off switches", () => {
    const t = createTempRoot(join(base, "pip-tmp"), "run3", 1, "p");
    const b = bindReflectionRoute({ driver: "fuigoAgent", temp: t, model: "m", runId: "run3", providerRoute: route });
    if (!b.ok) throw new Error("expected binding");
    expect(Object.keys(b.env).sort()).toEqual(["FUIGO_API_BASE_URL", "FUIGO_HOME", "FUIGO_MODELS_BASE_URL", "MURAGE_PROVIDER_API_KEY"]);
    const env = buildReflectionEnv("fuigo", "/usr/bin", t.home, t.root, b.env);
    expect(env.HOME).toBe(t.root); expect(env.PATH).toBe("/usr/bin"); expect(env.FUIGO_TELEMETRY_ENABLED).toBe("0");
    expect(Object.keys(env)).not.toContain("OPENAI_API_KEY");
    const login = bindReflectionRoute({ driver: "fuigoAgent", temp: t, model: "m", runId: "run3" });
    expect(login).toMatchObject({ ok: false, verdict: { reason: "login-route" } });
    mkdirSync(join(base, "pgrok"));
    expect(bindReflectionRoute({ driver: "grokAgent", temp: t, model: "m", runId: "run3", parentGrokHome: join(base, "pgrok") })).toMatchObject({ ok: false, verdict: { reason: "auth" } });
    writeFileSync(join(base, "pgrok", "auth.json"), "{}");
    expect(bindReflectionRoute({ driver: "grokAgent", temp: t, model: "m", runId: "run3", parentGrokHome: join(base, "pgrok") })).toMatchObject({ ok: true });
    expect(existsSync(join(t.home, "auth.json"))).toBe(true);
  });
});

describe("I-24 copy", () => {
  it("transport copy strings carry no em dash and avoid the banned words", async () => {
    const { HELD_PLUGIN_COPY, LOGIN_ROUTE_COPY } = await import("./pip-transport.ts");
    for (const s of [HELD_PLUGIN_COPY, LOGIN_ROUTE_COPY]) { expect(s).not.toMatch(/—/); expect(s).not.toMatch(/\b(safe|safety|unsafe)\b/i); }
  });
});


describe("Astra audit2 preflight and identity", () => {
  it("1: an MDM directory inspection error holds the route", () => {
    const loop = join(base, "mdm-loop"); symlinkSync(loop, loop);
    expect(preflightRoute("fuigo", { platform: "linux", home: base, etcRoot: base, mdmDir: loop, claudeManagedPath: join(base, "absent"), readMdm: () => "absent" })).toMatchObject({ ok: false, verdict: { detail: "inspection-failed: managed preferences" } });
  });
  it("21: fingerprints executable bytes without launching a version process", async () => {
    const path = join(base, "engine"); writeFileSync(path, "first executable bytes");
    vi.mocked(execFile).mockClear();
    const first = await binaryIdentity(path);
    expect(execFile).not.toHaveBeenCalled();
    writeFileSync(path, "other executable bytes");
    expect(await binaryIdentity(path)).not.toBe(first);
  });
});
