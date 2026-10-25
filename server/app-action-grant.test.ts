// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Always allow" on a connected-app card remembers the one action the card
// showed, never the tool every action runs through. Before 1.0.3 a Fuigo card
// saved the bare ACP kind "other", which then answered every connected-app
// action (and every other MCP tool) for good.
//
// Every reader fails closed (lanes/release103/APP-GRANT-FAIL-CLOSED.md): an
// identity is proven against the turn's mounts, a scan that runs out holds, a
// wrapper is opened under a cap, and a grant not in a current shape is dropped.
import { SCAN_DEPTH } from "../shared/scan-limits.ts";
import { acpToolKey, type McpMountRecord } from "../shared/mount-identity.ts";
import { describe, expect, it } from "vitest";

import { WRAP_DEPTH, actionGrantKey, commandArgument, placeArgumentScan, resolveCall, type GrantCall } from "../shared/app-action-grant.ts";
import { actionGrantWords, isStaleGrant, withoutStaleGrants } from "../shared/app-action-words.ts";
import { approvalKey, autoVerdict, type AutoApprover } from "./auto-approve.ts";
import { acpStampedIdentity } from "./drivers/acp/core.ts";
import { PI_GATE_MESSAGE_MAX, piGateMessage } from "./drivers/pi-permission-gate.ts";
import { piGateAsk } from "./drivers/pi.ts";
import { mcpServerNameError } from "./mcp-registry.ts";
import { classifyAsk, type StopLinePlace } from "./stop-line.ts";

type Ask = GrantCall & { tool: string; summary: string };

const run = (...slugs: string[]) => ({ tools: slugs.map((tool_slug) => ({ tool_slug, arguments: {} })) });
const stamp = (name: string) => ({ namespace: "mcp", name });
/** F4 records for server names the way the drivers write them (Rule 54):
 * Murage's own by builtin, every other one the owner's custom server. */
const OWN_ID: Record<string, string> = { agents: "own:agents", "murage-memory": "own:memory", computer: "own:computer", browser: "own:browser", murage_connectors: "own:connector", composio: "own:connector" };
const records = (names: readonly string[]): McpMountRecord[] =>
  names.map((engineName) => OWN_ID[engineName] ? { engineName, mountId: OWN_ID[engineName]!, provenance: "own" as const } : { engineName, mountId: `custom:${engineName}`, provenance: "custom" as const });
/** The mounts an ACP turn hands its engine: Murage's own and the owner's. */
const MOUNTS = records(["agents", "murage-memory", "computer", "browser", "murage_connectors", "github", "custom", "filesystem"]);

/** A Fuigo ask the way server/drivers/acp/core.ts files it: kind "other",
 * the title as the call's name, the stamped identity, the raw input and the
 * turn's mounts (null: the driver sent no list). */
function fuigo(input: unknown, identity: GrantCall["toolIdentity"] = stamp("murage_connectors__APPS_MULTI_EXECUTE_TOOL"), mounts: readonly McpMountRecord[] | null = MOUNTS): Ask {
  return { tool: "other", summary: "Run app tools", toolKind: "other", toolIdentity: identity, toolCall: { name: "Run app tools", input }, ...(mounts ? { mcpMounts: mounts } : {}) };
}
/** A Claude ask: the engine's own tool name and input. */
function claude(input: unknown, name = "mcp__murage_connectors__APPS_MULTI_EXECUTE_TOOL"): Ask {
  return { tool: name, summary: JSON.stringify(input), toolCall: { name, input } };
}
/** A Pi ask the way server/drivers/pi.ts files it: the label "Connected app"
 * and the driver's own name for the tool. */
function pi(tool: string, input: unknown): Ask {
  return { tool: "Connected app", summary: tool.toLowerCase(), toolCall: { name: `mcp__murage_connectors__${tool}`, input } };
}
/** `use_tool` around a call, `depth` times. */
function wrapped(name: string, input: unknown, depth: number, mounts: readonly McpMountRecord[] | null = MOUNTS): Ask {
  let body: unknown = { variant: "UseTool", tool_name: name, tool_input: input };
  for (let i = 1; i < depth; i++) body = { variant: "UseTool", tool_name: "use_tool", tool_input: body };
  return fuigo(body, { namespace: "fuigo_build", name: "use_tool", kind: "use_tool" }, mounts);
}
const keyOf = (ask: Ask) => approvalKey(ask.tool, ask.summary, undefined, ask);
const verdict = (bot: AutoApprover, ask: Ask, extra = {}) => autoVerdict(bot, ask.tool, ask.summary, { call: ask, ...extra });
const levels = (key: string): AutoApprover[] => [
  { alwaysAllow: [key] },
  { alwaysAllow: [key], autoApprove: true },
  { alwaysAllow: [key], autoApprove: true, fullAccess: true },
  { alwaysAllow: [key], autoApprove: true, fullAccess: true, noLimits: true },
];
const place: StopLinePlace = { home: "/Users/ada", cwd: "/Users/ada/work", roots: ["/Users/ada/work"], knownRecipients: new Set(["ada@example.com"]), realpath: (p: string) => p };

