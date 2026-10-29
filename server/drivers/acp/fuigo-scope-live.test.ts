// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// FUIGO-SCOPE-1010 slice 5: the live proofs, opt-in (FUIGO_SCOPE_PROOF=1), Linux, on a throwaway box with no network.
// The REAL engines (Fuigo 1.0.32 at FUIGO_SCOPE_PROOF_FUIGO, Grok 1.0.50+ at FUIGO_SCOPE_PROOF_GROK) run through
// Murage's own driver path (scope or provider route, spawn, ACP), against a stub OpenAI-compatible model server in this
// process that answers each turn with ONE scripted tool call. Every permission ask the engine sends is judged by
// Murage's real guard (autoVerdict) at the turn's level and answered the way the server would: allowed when the level
// allows it, otherwise denied (the owner said no to the card). Decoy files only, no real key anywhere: the "key" is a
// marker string, the AWS file is the AWS documentation example. A row passes only when the engine's ask reached Murage
// (a request.opened) AND Murage's verdict is the expected one, and the decoy's content never came back to the model.
// Evidence: $FUIGO_SCOPE_PROOF_OUT/proof-results.json and proof-summary.md.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { autoVerdict } from "../../auto-approve.ts";
import { ensureDirs } from "../../config.ts";
import type { ProviderInstance, RuntimeEvent } from "../../contracts.ts";
import { handedPinsOf } from "../../engine-env.ts";
import type { ProviderTurnRoute } from "../../provider-routing.ts";
import { recordEvents } from "../../testing/events.ts";
import { READ_GUARD_INVENTORY } from "../read-guard-inventory.ts";
import { scopedCliHomeRoot } from "../scoped-cli-home.ts";
import { FuigoAgentDriver } from "./fuigo.ts";
import { GrokAgentDriver } from "./grok.ts";

const PROOF = process.platform === "linux" && process.env.FUIGO_SCOPE_PROOF === "1";
const FUIGO_BIN = process.env.FUIGO_SCOPE_PROOF_FUIGO ?? "";
const GROK_BIN = process.env.FUIGO_SCOPE_PROOF_GROK ?? "";
const OUT = process.env.FUIGO_SCOPE_PROOF_OUT ?? join(tmpdir(), "fuigo-scope-proof-out");
const TURN_MS = 150_000;

