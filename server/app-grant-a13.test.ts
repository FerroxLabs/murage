// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AMEND-13 (APP-GRANT-AMEND-13.AGREED-r2.md), the server side: routine app
// grants, whole-call coverage and the data every pending card carries.
//
//   - Rules 77, 78: an execute call with one OR many rows has one exact key
//     per row, derived only after the mount is proven; the grant is a SET.
//   - Rule 76: a routine may remember exact actions and the four lookups.
//   - Rule 79: every row authorized AND every stop finding covered.
//   - Rule 80: a saved action is never a saved recipient; host and browser
//     stay out of reach.
//   - Rule 81: the server owns the set, saves it whole or not at all.
//
// Pure verdict tests over the real readers; isolated fixtures only.
import { describe, expect, it } from "vitest";

import { actionGrantKey, actionGrantSet, type GrantCall } from "../shared/app-action-grant.ts";
import type { McpMountRecord } from "../shared/mount-identity.ts";
import { SCAN_TOTAL } from "../shared/scan-limits.ts";

type Ask = GrantCall & { tool: string; summary: string };

const OWN: McpMountRecord = { engineName: "murage_connectors", mountId: "own:connector", provenance: "own" };
const CUSTOM = (engineName: string): McpMountRecord => ({ engineName, mountId: `custom:${engineName}`, provenance: "custom" });
const MOUNTS: McpMountRecord[] = [OWN, CUSTOM("github")];
const EXECUTE = "murage_connectors__APPS_MULTI_EXECUTE_TOOL";
const row = (tool_slug: string, args: Record<string, unknown> = {}) => ({ tool_slug, arguments: args });
const batch = (...rows: unknown[]) => ({ tools: rows });
/** A Fuigo ask: kind "other", the stamped identity, this turn's mounts. */
const fuigo = (input: unknown, name = EXECUTE, mounts: readonly McpMountRecord[] | undefined = MOUNTS): Ask => ({
  tool: "other", summary: "Run app tools", toolKind: "other", engine: "acp",
  toolIdentity: { namespace: "mcp", name }, toolCall: { name: "Run app tools", input }, ...(mounts ? { mcpMounts: mounts } : {}),
});
/** A Claude ask: the engine's own MCP name, proven against the same mounts. */
const claude = (input: unknown, mounts: readonly McpMountRecord[] = MOUNTS): Ask => ({
  tool: `mcp__${EXECUTE}`, summary: JSON.stringify(input), engine: "claude", toolCall: { name: `mcp__${EXECUTE}`, input }, mcpMounts: mounts,
});
const setOf = (ask: Ask) => actionGrantSet(ask.tool, ask);

