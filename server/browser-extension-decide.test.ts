// SPDX-License-Identifier: AGPL-3.0-or-later
// T23W: the one decision call site. Order, "a later stage never loosens an earlier one", fail closed.
import { describe, expect, it, vi } from "vitest";
import { classifyFloor } from "./browser-floor.ts";
import { classifyLevel, type LevelFacts } from "./browser-levels.ts";
import { checkIntent, type Visibility } from "./browser-intent.ts";
import { CheckerTally, type CheckerVerdict } from "./browser-action-checker.ts";
import { decide, DECIDE_LINES, type DecideDeps, type DecideInput } from "./browser-extension-decide.ts";
import en from "../src/locales/en.json" with { type: "json" };

const VISIBLE: Visibility = { box: { x: 10, y: 10, width: 80, height: 20 }, inViewport: true, opacity: 1, visibility: "visible", ariaHidden: false, coveredBy: null };
const typing: LevelFacts = { operation: "fill", tag: "input", type: "text", role: "textbox", name: "Notes" };
const sendBtn: LevelFacts = { operation: "click", tag: "button", role: "button", name: "Send" };
const snapshot: LevelFacts = { operation: "snapshot" };
const verdict = (decision: CheckerVerdict["decision"], code = "x", stage: 1 | 2 = 2): CheckerVerdict => ({ decision, code, stage, reason: "r" });

function input(facts: LevelFacts, over: Partial<DecideInput> = {}): DecideInput {
  const floor = classifyFloor(facts);
  return {
    bindingActive: true, ownerAudience: true, siteAccess: "allow", category: "normal", clipboard: false,
    floor: floor.floor ? floor : null,
    operation: facts.operation, key: facts.key, facts,
    mode: "task", routine: false, grants: { l1: true, l2: false }, siteAllowedAlways: false,
    probeFlagged: false,
    intent: { ownerWords: ["fill in my notes"], taskSites: new Set(["https://a.example"]), readOrigins: new Map(), counters: { hits: 0 }, visibility: VISIBLE,
      action: { operation: facts.operation, origin: "https://a.example" } },
    checker: { input: { ownerInstruction: "fill in my notes", siteGrant: "allowed", action: { operation: facts.operation, site: "https://a.example" } }, deps: { transport: async () => "ALLOW", models: { stage1: "s1", stage2: "s2" } }, tally: new CheckerTally() },
    ...over,
  };
}
function spies(order: string[], check: () => Promise<CheckerVerdict> = async () => verdict("allow", "checker_ok")): DecideDeps & { checkAction: ReturnType<typeof vi.fn> } {
  return {
    classifyLevel: vi.fn((i) => { order.push("level"); return classifyLevel(i); }),
    checkIntent: vi.fn((i) => { order.push("intent"); return checkIntent(i); }),
    checkAction: vi.fn(async () => { order.push("checker"); return check(); }),
  } as never;
}

describe("T23W decision order", () => {
  it("runs level, then the I-rules, then the checker, then the mode decision", async () => {
    const order: string[] = [];
    const d = await decide(input(typing), spies(order));
    // classifyLevel runs twice: once for the level, once more with the verdicts for mode and grants.
    expect(order).toEqual(["level", "intent", "checker", "level"]);
    expect(d.trace).toEqual(["binding", "site", "clipboard", "floor", "level", "intent", "checker", "mode"]);
    expect(d.outcome).toBe("card"); // task mode, first L2 on the site
  });
  it("the floor short-circuits before level, rules and checker are ever called", async () => {
    const order: string[] = [];
    const facts: LevelFacts = { operation: "fill", tag: "input", type: "password", role: "textbox", name: "Password" };
    const d = await decide(input(facts), spies(order));
    expect(d.outcome).toBe("floor");
    expect(order).toEqual([]);
  });
  it("a floor that was never checked (undefined) is the floor, not a pass", async () => {
    const order: string[] = [];
    const d = await decide(input(typing, { floor: undefined as never }), spies(order));
    expect(d.outcome).toBe("floor");
    expect(order).toEqual([]);
  });
  it("a refused site or clipboard never reaches the later stages", async () => {
    for (const over of [{ siteAccess: "never" as const }, { clipboard: true }, { bindingActive: false }, { ownerAudience: false }, { category: "handover" as const }]) {
      const order: string[] = [];
      const d = await decide(input(typing, over), spies(order));
      expect(d.outcome, JSON.stringify(over)).toBe("refuse");
      expect(order.includes("checker"), JSON.stringify(over)).toBe(false);
    }
  });
  it("L1 never calls the checker", async () => {
    const order: string[] = [];
    const deps = spies(order);
    const d = await decide(input(snapshot, { intent: { ...input(snapshot).intent, visibility: undefined, action: { operation: "snapshot", origin: "https://a.example", hasTarget: false } } }), deps);
    expect(d.level).toBe("L1");
    expect(d.outcome).toBe("pass");
    expect(deps.checkAction).not.toHaveBeenCalled();
  });
  it("an I-rule refusal (hidden target, I4) stops before the checker", async () => {
    const order: string[] = [];
    const d = await decide(input(typing, { intent: { ...input(typing).intent, visibility: { ...VISIBLE, opacity: 0 } } }), spies(order));
    expect(d.outcome).toBe("refuse");
    expect(d.rule).toBe("I4");
    expect(order).not.toContain("checker");
  });
  it("no visibility facts at all is hidden for a targeted action (unsure tightens)", async () => {
    const d = await decide(input(typing, { intent: { ...input(typing).intent, visibility: undefined } }), spies([]));
    expect(d.outcome).toBe("refuse");
    expect(d.rule).toBe("I4");
  });
});