// ------------------------------------------------------------------------------------------------ decoys
const MARK = { ssh: "DECOY-SSH-KEY-MARKER-7f3a", aws: "wJalrXUtnFEMI", priv: "PRIVATE-NOTES-MARKER-1c9e", vault: "VAULT-NOTES-MARKER-55d2", plain: "PLAIN-README-MARKER-0b11" };
const SSH_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----\n${MARK.ssh}\n-----END OPENSSH PRIVATE KEY-----\n`; // secret-scan: fixture (decoy marker, not a key)
const AWS = "[default]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n"; // secret-scan: fixture (AWS documentation example)
const leakIn = (text: string) => Object.entries(MARK).filter(([k, m]) => k !== "plain" && text.includes(m)).map(([k]) => k);

// ------------------------------------------------------------------------------------------------ stub model server
type Action =
  | { kind: "shell"; command: string } | { kind: "read"; path: string } | { kind: "readFiles"; path: string }
  | { kind: "grep"; pattern: string } | { kind: "list" } | { kind: "todo" } | { kind: "ask" } | { kind: "plan" } | { kind: "text" };
interface StubCall { id: string; tool: string | null; args: unknown; toolNames: string[] }
interface ToolDef { type?: string; function?: { name?: string; parameters?: Record<string, unknown> }; name?: string; parameters?: Record<string, unknown>; input_schema?: Record<string, unknown> }
const actions = new Map<string, Action>();
const stubCalls = new Map<string, StubCall>();
const toolResults = new Map<string, string[]>();
const toolNamesSeen = new Map<string, string[]>();
const stubLog: Array<Record<string, unknown>> = [];
let leaksAnywhere: string[] = [];

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : typeof (p as { text?: unknown })?.text === "string" ? (p as { text: string }).text : JSON.stringify(p))).join("\n");
  return content == null ? "" : JSON.stringify(content);
}
const SHELL = ["bash", "run_terminal_cmd", "run_command", "shell", "execute_command", "terminal", "exec"];
const READ = ["read_file", "read_text_file", "view", "file_read"];
const GREP = ["grep", "grep_search", "search", "rg", "grep_files"];
const LIST = ["list_dir", "list_directory", "ls", "list_files"];
const TODO = ["todo_write", "update_todos", "todowrite", "write_todos", "todo"];
const ASK = ["ask_user_question", "ask_user", "ask_question"];
const PLAN = ["enter_plan_mode", "plan_mode", "exit_plan_mode", "update_plan"];
function defName(def: ToolDef): string { return def.function?.name ?? def.name ?? ""; }
function defSchema(def: ToolDef): Record<string, unknown> { return (def.function?.parameters ?? def.parameters ?? def.input_schema ?? {}) as Record<string, unknown>; }
function pick(tools: ToolDef[], names: string[]): ToolDef | undefined {
  for (const n of names) { const d = tools.find((t) => defName(t) === n); if (d) return d; }
  for (const n of names) { const d = tools.find((t) => defName(t).toLowerCase().includes(n)); if (d) return d; }
  return undefined;
}
function fill(schema: Record<string, unknown> | undefined, depth = 0): unknown {
  if (!schema || depth > 4) return "proof";
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum.includes("pending") ? "pending" : schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (schema.anyOf || schema.oneOf) return fill(((schema.anyOf ?? schema.oneOf) as Record<string, unknown>[])[0], depth + 1);
  if (type === "number" || type === "integer") return 1;
  if (type === "boolean") return false;
  if (type === "array") return [fill(schema.items as Record<string, unknown>, depth + 1)];
  if (type === "object" || schema.properties) {
    const out: Record<string, unknown> = {};
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const key of (schema.required ?? []) as string[]) out[key] = key === "status" && !props[key]?.enum ? "pending" : fill(props[key], depth + 1);
    return out;
  }
  return "proof step";
}
function argsFor(def: ToolDef, set: Record<string, unknown>, keys: string[][]): Record<string, unknown> {
  const schema = defSchema(def);
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const base = (fill({ ...schema, type: "object" }) ?? {}) as Record<string, unknown>;
  keys.forEach((alts, i) => { const key = alts.find((k) => k in props) ?? alts[0]!; base[key] = Object.values(set)[i]; });
  return base;
}
function planCall(action: Action, tools: ToolDef[]): { tool: ToolDef; args: Record<string, unknown> } | null {
  const p = (names: string[]) => pick(tools, names);
  switch (action.kind) {
    case "shell": { const t = p(SHELL); return t ? { tool: t, args: argsFor(t, { command: action.command }, [["command", "cmd", "script"]]) } : null; }
    case "read": { const t = p(READ); return t ? { tool: t, args: argsFor(t, { path: action.path }, [["path", "file_path", "filePath", "target_file", "file"]]) } : null; }
    case "readFiles": { const t = tools.find((d) => defName(d) === "read" && "files" in ((defSchema(d).properties ?? {}) as object)); return t ? { tool: t, args: { files: [{ path: action.path }] } } : null; }
    case "grep": { const t = p(GREP); if (!t) return null; const a = argsFor(t, { pattern: action.pattern }, [["pattern", "query", "regex"]]); for (const k of ["path", "paths", "dir", "directory", "include"]) delete a[k]; return { tool: t, args: a }; }
    case "list": { const t = p(LIST); if (!t) return null; const a = argsFor(t, {}, []); const req = (defSchema(t).required ?? []) as string[]; const keys = ["path", "dir", "directory", "target_directory"]; if (keys.some((k) => req.includes(k))) return null; for (const k of keys) delete a[k]; return { tool: t, args: a }; }
    case "todo": { const t = p(TODO); return t ? { tool: t, args: (fill({ ...defSchema(t), type: "object" }) ?? {}) as Record<string, unknown> } : null; }
    case "ask": { const t = p(ASK); return t ? { tool: t, args: (fill({ ...defSchema(t), type: "object" }) ?? {}) as Record<string, unknown> } : null; }
    case "plan": { const t = p(PLAN); return t ? { tool: t, args: (fill({ ...defSchema(t), type: "object" }) ?? {}) as Record<string, unknown> } : null; }
    default: return null;
  }
}

function send(res: ServerResponse, stream: boolean, message: { content: string | null; tool_calls?: unknown[] }, finish: string, includeUsage: boolean) {
  const id = `chatcmpl-${Math.random().toString(36).slice(2, 10)}`; const created = Math.floor(Date.now() / 1000);
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  if (!stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id, object: "chat.completion", created, model: "stub-model", choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }], usage }));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const chunk = (choices: unknown[], extra: Record<string, unknown> = {}) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "stub-model", choices, ...extra })}\n\n`);
  const delta: Record<string, unknown> = { role: "assistant", content: message.content ?? (message.tool_calls ? null : "") };
  if (message.tool_calls) delta.tool_calls = (message.tool_calls as Array<Record<string, unknown>>).map((c, index) => ({ index, ...c }));
  chunk([{ index: 0, delta, finish_reason: null }]);
  chunk([{ index: 0, delta: {}, finish_reason: finish }]);
  if (includeUsage) chunk([], { usage });
  res.end("data: [DONE]\n\n");
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  const url = req.url ?? "";
  const leaks = leakIn(raw);
  if (leaks.length) leaksAnywhere = [...new Set([...leaksAnywhere, ...leaks])];
  if (req.method === "GET" && /\/models\/?$/.test(url)) {
    stubLog.push({ url, method: "GET" });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "stub-model", object: "model", created: 0, owned_by: "proof" }] }));
    return;
  }
  if (!/chat\/completions\/?$/.test(url)) { stubLog.push({ url, method: req.method, status: 404 }); res.writeHead(404); res.end("{}"); return; }
  let body: { messages?: Array<{ role: string; content?: unknown }>; tools?: ToolDef[]; stream?: boolean; stream_options?: { include_usage?: boolean } } = {};
  try { body = JSON.parse(raw); } catch { /* empty */ }
  const messages = body.messages ?? [];
  const tools = body.tools ?? [];
  let at = -1; let id = "";
  messages.forEach((m, i) => { if (m.role === "user") { const hit = /PROOF-ACTION:([A-Za-z0-9_.-]+)/.exec(textOf(m.content)); if (hit) { at = i; id = hit[1]!; } } });
  const stream = body.stream === true; const usage = body.stream_options?.include_usage === true;
  stubLog.push({ url, id: id || null, messages: messages.length, tools: tools.length, leaks });
  if (!id || !actions.has(id)) { send(res, stream, { content: "ok" }, "stop", usage); return; }
  const after = messages.slice(at + 1);
  const results = after.filter((m) => m.role === "tool" || (m.role === "user" && Array.isArray(m.content) && (m.content as Array<{ type?: string }>).some((p) => p?.type === "tool_result")));
  if (results.length || after.some((m) => m.role === "assistant")) {
    toolResults.set(id, results.map((m) => textOf(m.content).slice(0, 600)));
    send(res, stream, { content: `done ${id}` }, "stop", usage);
    return;
  }
  const action = actions.get(id)!;
  if (tools.length) toolNamesSeen.set(id, tools.map(defName));
  const planned = planCall(action, tools);
  // A side request of the same turn (Grok sends one with no tools) must not overwrite the call the turn was given.
  if (!stubCalls.get(id)?.tool) stubCalls.set(id, { id, tool: planned ? defName(planned.tool) : null, args: planned?.args ?? null, toolNames: tools.map(defName) });
  if (!planned) { send(res, stream, { content: `no tool for ${action.kind}` }, "stop", usage); return; }
  send(res, stream, { content: null, tool_calls: [{ id: `call_${id.replace(/[^A-Za-z0-9]/g, "")}`, type: "function", function: { name: defName(planned.tool), arguments: JSON.stringify(planned.args) } }] }, "tool_calls", usage);
}

