// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// F11-V3 r6 (1.0.23), W11 on the REAL vendor CLIs (ASTRA a73a2c5fbf High: the fake CLIs issued the MCP call themselves). The only fake
// is the MODEL: a local endpoint on 127.0.0.1, reached through the turn's provider connection (providerRoute, the base-URL override
// Murage ships), answers the CLI's first request with a tool call to the plain-name alias tool. From there everything is production
// or vendor code: the real CLI's permission prompt -> the real driver's request.opened -> the real bus aliasAsk intake -> the real
// decision registry -> the real driver reply -> the real CLI's own MCP client calls tools/call on the mount Murage wrote, where a
// stub MCP server logs it. Binaries: $MURAGE_REAL_CLI_DIR/{claude,codex} (WITNESS-DESIGN.md in the lane job dir).
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixture, d, baseRun, baseCard, card } from "../decision/fixture.ts";
import { ensureDirs } from "../config.ts";
import type { ProviderInstance, RuntimeEvent, RequestAnswerOptions, RequestDelivery } from "../contracts.ts";
import { EventBus } from "../harness/bus.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { fixtureMountTurn, bindFixtureAdapter } from "../testing/mcp-admission-fixture.ts";
import { recordEvents } from "../testing/events.ts";
import { ClaudeDriver } from "./claude.ts";
import { CodexDriver } from "./codex.ts";