describe("Rules 77, 78: identity and parsing", () => {
  it("derives one key per distinct action of a multi-row execute, every row in call order", () => {
    for (const ask of [fuigo(batch(row("GMAIL_FETCH_EMAILS"), row("GOOGLECALENDAR_EVENTS_LIST"), row("GMAIL_CREATE_EMAIL_DRAFT"))), claude(batch(row("GMAIL_FETCH_EMAILS"), row("GOOGLECALENDAR_EVENTS_LIST"), row("GMAIL_CREATE_EMAIL_DRAFT")))]) {
      const set = setOf(ask)!;
      expect(set.keys).toEqual(["app-action:GMAIL_FETCH_EMAILS", "app-action:GOOGLECALENDAR_EVENTS_LIST", "app-action:GMAIL_CREATE_EMAIL_DRAFT"]);
      expect(set.rows.map((r) => r.slug)).toEqual(["GMAIL_FETCH_EMAILS", "GOOGLECALENDAR_EVENTS_LIST", "GMAIL_CREATE_EMAIL_DRAFT"]);
      // never one key for the wrapper or only the first row
      expect(actionGrantKey(ask.tool, ask)).toBeNull();
    }
  });

  it("scans every row of a repeated slug and stores the key once", () => {
    const set = setOf(fuigo(batch(row("GMAIL_SEND_EMAIL", { to: "ada@example.com" }), row("GMAIL_SEND_EMAIL", { to: "bob@example.com" }))))!;
    expect(set.keys).toEqual(["app-action:GMAIL_SEND_EMAIL"]);
    expect(set.rows).toHaveLength(2);
    expect(set.rows.map((r) => r.arguments?.to)).toEqual(["ada@example.com", "bob@example.com"]);
  });

  it("keeps r10's one-row key", () => {
    const ask = fuigo(batch(row("GMAIL_FETCH_EMAILS")));
    expect(actionGrantKey(ask.tool, ask)).toBe("app-action:GMAIL_FETCH_EMAILS");
    expect(setOf(ask)).toMatchObject({ keys: ["app-action:GMAIL_FETCH_EMAILS"] });
  });

  it("offers no set for an empty, malformed, partly unreadable or oversized batch", () => {
    const unread = [
      batch(),
      { tools: "GMAIL_FETCH_EMAILS" },
      batch(row("GMAIL_FETCH_EMAILS"), "GMAIL_SEND_EMAIL"),
      batch(row("GMAIL_FETCH_EMAILS"), { arguments: {} }),
      batch(row("GMAIL_FETCH_EMAILS"), row("gmail send")),
      batch(row("GMAIL_FETCH_EMAILS"), { tool_slug: "GMAIL_SEND_EMAIL", arguments: "to bob" }),
      batch(row("GMAIL_FETCH_EMAILS"), { tool_slug: "GMAIL_SEND_EMAIL", arguments: {}, extra: 1 }),
      batch(row("GMAIL_FETCH_EMAILS"), { tool_slug: "GMAIL_SEND_EMAIL", toolSlug: "GMAIL_SEND_EMAIL", arguments: {} }),
      batch(row("GMAIL_FETCH_EMAILS"), row("COMPOSIO_SEARCH_TOOLS")),
      // a reader limit reached in the tail never lets the tail be ignored
      batch(row("GMAIL_FETCH_EMAILS"), row("GMAIL_SEND_EMAIL", { body: "x".repeat(SCAN_TOTAL + 10) })),
    ];
    for (const input of unread) expect(setOf(fuigo(input)), JSON.stringify(input).slice(0, 120)).toBeNull();
  });

  it("binds an app key to the proven own connector mount only", () => {
    const input = batch(row("GMAIL_FETCH_EMAILS"));
    // no mounts known, or a name no mount of this turn carries
    expect(setOf(fuigo(input, EXECUTE, []))).toBeNull();
    expect(setOf(fuigo(input, EXECUTE, [CUSTOM("github")]))).toBeNull();
    // a custom server spelled like the connector is its own mount's tool, never an app action
    const spoof = setOf(fuigo(input, EXECUTE, [CUSTOM("murage_connectors")]));
    expect(spoof?.keys.every((key) => key.startsWith("acp-tool:v2:"))).toBe(true);
    expect(spoof?.rows).toEqual([]);
    // the connector's id with another provenance is not the own connector
    const borrowed = setOf(fuigo(input, EXECUTE, [{ ...OWN, provenance: "custom" }]));
    expect(borrowed == null || borrowed.keys.every((key) => !key.startsWith("app-action:"))).toBe(true);
    // two records fitting one name
    expect(setOf(fuigo(input, EXECUTE, [OWN, { ...OWN, mountId: "own:connector2" }]))).toBeNull();
  });

  it("keys each lookup by its own canonical key, never an execute", () => {
    expect(setOf(fuigo({ queries: [{ use_case: "x" }] }, "murage_connectors__APPS_SEARCH_TOOLS"))).toEqual({ keys: ["mcp__murage_connectors__APPS_SEARCH_TOOLS"], rows: [] });
    expect(setOf(fuigo({}, "murage_connectors__APPS_GET_TOOL_SCHEMAS"))?.keys).toEqual(["mcp__murage_connectors__APPS_GET_TOOL_SCHEMAS"]);
  });
});