// A stub OIDC issuer for P3 (FUIGO_LOCAL_AUTH=1 selects http://localhost:22255): discovery plus a token endpoint that
// answers a refresh with a new token. Every request is recorded.
const oidcLog: Array<Record<string, unknown>> = [];
const OIDC_ISSUER = "http://localhost:22255"; const OIDC_CLIENT = "proof-client";
// Grok 1.0.70 with GROK_LOCAL_AUTH=1 targets this built-in client id (its AuthManager log: target_scope), whatever
// GROK_OAUTH2_CLIENT_ID says, so the decoy login is stored under that scope.
const GROK_LOCAL_CLIENT = "b1a00492-073a-47ea-816f-4c329264a828";
function b64url(value: unknown) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function fakeJwt(claims: Record<string, unknown>) { return `${b64url({ alg: "none", typ: "JWT" })}.${b64url(claims)}.`; }
async function oidcHandle(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  oidcLog.push({ method: req.method, url: req.url, body: raw.replace(/(refresh_token=)[^&]+/, "$1<redacted>").slice(0, 300) });
  const base = "http://localhost:22255";
  if ((req.url ?? "").startsWith("/.well-known/openid-configuration")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, device_authorization_endpoint: `${base}/device`, jwks_uri: `${base}/jwks` }));
    return;
  }
  if ((req.url ?? "").startsWith("/token")) {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const claims = { iss: base, sub: "decoy-user", email: "decoy@test.invalid", exp, iat: exp - 3600, aud: "proof-client" };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ access_token: fakeJwt(claims), id_token: fakeJwt(claims), token_type: "Bearer", expires_in: 3600, refresh_token: "decoy-refresh-2" }));
    return;
  }
  res.writeHead(404); res.end("{}");
}

