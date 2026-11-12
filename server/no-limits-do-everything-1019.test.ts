// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// NOLIM 1.0.19 (designs/NOLIM-DO-EVERYTHING-1019.md rev 3.1). Sean's 1.0.18 asked ~121 times at No limits in 14 hours.
// Under level no-limits, work the owner (or his own bot, channel message or routine) started raises NO card except the wipe
// list. An explicit 1.0.19 bot choice applies to guests; inherited guest and unproven origins stay Ask. Every fixture
// string is inert data, never executed. Names in comments (M-N1 ...) are the design's mutants: each one fails the assertion
// named in its row.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gateHit, ruleRowId } from "../shared/gate-files.ts";

process.env.HOME = "/home/tester";
process.env.USERPROFILE = "/home/tester";
vi.resetModules();
const approve = await import("./auto-approve.ts");
const { autoVerdict, finalizeNoLimits, noLimitsInitiator, NO_LIMITS_SOURCE } = approve;
type AutoContext = import("./auto-approve.ts").AutoContext;
type AutoVerdict = import("./auto-approve.ts").AutoVerdict;
type AutoVerdictSource = import("./auto-approve.ts").AutoVerdictSource;

const ASK = { autoApprove: false };
const AUTO = { autoApprove: true };
const FULL = { autoApprove: true, fullAccess: true };
const NO_LIMITS = { autoApprove: true, fullAccess: true, noLimits: true, permissionExplicit: true };
const HOME = "/home/tester";
const CWD = "/home/tester/Documents/x";

/** The stored origin and the flags the server sets with it (index.ts at the approval listener): complete requests. */
const ORIGINS: Record<string, Partial<AutoContext>> = {
  "explicit-guest": { fullAccessOrigin:"other",unattended:true },
  // the owner at the keyboard, the turn not "clean" (ownerStarted false: 56 of Sean's 79 asks were this)
  owner: { fullAccessOrigin: "owner", ownerStarted: false, outsideRead: null },
  // the owner's own clean turn
  "owner-clean": { fullAccessOrigin: "owner", ownerStarted: true, outsideRead: null },
  // work continuing from the owner's turn through a bot hop (origin stays owner, the server's record)
  "owner-continuation": { fullAccessOrigin: "owner", ownerStarted: false, outsideRead: ["git"] },
  "owner-channel": { fullAccessOrigin: "owner-channel", unattended: true, automated: true, channelOwner: true },
  routine: { fullAccessOrigin: "routine", routineLevel: true, automated: true },
  "unattended-routine": { fullAccessOrigin:"routine",routineLevel:true,unattended:true },
};
const NOT_OWNER: Record<string, Partial<AutoContext>> = {
  // a stranger's message started a routine or delegated run: stored origin stays other through the hop (M-hop)
  // missing: no stored origin (the inferred default would say owner, M-origin-default)
  missing: {},
  "missing-automated": { automated: true },
  // conflicting stored facts
  "owner+unattended": { fullAccessOrigin: "owner", unattended: true },
  "owner+automated": { fullAccessOrigin: "owner", automated: true },
  "owner+channel": { fullAccessOrigin: "owner", channelOwner: true },
  "routine-without-level": { fullAccessOrigin: "routine", automated: true },
  "owner-channel-without-flag": { fullAccessOrigin: "owner-channel", unattended: true, automated: true },
};

const request = (bot: object, tool: string, text: string, ctx: Partial<AutoContext>, extra: Partial<AutoContext> = {}) =>
  autoVerdict(bot, tool, text, {
    ...(tool === "Bash" ? { commandText: text } : {}), commandCwd: CWD, stopLine: null,
    promptFacts: { cwd: CWD, home: HOME }, unseen: { platform: "posix" }, ...ctx, ...extra,
  } as AutoContext);

let botSeq = 0;
let info: ReturnType<typeof vi.spyOn>;
const lines = (): string[] => (info.mock.calls as unknown[][]).map((call) => String(call[0]));
beforeEach(() => { info = vi.spyOn(console, "info").mockImplementation(() => undefined); });
afterEach(() => { info.mockRestore(); });