describe("the key a connected-app card offers", () => {
  it("names the app and the action on Fuigo, Claude, Pi and a wrapped call alike", () => {
    expect(keyOf(fuigo(run("GMAIL_FETCH_EMAILS")))).toBe("app-action:GMAIL_FETCH_EMAILS");
    expect(keyOf(claude(run("GMAIL_SEND_EMAIL")))).toBe("app-action:GMAIL_SEND_EMAIL");
    expect(keyOf(claude(run("SLACK_SEND_MESSAGE"), "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL"))).toBe("app-action:SLACK_SEND_MESSAGE");
    expect(keyOf(pi("APPS_MULTI_EXECUTE_TOOL", run("GMAIL_FETCH_EMAILS")))).toBe("app-action:GMAIL_FETCH_EMAILS");
    expect(keyOf(wrapped("murage_connectors__APPS_MULTI_EXECUTE_TOOL", run("GMAIL_FETCH_EMAILS"), 1))).toBe("app-action:GMAIL_FETCH_EMAILS");
  });

  it("tells reading mail from sending it, and Gmail from Slack", () => {
    const keys = ["GMAIL_FETCH_EMAILS", "GMAIL_SEND_EMAIL", "SLACK_SEND_MESSAGE"].map((slug) => keyOf(fuigo(run(slug))));
    expect(new Set(keys).size).toBe(3);
  });

  it("never offers the bare kind, the execute tool or Pi's label", () => {
    for (const ask of [fuigo(run("GMAIL_FETCH_EMAILS")), claude(run("GMAIL_FETCH_EMAILS")), pi("APPS_MULTI_EXECUTE_TOOL", run("GMAIL_FETCH_EMAILS"))]) {
      const key = keyOf(ask)!;
      expect(key).not.toBe("other");
      expect(key).not.toBe("Connected app");
      expect(isStaleGrant(key)).toBe(false);
    }
  });

  it("offers no standing grant where one action cannot be named", () => {
    const none = [
      // two actions at once
      fuigo(run("GMAIL_FETCH_EMAILS", "GMAIL_SEND_EMAIL")),
      // an unrecognised shape
      fuigo({ tools: [{ tool_slug: "GMAIL_SEND_EMAIL" }], extra: true }),
      fuigo({ tool_slug: "GMAIL_SEND_EMAIL" }),
      // no input at all
      fuigo(undefined),
      // the remote shell and connection management run anything
      fuigo({ command: "ls" }, stamp("murage_connectors__APPS_REMOTE_BASH_TOOL")),
      fuigo({}, stamp("murage_connectors__APPS_MANAGE_CONNECTIONS")),
      // an ACP call with no stamp: its title is the model's words
      { tool: "other", summary: "mcp__murage_connectors__APPS_MULTI_EXECUTE_TOOL", toolKind: "other", toolCall: { name: "mcp__murage_connectors__APPS_MULTI_EXECUTE_TOOL", input: run("GMAIL_FETCH_EMAILS") }, mcpMounts: MOUNTS },
      // a Fuigo tool of its own filed as "other"
      fuigo({}, { namespace: "fuigo_build", name: "web_search" }),
      // a wrapper with anything beside one name and one input
      fuigo({ variant: "UseTool", tool_name: "murage_connectors__APPS_MULTI_EXECUTE_TOOL", tool_input: run("GMAIL_FETCH_EMAILS"), more: 1 }, { namespace: "fuigo_build", name: "use_tool" }),
      // the execute tool named without its call
      { tool: "mcp__murage_connectors__APPS_MULTI_EXECUTE_TOOL", summary: JSON.stringify(run("GMAIL_FETCH_EMAILS")) },
      { tool: "other", summary: "anything" },
      { tool: "use_tool", summary: "anything" },
      { tool: "Connected app", summary: "anything" },
    ];
    for (const ask of none) expect(keyOf(ask as never), JSON.stringify(ask)).toBeUndefined();
  });

  it("names a stamped MCP tool by its stamped name, server included, never normalised", () => {
    expect(keyOf(fuigo({ title: "x" }, stamp("github__create_issue")))).toBe(acpToolKey("custom:github", "create_issue"));
    expect(keyOf(fuigo({}, stamp("murage_connectors__APPS_SEARCH_TOOLS")))).toBe("mcp__murage_connectors__APPS_SEARCH_TOOLS");
    // a server that is not Murage's is never read as connected apps
    expect(keyOf(fuigo(run("GMAIL_SEND_EMAIL"), stamp("custom__COMPOSIO_MULTI_EXECUTE_TOOL")))).toBe(acpToolKey("custom:custom", "COMPOSIO_MULTI_EXECUTE_TOOL"));
  });

  it("writes a lookup grant in one spelling on every engine", () => {
    const key = "mcp__murage_connectors__APPS_SEARCH_TOOLS";
    expect(keyOf(claude({ query: "mail" }, "mcp__murage_connectors__APPS_SEARCH_TOOLS"))).toBe(key);
    expect(keyOf(claude({ query: "mail" }, "mcp__composio__COMPOSIO_SEARCH_TOOLS"))).toBe(key);
    expect(keyOf(pi("APPS_SEARCH_TOOLS", { query: "mail" }))).toBe(key);
    expect(keyOf({ tool: "murage_connectors/APPS_SEARCH_TOOLS", summary: "search" })).toBe(key);
    expect(isStaleGrant(key)).toBe(false);
  });

  it("keeps two servers that offer the same action apart", () => {
    // the owner's custom github and an external server of the same tool, by another name
    const mounts = [...MOUNTS, { engineName: "gh2", mountId: "external:codex:0123456789abcdef:gh2", provenance: "external" as const }];
    const plain = fuigo({}, stamp("github__create_issue"), mounts);
    const prefixed = fuigo({}, stamp("gh2__create_issue"), mounts);
    expect(keyOf(plain)).not.toBe(keyOf(prefixed));
    const bot = { alwaysAllow: [keyOf(plain)!] };
    expect(verdict(bot, plain)).toMatchObject({ source: "always-allow" });
    expect(verdict(bot, prefixed)).toMatchObject({ approve: null, source: "no-grant" });
    expect(verdict({ alwaysAllow: [keyOf(prefixed)!] }, plain)).toMatchObject({ approve: null, source: "no-grant" });
    // and a grant another engine keeps under its own name answers neither
    expect(verdict({ alwaysAllow: ["mcp__github__create_issue"] }, plain)).toMatchObject({ approve: null, source: "no-grant" });
  });

  it("leaves every other tool's grant as it was", () => {
    expect(actionGrantKey("Bash")).toBeUndefined();
    expect(approvalKey("Bash", "git status")).toBe("Bash:git");
    expect(approvalKey("Read", "src/index.ts")).toBe("Read");
    expect(approvalKey("mcp__murage_connectors__APPS_SEARCH_TOOLS", "search")).toBe("mcp__murage_connectors__APPS_SEARCH_TOOLS");
  });
});