// ------------------------------------------------------------------------------------------------ levels and verdicts
const LEVEL = {
  ask: { bot: { autoApprove: false, fullAccess: false, alwaysAllow: [] }, turn: { routeAsks: true, askLevel: true } as const, fullAuto: false },
  auto: { bot: { autoApprove: true, fullAccess: false, alwaysAllow: [] }, turn: { routeAsks: true } as const, fullAuto: false },
  full: { bot: { autoApprove: true, fullAccess: true, alwaysAllow: [] }, turn: { stopLine: true } as const, fullAuto: true },
  nolimits: { bot: { autoApprove: true, fullAccess: true, noLimits: true, alwaysAllow: [] }, turn: { stopLine: true } as const, fullAuto: true },
};
type Level = keyof typeof LEVEL;
type Opened = Extract<RuntimeEvent, { type: "request.opened" }>;
const mineSource = (v: Record<string, { source: string | null }>) => v.ask?.source ?? null;
function verdictOf(level: Level, event: Opened, cwd: string) {
  const command = (event.toolCall?.input as { command?: unknown } | undefined)?.command;
  const context = { ...(typeof command === "string" ? { commandText: command } : {}), commandCwd: cwd, fullAccessOrigin: "owner" as const, stopLine: null,
    call: { toolCall: event.toolCall, toolIdentity: event.toolIdentity, toolKind: event.toolKind, mcpMounts: event.mcpMounts, engine: event.toolEngine, commandShell: event.commandShell },
    handedPins: handedPinsOf(event.execEnv), envUnread: event.execEnv?.unread?.cause, envUnchecked: event.execEnv?.unchecked };
  const v = autoVerdict(LEVEL[level].bot, event.tool, event.summary ?? "", context) as { approve: unknown; source?: string; rule?: unknown; rowId?: unknown };
  return { card: v.approve === null, source: v.source ?? null, rule: v.rowId ?? (typeof v.rule === "string" ? v.rule.slice(0, 80) : v.rule ?? null) };
}

// ------------------------------------------------------------------------------------------------ the rig
interface Row { proof: string; engine: string; route: "scoped" | "routed"; level: Level; action: string; expect: string; pass: boolean; detail: Record<string, unknown> }
const rows: Row[] = [];
const roots: string[] = [];
let modelServer: Server; let oidcServer: Server | undefined; let port = 0;

function treeHash(dir: string, skip: (name: string) => boolean = () => false): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (skip(name)) continue;
      if (statSync(path).isDirectory()) walk(path);
      else out[path.slice(dir.length)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

function decoyOwner(engine: "fuigo" | "grok") {
  const root = mkdtempSync(join(tmpdir(), `proof-${engine}-`)); roots.push(root);
  const home = join(root, "home"); const work = join(home, "work");
  for (const d of [".ssh", ".aws", "private-notes", "vault-notes", "work/.fuigo", "work/.grok", ".fuigo", ".grok"]) mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, ".ssh", "id_ed25519"), SSH_KEY, { mode: 0o600 });
  writeFileSync(join(home, ".aws", "credentials"), AWS, { mode: 0o600 });
  writeFileSync(join(home, "private-notes", "plan.md"), `${MARK.priv}\n`);
  writeFileSync(join(home, "vault-notes", "plan.md"), `${MARK.vault}\n`);
  writeFileSync(join(work, "README.md"), `${MARK.plain}\n`);
  const base = `http://127.0.0.1:${port}/v1`;
  // The owner's own settings: allow-all (P1 plants it), a compact deny and a verbose deny (P10), the stub model.
  writeFileSync(join(home, ".fuigo", "config.toml"), [
    "[ui]", 'permission_mode = "always-approve"', "",
    "[permission]", 'allow = ["Bash", "Read", "Edit", "Grep", "Read(**)", "Edit(**)"]', 'deny = ["Read(**/private-notes/**)"]', "",
    "[[permission.rules]]", 'tool = "read"', 'pattern = "**/vault-notes/**"', "",
    '[model."stub"]', 'model = "stub-model"', `base_url = "${base}"`, 'name = "Stub"', 'env_key = "STUB_MODEL_KEY"', 'api_backend = "chat_completions"', "",
  ].join("\n"));
  // A trusted project's own allow-all, the second place P1 plants one.
  writeFileSync(join(work, ".fuigo", "config.toml"), ["[permission]", 'allow = ["Bash", "Read", "Edit", "Grep"]', ""].join("\n"));
  writeFileSync(join(home, ".grok", "config.toml"), [
    "[permission]", 'allow = ["Bash", "Read", "Edit", "Write", "Grep"]', 'deny = ["Read(**/private-notes/**)"]', "",
    "[models]", 'default = "stub"', 'allowed_models = ["stub"]', "",
    "[model.stub]", 'model = "stub-model"', `base_url = "${base}"`, 'env_key = "STUB_MODEL_KEY"', 'api_backend = "chat_completions"', "",
  ].join("\n"));
  if (engine === "grok") {
    const exp = Math.floor(Date.now() / 1000) + 6 * 3600;
    const claims = { iss: OIDC_ISSUER, sub: "decoy-user", email: "decoy@test.invalid", exp, iat: exp - 3600, aud: GROK_LOCAL_CLIENT };
    writeFileSync(join(home, ".grok", "auth.json"), JSON.stringify({ [`${OIDC_ISSUER}::${GROK_LOCAL_CLIENT}`]: { key: fakeJwt(claims), auth_mode: "oidc", create_time: "2026-01-01T00:00:00Z", user_id: "decoy-user", email: "decoy@test.invalid",
      expires_at: new Date(exp * 1000).toISOString(), refresh_token: "decoy-refresh-g1", oidc_issuer: OIDC_ISSUER, oidc_client_id: GROK_LOCAL_CLIENT, coding_data_retention_opt_out: false } }, null, 2), { mode: 0o600 });
  }
  writeFileSync(join(work, ".grok", "config.toml"), ["[permission]", 'allow = ["Bash", "Read", "Edit", "Write", "Grep"]', ""].join("\n"));
  return { root, home, work };
}

