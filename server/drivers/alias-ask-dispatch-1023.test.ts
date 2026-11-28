// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// F11-V3 r4 (1.0.23), W11/W14 on the REAL ask-to-dispatch path (ASTRA 2d5505dde5 High): the real driver runs its fake CLI,
// the CLI's plain-name app call (`gmail_send_email`) raises the driver's own request.opened, the real EventBus intake
// (server/harness/bus.ts aliasAsk) files it, the real decision registry (installRequestIngress on that bus, decide,
// deliverRequest / answerApproval) judges it, and the answer goes through the real driver respondToRequest back to the CLI.
// Nothing is hand-built: no mirrored event, no direct aliasAsk call. Table rows: SITES.md (W11 per engine).
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fixture, d, baseRun, baseCard, card } from "../decision/fixture.ts";
import { ensureDirs } from "../config.ts";
import type { ProviderInstance, RuntimeEvent, RequestAnswerOptions, RequestDelivery } from "../contracts.ts";
import { EventBus } from "../harness/bus.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { fixtureMountTurn, bindFixtureAdapter } from "../testing/mcp-admission-fixture.ts";
import { recordEvents } from "../testing/events.ts";
import { ClaudeDriver } from "./claude.ts";
import { PiDriver } from "./pi.ts";
import { CodexDriver } from "./codex.ts";
import { AntigravityDriver } from "./antigravity.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { bindOpenAIFixture } from "../testing/bound-openai-fixture.ts";
import { ALIAS_ENGINES } from "../../shared/connected-app-aliases.ts";
import { fixtureBotFolder } from "../testing/bot-folder-fixture.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = { claude: join(here, "..", "testing", "fake-claude-cli.ts"), pi: join(here, "..", "testing", "fake-pi-cli.ts"), antigravity: join(here, "..", "testing", "fake-agy-cli.ts"), codex: join(here, "..", "testing", "fake-codex-app-server.ts") };
const ACCOUNT = "acct_fixture_a";
const ARGS = { recipient_email: "pat.recipient@example.com", subject: "Hello", body: "Hi there" };
const SEND = { account: ACCOUNT, arguments: ARGS };
const BODY = { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", account: ACCOUNT, arguments: ARGS }], sync_response_to_workbench: false };
const EXEC = "APPS_MULTI_EXECUTE_TOOL";
type Engine = "claude" | "codex" | "antigravity";
type Answer = { behavior: string; updatedInput?: unknown };
type Opened = Extract<RuntimeEvent, { type: "request.opened" }> & Record<string, any>;

// the stub MCP server on the connector mount: it logs every tools/call it is asked to run (the dispatch)
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
    else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: ["gmail_send_email", "APPS_MULTI_EXECUTE_TOOL"].map((name) => ({ name, inputSchema: { type: "object", properties: {} } })) } });
    else if (m.method === "tools/call") { appendFileSync(process.env.FAKE_LOG, JSON.stringify(m.params) + "\n"); send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ran" }] } }); }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

const ENV_KEYS = ["FAKE_CLAUDE_PERM_TOOL", "FAKE_CLAUDE_PERM_INPUT", "FAKE_AGY_DUMP", "FAKE_AGY_TOOL_CALLS", "FAKE_AGY_RUN_HOOKS", "FAKE_CODEX_DUMP", "FAKE_CODEX_MODE", "FAKE_CODEX_MCP_SERVER", "FAKE_CODEX_MCP_TOOL", "FAKE_CODEX_MCP_PARAMS", "FAKE_CLAUDE_PERM_DISPATCH", "FAKE_AGY_DISPATCH", "FAKE_CODEX_MCP_DISPATCH"];

describe("W11/W14 per engine, real driver -> real bus -> real decision registry -> real driver reply", () => {
  let instance: ProviderInstance | undefined;
  let scratch = "";
  const offs: Array<() => void> = [];
  beforeEach(() => {
    ensureDirs();
    for (const file of Object.values(FAKE)) chmodSync(file, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "murage-alias-ask-"));
    mkdirSync(join(scratch, "work"), { recursive: true });
    mkdirSync(join(scratch, "home"), { recursive: true });
    writeFileSync(join(scratch, "mcp.mjs"), MCP_SERVER);
  });
  afterEach(async () => {
    for (const off of offs.splice(0)) off();
    await instance?.dispose();
    instance = undefined;
    for (const name of ENV_KEYS) delete process.env[name];
    await removeTempDir(scratch);
  });

  /** One turn of the real driver whose CLI makes the app call `tool(input)` on the connector mount. Returns the events the
   * bus delivered (the alias rewritten), what the decision registry judged, and every answer the driver received. */
  async function drive(engine: Engine, tool: string, input: unknown, level: "unlimited" | "ask") {
    const f = fixture(level);
    const log = join(scratch, "dispatch.ndjson");
    const composio = { command: process.execPath, args: [join(scratch, "mcp.mjs")], env: { FAKE_LOG: log } as Record<string, string> };
    const environment = { HOME: join(scratch, "home") };
    const config = { cli: FAKE[engine], fullAuto: false, permissionMode: "default" as const };
    if (engine === "claude") {
      process.env.FAKE_CLAUDE_PERM_DISPATCH = "1";
      process.env.FAKE_CLAUDE_PERM_TOOL = `mcp__murage_connectors__${tool}`;
      process.env.FAKE_CLAUDE_PERM_INPUT = JSON.stringify(input);
      instance = await ClaudeDriver.create({ instanceId: "p", displayName: "Alias fixture", enabled: true, environment, config });
      bindFixtureAdapter(instance.adapter);
    } else if (engine === "antigravity") {
      process.env.FAKE_AGY_RUN_HOOKS = "1";
      process.env.FAKE_AGY_DISPATCH = "1";
      process.env.FAKE_AGY_DUMP = join(scratch, "dump.json");
      process.env.FAKE_AGY_TOOL_CALLS = JSON.stringify([{ name: "call_mcp_tool", args: { ServerName: "murage_connectors", ToolName: tool, Arguments: input } }]);
      instance = await AntigravityDriver.create({ instanceId: "p", displayName: "Alias fixture", enabled: true, environment, config });
    } else {
      process.env.FAKE_CODEX_DUMP = join(scratch, "codex-dump.json");
      process.env.FAKE_CODEX_MODE = "mcp-elicitation";
      process.env.FAKE_CODEX_MCP_DISPATCH = "1";
      process.env.FAKE_CODEX_MCP_SERVER = "murage_connectors";
      process.env.FAKE_CODEX_MCP_TOOL = tool;
      process.env.FAKE_CODEX_MCP_PARAMS = JSON.stringify(input);
      instance = await CodexDriver.create({ instanceId: "p", displayName: "Alias fixture", enabled: true, environment, config: { cli: FAKE.codex, fullAuto: false } });
      bindFixtureAdapter(instance.adapter);
    }
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
    const turn = fixtureMountTurn({ threadId: "t", cwd: join(scratch, "work"), text: engine === "claude" ? "__fixture_permission_tool__" : "send it", routeAsks: true, stopLine: true,
      ...(level === "unlimited" ? { noLimits: true } : {}), permissionNow: () => d.readTurnPolicy({ threadId: "t", generation: "g" })!.permission,
      integrations: { composio } } as never);
    await adapter.sendTurn(turn);
    await recorder.until((e) => e.type === "turn.completed");
    await Promise.all(settled);
    // what the ENGINE did with the answer: Codex reports the decision it was handed (its dump is written when it exits)
    let codexDecision: unknown;
    if (engine === "codex") {
      await instance.dispose();
      instance = undefined;
      codexDecision = JSON.parse(readFileSync(process.env.FAKE_CODEX_DUMP!, "utf8")).decision;
    }
    // the DISPATCH: the tools/call the mounted MCP server was actually asked to run, by the engine's own MCP client
    const dispatched = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    return { seen, judged, answers, events: recorder.events as RuntimeEvent[], codexDecision, dispatched };
  }

  // Antigravity runs only while it is in ALIAS_ENGINES (out until proven on its real CLI). These rows use the fake CLIs: they pin the
  // driver -> bus -> registry -> reply leg; the dispatch on the REAL vendor CLI is W11 in alias-ask-dispatch-real-1023.test.ts.
  const ENGINES = (["claude", "codex", "antigravity"] as Engine[]).filter((engine) => ALIAS_ENGINES.has(engine));
  for (const engine of ENGINES) {
    for (const level of ["unlimited", "ask"] as const) {
      // SITES.md W11 row <engine>: driver request.opened -> bus aliasAsk -> decision -> driver respondToRequest
      it(`${engine} at ${level}: the plain-name call is filed as the execute call, judged, and the engine's own alias call is allowed with no body`, async () => {
        const run = await drive(engine, "gmail_send_email", SEND, level);
        expect(run.seen).toHaveLength(1);
        // the bus filed the engine's alias ask as the equal execute call (the intake ran on the driver's own event)
        expect(run.seen[0]!.toolCall!.input).toEqual(BODY);
        expect(run.seen[0]!.toolCall!.name).toContain(EXEC);
        // the registry judged the equal call: a card at Ask, a release at No limits
        expect(run.judged.map((o) => o.kind)).toEqual([level === "unlimited" ? "run" : "card"]);
        // the engine got exactly one allow and it carries no rewritten body: the engine runs its OWN alias call
        expect(run.answers).toHaveLength(1);
        expect(run.answers[0]).toMatchObject({ behavior: "allow" });
        expect(run.answers[0]).not.toHaveProperty("updatedInput");
        expect(JSON.stringify(run.answers[0])).not.toContain("tool_slug");
        // W11 real MCP dispatch, one row per engine: after the Allow the engine's own MCP client called the plain-name tool on the
        // mounted server with the model's own arguments, once, not the rewritten execute body (a no-dispatch engine fails here)
        expect(run.dispatched).toEqual([{ name: "gmail_send_email", arguments: SEND }]);
        // and the engine saw that allow (its turn ended having been answered, not left waiting)
        expect(run.events.some((e) => e.type === "request.resolved" && e.behavior === "allow")).toBe(true);
        // the engine's own call went ahead: Claude's CLI reported its permission prompt allowed, Antigravity completed the tool item ok, Codex was handed an accept that
        // carries no rewritten body (a driver that resolved Allow and never let the call run would fail here)
        if (engine === "codex") {
          expect(JSON.stringify(run.codexDecision)).toContain("accept");
          expect(JSON.stringify(run.codexDecision)).not.toContain("tool_slug");
        } else if (engine === "claude") {
          // the fake CLI reports what its permission prompt returned: it ran the tool only on an allow
          expect(run.events.filter((e) => e.type === "item.completed" && (e as any).itemType === "assistant_text").map((e) => (e as any).text)).toContain("permission: allowed");
        } else {
          expect(run.events.filter((e) => e.type === "item.completed" && (e as any).itemType === "tool").map((e) => (e as any).ok)).toEqual([true]);
        }
      });
    }
  }
});