describe("identity is proven against the turn's mounts, never read from a name", () => {
  const fetchMail = run("GMAIL_FETCH_EMAILS");

  it("keeps a custom mount named mcp__murage_connectors apart from the connector (Astra r2)", () => {
    // a mount named so cannot exist (Rule 11); one spelled to pass for the
    // connector is custom by its record, never own
    const mounts = [...MOUNTS, ...records(["murage-connectors"])];
    const real = fuigo(fetchMail, stamp("murage_connectors__APPS_MULTI_EXECUTE_TOOL"), mounts);
    const fake = fuigo(fetchMail, stamp("murage-connectors__APPS_MULTI_EXECUTE_TOOL"), mounts);
    expect(resolveCall(fake)).toMatchObject({ kind: "mcp", server: "murage-connectors", own: false });
    expect(keyOf(real)).toBe("app-action:GMAIL_FETCH_EMAILS");
    // a look-alike mount is keyed as the custom mount it is, never as the connector
    expect(keyOf(fake)).toBe(acpToolKey("custom:murage-connectors", "APPS_MULTI_EXECUTE_TOOL"));
    expect(verdict({ alwaysAllow: [keyOf(real)!] }, fake)).toMatchObject({ approve: null, source: "no-grant" });
    expect(verdict({ alwaysAllow: ["acp-tool:mcp:mcp__murage_connectors__APPS_MULTI_EXECUTE_TOOL"] }, real)).toMatchObject({ approve: null, source: "no-grant" });
    // and the registry never lets such a mount be named
    expect(mcpServerNameError("mcp__murage_connectors")).not.toBeNull();
    expect(mcpServerNameError("murage_connectors_x")).not.toBeNull();
    expect(mcpServerNameError("composio_tools")).not.toBeNull();
    expect(mcpServerNameError("a__b")).not.toBeNull();
    expect(mcpServerNameError("my-github")).toBeNull();
  });

  it("holds a stamp that fits no mount, two mounts, no list, or that could not be read, at every level", () => {
    const unproven: Ask[] = [
      fuigo(fetchMail, stamp("murage_connectors__APPS_MULTI_EXECUTE_TOOL"), []),
      fuigo(fetchMail, stamp("murage_connectors__APPS_MULTI_EXECUTE_TOOL"), null),
      fuigo({}, stamp("a__b__c"), [...records(["a"]), { engineName: "a__b", mountId: "custom:a__b", provenance: "custom" }]),
      fuigo({}, stamp("github__create_issue"), records(["gitlab"])),
      fuigo({}, stamp("memory_search")),
      // the driver found a stamp it could not read
      fuigo(fetchMail, { namespace: "", name: "" }),
    ];
    for (const ask of unproven) {
      expect(resolveCall(ask).kind, JSON.stringify(ask)).toBe("unproven");
      expect(keyOf(ask), JSON.stringify(ask)).toBeUndefined();
      const hit = classifyAsk(ask, place);
      expect(hit, JSON.stringify(ask)).toMatchObject({ kind: "delete" });
      for (const bot of levels("app-action:GMAIL_FETCH_EMAILS")) {
        expect(verdict(bot, ask, { stopLine: hit }), JSON.stringify([ask, bot])).toMatchObject({ approve: null, source: "unread-call" });
        expect(verdict(bot, ask), JSON.stringify([ask, bot])).toMatchObject({ approve: null, source: "unread-call" });
      }
    }
  });

  it("keys a stamped MCP tool by itself even under a named kind", () => {
    const read = { ...fuigo({ path: "README.md" }, stamp("filesystem__read_file")), tool: "read", toolKind: "read" };
    expect(keyOf(read)).toBe(acpToolKey("custom:filesystem", "read_file"));
    expect(verdict({ alwaysAllow: ["read"] }, read)).toMatchObject({ approve: null, source: "no-grant" });
  });
});

