// W15-DIAG: WHAT ACTUALLY STOPS A MORNING BRIEF?
//
// The 0.1.58 plan carried an approved policy change built on this diagnosis:
// "a Full-access bot running a routine is judged as Auto, and therefore
// stalls waiting for approval". The first half is true and the second half
// does not follow, so before anything in the approval policy is relaxed, this
// establishes — by running the real policy over the real routine — which call
// raises a card and under which rule.
//
// THIS FILE WAS WRONG ONCE AND THE POLICY CHANGE WAS CALLED OFF ON IT.
//
// The first version hand-wrote the bot as `{ autoApprove: true, fullAccess:
// true }`, called it "the bot the first run creates", found that it raised no
// cards, and concluded there was no stall to fix. The first run creates no
// such bot. `Store.createBot` gives its first task `autoApprove: false`,
// `createTask` inherits `autoApprove: bot.autoApprove === true` for every
// task a routine is given afterwards, and Full access can only be switched on
// by a desktop PATCH that carries an acknowledged warning (server/
// full-access.ts) — electing the Chief does not grant it and neither does
// finishing setup. The first-run Chief runs its 07:00 brief in ASK mode.
//
// So the bot under test is now BUILT by the real store: created the way a
// blank machine creates it, elected the way opening setup elects it, given a
// routine's task the way the scheduler gives it one, and projected onto the
// approver the dispatch actually hands to autoVerdict. Nothing about its
// permissions is written down here. The Auto and Full-access bots are still
// measured, as what they are: a bot the PERSON has since turned up.
//
// Read the FINDING block at the bottom for the answer in words.

import { readFileSync, rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { autoVerdict, type AutoApprover, type AutoVerdictSource } from "./auto-approve.ts";
import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { chiefDecision } from "./setup.ts";
import { Store } from "./store.ts";

/** server/index.ts boots a server on import, so the three facts this test
 *  needs from it — the brief's prompt, and the turn context a scheduled
 *  routine runs under — are read out of the source, the same way
 *  server/setup-brief-template.test.ts reads the template. Everything about
 *  the BOT is executed instead. */
const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

/** Comments out, ALWAYS, before any assertion touches this source. A previous
 *  test on this branch matched prose in a comment and so enforced a claim the
 *  code did not make. Block comments first; then a line comment, skipping the
 *  `://` of a URL, which is the only `//` that routinely survives in code. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "\n").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const code = stripComments(index);

// ── the routine this is about ──────────────────────────────────────────────

describe("the Morning brief routine is still the thing being diagnosed", () => {
  it("is the first run's scheduled brief, with the prompt this test assumes", () => {
    const at = code.indexOf('  brief: {\n    name: "Morning brief",');
    expect(at, "SETUP_ROUTINE_TEMPLATES.brief has moved or been renamed").toBeGreaterThan(-1);
    const prompt = code.slice(at, code.indexOf("\n  },", at));
    // The five things it goes and gets. Each one is a connected-app read, and
    // that is the whole reason the tool sequence below looks the way it does.
    expect(prompt).toContain("Go through my calendar, what came in overnight and anything that moved");
  });
});

// ── the turn context a SCHEDULED routine actually runs under ───────────────
//
// This is the fact the withdrawn diagnosis skipped, and it decides part of
// what follows: `unattended` and `automated` are two different flags, and a
// routine on a clock sets only one of them.

describe("a scheduled routine is automated but NOT unattended", () => {
  it("only a webhook or a channel event marks the thread unattended", () => {
    const mark = code.split("\n").find((line) => line.includes("markUnattended(threadId)") && line.includes("automationSource"));
    expect(mark, "the unattended mark has moved out of startTurn").toBeTruthy();
    // "schedule" and "manual" are the other two RoutineRunTrigger values and
    // neither appears here, so a routine on a clock leaves the flag off.
    expect(mark).toContain('"webhook"');
    expect(mark).toContain('"channel"');
    expect(mark).not.toContain('"schedule"');
    expect(mark).not.toContain('"manual"');
  });

  it("but every routine turn is automated, which downgrades Full access to `other`", () => {
    const automated = code.split("\n").find((line) => line.includes("automated: Boolean(routineRun)"));
    expect(automated, "the automated flag has moved out of the request.opened handler").toBeTruthy();
    expect(automated).toContain("isActiveThread");
  });
});

// ── the bot, built rather than described ───────────────────────────────────

const selection = (): ModelSelection => ({ instanceId: "claude", model: "fake-model" });

/** A 7am scheduled run of the brief. `automated`, not `unattended`. */
const scheduled = { automated: true } as const;

/** The same routine fired by a webhook or an inbound channel message, which
 *  is the other way the first run's routines can start. */
const triggered = { automated: true, unattended: true } as const;

let store: Store;
/** the approver the dispatch hands to autoVerdict for the brief's own task */
let firstRunChief: AutoApprover;
let briefThreadId: string;
let chiefId: string;

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  store = new Store(selection);
  // exactly what a blank machine does: one bot, then opening setup elects it
  const created = store.createBot({ name: "Chief" });
  const decision = chiefDecision(undefined, store.bots);
  expect(decision.kind).toBe("elect");
  chiefId = created.id;
  store.setChiefOfStaff(chiefId, decision.kind === "elect" ? decision.section : null, "workspace");
  // and what the scheduler does at 07:00: a task of its own for this run
  briefThreadId = store.createTask(chiefId, "Morning brief", false)!.threadId;
  firstRunChief = store.projectBotForTask(chiefId, briefThreadId)!;
});