// ── Rule 76: what a routine may remember, and where it applies ───────────

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { autoVerdict, type AutoApprover, type AutoContext } from "./auto-approve.ts";
import { ROUTINE_GRANTS_MAX, isRoutineGrantKey, routineGrantKeys, routineTurnApproval } from "./routine-permissions.ts";
import { RoutineManager, type RoutineManagerOptions } from "./routines.ts";
import { classifyAsk, classifyAskRows, type StopLinePlace } from "./stop-line.ts";
import { exactCommandKey } from "../shared/exact-command.ts";
import { APP_LOOKUPS } from "../shared/app-action-words.ts";
import { CONNECTED_APPS_SERVER, exposedToolName } from "../shared/connected-app-names.ts";

const LOOKUPS = Object.keys(APP_LOOKUPS).map((app) => `mcp__${CONNECTED_APPS_SERVER}__${exposedToolName(app)}`);
const place: StopLinePlace = { home: "/Users/ada", cwd: "/Users/ada/work", roots: ["/Users/ada/work"], knownRecipients: new Set(["ada@example.com"]), realpath: (p: string) => p };
/** The context the host builds for an ask: the call, its stop line and rows. */
const ctx = (ask: Ask, extra: AutoContext = {}): AutoContext => ({ call: ask, stopLine: classifyAsk(ask, place), stopRows: classifyAskRows(ask, place), ...extra });
const routineRun = (alwaysAllow: string[], permissionMode: "ask" | "auto" | "full" | "unlimited" = "ask") => ({ permissionMode, alwaysAllow });
/** The bot is on No limits, so a routine run is judged at its own ceiling. */
const judge = (ask: Ask, run: ReturnType<typeof routineRun> | null, extra: AutoContext = {}, bot: AutoApprover = run ? { autoApprove: true, fullAccess: true, noLimits: true } : {}) =>
  routineTurnApproval({ bot, run, tool: ask.tool, summary: ask.summary, context: ctx(ask, extra) }).verdict;
const TRAINING = batch(
  row("GMAIL_FETCH_EMAILS", { query: "is:unread newer_than:1d" }),
  row("GOOGLECALENDAR_EVENTS_LIST", { timeMin: "2026-10-18T00:00:00Z" }),
  row("GOOGLECALENDAR_CREATE_EVENT", { summary: "Training", start_datetime: "2026-10-19T09:00:00" }),
  row("GMAIL_CREATE_EMAIL_DRAFT", { recipient_email: "ada@example.com", body: "Notes" }),
);
const TRAINING_KEYS = ["app-action:GMAIL_FETCH_EMAILS", "app-action:GOOGLECALENDAR_EVENTS_LIST", "app-action:GOOGLECALENDAR_CREATE_EVENT", "app-action:GMAIL_CREATE_EMAIL_DRAFT"];