describe("what a remembered connected-app grant answers", () => {
  const fetchMail = fuigo(run("GMAIL_FETCH_EMAILS"));
  const sendMail = fuigo(run("GMAIL_SEND_EMAIL"));
  const github = fuigo({}, stamp("github__create_issue"));

  it("answers the one action it names, on any engine, and nothing else", () => {
    const bot = { alwaysAllow: [keyOf(fetchMail)!] };
    expect(verdict(bot, fetchMail)).toMatchObject({ source: "always-allow", rule: "app-action:GMAIL_FETCH_EMAILS" });
    expect(verdict(bot, claude(run("GMAIL_FETCH_EMAILS")))).toMatchObject({ source: "always-allow" });
    expect(verdict(bot, pi("APPS_MULTI_EXECUTE_TOOL", run("GMAIL_FETCH_EMAILS")))).toMatchObject({ source: "always-allow" });
    expect(verdict(bot, sendMail)).toMatchObject({ approve: null, source: "no-grant" });
    expect(verdict(bot, github)).toMatchObject({ approve: null, source: "no-grant" });
    expect(verdict(bot, fuigo(run("GMAIL_FETCH_EMAILS", "GMAIL_SEND_EMAIL")))).toMatchObject({ approve: null, source: "no-grant" });
  });

  it("gives a grant saved before 1.0.3 nothing to match", () => {
    const old = { alwaysAllow: ["other", "mcp__murage_connectors__APPS_MULTI_EXECUTE_TOOL", "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", "use_tool", "Connected app"] };
    for (const ask of [fetchMail, sendMail, github, claude(run("GMAIL_SEND_EMAIL")), pi("APPS_MULTI_EXECUTE_TOOL", run("GMAIL_SEND_EMAIL")), pi("APPS_SEARCH_TOOLS", { query: "x" })]) {
      expect(verdict(old, ask), JSON.stringify(ask)).toMatchObject({ approve: null, source: "no-grant" });
    }
    // and without the engine's facts the bare kind is never a key either
    expect(autoVerdict(old, "other", "Run app tools")).toMatchObject({ approve: null, source: "no-grant" });
    expect(autoVerdict(old, "Connected app", "apps_search_tools")).toMatchObject({ approve: null, source: "no-grant" });
  });

  it("never answers past the guards, at any level", () => {
    const key = keyOf(fetchMail)!;
    const reading = fuigo({ tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: { query: "x" } }] });
    const secret = { ...reading, summary: "cat ~/.ssh/id_rsa" };
    const wipe = { ...reading, summary: "rm -rf /" };
    for (const bot of levels(key)) {
      expect(verdict(bot, secret), JSON.stringify(bot)).toMatchObject({ approve: null, source: "sensitive-guard" });
    }
    // deleting the drive is one of the commands that always ask, ahead of every grant and level
    for (const bot of levels(key).slice(0, 2)) {
      expect(verdict(bot, wipe), JSON.stringify(bot)).toMatchObject({ approve: null, source: "always-ask" });
    }
    // a turn nobody is at, and host control, still hold a granted action
    expect(verdict({ alwaysAllow: [key] }, fetchMail, { unattended: true })).toMatchObject({ approve: null, source: "unattended-block" });
    expect(verdict({ alwaysAllow: [`local-computer:${key}`] }, fetchMail, { scope: "local-computer" })).toMatchObject({ approve: null, source: "local-computer-block" });
  });
});

describe("grants not in a shape the key builder writes", () => {
  it("are dropped in every spelling an older release or engine saved", () => {
    for (const key of [
      "other", "OTHER", "tool", "use_tool", "local-computer:other", "Connected app", "connected app",
      "mcp__murage_connectors__APPS_MULTI_EXECUTE_TOOL", "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL",
      "murage_connectors__APPS_REMOTE_BASH_TOOL", "COMPOSIO_MULTI_EXECUTE_TOOL", "APPS_MULTI_EXECUTE_TOOL",
      "composio_composio_remote_workbench", "mcp__murage_connectors__APPS_MANAGE_CONNECTIONS",
      // a lookup in an engine's own spelling, not the builder's
      "murage_connectors_apps_search_tools", "murage_connectors/APPS_SEARCH_TOOLS", "composio:COMPOSIO_SEARCH_TOOLS",
      "mcp__composio__COMPOSIO_GET_TOOL_SCHEMAS", "mcp__murage_connectors__COMPOSIO_SEARCH_TOOLS", "mcp__murage_connectors__apps_search_tools",
      // this lane's prefixes over something the builder never writes
      "acp-tool:mcp:murage_connectors__APPS_MULTI_EXECUTE_TOOL", "acp-tool:mcp:mcp__murage_connectors__APPS_MULTI_EXECUTE_TOOL",
      "acp-tool:mcp:other", "acp-tool:mcp:nounderscore", "app-action:COMPOSIO_MULTI_EXECUTE_TOOL", "app-action:gmail_send_email", "app-action:GMAIL",
      "local-computer:acp-tool:mcp:composio__COMPOSIO_SEARCH_TOOLS",
    ]) expect(isStaleGrant(key), key).toBe(true);
  });

  it("leave every grant the builder writes, and every grant outside the domain, alone", () => {
    const kept = [
      "Bash:git", "Read", "app-action:GMAIL_SEND_EMAIL", "mcp__murage_connectors__APPS_SEARCH_TOOLS",
      "local-computer:app-action:GMAIL_SEND_EMAIL", acpToolKey("custom:github", "create_issue"), acpToolKey("custom:custom", "COMPOSIO_MULTI_EXECUTE_TOOL"),
      "mcp__github__create_issue", "mcp__custom__COMPOSIO_MULTI_EXECUTE_TOOL",
      "stop:pay:acme", 'exact:["claude","/tmp","ls"]', "local-computer:mcp__computer__click",
    ];
    expect(withoutStaleGrants([...kept, "other", "mcp__murage_connectors__APPS_MULTI_EXECUTE_TOOL", "Connected app"])).toEqual(kept);
  });
});