/** The same bot after the PERSON has turned Auto — or Auto and Full access —
 *  up on it. Both go through the store, so "Full access implies Auto" is the
 *  store's rule here rather than this file's assumption. */
function raisedTo(level: "auto" | "full"): AutoApprover {
  store.patchTask(chiefId, briefThreadId, { autoApprove: true, fullAccess: level === "full" });
  return store.projectBotForTask(chiefId, briefThreadId)!;
}

describe("the bot the first run actually creates", () => {
  it("runs its brief in Ask mode: Auto off, Full access off, nothing remembered", () => {
    expect(firstRunChief.autoApprove).toBe(false);
    expect(firstRunChief.fullAccess).toBe(false);
    expect(firstRunChief.alwaysAllow).toEqual([]);
  });

  it("is the elected workspace Chief all the same — the role grants no permission", () => {
    expect(store.workspaceChief()?.id).toBe(chiefId);
    expect(store.projectBotForTask(chiefId, briefThreadId)!.autoApprove).toBe(false);
  });
});

// ── the real tool sequence ─────────────────────────────────────────────────
//
// What the brief does, in order, on a bot with connected apps. Connector work
// is three calls (search, schemas, execute) because that is the sequence
// server/composio.ts's own system prompt instructs the model to use, and every
// connected app — calendar, mail, chat — arrives through the same third one,
// COMPOSIO_MULTI_EXECUTE_TOOL. The summaries are what the card carries: the
// engine's structured tool input, JSON-stringified and cut to 200 characters
// (server/drivers/claude.ts, askSummary).

interface Call {
  step: string;
  tool: string;
  summary: string;
  ownWorkspace?: true;
}

const BRIEF_SEQUENCE: Call[] = [
  { step: "find the calendar tool", tool: "COMPOSIO_SEARCH_TOOLS", summary: '{"use_case":"list the events on my calendar today"}' },
  { step: "read its arguments", tool: "COMPOSIO_GET_TOOL_SCHEMAS", summary: '{"tool_slugs":["GOOGLECALENDAR_EVENTS_LIST"]}' },
  { step: "today's calendar", tool: "COMPOSIO_MULTI_EXECUTE_TOOL", summary: '{"tools":[{"tool_slug":"GOOGLECALENDAR_EVENTS_LIST","arguments":{"timeMin":"2026-09-21T00:00:00Z","timeMax":"2026-09-22T00:00:00Z"}}]}' },
  { step: "what came in overnight", tool: "COMPOSIO_MULTI_EXECUTE_TOOL", summary: '{"tools":[{"tool_slug":"GMAIL_FETCH_EMAILS","arguments":{"query":"newer_than:1d","max_results":25}}]}' },
  { step: "anything that moved", tool: "COMPOSIO_MULTI_EXECUTE_TOOL", summary: '{"tools":[{"tool_slug":"SLACK_FETCH_CONVERSATION_HISTORY","arguments":{"channel":"C0THREAD","oldest":"1758400000"}}]}' },
  { step: "look one thing up", tool: "web_search", summary: '{"query":"acme corp funding round announced"}' },
  { step: "write the brief into its own thread file", tool: "Write", summary: '{"file_path":"/data/threads/t-chief/brief.md"}', ownWorkspace: true },
];

function verdictsFor(bot: AutoApprover, context: object): Array<{ step: string; source: AutoVerdictSource; carded: boolean }> {
  return BRIEF_SEQUENCE.map((call) => {
    const verdict = autoVerdict(bot, call.tool, call.summary, {
      ...context,
      ...(call.ownWorkspace ? { ownWorkspace: true as const } : {}),
    });
    return { step: call.step, source: verdict.source, carded: verdict.approve === null };
  });
}

// ── THE CASE THAT WAS NEVER MEASURED ───────────────────────────────────────