/** What Sean's asks were (server.log since 11-09T12:00Z, sanitized fields only), as complete requests. Each: the class, the
 * origin it carried, a real entry-point request that raises that ask at c12aaad93, and the source it asks with. */
const LOG_ROWS: Array<{ id: string; reason: string; origin: keyof typeof ORIGINS; tool: string; text: string; extra?: Partial<AutoContext>; source: AutoVerdictSource; count: number }> = [
  { id: "unreadable owner=0", reason: "unreadable", origin: "owner", tool: "Bash", text: 'eval "$X"', source: "always-ask", count: 30 },
  { id: "outside-turn owner=1", reason: "outside-turn", origin: "owner-clean", tool: "Bash", text: "touch a", extra: { outsideRead: ["git"] }, source: "outside-turn", count: 18 },
  { id: "sensitive key-row owner=0", reason: "sensitive-guard", origin: "owner", tool: "Bash", text: "cat ~/.ssh/id_rsa", source: "sensitive-guard", count: 15 },
  { id: "sensitive home-glob owner=0", reason: "sensitive-guard", origin: "owner", tool: "Bash", text: "ls ~/.ssh/*", source: "sensitive-guard", count: 4 },
  { id: "routine unreadable", reason: "unreadable", origin: "routine", tool: "Bash", text: 'eval "$X"', source: "always-ask", count: 3 },
  { id: "routine sensitive", reason: "sensitive-guard", origin: "routine", tool: "Bash", text: "cat ~/.ssh/id_rsa", source: "sensitive-guard", count: 4 },
  { id: "unreadable owner=1", reason: "unreadable", origin: "owner-clean", tool: "Bash", text: 'bash -c "$(cat run.sh)"', source: "always-ask", count: 3 },
];

describe("P1 replay: the asked lines of Sean's 1.0.18 log", () => {
  it("every logged ask class asks at c12aaad93's shape under Ask and Auto (no change outside No limits)", () => {
    for (const row of LOG_ROWS) {
      for (const bot of [ASK, AUTO]) {
        const verdict = request(bot, row.tool, row.text, ORIGINS[row.origin]!, row.extra);
        if (bot === ASK) expect(verdict.approve, `${row.id} at Ask`).toBeNull();
        if (bot === AUTO && row.source === "outside-turn") continue; // the lane is a No limits rule; Auto answers or asks by its own rules
        if (bot === AUTO) expect(verdict.source, `${row.id} at Auto`).not.toBe("no-limits");
      }
    }
  });

  it("Full access: nothing changes (no no-limits source, no auto line)", () => {
    for (const row of LOG_ROWS) {
      const verdict = request(FULL, row.tool, row.text, ORIGINS[row.origin]!, row.extra);
      expect(verdict.source, row.id).not.toBe("no-limits");
    }
    expect(lines().filter((line) => line.startsWith("approvals: auto "))).toEqual([]);
  });

  it("No limits: every logged ask class runs with no card and one auto line (M-N1: drop the gate)", () => {
    for (const row of LOG_ROWS) {
      info.mockClear();
      const verdict = request(NO_LIMITS, row.tool, row.text, ORIGINS[row.origin]!, row.extra);
      expect(verdict.approve, `${row.id}: ${verdict.source} ${verdict.rule ?? ""}`).toBeTruthy();
      expect(verdict.source, row.id).toBe("no-limits");
      const auto = lines().filter((line) => line.startsWith("approvals: auto "));
      expect(auto, row.id).toHaveLength(1);
      expect(auto[0]).toMatch(/ level=no-limits initiator=(owner|routine|owner-channel)$/);
      expect(auto[0]).not.toContain(row.text);
      expect(lines().filter((line) => line.startsWith("approvals: asked")), `${row.id}: no ask line`).toEqual([]);
    }
  });

  // Reconciliation (design R8): the log holds 128 asked lines since 11-09T12:00Z: 81 at level=no-limits (every one origin
  // owner or routine, none other) and 47 at Ask or Auto (unchanged). The 121/126/79 figures count other windows; the log
  // writes one line per bot/tool/class/minute (ASK_LOG_MS) and counts repeats in suppressed=, so a line is not a card.
  // The 81 are the seven rows above (77) plus owner=1 sensitive-guard key-row (3) and one owner=0 unread-call:truncated.
  it("the table covers every no-limits class in the log", () => {
    expect(LOG_ROWS.reduce((n, row) => n + row.count, 0) + 3 + 1).toBe(81);
  });
});