// SITES.md W11 row pi: the real Pi driver refuses every mounted turn (the connector mount cannot be handed to Pi), so no alias
// ask can ever come from Pi in this build. If that refusal is lifted this row must become a driven row like the others.
describe("W11 pi: the connector mount is refused, so Pi never raises an alias ask", () => {
  it("a connector-mounted turn is refused before any ask", async () => {
    ensureDirs();
    const instance = await PiDriver.create({ instanceId: "p", displayName: "Alias fixture", enabled: true, environment: {}, config: { cli: FAKE.pi, fullAuto: false } });
    try {
      const recorder = recordEvents(instance.adapter);
      await expect(instance.adapter.sendTurn(fixtureMountTurn({ threadId: "t", cwd: fixtureBotFolder(), text: "send it", integrations: { composio: { command: process.execPath, args: [], env: {} } } } as never)))
        .rejects.toThrow("Murage keeps this bot's memory out of Pi's tools.");
      expect(recorder.events.some((e) => e.type === "request.opened")).toBe(false);
    } finally { await instance.dispose(); }
  });
});

// SITES.md W11 row chat: the real openai-compat driver, a stubbed completions endpoint whose model calls the plain name, a
// real stdio MCP server on the connector mount that logs what it is asked to run (the dispatch).
describe("W11 chat: real openai-compat driver -> real bus -> real decision registry -> the engine's own alias call runs", () => {
  let dir = "";
  let previousFetch: typeof globalThis.fetch;
  let instance: ProviderInstance | undefined;
  const offs: Array<() => void> = [];
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "murage-alias-chat-")); writeFileSync(join(dir, "mcp.mjs"), MCP_SERVER); });
  afterAll(async () => { await removeTempDir(dir); });
  beforeEach(() => { ensureDirs(); previousFetch = globalThis.fetch; });
  afterEach(async () => {
    globalThis.fetch = previousFetch;
    for (const off of offs.splice(0)) off();
    await instance?.dispose().catch(() => {});
    instance = undefined;
  });

  for (const level of ["unlimited", "ask"] as const) {
    it(`chat at ${level}: the model's plain-name call is judged as the execute call and the engine's own call runs unchanged`, async () => {
      const f = fixture(level);
      const log = join(dir, `calls-${level}.ndjson`);
      const names: string[] = [];
      let step = 0;
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        if (!String(input instanceof Request ? input.url : input).endsWith("/chat/completions")) return new Response("not found", { status: 404 });
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>;
        const frame = (v: unknown) => `data: ${JSON.stringify(v)}\n\n`;
        const sse = (chunks: string[]) => new Response(chunks.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
        if (step++ > 0) return sse([frame({ choices: [{ delta: { content: "sent" } }] }), frame({ choices: [{ delta: {}, finish_reason: "stop" }] }), "data: [DONE]\n\n"]);
        names.push(...(body.tools ?? []).map((t: any) => t.function.name));
        const name = names.find((n) => n.endsWith("gmail_send_email"))!;
        return sse([frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: JSON.stringify(SEND) } }] } }] }), frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }), "data: [DONE]\n\n"]);
      }) as typeof fetch;
      instance = await OpenAICompatDriver.create({ instanceId: "p", displayName: "Alias fixture", environment: {}, enabled: true, config: OpenAICompatDriver.decodeConfig({ url: "https://compat.invalid/v1", key: "compat-key-fixture", model: "test-model" }) });
      bindOpenAIFixture(instance);
      const adapter = instance.adapter;
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
      const judged: string[] = [];
      const settled: Promise<void>[] = [];
      bus.subscribe((e) => { if (e.type === "request.opened") seen.push(e as Opened); });
      offs.push(adapter.onEvent((e) => {
        if (e.type === "turn.started") turnId = e.turnId ?? "";
        if (e.type !== "request.opened") return;
        const ref = d.openRequest({ kind: "engine", threadId: e.threadId, requestId: e.requestId! });
        const outcome = d.decide(ref, level === "unlimited" ? baseRun : baseCard);
        judged.push(outcome.kind);
        if (outcome.kind === "run") settled.push(d.deliverRequest(ref));
        else settled.push((async () => { const approval = card(outcome); await d.presentApproval(approval, { title: "Action", subtitle: "Fixture" }); await d.answerApproval(approval, { behavior: "allow" }); })());
      }));
      const recorder = recordEvents(adapter);
      const { turnId: started } = await adapter.sendTurn(fixtureMountTurn({ cwd: fixtureBotFolder(), threadId: "t", text: "send it", routeAsks: true, stopLine: true, model: "test-model",
        ...(level === "unlimited" ? { noLimits: true } : {}), permissionNow: () => d.readTurnPolicy({ threadId: "t", generation: "g" })!.permission,
        integrations: { composio: { command: process.execPath, args: [join(dir, "mcp.mjs")], env: { FAKE_LOG: log } } } } as never));
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === started);
      await Promise.all(settled);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.toolCall!.input).toEqual(BODY);
      expect(seen[0]!.toolCall!.name).toContain(EXEC);
      expect(judged).toEqual([level === "unlimited" ? "run" : "card"]);
      expect(answers).toHaveLength(1);
      expect(answers[0]).toMatchObject({ behavior: "allow" });
      expect(answers[0]).not.toHaveProperty("updatedInput");
      // the dispatch: the MCP server ran the engine's OWN alias call with the model's arguments, not the rewritten body
      const ran = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
      expect(ran).toEqual([{ name: "gmail_send_email", arguments: SEND }]);
    });
  }
});