describe("Rule 76: routine alwaysAllow grammar", () => {
  it("holds exact actions, the four lookups, exact commands and permitted stop places", () => {
    const exact = exactCommandKey({ engine: "fuigo", cwd: "/Users/ada/work", command: "git status" })!;
    for (const key of [...TRAINING_KEYS, ...LOOKUPS, exact, "stop:message:bob@example.com", "stop:delete:/Users/ada/old"]) expect(isRoutineGrantKey(key), key).toBe(true);
  });

  it("never holds a browser stop, a bare execute, an app-wide or generic grant, or a custom tool", () => {
    for (const key of [
      "stop:browser:I1@https://example.com", "mcp__murage_connectors__APPS_MULTI_EXECUTE_TOOL", "app-action:GMAIL", "app-action:*", "app-action:gmail_send_email",
      "app-action:COMPOSIO_SEARCH_TOOLS", "other", "use_tool", "Bash", "Bash:git", "mcp__github__create_issue", "acp-tool:v2:custom%3Agithub/create%5Fissue",
      "local-computer:app-action:GMAIL_FETCH_EMAILS", "mcp__murage_connectors__APPS_REMOTE_BASH_TOOL",
    ]) expect(isRoutineGrantKey(key), key).toBe(false);
    expect(routineGrantKeys(["app-action:GMAIL_FETCH_EMAILS", "other", "stop:browser:I1@https://x.test", LOOKUPS[0]])).toEqual(["app-action:GMAIL_FETCH_EMAILS", LOOKUPS[0]]);
  });

  it("lets that routine's run use its saved keys for every row, and nothing else", () => {
    const ask = fuigo(TRAINING);
    expect(judge(ask, routineRun(TRAINING_KEYS))).toMatchObject({ source: "routine-allow" });
    expect(judge(claude(TRAINING), routineRun(TRAINING_KEYS))).toMatchObject({ source: "routine-allow" });
    // one missing action anywhere holds the whole call
    for (const missing of TRAINING_KEYS) expect(judge(ask, routineRun(TRAINING_KEYS.filter((key) => key !== missing))).approve).toBeNull();
    // permutations decide the same
    const reversed = fuigo({ tools: [...TRAINING.tools].reverse() });
    expect(judge(reversed, routineRun(TRAINING_KEYS))).toMatchObject({ source: "routine-allow" });
    expect(judge(reversed, routineRun(TRAINING_KEYS.slice(1))).approve).toBeNull();
  });

  it("gives another routine, an ordinary chat, an unattended turn and host control none of them", () => {
    const ask = fuigo(TRAINING);
    expect(judge(ask, routineRun(["app-action:SLACK_SEND_MESSAGE"])).approve).toBeNull();
    expect(judge(ask, null).approve).toBeNull();
    expect(judge(ask, routineRun(TRAINING_KEYS), { unattended: true }).approve).toBeNull();
    expect(judge(ask, routineRun(TRAINING_KEYS), { scope: "local-computer" }).approve).toBeNull();
    // routine keys are never read as the bot's own grants on an ordinary turn
    expect(autoVerdict({}, ask.tool, ask.summary, ctx(ask, { routineAllow: TRAINING_KEYS })).approve).toBeNull();
  });

  it("lets a lookup be remembered without letting what it finds run", () => {
    const search = fuigo({ queries: [{ use_case: "send email" }] }, "murage_connectors__APPS_SEARCH_TOOLS");
    expect(judge(search, routineRun([LOOKUPS[0]!]))).toMatchObject({ source: "routine-allow" });
    expect(judge(fuigo(batch(row("GMAIL_SEND_EMAIL", { to: "ada@example.com" }))), routineRun([LOOKUPS[0]!])).approve).toBeNull();
    expect(judge(fuigo({}, "murage_connectors__APPS_GET_TOOL_SCHEMAS"), routineRun([LOOKUPS[0]!])).approve).toBeNull();
  });

  it("does not let saved keys override the key guard or an unread call", () => {
    const keyed = fuigo(batch(row("GMAIL_FETCH_EMAILS", { query: "~/.ssh/id_rsa" })));
    expect(judge(keyed, routineRun(["app-action:GMAIL_FETCH_EMAILS"])).approve).toBeNull();
    const cut = { ...fuigo(TRAINING), truncated: true };
    expect(judge(cut, routineRun(TRAINING_KEYS)).approve).toBeNull();
  });
});