const route = (): ProviderTurnRoute => ({ connectionId: "proof-connection", preset: "openai", protocol: "openai", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "stub-route-key-fixture-only", model: "stub-model", revision: "r1" });

async function engineInstance(engine: "fuigo" | "grok", home: string, fullAuto: boolean, extraEnv: Record<string, string> = {}): Promise<ProviderInstance> {
  const environment = { HOME: home, USERPROFILE: home, STUB_MODEL_KEY: "stub-model-key-fixture-only", ...(engine === "fuigo" ? { FUIGO_API_KEY: "sk-flux-fixture-only" } : { XAI_API_KEY: "xai-fixture-only", GROK_LOCAL_AUTH: "1" }), ...extraEnv };
  if (engine === "fuigo") return FuigoAgentDriver.create({ instanceId: `proof-fuigo-${fullAuto ? "full" : "ask"}`, displayName: "Fuigo", enabled: true, environment, config: { cli: FUIGO_BIN, fullAuto } });
  return GrokAgentDriver.create({ instanceId: `proof-grok-${fullAuto ? "full" : "ask"}`, displayName: "Grok", enabled: true, environment, config: GrokAgentDriver.decodeConfig({ cli: GROK_BIN, fullAuto }) });
}

let seq = 0;
/** One turn, one scripted tool call: every ask is judged at `level` and answered as the server would. */
async function turn(instance: ProviderInstance, engine: string, level: Level, action: Action, cwd: string, routed: boolean, threadId?: string) {
  const id = `${engine}-${level}-${routed ? "r" : "s"}-${++seq}`;
  actions.set(id, action);
  const thread = threadId ?? `proof-${id}`;
  const events = recordEvents(instance.adapter);
  const opened: Array<Record<string, unknown>> = [];
  // Fuigo's folder-trust ask (a project with its own permission rules) is the trust question, not a tool call: it is
  // answered at the level like any ask, recorded apart, and never counted as a tool card.
  const trust: Array<Record<string, unknown>> = [];
  let completed: RuntimeEvent | undefined; let error: string | undefined;
  try {
    const turnInput = { threadId: thread, text: `PROOF-ACTION:${id} Run the one tool call you are given, then stop.`, cwd, ...LEVEL[level].turn,
      ...(routed ? { model: "stub-model", providerRoute: route() } : { model: "stub" }) };
    const started = await instance.adapter.sendTurn(turnInput as never);
    const deadline = Date.now() + TURN_MS; let handled = 0;
    while (Date.now() < deadline) {
      const evs = events.events;
      for (; handled < evs.length; handled++) {
        const e = evs[handled]!;
        if (e.type === "request.opened") {
          const ev = e as Opened;
          const verdicts = Object.fromEntries((["ask", "auto", "full", "nolimits"] as Level[]).map((l) => [l, verdictOf(l, ev, cwd)]));
          const mine = verdicts[level] as { card: boolean };
          // The question tool's card is the question itself, not a permission card (source "question-tool").
          (ev.tool === "folder_trust" || mineSource(verdicts) === "question-tool" ? trust : opened).push({ tool: ev.tool, summary: (ev.summary ?? "").slice(0, 160), kind: ev.toolKind ?? null, verdicts });
          await instance.adapter.respondToRequest(thread, ev.requestId!, { behavior: mine.card ? "deny" : "allow" });
        }
        if (e.type === "turn.completed" && (e as { turnId?: string }).turnId === (started as { turnId?: string }).turnId) completed = e;
      }
      if (completed) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!completed) error = `no turn.completed within ${TURN_MS} ms; saw ${events.events.map((e) => e.type).slice(-12).join(",")}`;
  } catch (e) { error = String((e as Error)?.message ?? e).slice(0, 400); }
  const tail = events.events.slice(-6).map((e) => JSON.stringify(e).slice(0, 300));
  events.stop();
  const results = toolResults.get(id) ?? [];
  return { id, thread, call: stubCalls.get(id) ?? null, opened, trust, tail, cards: opened.filter((o) => (o.verdicts as Record<Level, { card: boolean }>)[level].card), results, leaked: leakIn(results.join("\n")), completed: Boolean(completed), ok: (completed as { ok?: boolean } | undefined)?.ok ?? null, stopReason: (completed as { stopReason?: string | null } | undefined)?.stopReason ?? null, error };
}

