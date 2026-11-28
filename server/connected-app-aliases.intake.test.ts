// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// F11-V3 (1.0.23) card side: a plain-name app call (`gmail_send_email`) is filed ONCE, at the bus, as the equal
// execute call, so every reader (decision snapshot, execution fold, stop line, grant, card text) judges the same call.
// Witnesses W1 W3 W5 W9 W9b W11 W13 of designs/F11-V3-APP-ALIASES-1023.md. Real bus, real readers, no mock of the
// thing under test; the engine events mirror what each driver files (server/drivers/*.ts request.opened).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureDirs } from "./config.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { makeFakeDriver } from "./testing/fake-driver.ts";
import { EventBus } from "./harness/bus.ts";
import { cardDetail, boundedToolInput } from "./approval-text.ts";
import { plainApproval } from "../shared/approval-plain.ts";
import { classifyAsk, classifyAskRows, type StopLinePlace } from "./stop-line.ts";
import { autoVerdict } from "./auto-approve.ts";
import { actionGrantRead, type EngineKind } from "../shared/app-action-grant.ts";
import { ALIAS_ENGINES, aliasAsk, driverGetsAliases } from "../shared/connected-app-aliases.ts";
import { claudeMountRecords } from "./drivers/claude.ts";
import { antigravityMountRecords } from "./drivers/antigravity-relay.ts";
import type { McpMountRecord } from "../shared/mount-identity.ts";

const OWN: McpMountRecord = { engineName: "murage_connectors", mountId: "own:connector", provenance: "own" };
const CUSTOM_GMAIL: McpMountRecord = { engineName: "gmail", mountId: "custom:gmail", provenance: "custom" };
const EXTERNAL_SAME_NAME: McpMountRecord = { engineName: "murage_connectors", mountId: "external:claude:0123456789abcdef:murage_connectors", provenance: "external" };

const SEND = (to: string, account = "acct_a") => ({ account, arguments: { recipient_email: to, subject: "Hello", body: "Hi there" } });
const EXECUTE_BODY = (slug: string, account: string, args: Record<string, unknown>) => ({ tools: [{ tool_slug: slug, account, arguments: args }], sync_response_to_workbench: false });

/** What each driver files for one MCP ask on the connector mount (server/drivers/{claude,codex,pi,openai-chat,antigravity}.ts
 * request.opened): the tool-name spelling, the stamp, the summary and the mount records are that driver's. `tool` is the
 * tool part (an alias, or the execute tool in the engine's exposed spelling). */
type Spelling = { make: (tool: string, input: unknown, mounts?: McpMountRecord[]) => Record<string, unknown>; execute: string };
const ENGINES: Record<string, Spelling> = {
  claude: {
    execute: "APPS_MULTI_EXECUTE_TOOL",
    make: (tool, input, mounts) => ({ toolEngine: "claude", tool: `mcp__murage_connectors__${tool}`, summary: JSON.stringify(input).slice(0, 200), toolInput: boundedToolInput(input), toolCall: { name: `mcp__murage_connectors__${tool}`, input }, mcpMounts: mounts ?? claudeMountRecords(["murage_connectors"], "murage_connectors", new Set()) }),
  },
  codex: {
    execute: "APPS_MULTI_EXECUTE_TOOL",
    make: (tool, input, mounts) => ({ toolEngine: "codex", tool, summary: `use ${tool}`, toolInput: boundedToolInput(input), toolCall: { name: `mcp__murage_connectors__${tool}`, input }, mcpMounts: mounts ?? [OWN] }),
  },
  pi: {
    execute: "APPS_MULTI_EXECUTE_TOOL",
    make: (tool, input, mounts) => ({ toolEngine: "pi", tool: `mcp__murage_connectors__${tool}`, summary: tool, toolInput: boundedToolInput(input), toolCall: { name: `mcp__murage_connectors__${tool}`, input }, toolIdentity: { namespace: "mcp", name: `murage_connectors__${tool}` }, mcpMounts: mounts ?? [OWN] }),
  },
  chat: {
    execute: "APPS_MULTI_EXECUTE_TOOL",
    make: (tool, input, mounts) => ({ toolEngine: "chat", tool: `murage_connectors__${tool}`, summary: tool, toolInput: boundedToolInput(input), toolCall: { name: `murage_connectors__${tool}`, input }, toolIdentity: { namespace: "mcp", name: `murage_connectors__${tool}` }, mcpMounts: mounts ?? [OWN] }),
  },
  antigravity: {
    execute: "APPS_MULTI_EXECUTE_TOOL",
    make: (tool, input, mounts) => ({ toolEngine: "antigravity", tool: `mcp__murage_connectors__${tool}`, summary: tool, toolInput: boundedToolInput(input), toolCall: { name: `mcp__murage_connectors__${tool}`, input }, toolIdentity: { namespace: "mcp", name: `murage_connectors__${tool}` }, mcpMounts: mounts ?? antigravityMountRecords({ murage_connectors: {} }, { computer: "c", agents: "a", connector: "murage_connectors" }) }),
  },
};