describe("Rule 76: persistence, reload and revocation", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) removeTempDirSync(dir); });
  const manager = () => {
    const dir = mkdtempSync(join(tmpdir(), "murage-a13-"));
    dirs.push(dir);
    let task = 0;
    const options: RoutineManagerOptions = {
      file: join(dir, "routines.json"), now: () => new Date(2026, 9, 18, 8).getTime(), botState: () => "ready",
      createTask: () => ({ threadId: `thread-${++task}` }), startTurn: async () => {}, interruptTurn: async () => {},
    };
    return { manager: new RoutineManager(options), options };
  };
  const make = (m: RoutineManager) => m.create({ name: "Training", prompt: "Prepare", botId: "dax", enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() } });

  it("saves the whole set, survives a reload and revokes one key at a time", () => {
    const h = manager();
    const routine = make(h.manager);
    expect(h.manager.grantAlwaysAllowSet(routine.id, [...TRAINING_KEYS, ...LOOKUPS])?.alwaysAllow).toEqual([...TRAINING_KEYS, ...LOOKUPS]);
    const reloaded = new RoutineManager({ ...h.options });
    expect(reloaded.listRoutines()[0]?.alwaysAllow).toEqual([...TRAINING_KEYS, ...LOOKUPS]);
    reloaded.revokeAlwaysAllow(routine.id, TRAINING_KEYS[2]!);
    expect(new RoutineManager({ ...h.options }).listRoutines()[0]?.alwaysAllow).not.toContain(TRAINING_KEYS[2]);
  });

  it("saves none of a set with one invalid key or past the cap, and repeats idempotently", () => {
    const h = manager();
    const routine = make(h.manager);
    expect(() => h.manager.grantAlwaysAllowSet(routine.id, [TRAINING_KEYS[0]!, "other"])).toThrow();
    expect(h.manager.listRoutines()[0]?.alwaysAllow ?? []).toEqual([]);
    const filler = Array.from({ length: ROUTINE_GRANTS_MAX - 1 }, (_, i) => `stop:message:p${i}@example.com`);
    h.manager.grantAlwaysAllowSet(routine.id, filler);
    expect(() => h.manager.grantAlwaysAllowSet(routine.id, TRAINING_KEYS.slice(0, 2))).toThrow(/remembers/);
    expect(h.manager.listRoutines()[0]?.alwaysAllow).toHaveLength(ROUTINE_GRANTS_MAX - 1);
    // keys already held are deduplicated first, so one new key still fits
    expect(h.manager.grantAlwaysAllowSet(routine.id, [filler[0]!, TRAINING_KEYS[0]!])?.alwaysAllow).toHaveLength(ROUTINE_GRANTS_MAX);
    expect(h.manager.grantAlwaysAllowSet(routine.id, [TRAINING_KEYS[0]!])?.alwaysAllow).toHaveLength(ROUTINE_GRANTS_MAX);
  });
});

// ── Rules 79, 80: whole-call coverage, recipients, host ──────────────────

describe("Rule 79: every row authorized and every finding covered", () => {
  const sendBob = row("GMAIL_SEND_EMAIL", { recipient_email: "bob@example.com", body: "hi" });
  const fetch = row("GMAIL_FETCH_EMAILS", { query: "x" });

  it("keeps a one-row call's r10 outcome", () => {
    const one = fuigo(batch(sendBob));
    expect(judge(one, routineRun(["stop:message:bob@example.com"]))).toMatchObject({ source: "routine-allow" });
    expect(judge(one, routineRun(["app-action:GMAIL_SEND_EMAIL"])).source).toBe("stop-line");
  });

  it("never lets one row's covered stop authorize an ungranted sibling", () => {
    const mixed = fuigo(batch(fetch, sendBob));
    expect(judge(mixed, routineRun(["stop:message:bob@example.com"])).approve).toBeNull();
    expect(judge(mixed, routineRun(["stop:message:bob@example.com", "app-action:GMAIL_FETCH_EMAILS"]))).toMatchObject({ source: "routine-allow" });
    // the order of the rows changes nothing
    const swapped = fuigo(batch(sendBob, fetch));
    expect(judge(swapped, routineRun(["stop:message:bob@example.com"])).approve).toBeNull();
    expect(judge(swapped, routineRun(["stop:message:bob@example.com", "app-action:GMAIL_FETCH_EMAILS"]))).toMatchObject({ source: "routine-allow" });
  });

  it("lets a mode authorize the rows a cover did not, on its own terms", () => {
    const mixed = fuigo(batch(fetch, sendBob));
    expect(judge(mixed, routineRun(["stop:message:bob@example.com"], "auto"))).toMatchObject({ source: "auto-mode" });
    expect(judge(mixed, routineRun([], "auto")).source).toBe("stop-line");
  });

  it("holds the whole call when one finding anywhere is uncovered", () => {
    const two = fuigo(batch(row("GMAIL_SEND_EMAIL", { recipient_email: "bob@example.com" }), row("GMAIL_SEND_EMAIL", { recipient_email: "eve@example.com" })));
    expect(judge(two, routineRun(["stop:message:bob@example.com", "app-action:GMAIL_SEND_EMAIL"], "full")).source).toBe("stop-line");
    expect(judge(two, routineRun(["stop:message:bob@example.com", "stop:message:eve@example.com"]))).toMatchObject({ source: "routine-allow" });
  });

  it("covers each row's findings with the owner's task allowances one by one", () => {
    const two = fuigo(batch(row("GMAIL_SEND_EMAIL", { recipient_email: "bob@example.com" }), row("GMAIL_SEND_EMAIL", { recipient_email: "eve@example.com" })));
    const owner = (keys: string[]) => autoVerdict({}, two.tool, two.summary, ctx(two, { taskAllowanceKeys: keys }));
    expect(owner(["stop:message:bob@example.com", "stop:message:eve@example.com"])).toMatchObject({ source: "task-allowance" });
    expect(owner(["stop:message:bob@example.com"]).source).toBe("stop-line");
  });
});