function record(proof: string, engine: string, routed: boolean, level: Level, action: string, expectText: string, pass: boolean, detail: Record<string, unknown>) {
  rows.push({ proof, engine, route: routed ? "routed" : "scoped", level, action, expect: expectText, pass, detail });
}
const keyHeld = (r: Awaited<ReturnType<typeof turn>>, level: Level) =>
  r.call?.tool != null && r.opened.length > 0 && r.cards.length > 0 && r.leaked.length === 0 &&
  (level === "ask" || r.cards.every((c) => ((c.verdicts as Record<Level, { source: string }>)[level].source === "sensitive-guard")));

// ------------------------------------------------------------------------------------------------ proofs
describe.skipIf(!PROOF)("FUIGO-SCOPE-1010 live proofs (real Fuigo and Grok, stub model, decoys only)", () => {
  beforeAll(async () => {
    ensureDirs();
    mkdirSync(OUT, { recursive: true });
    modelServer = createServer((req, res) => { handle(req, res).catch(() => { try { res.writeHead(500); res.end(); } catch { /* closed */ } }); });
    await new Promise<void>((r) => modelServer.listen(0, "127.0.0.1", () => r()));
    port = (modelServer.address() as { port: number }).port;
    // The stub OIDC issuer serves the decoy logins (P3's Fuigo refresh, the scoped Grok's grok.com login) for the whole run.
    oidcServer = createServer((req, res) => { oidcHandle(req, res).catch(() => { try { res.writeHead(500); res.end(); } catch { /* closed */ } }); });
    await new Promise<void>((r) => oidcServer!.listen(22255, "127.0.0.1", () => r()));
  });
  afterAll(async () => {
    const summary = ["| proof | engine | route | level | action | expect | result |", "|---|---|---|---|---|---|---|",
      ...rows.map((r) => `| ${r.proof} | ${r.engine} | ${r.route} | ${r.level} | ${r.action} | ${r.expect} | ${r.pass ? "PASS" : "FAIL"} |`)].join("\n");
    writeFileSync(join(OUT, "proof-results.json"), JSON.stringify({ rows, toolNamesSeen: Object.fromEntries(toolNamesSeen), stubLog: stubLog.slice(-400), oidcLog, leaksAnywhere }, null, 1));
    writeFileSync(join(OUT, "proof-summary.md"), `${summary}\n`);
    console.log(summary);
    await new Promise<void>((r) => modelServer.close(() => r()));
    if (oidcServer) await new Promise<void>((r) => oidcServer!.close(() => r()));
  });

  const P1: Array<[string, (h: string, w: string) => Action, "key" | "touch" | "grep"]> = [
    ["shell cat key | wc -c", () => ({ kind: "shell", command: "cat ~/.ssh/id_ed25519 | wc -c" }), "key"],
    ["shell head -c 10 key", () => ({ kind: "shell", command: "head -c 10 ~/.ssh/id_ed25519" }), "key"],
    ["read_file key, absolute", (h) => ({ kind: "read", path: join(h, ".ssh", "id_ed25519") }), "key"],
    ["read_file key, ~ path", () => ({ kind: "read", path: "~/.ssh/id_ed25519" }), "key"],
    ["read_file key, relative", () => ({ kind: "read", path: "../.ssh/id_ed25519" }), "key"],
    ["read files:[{path}] key", (h) => ({ kind: "readFiles", path: join(h, ".ssh", "id_ed25519") }), "key"],
    ["shell touch /tmp/x", () => ({ kind: "shell", command: `touch /tmp/proof-touch-${process.pid}` }), "touch"],
    ["grep with no path", () => ({ kind: "grep", pattern: "PLAIN-README" }), "grep"],
  ];

  for (const engine of ["fuigo", "grok"] as const) {
    const proof = engine === "fuigo" ? "P1" : "P1-G";
    it(`${proof}: every key read cards at Ask and at No limits; touch and a path-less grep card at Ask only`, async () => {
      if (!(engine === "fuigo" ? FUIGO_BIN : GROK_BIN)) throw new Error(`no ${engine} binary`);
      const { home, work } = decoyOwner(engine);
      for (const fullAuto of [false, true]) {
        const beforeCreate = treeHash(join(home, ".fuigo"), (n) => n === "auth.json" || n === "auth.json.lock");
        const instance = await engineInstance(engine, home, fullAuto);
        const afterCreate = treeHash(join(home, ".fuigo"), (n) => n === "auth.json" || n === "auth.json.lock");
        if (engine === "fuigo") {
          const changed = Object.keys({ ...beforeCreate, ...afterCreate }).filter((k) => beforeCreate[k] !== afterCreate[k]);
          record("P2-catalog", engine, false, fullAuto ? "full" : "ask", "owner ~/.fuigo across instance create (version probe + `fuigo models` catalog call)", "unchanged", changed.length === 0, { changed });
          // P2-catalog (MurageMain ruling): the catalog call's own home writes land in a Murage-owned scope built by the same code.
          const scopeConfigs: string[] = [];
          try { for (const id of readdirSync(scopedCliHomeRoot("fuigo"))) { try { scopeConfigs.push(readFileSync(join(scopedCliHomeRoot("fuigo"), id, "config.toml"), "utf8")); } catch { /* not a scope */ } } } catch { /* none yet */ }
          record("P2-catalog-scope", engine, false, fullAuto ? "full" : "ask", "`fuigo models` ran with FUIGO_HOME = a Murage scope (its home write landed there)", "a scope config carries Fuigo's own write and Murage's [permission]", scopeConfigs.some((text) => text.includes("[marketplace]") && text.includes("[permission]")), { scopes: scopeConfigs.length });
        }
        try {
          for (const level of (fullAuto ? ["full", "nolimits"] : ["ask"]) as Level[]) {
            for (const routed of [false, true]) {
              for (const [label, make, kind] of P1) {
                if (routed && kind !== "key" && level !== "ask") continue;
                const r = await turn(instance, engine, level, make(home, work), work, routed);
                if (label.startsWith("read files:") && r.call?.tool == null && r.completed) { record(routed ? `${proof}/P8-rules` : proof, engine, routed, level, label, "form absent in this engine (N/A)", true, { ...r, absent: true }); continue; }
                const pass = kind === "key" ? keyHeld(r, level) : level === "ask" ? r.call?.tool != null && r.cards.length > 0 : r.call?.tool != null && r.cards.length === 0 && r.completed;
                record(routed ? `${proof}/P8-rules` : proof, engine, routed, level, label, kind === "key" ? "card (sensitive guard), no content back" : level === "ask" ? "card" : "zero cards", pass, r);
              }
            }
          }
          // P10: an owner deny is enforced by the engine itself, no card, at every level.
          for (const level of (fullAuto ? ["full", "nolimits"] : ["ask"]) as Level[]) {
            for (const routed of [false, true]) {
              for (const [label, path, mark] of [["compact deny Read(**/private-notes/**)", join(home, "private-notes", "plan.md"), "priv"], ...(engine === "fuigo" ? [["verbose deny [[permission.rules]] read **/vault-notes/**", join(home, "vault-notes", "plan.md"), "vault"]] : [])] as Array<[string, string, string]>) {
                const r = await turn(instance, engine, level, { kind: "read", path }, work, routed);
                const pass = r.call?.tool != null && r.opened.length === 0 && !r.leaked.includes(mark) && r.results.length > 0;
                record("P10", engine, routed, level, label, "refused by the engine, no card, no content", pass, r);
              }
            }
          }
          // P7: the decoy ~/.aws/credentials by shell and by the native read tool, every level this instance serves.
          for (const level of (fullAuto ? ["full", "nolimits"] : ["ask", "auto"]) as Level[]) {
            for (const [routeName, action] of [["shell", { kind: "shell", command: "wc -c ~/.aws/credentials" }], ["nativeRead", { kind: "read", path: join(home, ".aws", "credentials") }]] as Array<["shell" | "nativeRead", Action]>) {
              const r = await turn(instance, engine, level, action, work, engine === "grok");
              const viaGuard = r.opened.some((o) => (o.verdicts as Record<Level, { source: string }>)[level].source === "sensitive-guard");
              const pass = r.call?.tool != null && r.opened.length > 0 && r.cards.length > 0 && r.leaked.length === 0 && (level === "ask" || level === "auto" || viaGuard);
              record("P7", engine, engine === "grok", level, `${routeName} wc -c ~/.aws/credentials`, `inventory ${READ_GUARD_INVENTORY[engine === "fuigo" ? "fuigoAgent" : "grokAgent"].p7[routeName]}`, pass, r);
            }
          }
          if (!fullAuto) {
            // P6 (Fuigo and Grok): reads with no path never card at Ask.
            for (const [label, action] of [["todo_write", { kind: "todo" }], ["list_dir with no path", { kind: "list" }], ["plan mode", { kind: "plan" }], ["ask_user_question", { kind: "ask" }]] as Array<[string, Action]>) {
              const r = await turn(instance, engine, "ask", action, work, engine === "grok");
              const pass = r.call?.tool == null ? false : r.cards.length === 0;
              record("P6", engine, engine === "grok", "ask", label, r.call?.tool == null ? "tool absent in this engine" : "zero cards", r.call?.tool == null ? true : pass, { ...r, absent: r.call?.tool == null });
            }
            // Second-turn continuity: the same thread, a second turn, the rules still hold.
            const first = await turn(instance, engine, "ask", { kind: "text" }, work, engine === "grok", `proof-${engine}-continuity`);
            const second = await turn(instance, engine, "ask", { kind: "read", path: join(home, ".ssh", "id_ed25519") }, work, engine === "grok", `proof-${engine}-continuity`);
            record("continuity", engine, engine === "grok", "ask", "second turn, same thread: key read", "card", first.completed && keyHeld(second, "ask"), { first, second });
          }
        } finally { await instance.dispose(); }
        if (engine === "fuigo") {
          const afterTurns = treeHash(join(home, ".fuigo"), (n) => n === "auth.json" || n === "auth.json.lock");
          const changed = Object.keys({ ...afterCreate, ...afterTurns }).filter((k) => afterCreate[k] !== afterTurns[k]);
          record("P2", engine, false, fullAuto ? "nolimits" : "ask", `owner ~/.fuigo hash before and after every bot turn (${fullAuto ? "Full access and No limits" : "Ask and Auto"}, scoped and routed)`, "unchanged", changed.length === 0, { changed });
        }
      }
      const failed = rows.filter((r) => r.engine === engine && !r.pass);
      expect.soft(failed.map((r) => `${r.proof} ${r.route} ${r.level} ${r.action}`)).toEqual([]);
    }, 3_600_000);
  }

  it("P3: a native-login turn refreshes the owner's own auth.json in the owner's folder, lock beside it, nothing in the scope", async () => {
    const { home, work } = decoyOwner("fuigo");
    const client = OIDC_CLIENT;
    const issuer = OIDC_ISSUER;
    const auth = { [`${issuer}::${client}`]: { key: "decoy-expired-token", auth_mode: "oidc", create_time: "2026-01-01T00:00:00Z", user_id: "decoy-user", email: "decoy@test.invalid",
      expires_at: "2026-01-01T01:00:00Z", refresh_token: "decoy-refresh-1", oidc_issuer: issuer, oidc_client_id: client, coding_data_retention_opt_out: false } };
    const authPath = join(home, ".fuigo", "auth.json");
    writeFileSync(authPath, JSON.stringify(auth, null, 2), { mode: 0o600 });
    const beforeAuth = readFileSync(authPath, "utf8");
    const oidcBefore = oidcLog.length; // only this turn's requests count (the scoped Grok turns use the same issuer)
    const instance = await FuigoAgentDriver.create({ instanceId: "proof-fuigo-native", displayName: "Fuigo", enabled: true,
      environment: { HOME: home, USERPROFILE: home, STUB_MODEL_KEY: "stub-model-key-fixture-only", FUIGO_LOCAL_AUTH: "1", FUIGO_OAUTH2_CLIENT_ID: client }, config: { cli: FUIGO_BIN, fullAuto: false } });
    let r: Awaited<ReturnType<typeof turn>> | undefined;
    try { r = await turn(instance, "fuigo", "ask", { kind: "read", path: join(home, ".ssh", "id_ed25519") }, work, false); } finally { await instance.dispose(); }
    const afterAuth = existsSync(authPath) ? readFileSync(authPath, "utf8") : "<gone>";
    const ownerFiles = readdirSync(join(home, ".fuigo"));
    const scopeRoots: string[] = [];
    const walk = (dir: string, depth: number) => { if (depth > 6 || !existsSync(dir)) return; for (const n of readdirSync(dir)) { const p = join(dir, n); try { if (statSync(p).isDirectory()) walk(p, depth + 1); else if (/auth\.json|\.lock$/.test(n)) scopeRoots.push(p); } catch { /* raced */ } } };
    walk(scopedCliHomeRoot("fuigo"), 0);
    const refreshed = oidcLog.slice(oidcBefore).some((l) => String(l.url).startsWith("/token"));
    const changedInPlace = afterAuth !== beforeAuth && afterAuth.includes("decoy-refresh-2");
    record("P3", "fuigo", false, "ask", "forced refresh of an expired native login", "owner auth.json replaced in the owner's folder, lock beside it, no auth file in the scope",
      refreshed && changedInPlace && !scopeRoots.some((p) => p.endsWith("auth.json")), { turn: r, refreshed, changedInPlace, ownerFiles, lockBeside: ownerFiles.filter((n) => /lock/.test(n)), scopeAuthOrLockFiles: scopeRoots, oidcLog });
    expect.soft(rows.filter((x) => x.proof === "P3" && !x.pass).length).toBe(0);
  }, 600_000);
});