describe("T23W the checker can only tighten", () => {
  it("allow on L3 still shows the card (task and step), with the matches line", async () => {
    for (const mode of ["task", "step"] as const) {
      const d = await decide(input(sendBtn, { mode }), spies([], async () => verdict("allow", "checker_ok")));
      expect(d.level).toBe("L3");
      expect(d.outcome, mode).toBe("card");
      expect(d.checkerNote).toBe(DECIDE_LINES.matches);
    }
  });
  it("Full permissive L3 passes only on the checker's allow with the rules clear (spec D3)", async () => {
    const d = await decide(input(sendBtn, { mode: "full" }), spies([], async () => verdict("allow", "checker_ok")));
    expect(d.outcome).toBe("pass");
  });
  it("legacy: allow on L3 shows the matches line", async () => {
    const d = await decide(input(sendBtn, { mode: "task" }), spies([], async () => verdict("allow", "checker_ok")));
    expect(d.level).toBe("L3");
    expect(d.outcome).toBe("card");
    expect(d.checkerNote).toBe(DECIDE_LINES.matches);
  });
  it("allow on L2 in task mode with a grant passes silently (the checker never invents a card)", async () => {
    const d = await decide(input(typing, { grants: { l1: true, l2: true } }), spies([], async () => verdict("allow", "checker_ok")));
    expect(d.outcome).toBe("pass");
  });
  it("ask on L2 with a grant adds a card, decided by the checker", async () => {
    const d = await decide(input(typing, { grants: { l1: true, l2: true } }), spies([], async () => verdict("ask", "checker_ask")));
    expect(d.outcome).toBe("card");
    expect(d.decidedBy).toBe("checker");
    expect(d.checkerNote).toBe(DECIDE_LINES.mismatch);
  });
  it("block, attended, is a card with the plain checker copy; unattended (routine) it is a refusal", async () => {
    const attended = await decide(input(typing, { grants: { l1: true, l2: true } }), spies([], async () => verdict("block", "checker_block")));
    expect(attended.outcome).toBe("card");
    expect(attended.decidedBy).toBe("checker");
    expect(attended.line).toBe(DECIDE_LINES.blocked);
    const routine = await decide(input(typing, { routine: true, siteAllowedAlways: true, grants: { l1: false, l2: false } }), spies([], async () => verdict("block", "checker_block")));
    expect(routine.outcome).toBe("refuse");
  });
  it("Full permissive + checker allow + the probe's I3 flag is a card", async () => {
    const d = await decide(input(typing, { mode: "full", probeFlagged: true }), spies([], async () => verdict("allow", "checker_ok")));
    expect(d.outcome).toBe("card");
    expect(d.decidedBy).toBe("intent");
    expect(d.line).toContain(en["browserExt.intent.i3" as keyof typeof en] as string);
  });
  it("Full permissive L3 needs the checker's allow; ask keeps the card", async () => {
    const d = await decide(input(sendBtn, { mode: "full" }), spies([], async () => verdict("ask", "checker_ask")));
    expect(d.outcome).toBe("card");
  });
  it("property: no stage output ever makes a decision less strict than the all-allow baseline, and the floor and refusals are sticky", async () => {
    const verdicts = [verdict("allow", "checker_ok"), verdict("ask", "checker_ask"), verdict("block", "checker_block"), verdict("block", "checker_unavailable")];
    const rank = { pass: 0, skip: 1, "site-card": 1, card: 1, pause: 2, refuse: 2, floor: 3 } as const;
    for (const facts of [snapshot, typing, sendBtn]) for (const mode of ["step", "task", "full"] as const) for (const flagged of [false, true]) {
      const base = input(facts, { mode, probeFlagged: false, intent: { ...input(facts).intent, visibility: facts.operation === "snapshot" ? undefined : VISIBLE, action: { operation: facts.operation, origin: "https://a.example", ...(facts.operation === "snapshot" ? { hasTarget: false } : {}) } } });
      const best = await decide(base, spies([], async () => verdict("allow", "checker_ok")));
      for (const v of verdicts) {
        const got = await decide({ ...base, probeFlagged: flagged }, spies([], async () => v));
        expect(rank[got.outcome], `${facts.operation} ${mode} flagged=${flagged} ${v.decision}`).toBeGreaterThanOrEqual(rank[best.outcome]);
        expect(got.level).toBe(best.level);
      }
    }
  });
  it("a checker that throws, times out or returns junk is a block, never a pass, for L2 and L3", async () => {
    for (const facts of [typing, sendBtn]) {
      for (const bad of [async () => { throw new Error("boom"); }, async () => ({ nonsense: true }) as never, async () => undefined as never]) {
        const d = await decide(input(facts, { mode: "full", grants: { l1: true, l2: true } }), spies([], bad));
        expect(d.outcome, facts.operation).not.toBe("pass");
        expect(d.checker?.decision).toBe("block");
      }
    }
  });
  it("Flux's plan and key refusals keep their own plain copy and are never silent passes", async () => {
    for (const code of ["checker_model_not_allowed", "checker_model_not_permitted"]) {
      const d = await decide(input(typing, { mode: "full", grants: { l1: true, l2: true } }), spies([], async () => verdict("block", code, 1)));
      expect(d.outcome).toBe("card");
      expect(d.checker?.code).toBe(code);
      expect(d.line).not.toBe(DECIDE_LINES.blocked);
    }
  });
  it("checker timeout on L2 in step mode: card, nothing dispatched by decide", async () => {
    const d = await decide(input(typing, { mode: "step" }), spies([], async () => verdict("block", "checker_unavailable", 1)));
    expect(d.outcome).toBe("card");
    expect(d.line).toBe(DECIDE_LINES.unavailable);
  });
  it("no transport: the checker is skipped, the bot is treated as Ask each step, and the plain line is returned", async () => {
    const deps = spies([]);
    const d = await decide(input(typing, { mode: "full", grants: { l1: true, l2: true }, checker: undefined }), deps);
    expect(deps.checkAction).not.toHaveBeenCalled();
    expect(d.outcome).toBe("card");
    expect(d.checkerMissing).toBe(true);
    expect(d.line).toBe(DECIDE_LINES.askEachStep);
  });
  it("3 blocks in a row pause the task with a human prompt", async () => {
    const tally = new CheckerTally();
    const base = input(typing, { grants: { l1: true, l2: true } });
    base.checker = { ...base.checker!, tally };
    const out = [];
    for (let i = 0; i < 3; i++) out.push(await decide(base, spies([], async () => verdict("block", "checker_block"))));
    expect(out.slice(0, 2).map((d) => d.outcome)).toEqual(["card", "card"]);
    expect(out[2]!.outcome).toBe("pause");
  });
  it("20 blocks per task pause even with allows between them", async () => {
    const tally = new CheckerTally();
    const base = input(typing, { grants: { l1: true, l2: true } });
    base.checker = { ...base.checker!, tally };
    let last = "";
    for (let i = 0; i < 20; i++) {
      await decide(base, spies([], async () => verdict("block", "checker_block")));
      last = (await decide(base, spies([], async () => verdict("allow", "checker_ok")))).outcome;
    }
    expect(last).toBe("pause");
  });
});

describe("T23W copy matches the locale pack", () => {
  it("the plain lines equal their en.json keys", () => {
    const pack = en as Record<string, string>;
    expect(DECIDE_LINES.matches).toBe(pack["browserExt.intent.matches"]);
    expect(DECIDE_LINES.mismatch).toBe(pack["browserExt.intent.mismatch"]);
    expect(DECIDE_LINES.blocked).toBe(pack["browserExt.checker.blocked"]);
    expect(DECIDE_LINES.unavailable).toBe(pack["browserExt.checker.unavailable"]);
    expect(DECIDE_LINES.askEachStep).toBe(pack["browserExt.checker.askEachStepUntil"]);
  });
});