describe("Rule 80: a saved action is never a saved recipient", () => {
  it("stops a fresh To, Cc or Bcc destination despite the saved send", () => {
    for (const args of [{ recipient_email: "bob@example.com" }, { recipient_email: "ada@example.com", cc: ["carol@example.com"] }, { recipient_email: "ada@example.com", bcc: "dan@example.com" }]) {
      const ask = fuigo(batch(row("GMAIL_FETCH_EMAILS"), row("GMAIL_SEND_EMAIL", args)));
      expect(judge(ask, routineRun(["app-action:GMAIL_FETCH_EMAILS", "app-action:GMAIL_SEND_EMAIL"], "unlimited")).source, JSON.stringify(args)).toBe("stop-line");
    }
  });

  it("covers only the named recipient of a recipient key", () => {
    const both = fuigo(batch(row("GMAIL_FETCH_EMAILS"), row("GMAIL_SEND_EMAIL", { recipient_email: "bob@example.com", cc: "eve@example.com" })));
    expect(judge(both, routineRun(["app-action:GMAIL_FETCH_EMAILS", "app-action:GMAIL_SEND_EMAIL", "stop:message:bob@example.com"])).source).toBe("stop-line");
    expect(judge(both, routineRun(["app-action:GMAIL_FETCH_EMAILS", "stop:message:bob@example.com", "stop:message:eve@example.com"]))).toMatchObject({ source: "routine-allow" });
  });

  it("holds an unknown destination and a reply that adds someone", () => {
    const unknown = fuigo(batch(row("GMAIL_FETCH_EMAILS"), row("GMAIL_SEND_EMAIL", { recipient_email: { nested: { deep: "x" } } })));
    expect(judge(unknown, routineRun(["app-action:GMAIL_FETCH_EMAILS", "app-action:GMAIL_SEND_EMAIL"], "full")).source).toBe("stop-line");
    const reply = fuigo(batch(row("GMAIL_FETCH_EMAILS"), row("GMAIL_REPLY_TO_THREAD", { thread_id: "t1", recipient_email: "mallory@example.com" })));
    expect(judge(reply, routineRun(["app-action:GMAIL_FETCH_EMAILS", "app-action:GMAIL_REPLY_TO_THREAD"])).source).toBe("stop-line");
  });

  it("holds pay, delete and public findings despite saved action keys", () => {
    for (const slug of ["STRIPE_CREATE_PAYMENT_INTENT", "GMAIL_DELETE_MESSAGE", "TWITTER_CREATION_OF_A_POST"]) {
      const ask = fuigo(batch(row("GMAIL_FETCH_EMAILS"), row(slug, { customer: "cus_1", message_id: "m1", text: "hi" })));
      expect(judge(ask, routineRun(["app-action:GMAIL_FETCH_EMAILS", `app-action:${slug}`], "full")).source, slug).toBe("stop-line");
    }
  });

  it("never covers host scope with a routine, app or stop grant", () => {
    const ask = fuigo(batch(row("GMAIL_FETCH_EMAILS"), row("GMAIL_SEND_EMAIL", { recipient_email: "bob@example.com" })));
    const keys = ["app-action:GMAIL_FETCH_EMAILS", "app-action:GMAIL_SEND_EMAIL", "stop:message:bob@example.com"];
    expect(judge(ask, routineRun(keys), { scope: "local-computer" }).approve).toBeNull();
    expect(autoVerdict({ alwaysAllow: keys }, ask.tool, ask.summary, ctx(ask, { scope: "local-computer", taskAllowanceKeys: keys })).approve).toBeNull();
  });
});

// ── Rule 82's data: every row, and the routine offer ─────────────────────