const DIR = process.env.MURAGE_REAL_CLI_DIR ?? "";
if (!DIR) console.info("SKIP W11 real-CLI rows: set MURAGE_REAL_CLI_DIR to a directory holding the vendor claude (2.1.310) and codex (0.167.0) binaries.");
const ACCOUNT = "acct_fixture_a";
const ARGS = { recipient_email: "pat.recipient@example.com", subject: "Hello", body: "Hi there" };
const SEND = { account: ACCOUNT, arguments: ARGS };
const BODY = { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", account: ACCOUNT, arguments: ARGS }], sync_response_to_workbench: false };
const EXEC = "APPS_MULTI_EXECUTE_TOOL";
const ALIAS = "gmail_send_email";
type Engine = "claude" | "codex";
type Answer = { behavior: string; updatedInput?: unknown };
type Opened = Extract<RuntimeEvent, { type: "request.opened" }> & Record<string, any>;

// the stub MCP server on the connector mount: it logs every tools/call the CLI's MCP client asks it to run (the dispatch)
const MCP_SERVER = String.raw`
import { appendFileSync } from "node:fs";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
    else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: ["gmail_send_email", "APPS_MULTI_EXECUTE_TOOL"].map((name) => ({ name, description: "Connected app tool " + name, inputSchema: { type: "object", properties: {} } })) } });
    else if (m.method === "tools/call") { appendFileSync(process.env.FAKE_LOG, JSON.stringify(m.params) + "\n"); send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ran" }] } }); }
    else if (m.id !== undefined && m.method) send({ jsonrpc: "2.0", id: m.id, result: {} });
  }
});
process.stdin.on("end", () => process.exit(0));
`;

/** The CLI's own spelling of the mounted alias tool in a request's `tools`: a flat name ending with the alias (Claude
 * `mcp__murage_connectors__gmail_send_email`), or the alias inside a Responses namespace tool (Codex `mcp__murage_connectors`). */
function aliasTool(tools: unknown): { name: string; namespace?: string } | undefined {
  for (const t of Array.isArray(tools) ? tools as any[] : []) {
    if (t?.type === "namespace") for (const inner of Array.isArray(t.tools) ? t.tools : []) { if (inner?.name === ALIAS) return { name: inner.name, namespace: t.name }; }
    if (typeof t?.name === "string" && t.name.endsWith(ALIAS)) return { name: t.name };
  }
  return undefined;
}

/** The fake MODEL. Anthropic Messages (Claude) or OpenAI Responses (Codex), streamed. The first request that lists the alias tool
 * gets a tool call to it with SEND; a request that carries a tool result gets a short text; anything else gets a short text. */
async function fakeModel(dialect: "anthropic" | "responses") {
  const requests: Array<{ path: string; body: any }> = [];
  const calls: string[] = [];
  let searched = false;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let body: any = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = { raw }; }
      const path = (req.url ?? "").split("?")[0]!;
      requests.push({ path, body });
      const text = JSON.stringify(body);
      const found = aliasTool(body.tools);
      const tool = found?.name;
      const callIt = tool !== undefined && calls.length === 0;
      if (callIt) calls.push(found!.namespace ? `${found!.namespace}/${tool}` : tool!);
      // Claude Code lists MCP tools as deferred (named in a reminder, loaded through its ToolSearch tool): the model loads it first,
      // exactly as a real model does, then calls it once it is in `tools`
      const deferred = dialect === "anthropic" && !callIt && !searched && calls.length === 0 ? text.match(/mcp__[A-Za-z0-9_]+__gmail_send_email/)?.[0] : undefined;
      const search = deferred && (body.tools ?? []).some((t: any) => t.name === "ToolSearch") ? deferred : undefined;
      if (search) searched = true;
      if (dialect === "anthropic") {
        if (path.endsWith("/count_tokens")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ input_tokens: 1 })); return; }
        if (!path.endsWith("/messages")) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "fixture" } })); return; }
        const use = callIt ? { id: "toolu_fixture_1", name: tool!, input: SEND as object } : search ? { id: "toolu_fixture_search", name: "ToolSearch", input: { query: `select:${search}`, max_results: 5 } } : undefined;
        const content = use ? [{ type: "tool_use", ...use }] : [{ type: "text", text: "sent" }];
        const stop = use ? "tool_use" : "end_turn";
        const message = { id: `msg_fixture_${requests.length}`, type: "message", role: "assistant", model: body.model ?? "fixture", content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
        if (!body.stream) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(message)); return; }
        const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
        const block = use
          ? [ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: use.id, name: use.name, input: {} } }), ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(use.input) } })]
          : [ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }), ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "sent" } })];
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end([ev("message_start", { message: { ...message, content: [], stop_reason: null } }), ...block, ev("content_block_stop", { index: 0 }),
          ev("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } }), ev("message_stop", {})].join(""));
        return;
      }
      if (!path.endsWith("/responses")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ object: "list", data: [], models: [] })); return; }
      const id = `resp_fixture_${requests.length}`;
      const item = callIt
        ? { type: "function_call", id: "fc_fixture_1", call_id: "call_fixture_1", name: tool, ...(found?.namespace ? { namespace: found.namespace } : {}), arguments: JSON.stringify(SEND), status: "completed" }
        : { type: "message", id: `msg_fixture_${requests.length}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "sent", annotations: [] }] };
      const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end([ev("response.created", { response: { id } }), ev("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress" } }), ev("response.output_item.done", { output_index: 0, item }),
        ev("response.completed", { response: { id, usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 } } })].join(""));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, requests, calls, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe.skipIf(!DIR)("W11 real vendor CLI: the model's plain-name call -> real CLI ask -> real driver -> real bus -> real registry -> the CLI's own MCP call", () => {
  let instance: ProviderInstance | undefined;
  let model: Awaited<ReturnType<typeof fakeModel>> | undefined;
  let scratch = "";
  const offs: Array<() => void> = [];
  beforeEach(() => {
    ensureDirs();
    for (const name of ["claude", "codex"]) chmodSync(join(DIR, name), 0o755);
    scratch = mkdtempSync(join(tmpdir(), "murage-alias-real-"));
    mkdirSync(join(scratch, "work"), { recursive: true });
    mkdirSync(join(scratch, "home"), { recursive: true });
    writeFileSync(join(scratch, "mcp.mjs"), MCP_SERVER);
  });
  afterEach(async () => {
    for (const off of offs.splice(0)) off();
    await instance?.dispose();
    instance = undefined;
    await model?.close();
    model = undefined;
    await removeTempDir(scratch);
  });

  async function drive(engine: Engine, level: "unlimited" | "ask") {
    const f = fixture(level);
    const log = join(scratch, "dispatch.ndjson");
    model = await fakeModel(engine === "claude" ? "anthropic" : "responses");
    const composio = { command: process.execPath, args: [join(scratch, "mcp.mjs")], env: { FAKE_LOG: log } as Record<string, string> };
    // offline: no update check, no telemetry; HOME is the scratch home so no owner config is read
    const environment = { HOME: join(scratch, "home"), CODEX_HOME: join(scratch, "home", ".codex"), CLAUDE_CONFIG_DIR: join(scratch, "home", ".claude"),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", FIXTURE_MODEL_TOKEN: "fixture-model-key" };
    mkdirSync(environment.CODEX_HOME, { recursive: true });
    mkdirSync(environment.CLAUDE_CONFIG_DIR, { recursive: true });
    // Claude: the turn's model connection (providerRoute -> ANTHROPIC_BASE_URL). Codex: the owner's own Codex config naming its model
    // provider (config.toml model_provider + [model_providers.*].base_url), which the driver leaves to the CLI
    const providerRoute = engine === "claude"
      ? { connectionId: "conn-fixture-a", revision: "1", preset: "anthropic", protocol: "anthropic", baseUrl: model.url, apiKey: "fixture-model-key", model: "claude-sonnet-4-5" }
      : undefined;
    if (engine === "codex") writeFileSync(join(environment.CODEX_HOME, "config.toml"), `model = "gpt-5"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "${model.url}/v1"\nwire_api = "responses"\nenv_key = "FIXTURE_MODEL_TOKEN"\n`);
    if (engine === "claude") {
      instance = await ClaudeDriver.create({ instanceId: "p", displayName: "Alias fixture", enabled: true, environment, config: { cli: join(DIR, "claude"), permissionMode: "default" as const } });
    } else {
      instance = await CodexDriver.create({ instanceId: "p", displayName: "Alias fixture", enabled: true, environment, config: { cli: join(DIR, "codex"), fullAuto: false } });
    }
    bindFixtureAdapter(instance.adapter);
    const adapter = instance.adapter;
    const recorder = recordEvents(adapter);
    // the production wiring: ONE bus over the driver, the decision registry reading that bus, answers back to the driver
    const bus = new EventBus();
    bus.attach([instance]);
    f.dispose();
    let turnId = "";
    offs.push(d.installRequestIngress({ subscribe: (fn) => bus.subscribe((e) => fn({ ...(e as object), providerInstanceId: "p" } as never)) }));
    d.installProvenanceReader({ turnGenerationFor: () => "g", provenance: () => ({ generation: "g", threadId: "t", botId: "b", principal: "owner", initiator: { k: "owner-typed" }, roomOwnerOnly: true, at: 1 }), live: () => ({ botId: "b", turnId, providerInstanceId: "p", principal: "owner", owner: true, level }) });
    const answers: Answer[] = [];
    d.installDecisionTransport({ interrupt: async () => {}, respond: async (target, answer, options) => {
      answers.push(answer as Answer);
      return (adapter.respondToRequest as unknown as (t: string, r: string, a: typeof answer, o: Readonly<RequestAnswerOptions>) => Promise<RequestDelivery>)(target.threadId, target.requestId, answer, options);
    } });
    const seen: Opened[] = [];
    const judged: Array<{ kind: string }> = [];
    const settled: Promise<void>[] = [];
    bus.subscribe((e) => { if (e.type === "request.opened") seen.push(e as Opened); });
    offs.push(adapter.onEvent((e) => {
      if (e.type === "turn.started") turnId = e.turnId ?? "";
      if (e.type !== "request.opened") return;
      const ref = d.openRequest({ kind: "engine", threadId: e.threadId, requestId: e.requestId! });
      const outcome = d.decide(ref, level === "unlimited" ? baseRun : baseCard);
      judged.push(outcome);
      if (outcome.kind === "run") settled.push(d.deliverRequest(ref));
      else settled.push((async () => {
        const approval = card(outcome);
        await d.presentApproval(approval, { title: "Action", subtitle: "Fixture" });
        await d.answerApproval(approval, { behavior: "allow" });
      })());
    }));
    const turn = fixtureMountTurn({ threadId: "t", cwd: join(scratch, "work"), text: "send it", routeAsks: true, stopLine: true, ...(providerRoute ? { providerRoute, model: providerRoute.model } : {}),
      ...(level === "unlimited" ? { noLimits: true } : {}), permissionNow: () => d.readTurnPolicy({ threadId: "t", generation: "g" })!.permission,
      integrations: { composio } } as never);
    await adapter.sendTurn(turn);
    await recorder.until((e) => e.type === "turn.completed", 90_000);
    await Promise.all(settled);
    const dispatched = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    return { seen, judged, answers, events: recorder.events as RuntimeEvent[], dispatched, model };
  }

  for (const engine of ["claude", "codex"] as const) {
    for (const level of ["unlimited", "ask"] as const) {
      // SITES.md W11 row <engine> (real CLI): driver request.opened -> bus aliasAsk -> decision -> driver reply -> CLI MCP tools/call
      it(`${engine} (real CLI) at ${level}: the model's alias call is filed as the execute call, judged, allowed, and the CLI itself dispatches it`, async () => {
        const run = await drive(engine, level);
        // the fake model was asked by the REAL CLI with the mounted alias tool listed, and answered with a call to it
        expect(run.model.calls).toHaveLength(1);
        // the bus filed the CLI's alias ask as the equal execute call (the intake ran on the driver's own event). Claude asks once (its
        // permission prompt); Codex asks twice for one call (Murage's PreToolUse hook, then its MCP tool approval): every ask is filed
        // as the execute call, judged the same, and answered with a plain allow
        const asks = engine === "claude" ? 1 : 2;
        expect(run.seen).toHaveLength(asks);
        for (const ask of run.seen) {
          expect(ask.toolCall!.input).toEqual(BODY);
          expect(ask.toolCall!.name).toContain(EXEC);
        }
        expect(run.judged.map((o) => o.kind)).toEqual(Array(asks).fill(level === "unlimited" ? "run" : "card"));
        expect(run.answers).toHaveLength(asks);
        for (const answer of run.answers) {
          expect(answer).toMatchObject({ behavior: "allow" });
          expect(answer).not.toHaveProperty("updatedInput");
          expect(JSON.stringify(answer)).not.toContain("tool_slug");
        }
        // W11 DISPATCH: the vendor CLI's own MCP client called the plain-name tool on the mount Murage wrote, once, with the model's
        // own arguments (a deny, a lost answer, a rewritten body or a dropped mount fails here). `_meta` is the CLI's own call metadata.
        expect(run.dispatched.map(({ name, arguments: args }: { name: string; arguments: unknown }) => ({ name, arguments: args }))).toEqual([{ name: ALIAS, arguments: SEND }]);
        // and the CLI carried the tool's result back to the model (the call ran and the turn went on)
        expect(run.model.requests.some((r) => toolResultSays(r.body, "ran"))).toBe(true);
      }, 120_000);
    }
  }
});

/** Whether a model request carries the result of the fixture tool call (Anthropic `tool_result` for toolu_fixture_1, Responses
 * `function_call_output` for call_fixture_1) and that result says `text`. */
function toolResultSays(value: unknown, text: string): boolean {
  if (Array.isArray(value)) return value.some((v) => toolResultSays(v, text));
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  const mine = (o.type === "tool_result" && o.tool_use_id === "toolu_fixture_1") || (typeof o.type === "string" && o.type.endsWith("_output") && o.call_id === "call_fixture_1");
  if (mine) return JSON.stringify(o.content ?? o.output ?? "").includes(text);
  return Object.values(o).some((v) => toolResultSays(v, text));
}