describe("the 7am scheduled brief on the first-run Chief, start to finish", () => {
  it("stops on the FIRST call and on every call after it, as no-grant", () => {
    expect(verdictsFor(firstRunChief, scheduled)).toEqual([
      { step: "find the calendar tool", source: "no-grant", carded: true },
      { step: "read its arguments", source: "no-grant", carded: true },
      { step: "today's calendar", source: "no-grant", carded: true },
      { step: "what came in overnight", source: "no-grant", carded: true },
      { step: "anything that moved", source: "no-grant", carded: true },
      { step: "look one thing up", source: "no-grant", carded: true },
      // the bot's own bookkeeping still goes through, which is what
      // own-workspace was added for
      { step: "write the brief into its own thread file", source: "own-workspace", carded: false },
    ]);
  });

  it("stalls before it has read anything, so the card the person wakes up to is a calendar search", () => {
    const first = autoVerdict(firstRunChief, BRIEF_SEQUENCE[0]!.tool, BRIEF_SEQUENCE[0]!.summary, scheduled);
    expect(first.approve).toBeNull();
    expect(first.source).toBe("no-grant");
    // no rule is named, because no grant was consulted: nobody ever said yes
    // to anything on this bot
    expect(first.rule).toBeUndefined();
  });

  it("is stopped by the absence of a grant, not by a guard and not by the mode downgrade", () => {
    const sources = new Set(verdictsFor(firstRunChief, scheduled).map((row) => row.source));
    expect(sources.has("destructive-guard")).toBe(false);
    expect(sources.has("sensitive-guard")).toBe(false);
    expect(sources.has("unattended-block")).toBe(false);
    expect(sources.has("full-access")).toBe(false);
  });
});

// ── and the bot the withdrawn diagnosis was actually describing ────────────

describe("the same brief once the PERSON has turned Auto on", () => {
  it("raises no card at all: every call falls through to the auto-mode grant", () => {
    expect(verdictsFor(raisedTo("auto"), scheduled).map((row) => row.source)).toEqual([
      "auto-mode",
      "auto-mode",
      "auto-mode",
      "auto-mode",
      "auto-mode",
      "auto-mode",
      "own-workspace",
    ]);
  });

  it("is judged identically on Full access — the downgrade is real, and costs nothing here", () => {
    // This half of the withdrawn diagnosis was right: `automated` downgrades
    // Full access to `other`, so the brief is judged exactly as Auto judges
    // it. It just never followed that a card appears, because Full access
    // implies Auto and Auto approves these.
    const auto = verdictsFor(raisedTo("auto"), scheduled).map((row) => row.source);
    const full = verdictsFor(raisedTo("full"), scheduled).map((row) => row.source);
    expect(full).toEqual(auto);
    expect(full).not.toContain("full-access");
  });
});

// ── so what else can stop it? ──────────────────────────────────────────────

describe("what stops a scheduled brief on a bot that IS on Auto", () => {
  // The guards match the card's summary text, and for a connector call that
  // text is arguments the model composed out of the person's own calendar and
  // inbox. So this stall is content-triggered: the same routine runs clean for
  // thirty days and stops on the morning somebody schedules a reboot window.
  const contentStalls: Array<[string, string, AutoVerdictSource]> = [
    [
      "a calendar entry with a maintenance window in its title",
      '{"tools":[{"tool_slug":"GOOGLECALENDAR_EVENTS_LIST","arguments":{"q":"prod database reboot window"}}]}',
      "destructive-guard",
    ],
    [
      "a mail search that happens to name a shutdown",
      '{"tools":[{"tool_slug":"GMAIL_FETCH_EMAILS","arguments":{"query":"subject:(office shutdown notice)"}}]}',
      "destructive-guard",
    ],
    [
      "a mail thread about a rotated key",
      '{"tools":[{"tool_slug":"GMAIL_FETCH_EMAILS","arguments":{"query":"STRIPE_API_KEY rotation"}}]}',
      "sensitive-guard",
    ],
    [
      "anything that says keychain",
      '{"tools":[{"tool_slug":"GMAIL_FETCH_EMAILS","arguments":{"query":"keychain prompt on the new laptop"}}]}',
      "sensitive-guard",
    ],
  ];

  for (const [what, summary, source] of contentStalls) {
    it(`stops on ${what}, as ${source}`, () => {
      const verdict = autoVerdict(raisedTo("full"), "COMPOSIO_MULTI_EXECUTE_TOOL", summary, scheduled);
      expect(verdict.source).toBe(source);
      expect(verdict.approve).toBeNull();
      // and the person is told nothing about WHICH app it was: the tool name
      // on the card is the wrapper, the same one a read and a send share
      expect(verdict.rule).toBeTruthy();
    });

    it(`stops on ${what} for the first-run Chief too, but as no-grant`, () => {
      // The guards sit ahead of the grants, so they decide the outcome only
      // where a grant would otherwise have applied. On a bot in Ask mode
      // there is no grant to overrule, and the card says so.
      const verdict = autoVerdict(firstRunChief, "COMPOSIO_MULTI_EXECUTE_TOOL", summary, scheduled);
      expect(verdict.approve).toBeNull();
      expect(verdict.source).toBe(source);
    });
  }

  it("a question from the engine always stops it, whatever the mode", () => {
    expect(autoVerdict(raisedTo("full"), "AskUserQuestion", "Should I include the board thread?", scheduled))
      .toEqual({ approve: null, source: "question-tool" });
    expect(autoVerdict(firstRunChief, "AskUserQuestion", "Should I include the board thread?", scheduled))
      .toEqual({ approve: null, source: "question-tool" });
  });
});