describe("P2 per source: N1 sources run, N2 stops", () => {
  const RUN_SOURCES = (Object.keys(NO_LIMITS_SOURCE ?? {}) as AutoVerdictSource[]).filter((source) => NO_LIMITS_SOURCE[source] === "run");
  const KEEP_SOURCES = (Object.keys(NO_LIMITS_SOURCE ?? {}) as AutoVerdictSource[]).filter((source) => NO_LIMITS_SOURCE[source] === "keep");

  it("each N1 source runs for every eligible owner, automation and explicitly set guest origin with one auto line", () => {
    for (const source of RUN_SOURCES) {
      for (const [name, ctx] of Object.entries(ORIGINS)) {
        info.mockClear();
        const given: AutoVerdict = { approve: null, source, ...(source === "always-ask" ? { rule: "unreadable" } : {}) };
        const final = finalizeNoLimits(NO_LIMITS, "Bash", "echo hi", { ...ctx, commandText: "echo hi", stopLine: null } as AutoContext, given);
        expect(final.approve, `${source} / ${name}`).toBeTruthy();
        expect(final.source).toBe("no-limits");
        expect(lines().filter((line) => line.startsWith("approvals: auto ")), `${source} / ${name}`).toHaveLength(1);
      }
    }
  });

  it("an allow is left untouched (F4: handler-carded own tools return an own-unasked approve)", () => {
    const allowed: AutoVerdict = { approve: "ok", source: "own-unasked" };
    expect(finalizeNoLimits(NO_LIMITS, "mcp__murage__x", "x", ORIGINS.owner as AutoContext, allowed)).toBe(allowed);
  });

  it("question-tool remains a question; permission sources run at No limits", () => {
    expect(KEEP_SOURCES.sort()).toEqual(["owner-switch","question-tool"]);
    for (const source of KEEP_SOURCES) {
      const given: AutoVerdict = { approve: null, source };
      expect(finalizeNoLimits(NO_LIMITS, "Bash", "x", ORIGINS.owner as AutoContext, given), source).toBe(given);
    }
  });

  const WIPES: Array<[string, string, string]> = [
    ["delete-root", "rm -rf /", "Bash"], ["delete-home", "rm -rf ~", "Bash"], ["delete-system-folder", "rm -rf /usr", "Bash"],
    ["disk-erase", "dd if=/dev/zero of=/dev/sda", "Bash"], ["fork-bomb", ":(){ :|:& };:", "Bash"],
  ];
  it("N2.1: every wipe-list rule still asks, for every eligible origin (M-N2: let disk-erase through)", () => {
    for (const [rule, text, tool] of WIPES) {
      for (const [name, ctx] of Object.entries(ORIGINS)) {
        const verdict = request(NO_LIMITS, tool, text, ctx);
        expect(verdict.approve, `${rule} / ${name}`).toBeNull();
        expect(verdict.source).toBe("always-ask");
        expect(verdict.rule, `${rule} / ${name}`).toBe(rule);
        expect(verdict.reason, `${rule} / ${name}: the held verdict names its finding (M-N2.1b)`).toBeDefined();
      }
    }
  });

  it("R3 unknown deletes run in outer and nested commands without a named catastrophe", () => {
    for (const [name, ctx] of Object.entries(ORIGINS)) {
      // the reader cannot place the target, but the text plainly deletes: today's card stays
      const outer = request(NO_LIMITS, "Bash", 'rm -rf "$X"', ctx);
      expect(outer.approve, `outer / ${name}: unknown target is not a wipe`).toBeTruthy();
      // a wrapper tool: the outer text is harmless, the inner command is what runs
      const wrapped = autoVerdict(NO_LIMITS, "mcp__cloud__exec", "run a command", {
        ...ctx, commandCwd: CWD, stopLine: null, promptFacts: { cwd: CWD, home: HOME }, unseen: { platform: "posix" },
        call: { toolCall: { input: { command: 'rm -rf "$Y"' } }, engine: "claude" },
      } as AutoContext);
      expect(wrapped.approve, `inner / ${name}: ${wrapped.source}`).toBeTruthy();
    }
  });

  it("R4/F3: a named catastrophe the reader could name but not place stays held in every reader mode (M-N2.1b)", () => {
    for (const [name, ctx] of Object.entries(ORIGINS)) {
      const verdict = request(NO_LIMITS, "Bash", `python3 -c "import shutil; shutil.rmtree('/')"`, ctx);
      expect(verdict.approve, name).toBeNull();
    }
  });

  it("a text the reader could not follow, with no wipe in it, runs (the case Sean's log is full of)", () => {
    const verdict = request(NO_LIMITS, "Bash", 'eval "$X"', ORIGINS.owner!);
    expect(verdict.approve).toBeTruthy();
  });
});

