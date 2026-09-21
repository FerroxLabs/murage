// W15-DIAG: WHAT ACTUALLY STOPS A MORNING BRIEF?
//
// The 0.1.58 plan carried an approved policy change built on this diagnosis:
// "a Full-access bot running a routine is judged as Auto, and therefore
// stalls waiting for approval". The first half is true and the second half
// does not follow, so before anything in the approval policy is relaxed, this
// establishes — by running the real policy over the real routine — which call
// raises a card and under which rule.
//
// Nothing here changes policy. It is a characterization test: it pins what
// server/auto-approve.ts does today for the first run's Morning brief, so the
// next person to propose a fix is arguing with a recorded verdict rather than
// with a description of one.
//
// Read the FINDING block at the bottom for the answer in words.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { autoVerdict, type AutoVerdictSource } from "./auto-approve.ts";

/** server/index.ts boots a server on import, so the two facts this test needs
 *  from it — the brief's prompt and the turn context a scheduled routine runs
 *  under — are read out of the source, the same way
 *  server/setup-brief-template.test.ts reads the template. */
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
// This is the fact the withdrawn diagnosis skipped, and it decides everything
// below: `unattended` and `automated` are two different flags, and a routine
// on a clock sets only one of them.

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

/** The bot the first run creates: Chief, on Full access, which per
 *  src/lib/permission-mode.ts can only mean `autoApprove` is on as well. */
const chief = { autoApprove: true, fullAccess: true, alwaysAllow: [] };

/** A 7am scheduled run of the brief. `automated`, not `unattended`. */
const scheduled = { automated: true } as const;

/** The same routine fired by a webhook or an inbound channel message, which
 *  is the other way the first run's routines can start. */
const triggered = { automated: true, unattended: true } as const;

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

function verdictsFor(context: object): Array<{ step: string; source: AutoVerdictSource; carded: boolean }> {
  return BRIEF_SEQUENCE.map((call) => {
    const verdict = autoVerdict(chief, call.tool, call.summary, {
      ...context,
      ...(call.ownWorkspace ? { ownWorkspace: true as const } : {}),
    });
    return { step: call.step, source: verdict.source, carded: verdict.approve === null };
  });
}

describe("the 7am scheduled brief, start to finish", () => {
  it("raises NO card: every call is approved, and Full access is not what approves it", () => {
    expect(verdictsFor(scheduled)).toEqual([
      { step: "find the calendar tool", source: "auto-mode", carded: false },
      { step: "read its arguments", source: "auto-mode", carded: false },
      { step: "today's calendar", source: "auto-mode", carded: false },
      { step: "what came in overnight", source: "auto-mode", carded: false },
      { step: "anything that moved", source: "auto-mode", carded: false },
      { step: "look one thing up", source: "auto-mode", carded: false },
      { step: "write the brief into its own thread file", source: "own-workspace", carded: false },
    ]);
  });

  it("is judged identically to the same bot on plain Auto — the downgrade is real, and costs nothing here", () => {
    const asAuto = BRIEF_SEQUENCE.map((call) =>
      autoVerdict({ autoApprove: true, fullAccess: false, alwaysAllow: [] }, call.tool, call.summary, {
        ...scheduled,
        ...(call.ownWorkspace ? { ownWorkspace: true as const } : {}),
      }).source,
    );
    expect(asAuto).toEqual(verdictsFor(scheduled).map((row) => row.source));
    // and nowhere in the run does Full access itself decide anything
    expect(verdictsFor(scheduled).map((row) => row.source)).not.toContain("full-access");
  });
});

// ── so what DOES raise a card? ─────────────────────────────────────────────

describe("what actually stops a scheduled brief", () => {
  // The guards match the card's summary text, and for a connector call that
  // text is arguments the model composed out of the person's own calendar and
  // inbox. So the stall is content-triggered: the same routine runs clean for
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
      const verdict = autoVerdict(chief, "COMPOSIO_MULTI_EXECUTE_TOOL", summary, scheduled);
      expect(verdict.source).toBe(source);
      expect(verdict.approve).toBeNull();
      // and the person is told nothing about WHICH app it was: the tool name
      // on the card is the wrapper, the same one a read and a send share
      expect(verdict.rule).toBeTruthy();
    });
  }

  it("a question from the engine always stops it, whatever the mode", () => {
    const verdict = autoVerdict(chief, "AskUserQuestion", "Should I include the board thread?", scheduled);
    expect(verdict).toEqual({ approve: null, source: "question-tool" });
  });
});

describe("the same routine started by a webhook or a channel message", () => {
  it("stops on EVERY call, as unattended-block, before content is even looked at", () => {
    const rows = verdictsFor(triggered);
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
});

// ── FINDING ────────────────────────────────────────────────────────────────
//
// 1. A SCHEDULED brief on a Full-access bot raises no card at all. Full access
//    is downgraded to `other` by `automated`, exactly as the plan said — and
//    then the turn falls straight through to the `auto-mode` grant, because
//    Full access implies `autoApprove: true`. The withdrawn diagnosis was
//    wrong: there is no stall to fix on this path.
//
// 2. What a scheduled brief CAN stop on is content, not policy mode: the
//    destructive and sensitive regexes are matched against the card summary,
//    and for a connector call that summary is arguments composed from the
//    person's own calendar and inbox. "reboot", "shutdown", "keychain" or a
//    `*_API_KEY` name in a subject line is enough. The approved split ("reads
//    auto-approve, writes keep asking") would not have moved any of these:
//    they are all reads, and they are all carded by a guard that sits ahead of
//    every grant.
//
// 3. The path that really does stop on every call is a routine started by a
//    WEBHOOK or a CHANNEL message, where `markUnattended` fires and
//    `unattended-block` refuses every grant. That is deliberate and documented
//    in its own comment; it is not a bug and the approved fix did not address
//    it either.
//
// 4. And some calls never reach this policy at all: Codex pre-approves
//    harness-owned MCP servers, and provider-level `fullAuto` answers the
//    permission before a card exists. A verdict recorded here is only the
//    verdict for calls that do arrive.