describe("a connected-app grant in plain words", () => {
  it("names the app and the action", () => {
    expect(actionGrantWords("app-action:GMAIL_SEND_EMAIL")).toBe("Gmail: send email");
    expect(actionGrantWords("app-action:GOOGLECALENDAR_EVENTS_LIST")).toBe("Google Calendar: events list");
    expect(actionGrantWords("mcp__murage_connectors__APPS_SEARCH_TOOLS")).toBe("Connected apps: find app tools");
    expect(actionGrantWords("Bash:git")).toBeUndefined();
    for (const words of [actionGrantWords("app-action:GMAIL_SEND_EMAIL")!, actionGrantWords("mcp__composio__COMPOSIO_SEARCH_TOOLS")!]) {
      expect(words).not.toMatch(/composio|—/i);
    }
  });
});

describe("the stop line judges the tool the engine stamped, never the title", () => {
  const sendInput = { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "stranger@example.com", body: "hi" } }] };
  const send = fuigo(sendInput);
  const remove = fuigo({ tools: [{ tool_slug: "GMAIL_DELETE_MESSAGE", arguments: { message_id: "m1" } }] });
  const wrappedSend = wrapped("murage_connectors__APPS_MULTI_EXECUTE_TOOL", sendInput, 1);

  it("stops a send to someone new and a delete under a neutral title", () => {
    expect(send.toolCall!.name).toBe("Run app tools");
    expect(classifyAsk(send, place)).toMatchObject({ kind: "message" });
    expect(classifyAsk(wrappedSend, place)).toMatchObject({ kind: "message" });
    expect(classifyAsk(remove, place)).not.toBeNull();
    // the same send to someone it already writes to passes, as before
    const known = fuigo({ tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "ada@example.com" } }] });
    expect(classifyAsk(known, place)).toBeNull();
  });

  it("lets a title add a stop, never clear one, and stops a stamp it cannot read", () => {
    const titled = { ...fuigo({ path: "/Users/ada/elsewhere/x" }, { namespace: "fuigo_build", name: "web_search" }), toolCall: { name: "delete", input: { path: "/Users/ada/elsewhere/x" } } };
    expect(classifyAsk(titled, place)).toMatchObject({ kind: "delete" });
    const broken = fuigo({ variant: "UseTool", tool_name: "x__y" }, { namespace: "fuigo_build", name: "use_tool" });
    expect(classifyAsk(broken, place)).toMatchObject({ kind: "delete" });
  });

  it("stops a send whose recipient it cannot read", () => {
    const hidden = fuigo({ tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { recipient_email: ["ada@example.com", { nested: { deeper: { email: "stranger@example.com" } } }] } }] });
    expect(classifyAsk(hidden, place)).toMatchObject({ kind: "message" });
    const flag = fuigo({ tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { recipient_email: true } }] });
    expect(classifyAsk(flag, place)).toMatchObject({ kind: "message" });
  });

  it("holds the stopped call at Ask, Auto and Full access, granted or not", () => {
    for (const ask of [send, remove, wrappedSend]) {
      const hit = classifyAsk(ask, place);
      const key = keyOf(ask)!;
      for (const bot of levels(key).slice(0, 3)) {
        expect(verdict(bot, ask, { stopLine: hit }), JSON.stringify(bot)).toMatchObject({ approve: null, source: "stop-line" });
      }
      // No limits lifts the stop line only for the owner's own turns; a
      // routine or unattended run on No limits still stops
      const unlimited = { alwaysAllow: [key], autoApprove: true, fullAccess: true, noLimits: true };
      expect(verdict(unlimited, ask, { stopLine: hit, automated: true, routineLevel: true }).approve).toBeNull();
      expect(verdict(unlimited, ask, { stopLine: hit, unattended: true }).approve).toBeNull();
    }
  });
});

describe("wrappers are opened to a fixed point under a cap, and both readers see the same call", () => {
  const sendInput = { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "stranger@example.com", body: "hi" } }] };

  it("reads a doubly and triply wrapped send as the send (Astra r2)", () => {
    for (const depth of [2, 3]) {
      const ask = wrapped("murage_connectors__APPS_MULTI_EXECUTE_TOOL", sendInput, depth);
      expect(resolveCall(ask), `depth ${depth}`).toMatchObject({ kind: "mcp", server: "murage_connectors", own: true });
      expect(keyOf(ask), `depth ${depth}`).toBe("app-action:GMAIL_SEND_EMAIL");
      const hit = classifyAsk(ask, place);
      expect(hit, `depth ${depth}`).toMatchObject({ kind: "message" });
      const unlimited = { alwaysAllow: ["app-action:GMAIL_SEND_EMAIL"], autoApprove: true, fullAccess: true, noLimits: true };
      expect(verdict(unlimited, ask, { stopLine: hit, automated: true, routineLevel: true }).approve).toBeNull();
      expect(verdict({ alwaysAllow: ["app-action:GMAIL_SEND_EMAIL"] }, ask, { stopLine: hit })).toMatchObject({ approve: null, source: "stop-line" });
    }
  });

  it("holds a call wrapped past the cap, or a wrapper that names no tool", () => {
    const deep = wrapped("murage_connectors__APPS_MULTI_EXECUTE_TOOL", sendInput, WRAP_DEPTH + 1);
    const blank = wrapped("other", sendInput, 1);
    const stray = wrapped("github__create_issue", {}, 1, records(["gitlab"]));
    for (const ask of [deep, blank, stray]) {
      expect(resolveCall(ask).kind).toBe("unproven");
      expect(keyOf(ask)).toBeUndefined();
      expect(classifyAsk(ask, place)).toMatchObject({ kind: "delete" });
      for (const bot of levels("app-action:GMAIL_SEND_EMAIL")) expect(verdict(bot, ask).approve).toBeNull();
    }
  });

  it("judges a wrapped engine tool by that tool and its own arguments", () => {
    const shell = wrapped("run_terminal_command", { command: "rm -rf /Users/ada/elsewhere" }, 2);
    expect(resolveCall(shell)).toMatchObject({ kind: "engine", name: "run_terminal_command", wrapped: true });
    expect(keyOf(shell)).toBeUndefined();
    expect(classifyAsk(shell, place)).toMatchObject({ kind: "delete" });
  });
});