const base = { eventId: "ev-1", provider: "fake", threadId: "thread-1", createdAt: "2026-01-01T00:00:00.000Z", type: "request.opened", requestId: "req-1", requestType: "permission", executionCwd: "/tmp/x" } as const;

/** One event through the REAL bus intake (EventBus.attach); returns what a subscriber of the bus received. */
async function through(event: Record<string, unknown>): Promise<RuntimeEvent & Record<string, any>> {
  ensureDirs();
  const fake = makeFakeDriver();
  await fake.driver.create({ instanceId: "inst-1", displayName: undefined, environment: {}, enabled: true, config: {} });
  const { instance, emit } = fake.created.get("inst-1")!;
  const bus = new EventBus();
  bus.attach([instance]);
  const seen: Array<RuntimeEvent & Record<string, any>> = [];
  bus.subscribe((e) => { if (e.type === "request.opened") seen.push(e as never); });
  emit({ ...base, ...event } as RuntimeEvent);
  expect(seen).toHaveLength(1);
  return seen[0]!;
}

const place = (extra: Partial<StopLinePlace> = {}): StopLinePlace => ({ cwd: "/tmp/x", roots: ["/tmp/x", "/tmp"], home: "/Users/ada", knownRecipients: new Set(["boss@example.com", "#general"]), realpath: (p: string) => p, ...extra });
const ask = (event: Record<string, any>) => ({ ...event, engine: event.toolEngine as EngineKind, tool: event.tool as string, summary: event.summary as string }) as any;
const card = (event: Record<string, any>) => plainApproval(event.tool, cardDetail(event as never));

describe("W3 the card names the action and the account (rows AND headline), through the real bus", () => {
  for (const [engine, spelling] of Object.entries(ENGINES).filter(([name]) => ALIAS_ENGINES.has(name as never))) {
    it(`${engine}: the alias ask the bus delivers equals the raw execute ask, field for field`, async () => {
      const aliased = await through(spelling.make("gmail_send_email", SEND("new@x.com")));
      const raw = await through(spelling.make(spelling.execute, EXECUTE_BODY("GMAIL_SEND_EMAIL", "acct_a", SEND("new@x.com").arguments)));
      // every field the card or a reader looks at (the summary wording is per engine; compared as the raw call's own)
      for (const key of ["tool", "toolCall", "toolIdentity", "toolInput", "summary", "mcpMounts", "toolEngine"]) expect(aliased[key], `${engine} ${key}`).toEqual(raw[key]);
      // the grant rows: slug and account are the ones the call named
      const read = actionGrantRead(aliased.tool, ask(aliased));
      expect(read.unread).toBeUndefined();
      expect(read.set?.keys).toEqual(["app-action:GMAIL_SEND_EMAIL"]);
      expect(read.set?.rows[0]).toMatchObject({ slug: "GMAIL_SEND_EMAIL", account: "acct_a" });
      // the headline words the card shows ("use Gmail to send email" with its To/Subject lines), identical to the raw call's
      if (aliased.toolInput) expect(card(aliased)).toBeDefined();
      expect(card(aliased)).toEqual(card(raw));
    });
  }
  it("the engine's own reply path is untouched: the event the bus rewrites is a copy, the driver's object keeps its alias call", async () => {
    const original = { ...base, ...ENGINES.claude!.make("gmail_send_email", SEND("new@x.com")) } as Record<string, any>;
    const before = JSON.stringify(original);
    const out = aliasAsk(original as never) as Record<string, any>;
    expect(out).not.toBe(original);
    expect(JSON.stringify(original)).toBe(before);
    expect(out.toolCall.input).toEqual(EXECUTE_BODY("GMAIL_SEND_EMAIL", "acct_a", SEND("new@x.com").arguments));
  });
});