describe("P2 initiator: explicit bot choices apply; unproven origins stay Ask", () => {
  it("missing or inconsistent origin uses Ask and logs its original origin", () => {
    for (const [name, ctx] of Object.entries(NOT_OWNER)) {
      for (const [text, source] of [['eval "$X"', "always-ask"], ["cat ~/.ssh/id_rsa", "sensitive-guard"]] as const) {
        const caseId=++botSeq;
        info.mockClear();
        const baseline=request({...ASK,id:`baseline-${caseId}`},"Bash",text,ctx);
        const baselineOrigin=lines().find(line=>line.startsWith("approvals: asked"))?.match(/ origin=(\S+) /)?.[1];
        expect(baselineOrigin,`${name}: Ask log origin`).toBeDefined();
        expect(baseline.approve,`${name}: Ask control`).toBeNull();
        expect(baseline.source,`${name}: Ask source`).not.toBe("no-limits");
        info.mockClear();
        const verdict = request({ ...NO_LIMITS, id: `b${caseId}` }, "Bash", text, ctx);
        expect(verdict.approve, `${name}: ${text}`).toBeNull();
        expect(verdict, `${name}: exact Ask source and rule for ${source}`).toEqual(baseline);
        expect(lines().some((line) => line.startsWith("approvals: auto ")), name).toBe(false);
        expect(lines().find((line) => line.startsWith("approvals: asked")), name).toMatch(/ level=ask(?: |$)/);
        expect(lines().find((line) => line.startsWith("approvals: asked")), name).toContain(`origin=${baselineOrigin}`);
      }
    }
  });

  it("noLimitsInitiator reads the STORED origin only (M-origin-default)", () => {
    expect(noLimitsInitiator(NO_LIMITS, {})).toBe("unproven");
    expect(noLimitsInitiator(NO_LIMITS, { fullAccessOrigin: "other" })).toBe("other");
    expect(noLimitsInitiator(NO_LIMITS, { fullAccessOrigin: "owner" })).toBe("owner");
    expect(noLimitsInitiator(NO_LIMITS, { fullAccessOrigin: "owner", unattended: true })).toBe("unproven");
    expect(noLimitsInitiator(NO_LIMITS, { fullAccessOrigin: "routine", routineLevel: true })).toBe("routine");
    expect(noLimitsInitiator(NO_LIMITS, { fullAccessOrigin: "routine" })).toBe("unproven");
    expect(noLimitsInitiator(NO_LIMITS, { fullAccessOrigin: "owner-channel", channelOwner: true, unattended: true })).toBe("owner-channel");
    expect(noLimitsInitiator(NO_LIMITS, { fullAccessOrigin: "owner-channel" })).toBe("unproven");
    // the owner turned his channel option off: Full access does not cover it, so neither does No limits
    expect(noLimitsInitiator({ ...NO_LIMITS, fullAccessChannelMessages: false }, { fullAccessOrigin: "owner-channel", channelOwner: true })).toBe("other");
    // no stored origin, but a live routine level with nothing against it
    expect(noLimitsInitiator(NO_LIMITS, { routineLevel: true })).toBe("routine");
    expect(noLimitsInitiator(NO_LIMITS, { routineLevel: true, unattended: true })).toBe("unproven");
  });

  it("a stranger's message that reaches a routine or a bot hop stays other (M-hop)", () => {
    const verdict = request(NO_LIMITS, "Bash", 'eval "$X"', {fullAccessOrigin:"other",routineLevel:true,automated:true, noLimitsOrigin:"unproven"});
    expect(verdict.approve).toBeNull();
  });
});