import { ROUTINE_GRANT_REASONS, grantRequestFor, routineDecisionKeys } from "./approval-grant-request.ts";

describe("the pending request carries every row and the routine offer", () => {
  const routine = { routineId: "r1", routineName: "Training" };
  const build = (ask: Ask, extra: { inputCut?: boolean; scope?: "local-computer"; exactAllowKey?: string; routine?: typeof routine | null } = {}) =>
    grantRequestFor({ ask, stopHit: classifyAsk(ask, place), stopRows: classifyAskRows(ask, place), inputCut: extra.inputCut ?? false, ...(extra.scope ? { scope: extra.scope } : {}), ...(extra.exactAllowKey ? { exactAllowKey: extra.exactAllowKey } : {}), routine: extra.routine === undefined ? routine : extra.routine });

  it("lists every operation in call order with its destination, findings and arguments", () => {
    const ask = fuigo({ tools: [...TRAINING.tools, row("GMAIL_SEND_EMAIL", { recipient_email: "bob@example.com", cc: "eve@example.com", body: "hi" })] });
    const request = build(ask)!;
    expect(request.rows.map((r) => [r.index, r.operation, r.app, r.action])).toEqual([
      [0, "GMAIL_FETCH_EMAILS", "Gmail", "fetch emails"],
      [1, "GOOGLECALENDAR_EVENTS_LIST", "Google Calendar", "events list"],
      [2, "GOOGLECALENDAR_CREATE_EVENT", "Google Calendar", "create event"],
      [3, "GMAIL_CREATE_EMAIL_DRAFT", "Gmail", "create email draft"],
      [4, "GMAIL_SEND_EMAIL", "Gmail", "send email"],
    ]);
    expect(request.rows[3]!.destinations).toEqual(["ada@example.com"]);
    expect(request.rows[3]!.findings).toEqual([]);
    expect(request.rows[4]!.destinations).toEqual(["bob@example.com", "eve@example.com"]);
    expect(request.rows[4]!.findings.map((f) => f.key)).toEqual(["stop:message:bob@example.com", "stop:message:eve@example.com"]);
    expect(request.rows[4]!.arguments).toEqual({ recipient_email: "bob@example.com", cc: "eve@example.com", body: "hi" });
    expect(request.routine).toMatchObject({
      routineId: "r1", routineName: "Training", eligible: true, notRemembered: [],
      actionKeys: [...TRAINING_KEYS, "app-action:GMAIL_SEND_EMAIL"],
      stopKeys: [{ key: "stop:message:bob@example.com", recipient: "bob@example.com" }, { key: "stop:message:eve@example.com", recipient: "eve@example.com" }],
    });
  });

  it("says plainly why the routine choice is not offered", () => {
    const ask = fuigo(TRAINING);
    expect(build(ask, { scope: "local-computer" })!.routine).toMatchObject({ eligible: false, reason: ROUTINE_GRANT_REASONS.host, actionKeys: [] });
    expect(build(ask, { inputCut: true })!.routine).toMatchObject({ eligible: false, reason: ROUTINE_GRANT_REASONS.cut });
    expect(build(fuigo(batch(row("GMAIL_FETCH_EMAILS"), "x")))!.routine).toMatchObject({ eligible: false, reason: ROUTINE_GRANT_REASONS.unread });
    expect(build(fuigo({ issue_number: 1 }, "github__get_issue"))!.routine).toMatchObject({ eligible: false, reason: ROUTINE_GRANT_REASONS.nothing });
    for (const r of [ROUTINE_GRANT_REASONS.host, ROUTINE_GRANT_REASONS.cut, ROUTINE_GRANT_REASONS.unread, ROUTINE_GRANT_REASONS.nothing]) expect(r).not.toMatch(/—|\bsafe|unsafe|safety|composio/i);
  });

  it("names a finding that can never be remembered, so the choice does not promise the whole call", () => {
    const ask = fuigo(batch(row("GMAIL_FETCH_EMAILS"), row("GMAIL_SEND_EMAIL", { recipient_email: { deep: { x: 1 } } })));
    const offer = build(ask)!.routine!;
    expect(offer.eligible).toBe(true);
    expect(offer.notRemembered).toHaveLength(1);
    expect(offer.notRemembered[0]).toMatch(/cannot tell who it goes to/);
  });

  it("offers a lookup on its own, and an exact command on a command card", () => {
    const search = build(fuigo({ queries: [{ use_case: "x" }] }, "murage_connectors__APPS_SEARCH_TOOLS"))!;
    expect(search.rows).toEqual([{ index: 0, kind: "lookup", operation: "COMPOSIO_SEARCH_TOOLS", app: "Connected apps", action: "find app tools", destinations: [], findings: [], arguments: { queries: [{ use_case: "x" }] } }]);
    expect(search.routine?.actionKeys).toEqual([LOOKUPS[0]]);
    const exact = exactCommandKey({ engine: "claude", cwd: "/Users/ada/work", command: "git status" })!;
    const shell: Ask = { tool: "Bash", summary: "git status", engine: "claude", toolCall: { name: "Bash", input: { command: "git status" } } };
    expect(build(shell, { exactAllowKey: exact })).toEqual({ rows: [], routine: expect.objectContaining({ eligible: true, actionKeys: [exact], stopKeys: [] }) });
    expect(build(shell, { routine: null })).toBeUndefined();
  });

  it("decides the saved set from the offer alone", () => {
    const offer = build(fuigo({ tools: [...TRAINING.tools, row("GMAIL_SEND_EMAIL", { recipient_email: "bob@example.com" })] }))!.routine!;
    expect(routineDecisionKeys(offer, undefined, undefined)).toEqual([...TRAINING_KEYS, "app-action:GMAIL_SEND_EMAIL"]);
    expect(routineDecisionKeys(offer, undefined, ["stop:message:bob@example.com"])).toEqual([...TRAINING_KEYS, "app-action:GMAIL_SEND_EMAIL", "stop:message:bob@example.com"]);
    expect(routineDecisionKeys(offer, undefined, ["stop:message:eve@example.com"])).toMatch(/not on this approval/);
    // a pure stop card saves its stop place, as before
    const deleting = build({ tool: "Bash", summary: "rm -rf /Users/ada/old", engine: "claude", toolCall: { name: "Bash", input: { command: "rm -rf /Users/ada/old" } } })!.routine!;
    expect(routineDecisionKeys(deleting, undefined, undefined)).toEqual(["stop:delete:/Users/ada/old"]);
  });
});