describe("W1 mount proof: only the own connector record makes a plain name an app action", () => {
  it("own record: the grant is app-action:GMAIL_SEND_EMAIL with the row's account", async () => {
    const event = await through(ENGINES.claude!.make("gmail_send_email", SEND("new@x.com")));
    const read = actionGrantRead(event.tool, ask(event));
    expect(read.set?.keys).toEqual(["app-action:GMAIL_SEND_EMAIL"]);
    expect(read.set?.rows[0]?.account).toBe("acct_a");
  });
  it("a custom or an external server with the same tool name keeps its own mount-bound key, never an app-action key", async () => {
    for (const [label, mounts, name] of [["custom", [CUSTOM_GMAIL], "mcp__gmail__gmail_send_email"], ["external lookalike of the own name", [EXTERNAL_SAME_NAME], "mcp__murage_connectors__gmail_send_email"]] as const) {
      const event = await through({ ...ENGINES.claude!.make("gmail_send_email", SEND("new@x.com"), [...mounts]), tool: name, toolCall: { name, input: SEND("new@x.com") } });
      // not rewritten: the call keeps the name and the input the engine reported
      expect(event.toolCall.name, label).toBe(name);
      expect(event.toolCall.input, label).toEqual(SEND("new@x.com"));
      const read = actionGrantRead(event.tool, ask(event));
      for (const key of read.set?.keys ?? []) expect(key, label).toMatch(/^acp-tool:v2:/);
      expect(read.set?.keys.some((key) => key.startsWith("app-action:")), label).toBe(false);
    }
  });
});

describe("W15b (r2, SITES.md) the alias card names the account and the recipient on every engine, with or without the driver's preview", () => {
  for (const [engine, spelling] of Object.entries(ENGINES).filter(([name]) => ALIAS_ENGINES.has(name as never))) {
    for (const preview of [true, false]) {
      it(`${engine}: ${preview ? "driver preview filed" : "no driver preview"}`, async () => {
        const filed = spelling.make("gmail_send_email", SEND("new@x.com", "acct_card"));
        if (!preview) delete filed.toolInput;
        const event = await through(filed);
        expect(event.toolCall.input).toEqual(EXECUTE_BODY("GMAIL_SEND_EMAIL", "acct_card", SEND("new@x.com").arguments));
        const detail = cardDetail(event as never);
        expect(detail).toContain("acct_card");
        expect(detail).toContain("new@x.com");
      });
    }
  }
});