describe("the key guard reads structured arguments, not only the title", () => {
  const read = (args: unknown) => fuigo({ tools: [{ tool_slug: "GITHUB_GET_REPOSITORY_CONTENT", arguments: args }] });

  it("holds a granted read of a key file at Ask, Auto, Full access and No limits", () => {
    for (const args of [
      { owner: "o", repo: "r", path: ".env" },
      { owner: "o", repo: "r", files: [{ file_path: "deploy/.ssh/id_ed25519" }] },
      { nested: { deeper: [{ query: "find ~/.aws/credentials" }] } },
    ]) {
      const ask = read(args);
      expect(ask.summary).toBe("Run app tools");
      for (const bot of levels(keyOf(ask)!)) {
        expect(verdict(bot, ask), JSON.stringify([args, bot])).toMatchObject({ approve: null, source: "sensitive-guard" });
      }
    }
  });

  it("still answers the same granted read of an ordinary file", () => {
    const ask = read({ owner: "o", repo: "r", path: "README.md" });
    expect(verdict({ alwaysAllow: [keyOf(ask)!] }, ask)).toMatchObject({ source: "always-allow" });
  });

  it("finds a key file past the old 2,000-node mark, and holds what it cannot scan whole (Astra r2; Rule 37 bounds)", () => {
    const many = (count: number, last: string) => fuigo({ paths: [...Array.from({ length: count }, (_, i) => `docs/page-${i}.md`), last] }, stamp("filesystem__read_multiple_files"));
    const found = many(30_000, ".env");
    expect(placeArgumentScan(found.toolCall!.input)).toMatchObject({ cut: false });
    // past the depth bound the scan is not the whole call
    let nested: unknown = ".env";
    for (let i = 0; i <= SCAN_DEPTH; i++) nested = [nested];
    const past = fuigo({ paths: nested }, stamp("filesystem__read_multiple_files"));
    expect(placeArgumentScan(past.toolCall!.input)).toMatchObject({ cut: true });
    // no per-string cap: a long string is read whole, and what it names is judged
    const long = fuigo({ query: `${"a".repeat(5_000)} ~/.ssh/id_rsa` }, stamp("filesystem__search_files"));
    expect(placeArgumentScan(long.toolCall!.input)).toMatchObject({ cut: false });
    for (const bot of levels(acpToolKey("custom:filesystem", "read_multiple_files"))) {
      expect(verdict(bot, found), JSON.stringify(bot)).toMatchObject({ approve: null, source: "sensitive-guard" });
      expect(verdict(bot, past), JSON.stringify(bot)).toMatchObject({ approve: null, source: "unread-call" });
    }
    expect(verdict({ alwaysAllow: [acpToolKey("custom:filesystem", "search_files")], autoApprove: true, fullAccess: true, noLimits: true }, long)).toMatchObject({ approve: null, source: "sensitive-guard" });
    // the same list without a key file is answered
    expect(verdict({ alwaysAllow: [acpToolKey("custom:filesystem", "read_multiple_files")] }, many(2_000, "docs/last.md"))).toMatchObject({ source: "always-allow" });
  });

  it("holds a call the driver cut before it could be checked", () => {
    const ask = { ...read({ owner: "o", repo: "r", path: "README.md" }), truncated: true };
    for (const bot of levels(keyOf(ask)!)) expect(verdict(bot, ask), JSON.stringify(bot)).toMatchObject({ approve: null, source: "unread-call" });
  });
});