describe("R1 entry points: every approval path reaches the one finalizer", () => {
  it("autoVerdict and the routine wrapper both run it (routineTurnApproval calls autoVerdict)", async () => {
    const { routineTurnApproval } = await import("./routine-permissions.ts");
    const out = routineTurnApproval({ bot: NO_LIMITS, run: { permissionMode: "unlimited" } as never, tool: "Bash", summary: 'eval "$X"',
      context: { ...ORIGINS.routine, commandText: 'eval "$X"', commandCwd: CWD, stopLine: null, promptFacts: { cwd: CWD, home: HOME }, unseen: { platform: "posix" } } as AutoContext });
    expect(out.verdict.source).toBe("no-limits");
  });

  it("autoDecision, which every card-less caller reads, is the same answer", async () => {
    const decision = approve.autoDecision(NO_LIMITS, "Bash", 'eval "$X"', { ...ORIGINS.owner, commandText: 'eval "$X"', commandCwd: CWD, stopLine: null, promptFacts: { cwd: CWD, home: HOME }, unseen: { platform: "posix" } } as AutoContext);
    expect(decision).toBeTruthy();
  });

  it("a reader that throws still reaches the finalizer: the synthetic unreadable ask runs for the owner (M-catch)", () => {
    let reads = 0;
    const ctx = { ...ORIGINS.owner, commandCwd: CWD, stopLine: null, promptFacts: { cwd: CWD, home: HOME }, unseen: { platform: "posix" },
      get commandText(): string { if (reads++ === 0) throw new Error("reader fault"); return "echo hi"; } } as unknown as AutoContext;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const verdict = autoVerdict(NO_LIMITS, "Bash", "echo hi", ctx);
    expect(verdict.source).toBe("no-limits");
  });

  it("a finalizer fault keeps today's card (it never drops the request)", () => {
    const ctx = { commandText: 'eval "$X"', commandCwd: CWD, stopLine: null } as unknown as AutoContext;
    Object.defineProperty(ctx, "fullAccessOrigin", { get(): never { throw new Error("fault"); } });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const verdict = autoVerdict(NO_LIMITS, "Bash", 'eval "$X"', ctx);
    expect(verdict.approve).toBeNull();
  });
});

describe("P3 exhaustive classification", () => {
  const source = readFileSync(new URL("./auto-approve.ts", import.meta.url), "utf8");
  const askSource = readFileSync(new URL("./always-ask.ts", import.meta.url), "utf8");

  it("every AutoVerdictSource is classified (a new source fails here, and fails to compile: Record<AutoVerdictSource, ...>)", () => {
    const block = /export type AutoVerdictSource =([\s\S]*?);\n\nexport interface AutoVerdict /.exec(source)?.[1] ?? "";
    const declared = [...block.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/\|\s*"([a-z-]+)"/g)].map((match) => match[1]!).sort();
    expect(declared.length).toBeGreaterThan(20);
    expect(Object.keys(NO_LIMITS_SOURCE ?? {}).sort()).toEqual(declared);
  });

  it("every AlwaysAskRule is classified wipe or run (Record<AlwaysAskRule, ...>)", async () => {
    const { ALWAYS_ASK_NO_LIMITS } = await import("./always-ask.ts");
    const declared = [...(/export type AlwaysAskRule = ([^;]+);/.exec(askSource)?.[1] ?? "").matchAll(/"([a-z-]+)"/g)].map((match) => match[1]!).sort();
    expect(Object.keys(ALWAYS_ASK_NO_LIMITS).sort()).toEqual(declared);
    expect(declared.filter((rule) => ALWAYS_ASK_NO_LIMITS[rule as keyof typeof ALWAYS_ASK_NO_LIMITS] === "wipe").sort())
      .toEqual(["delete-home", "delete-root", "delete-system-folder", "disk-erase", "fork-bomb"]);
  });
});