// ── Rule 84a/b: a top-level scheduled run stays attended for routine authority ──

import { peerTurnAuthority } from "./routine-permissions.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";

describe("Rule 84: scheduled routine status", () => {
  it("keeps a scheduled run eligible for its own keys, with its ceiling and every guard", () => {
    const ask = fuigo(TRAINING);
    // a scheduled or manual run is judged as an automated routine turn at its level
    expect(judge(ask, routineRun(TRAINING_KEYS, "ask"))).toMatchObject({ source: "routine-allow" });
    // schedule provenance alone grants nothing
    expect(judge(ask, routineRun([], "ask")).approve).toBeNull();
    // the explicit unattended mark still outranks it
    expect(judge(ask, routineRun(TRAINING_KEYS, "ask"), { unattended: true }).approve).toBeNull();
    // the routine is never No limits' owner turn: its stop line holds
    const send = fuigo(batch(row("GMAIL_FETCH_EMAILS"), row("GMAIL_SEND_EMAIL", { recipient_email: "bob@example.com" })));
    expect(judge(send, routineRun(["app-action:GMAIL_FETCH_EMAILS", "app-action:GMAIL_SEND_EMAIL"], "unlimited")).source).toBe("stop-line");
  });

  it("leaves a scheduled peer child unattended, with no key set to inherit", () => {
    const authority = peerTurnAuthority({ autoApprove: true }, { permissionMode: "auto", triggerSource: "schedule" });
    expect(authority.unattended).toBe(true);
    expect(Object.keys(authority)).not.toContain("alwaysAllow");
    expect(judge(fuigo(TRAINING), null, { unattended: authority.unattended, automated: true, routineLevel: true, routineAllow: TRAINING_KEYS }).approve).toBeNull();
  });
});