describe("round 3: a missing, null, cut or unknown value never grants, approves or clears a stop", () => {
  const sendInput = { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "stranger@example.com", body: "hi" } }] };
  const unlimited: AutoApprover = { alwaysAllow: ["app-action:GMAIL_SEND_EMAIL", acpToolKey("custom:custom", "run"), "Bash:cat"], autoApprove: true, fullAccess: true, noLimits: true };
  /** Every level, plus a routine run and an unattended turn at No limits. */
  const holdsEverywhere = (ask: Ask, extra = {}) => {
    for (const bot of [...levels("app-action:GMAIL_SEND_EMAIL"), ...levels(acpToolKey("custom:custom", "run")), ...levels("Bash:cat")]) {
      expect(verdict(bot, ask, extra).approve, JSON.stringify([ask.tool, bot])).toBeNull();
    }
    expect(verdict(unlimited, ask, { ...extra, automated: true, routineLevel: true }).approve, "routine").toBeNull();
    expect(verdict(unlimited, ask, { ...extra, unattended: true }).approve, "unattended").toBeNull();
  };

  it("1. holds a Pi call the gate cut, at every level, and never keys it by the engine's name", () => {
    const message = piGateMessage("bash", { command: `cat ~/.ssh/id_rsa # ${"x".repeat(PI_GATE_MESSAGE_MAX)}` });
    const gate = piGateAsk(message);
    expect(gate).toMatchObject({ tool: "Bash", truncated: true });
    expect(gate.toolCall).toBeUndefined();
    // the driver files the ask as cut (request.opened toolInputTruncated), which server/index.ts turns into call.truncated
    const ask: Ask = { tool: gate.tool, summary: gate.summary, truncated: true };
    expect(keyOf(ask)).toBeUndefined();
    holdsEverywhere(ask);
    // a cut command is not read whole, so the always-ask reader holds it first
    expect(verdict(unlimited, ask)).toMatchObject({ approve: null, source: "always-ask" });
    // the same for a connected-app call and for any other tool the gate cut
    for (const tool of ["murage_connectors_apps_multi_execute_tool", "github_create_issue", "write"]) {
      const cut = piGateAsk(piGateMessage(tool, { blob: "a".repeat(PI_GATE_MESSAGE_MAX) }));
      expect(cut.truncated, tool).toBe(true);
      const cutAsk: Ask = { tool: cut.tool, summary: cut.summary, truncated: true, ...(cut.toolCall ? { toolCall: cut.toolCall } : {}) };
      expect(keyOf(cutAsk), tool).toBeUndefined();
      holdsEverywhere(cutAsk);
    }
    // the engine's own name is never a key, and a grant an older release saved under it is dropped
    for (const name of ["pi", "Pi", "claude", "codex", "fuigo"]) {
      expect(approvalKey(name, "pi wants to use x"), name).toBeUndefined();
      expect(isStaleGrant(name), name).toBe(true);
      expect(verdict({ alwaysAllow: [name], autoApprove: false }, { tool: name, summary: "pi wants to run a tool" })).toMatchObject({ approve: null, source: "no-grant" });
    }
    // an uncut Pi ask for another gated tool is keyed by pi's own name for that tool, with its input
    const other = piGateAsk(JSON.stringify({ tool: "github_create_issue", input: { title: "x" } }));
    expect(other.truncated).toBeUndefined();
    expect(keyOf({ tool: other.tool, summary: other.summary, toolCall: other.toolCall })).toBe("github_create_issue");
  });

  it("2. reads a terminal command under any key or tool, so a key-file read holds and a destructive line is guarded", () => {
    const calls: Ask[] = [
      wrapped("run_terminal_command", { command: "cat ~/.ssh/id_rsa" }, 1),
      wrapped("run_terminal_command", { command: "cat ~/.ssh/id_rsa" }, 2),
      fuigo({ command: "cat ~/.aws/credentials" }, { namespace: "fuigo_build", name: "run_terminal_command", kind: "execute" }),
      fuigo({ script: "cat .env" }, stamp("custom__run")),
      fuigo({ script: "cat /Users/ada/.netrc" }, stamp("custom__run")),
      fuigo({ args: ["cat", "~/.ssh/id_ed25519"] }, stamp("custom__run")),
      fuigo({ tools: [{ tool_slug: "GITHUB_RUN_WORKFLOW", arguments: { inputs: { note: "see ~/.docker/config.json" } } }] }),
      claude({ command: "security find-generic-password -s x" }, "mcp__custom__run"),
    ];
    for (const ask of calls) {
      expect(placeArgumentScan(ask.toolCall!.input).cut, ask.summary).toBe(false);
      expect(keyOf(ask) ?? "").not.toMatch(/^Bash|^shell/);
      holdsEverywhere(ask);
      expect(verdict(unlimited, ask), JSON.stringify(ask.toolCall)).toMatchObject({ approve: null, source: "sensitive-guard" });
    }
    // 0309 A1: the always-ask reader reads the command inside the call first, so code it cannot read as a shell line
    // (a Python key-file read) holds there, at every level, before the key guard is reached
    const py = fuigo({ code: "open('/Users/ada/.netrc').read()" }, stamp("custom__run"));
    expect(placeArgumentScan(py.toolCall!.input).cut).toBe(false);
    holdsEverywhere(py);
    expect(verdict(unlimited, py)).toMatchObject({ approve: null, source: "always-ask", rule: "unreadable" });
    expect(verdict({ autoApprove: true }, py)).toMatchObject({ approve: null, source: "always-ask", rule: "unreadable" });
    // the destructive guard reads the same command, and the stop line reads it as a shell line
    const wipe = wrapped("run_terminal_command", { command: "rm -rf /Users/ada/elsewhere" }, 1);
    expect(commandArgument(wipe.toolCall!.input)).toBeUndefined(); // the wrapper is not the call
    expect(commandArgument(resolveCall(wipe).kind === "engine" ? (resolveCall(wipe) as { input: unknown }).input : undefined)).toBe("rm -rf /Users/ada/elsewhere");
    expect(verdict({ autoApprove: true }, wipe)).toMatchObject({ approve: null, source: "destructive-guard" });
    expect(classifyAsk(wipe, place)).toMatchObject({ kind: "delete" });
    // an ordinary command under the same tool is still answered
    const list = wrapped("run_terminal_command", { command: "ls docs" }, 1);
    expect(verdict({ autoApprove: true }, list).approve).not.toBeNull();
  });

  it("3. reads an explicit null, empty, wrong-type or malformed stamp as an identity it cannot prove", () => {
    const broken = [null, "", 0, false, "use_tool", [], {}, { version: 2, namespace: "mcp", name: "github__create_issue" }, { version: 1, namespace: "mcp" }, { version: 1, namespace: " ", name: "github__create_issue" }, { version: 1, namespace: "mcp", name: 7 }, { version: "1", namespace: "mcp", name: "github__create_issue" }];
    for (const stamp of broken) {
      const identity = acpStampedIdentity({ kind: "other", title: "Send a note", rawInput: sendInput, _meta: { "fuigo/tool": stamp } });
      expect(identity, JSON.stringify(stamp)).toEqual({ namespace: "", name: "" });
      const ask = fuigo(sendInput, identity);
      expect(resolveCall(ask).kind, JSON.stringify(stamp)).toBe("unproven");
      expect(keyOf(ask), JSON.stringify(stamp)).toBeUndefined();
      expect(classifyAsk(ask, place), JSON.stringify(stamp)).toMatchObject({ kind: "delete" });
      holdsEverywhere(ask);
      holdsEverywhere(ask, { stopLine: classifyAsk(ask, place) });
    }
    // no `fuigo/tool` key at all is no stamp; a stamp that reads is read
    expect(acpStampedIdentity({ _meta: {} })).toBeUndefined();
    expect(acpStampedIdentity({ _meta: null })).toBeUndefined();
    expect(acpStampedIdentity({})).toBeUndefined();
    expect(acpStampedIdentity(null)).toBeUndefined();
    expect(acpStampedIdentity({ _meta: { "fuigo/tool": { version: 1, namespace: "mcp", name: "github__create_issue", kind: "other" } } })).toEqual({ namespace: "mcp", name: "github__create_issue", kind: "other" });
  });

  it("4. stops a reply that carries a thread id to someone new under any address key, or to an address it cannot read", () => {
    const reply = (args: unknown) => fuigo({ tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: args }] });
    const stops = [
      reply({ thread_id: "t1", recipient_email: "stranger@example.com", body: "ok" }),
      reply({ thread_id: "t1", recipient_email: "ada@example.com", cc: "stranger@example.com" }),
      reply({ thread_id: "t1", to: "ada@example.com", bcc: ["stranger@example.com"] }),
      reply({ in_reply_to: "m1", to_email: "stranger@example.com" }),
      reply({ thread_id: "t1", recipient_email: { nested: { deeper: { email: "ada@example.com" } } } }),
      reply({ thread_id: "t1", recipient_email: true }),
    ];
    for (const ask of stops) {
      const hit = classifyAsk(ask, place);
      expect(hit, JSON.stringify(ask.toolCall!.input)).toMatchObject({ kind: "message" });
      for (const bot of levels("app-action:GMAIL_SEND_EMAIL").slice(0, 3)) {
        expect(verdict(bot, ask, { stopLine: hit }), JSON.stringify(bot)).toMatchObject({ approve: null, source: "stop-line" });
      }
      expect(verdict(unlimited, ask, { stopLine: hit, automated: true, routineLevel: true }).approve).toBeNull();
      expect(verdict(unlimited, ask, { stopLine: hit, unattended: true }).approve).toBeNull();
    }
    // a plain thread reply names no address: it goes to the thread's own participants, so it passes
    expect(classifyAsk(reply({ thread_id: "t1", body: "ok" }), place)).toBeNull();
    // a reply to someone the bot already writes to, under any key, passes as before
    expect(classifyAsk(reply({ thread_id: "t1", recipient_email: "ada@example.com", body: "ok" }), place)).toBeNull();
    expect(classifyAsk(reply({ thread_id: "t1", to: "Ada <ADA@example.com>", cc: "ada@example.com" }), place)).toBeNull();
  });

  it("stops a connected-app run with no tools list, on every engine, and offers it no grant", () => {
    for (const ask of [fuigo({ tool: sendInput.tools }), claude({ tool: sendInput.tools }), pi("APPS_MULTI_EXECUTE_TOOL", { tool: sendInput.tools }), wrapped("murage_connectors__APPS_MULTI_EXECUTE_TOOL", {}, 1)]) {
      expect(classifyAsk(ask, place), ask.tool).toMatchObject({ kind: "message" });
      expect(keyOf(ask), ask.tool).toBeUndefined();
    }
  });

  it("judges an unwrapped engine stamp by its stamped name, so a neutral title cannot hide a delete or a shell line", () => {
    const remove = fuigo({ path: "/Users/ada/elsewhere/x" }, { namespace: "fuigo_build", name: "delete_file" });
    expect(remove.toolCall!.name).toBe("Run app tools");
    expect(classifyAsk(remove, place)).toMatchObject({ kind: "delete" });
    const shell = fuigo({ command: "rm -rf /Users/ada/elsewhere" }, { namespace: "fuigo_build", name: "run_terminal_command" });
    expect(classifyAsk(shell, place)).toMatchObject({ kind: "delete" });
    // one of the engine's own tools stays keyed as before (not this lane's), and still never by a generic name
    expect(keyOf(fuigo({ path: "/Users/ada/work/x" }, { namespace: "fuigo_build", name: "read_file" }))).toBeUndefined();
  });
});