describe("W5 no account is picked for the bot: a call without `account` is unread at every level", () => {
  const noAccount = { arguments: { recipient_email: "boss@example.com" } };
  const malformedRaw = { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", account: "", arguments: { recipient_email: "boss@example.com" } }], sync_response_to_workbench: false };
  it("is `unread-call` at Ask, Auto and Full access, with no standing grant, the same as a malformed raw execute call", async () => {
    const aliased = await through(ENGINES.claude!.make("gmail_send_email", noAccount));
    const raw = await through(ENGINES.claude!.make(ENGINES.claude!.execute, malformedRaw));
    const read = actionGrantRead(aliased.tool, ask(aliased));
    expect(read.set).toBeNull();
    expect(read.unread).toBeTruthy();
    expect(actionGrantRead(raw.tool, ask(raw)).set).toBeNull();
    for (const bot of [{ autoApprove: false }, { autoApprove: true }, { autoApprove: true, fullAccess: true }] as const) {
      const verdict = autoVerdict(bot as never, aliased.tool, aliased.summary, { call: ask(aliased), stopLine: null });
      const want = autoVerdict(bot as never, raw.tool, raw.summary, { call: ask(raw), stopLine: null });
      expect(verdict.source, JSON.stringify(bot)).toBe("unread-call");
      expect(verdict.approve, JSON.stringify(bot)).toBeNull();
      expect({ source: verdict.source, approve: verdict.approve }).toEqual({ source: want.source, approve: want.approve });
    }
  });
});

describe("W9 / W9b the stop line judges the alias exactly as the raw execute call", () => {
  for (const [engine, spelling] of Object.entries(ENGINES).filter(([name]) => ALIAS_ENGINES.has(name as never))) {
    for (const [label, input, slug, known] of [
      ["gmail outside recipient", SEND("new@x.com"), "GMAIL_SEND_EMAIL", false],
      ["gmail KNOWN recipient (W9b)", SEND("boss@example.com"), "GMAIL_SEND_EMAIL", true],
      ["slack message to a known channel (W9b)", { account: "acct_s", arguments: { channel: "#general", text: "hi" } }, "SLACK_SEND_MESSAGE", true],
      ["slack message to an unknown channel", { account: "acct_s", arguments: { channel: "#elsewhere", text: "hi" } }, "SLACK_SEND_MESSAGE", false],
    ] as const) {
      it(`${engine}: ${label}`, async () => {
        const alias = slug.toLowerCase();
        const aliased = await through(spelling.make(alias, input));
        const raw = await through(spelling.make(spelling.execute, EXECUTE_BODY(slug, input.account, input.arguments as Record<string, unknown>)));
        const got = classifyAsk(ask(aliased), place());
        const want = classifyAsk(ask(raw), place());
        expect(got).toEqual(want);
        expect(classifyAskRows(ask(aliased), place())).toEqual(classifyAskRows(ask(raw), place()));
        // W9b: a known recipient passes, and an unknown one stops, on BOTH (the alias is no way round the stop line, and no new prompt)
        expect(got === null).toBe(known);
      });
    }
  }
});

describe("W11 per engine: the table, and the ask facts that prove the mount", () => {
  it("the engine table is exactly the engines whose asks prove the own mount; ACP (stamped or not) is out", () => {
    expect([...ALIAS_ENGINES].sort()).toEqual(["chat", "claude", "codex"]);
    expect(ALIAS_ENGINES.has("acp")).toBe(false);
  });
  for (const [engine, spelling] of Object.entries(ENGINES).filter(([name]) => ALIAS_ENGINES.has(name as never))) {
    it(`${engine}: the driver's ask resolves to the own mount and the ask input is the call's arguments`, async () => {
      const input = SEND("new@x.com");
      const event = await through(spelling.make("gmail_send_email", input));
      expect(event.toolCall.input).toEqual(EXECUTE_BODY("GMAIL_SEND_EMAIL", "acct_a", input.arguments));
      // the literal arguments the MCP tools/call carries are the alias input; the rewritten body is built from them unchanged
      expect(event.toolCall.input.tools[0].arguments).toBe(input.arguments);
    });
  }
  it("pi is disabled until proven: its ask is never rewritten, and its driver gets no alias flag", async () => {
    expect(ALIAS_ENGINES.has("pi")).toBe(false);
    expect(driverGetsAliases("piAgent")).toBe(false);
    const event = await through(ENGINES.pi!.make("gmail_send_email", SEND("new@x.com")));
    expect(event.toolCall.name).toBe("mcp__murage_connectors__gmail_send_email");
    expect(event.toolCall.input).toEqual(SEND("new@x.com"));
  });
  it("antigravity is disabled until proven on its real CLI: its ask is never rewritten, and its driver gets no alias flag", async () => {
    const event = await through(ENGINES.antigravity!.make("gmail_send_email", SEND("new@x.com")));
    expect(event.toolCall.name).toBe("mcp__murage_connectors__gmail_send_email");
    expect(event.toolCall.input).toEqual(SEND("new@x.com"));
    expect(driverGetsAliases("antigravityAgent")).toBe(false);
  });
  it("an ACP ask (unstamped, or stamped) is never rewritten, whatever its mounts prove", async () => {
    for (const toolIdentity of [undefined, { namespace: "mcp", name: "murage_connectors__gmail_send_email" }]) {
      const event = await through({ toolEngine: "acp", tool: "gmail_send_email", summary: "x", toolKind: "other", toolCall: { name: "gmail_send_email", input: SEND("new@x.com") }, ...(toolIdentity ? { toolIdentity } : {}), mcpMounts: [OWN] });
      expect(event.toolCall.input).toEqual(SEND("new@x.com"));
    }
  });
});

describe("W13 one intake", () => {
  it("both broker paths and the registration snapshot read the event the bus delivered (a bus subscriber sees the rewrite)", async () => {
    const event = await through(ENGINES.claude!.make("gmail_send_email", SEND("new@x.com")));
    expect(event.toolCall.name).toBe("mcp__murage_connectors__APPS_MULTI_EXECUTE_TOOL");
    expect(JSON.parse(event.toolInput)).toEqual(EXECUTE_BODY("GMAIL_SEND_EMAIL", "acct_a", SEND("new@x.com").arguments));
  });
  it("source check: exactly one call site of aliasAsk in server code, and it is the bus intake", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (name === "node_modules" || name === "testing") continue;
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) for (const line of readFileSync(path, "utf8").split("\n")) if (/\baliasAsk\(/.test(line) && !/^\s*(\/\/|\*)/.test(line) && !/export function aliasAsk/.test(line)) hits.push(`${path}: ${line.trim()}`);
      }
    };
    walk(join(import.meta.dirname, "."));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/harness\/bus\.ts/);
  });
});