describe("the same routine started by a webhook or a channel message", () => {
  it("stops on EVERY call, as unattended-block, before content is even looked at", () => {
    const rows = verdictsFor(raisedTo("full"), triggered);
    expect(rows.filter((row) => row.step !== "write the brief into its own thread file")).toEqual([
      { step: "find the calendar tool", source: "unattended-block", carded: true },
      { step: "read its arguments", source: "unattended-block", carded: true },
      { step: "today's calendar", source: "unattended-block", carded: true },
      { step: "what came in overnight", source: "unattended-block", carded: true },
      { step: "anything that moved", source: "unattended-block", carded: true },
      { step: "look one thing up", source: "unattended-block", carded: true },
    ]);
    // the bot's own bookkeeping is the one thing that still goes through,
    // which is exactly what own-workspace was added for
    expect(rows.at(-1)).toEqual({ step: "write the brief into its own thread file", source: "own-workspace", carded: false });
  });

  it("names no block for the first-run Chief, because it had no grant to block", () => {
    // Same refusal, different reason, and the difference matters to anyone
    // reading a card: `unattended-block` means "this WOULD have been allowed",
    // `no-grant` means nobody has allowed anything here yet.
    expect(verdictsFor(firstRunChief, triggered).map((row) => row.source)).toEqual([
      "no-grant",
      "no-grant",
      "no-grant",
      "no-grant",
      "no-grant",
      "no-grant",
      "own-workspace",
    ]);
  });
});

// ── FINDING ────────────────────────────────────────────────────────────────
//
// This replaces the finding recorded here before, which was drawn from a
// hand-written `{ autoApprove: true, fullAccess: true }` bot that the first
// run does not create. Sean called off an approved policy change on the
// strength of it. The correction:
//
// 1. THE FIRST-RUN CHIEF'S 07:00 BRIEF DOES STALL, on its very first call,
//    and on every call after it. It is created in Ask mode — `createBot`
//    gives the first task `autoApprove: false`, `createTask` inherits that
//    for the routine's own task, electing the Chief changes no permission,
//    and Full access needs a desktop PATCH carrying an acknowledged warning
//    — so `autoVerdict` reaches the end with no grant to apply and returns
//    `no-grant`. The person wakes up to a card asking whether the bot may
//    search their calendar, and no brief.
//
// 2. THE WITHDRAWN DIAGNOSIS HAD THE RIGHT OUTCOME FOR THE WRONG REASON. Its
//    claim that `automated` downgrades Full access to `other` is true, and
//    its claim that the brief stalls is true. What does not follow is the
//    link between them: on a bot that HAS Full access the downgrade costs
//    nothing, because Full access implies Auto and Auto approves every call
//    in this sequence. The stall is not the downgrade. The stall is that
//    nobody ever turned Auto on.
//
// 3. WHICH MEANS THE APPROVED SPLIT WOULD HAVE MOVED THIS. All six carded
//    calls are reads, none of them is stopped by a guard, and every one of
//    them ends at `no-grant`. A rule that auto-approves connector READS on a
//    bot in Ask mode is exactly the rule that lets the first-run brief
//    finish. Whether that rule is wanted is a decision, and it is Sean's —
//    but it should be made against this, not against the earlier finding.
//
// 4. A BOT ALREADY ON AUTO stops for a different reason: content. The
//    destructive and sensitive regexes are matched against the card summary,
//    and for a connector call that summary is arguments composed from the
//    person's own calendar and inbox. "reboot", "shutdown", "keychain" or a
//    `*_API_KEY` name in a subject line is enough. Those four sit AHEAD of
//    every grant, so a reads-auto-approve split would not move them, and the
//    paragraph that said so still stands — for that case only.
//
// 5. The path that stops on every call whatever the mode is a routine started
//    by a WEBHOOK or a CHANNEL message, where `markUnattended` fires and
//    `unattended-block` refuses every grant. That is deliberate and
//    documented in its own comment; it is not a bug.
//
// 6. And some calls never reach this policy at all: Codex pre-approves
//    harness-owned MCP servers, and provider-level `fullAuto` answers the
//    permission before a card exists. A verdict recorded here is only the
//    verdict for calls that do arrive.