// T20: hook-canon.ts restores hook files before use; the finalizer has no kept-row step.
describe("T20 the No limits finalizer has no kept-row step", () => {
  it("guest hook writes follow an explicit choice while legacy bots keep Ask",()=>{
    const context=ORIGINS['explicit-guest']!;
    const legacy={...NO_LIMITS,permissionExplicit:false};
    expect(request(NO_LIMITS,'Bash',`cp /tmp/x ${HOME}/.murage/native/codex-scope/murage-hook.mjs`,context)).toMatchObject({source:'no-limits',approve:expect.any(String)});
    expect(request(NO_LIMITS,'edit','edit hook',context,{call:{toolCall:{name:'edit',input:{file_path:`${HOME}/.murage/native/codex-scope/murage-hook.mjs`,new_string:'x'}}}} as Partial<AutoContext>)).toMatchObject({source:'no-limits',approve:expect.any(String)});
    expect(request(legacy,'Bash',`cp /tmp/x ${HOME}/.murage/native/codex-scope/murage-hook.mjs`,context).approve).toBeNull();
    expect(request(legacy,'edit','edit hook',context,{call:{toolCall:{name:'edit',input:{file_path:`${HOME}/.murage/native/codex-scope/murage-hook.mjs`,new_string:'x'}}}} as Partial<AutoContext>).approve).toBeNull();
  });
  it("directly releases a held hook-row verdict for a proven owner's non-wipe copy (M-finalizer-kept)", () => {
    // Design 3.8: exercise the finalizer even when the clean-turn fast path would bypass it.
    const command = "cp x ~/.murage/native/codex-scope/murage-hook.mjs";
    const rule = gateHit([command]);
    expect(ruleRowId(rule ?? undefined)).toBe("murage-engine-hooks");
    const held: AutoVerdict = { approve: null, source: "sensitive-guard", rule: rule! };
    const context: AutoContext = {
      fullAccessOrigin: "owner", ownerStarted: true, outsideRead: null,
      commandText: command, commandCwd: CWD, stopLine: null,
      promptFacts: { cwd: CWD, home: HOME }, unseen: { platform: "posix" },
    };
    expect(finalizeNoLimits(NO_LIMITS, "Bash", command, context, held)).toMatchObject({
      approve: "auto-approved Bash (no limits)", source: "no-limits",
    });
    expect(lines()).toEqual([expect.stringContaining("reason=sensitive-guard row=murage-engine-hooks level=no-limits initiator=owner")]);
    expect(held.approve).toBeNull();
    expect(finalizeNoLimits(FULL, "Bash", command, context, held)).toBe(held);
    expect(finalizeNoLimits(NO_LIMITS, "Bash", command, { ...context, fullAccessOrigin: undefined }, held)).toBe(held);
  });

  for (const [name, ctx] of Object.entries(ORIGINS)) {
    it(`${name}: hook writes run for every proven initiator`, () => {
      const relay = `${HOME}/.murage/native/antigravity-relay/agy-t1/murage-agy-relay.cjs`;
      const hook = `${HOME}/.murage/native/codex-scope/murage-hook.mjs`;
      const cp = request(NO_LIMITS, "Bash", `cp /tmp/x ${relay}`, ctx);
      expect(cp.approve).toBeTruthy();
      expect(cp.source).toBe("no-limits");
      const edit = request(NO_LIMITS, "edit", `edit ${hook}`, ctx, { call: { toolCall: { name: "edit", input: { file_path: hook, new_string: "x" } } } } as Partial<AutoContext>);
      expect(edit.approve).toBeTruthy();
      expect(edit.source).toBe("no-limits");
    });
  }

  it("the same turn runs an ordinary write beside it", () => {
    const ok = request(NO_LIMITS, "Bash", `cp /tmp/x ${HOME}/.murage/notes-for-me.txt`, ORIGINS["owner-clean"]!);
    expect(ok.approve).toBeTruthy();
  });
});
