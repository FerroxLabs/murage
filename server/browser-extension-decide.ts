// SPDX-License-Identifier: AGPL-3.0-or-later
// The one place a browser action is decided (T23W, spec 2.7). The order is fixed:
//   owner audience and binding -> site -> clipboard -> floor (T02 on T01 facts) -> level (T12) -> I-rules (T27, with
//   T26's flag) -> model checker (T23, every L2 and L3, never L1) -> mode and grants (T12 again, with the verdicts).
// Every stage after the floor can only add a card or refuse. Nothing here can lift the floor or remove a card:
// the final decision is the strictest of what each stage said, and a verdict that is missing, malformed or late
// is a block, never an allow. Pure apart from the injected checker call.
import { checkAction, type CheckerAction, type CheckerDeps, type CheckerInput, type CheckerTally, type CheckerVerdict, CHECKER_REASONS } from "./browser-action-checker.ts";
import { checkIntent, type IntentAction, type IntentInput, type IntentResult } from "./browser-intent.ts";
import { classifyLevel, type ApprovalMode, type BrowserLevel, type LevelFacts, type LevelInput, type LevelResult, type SiteCategory } from "./browser-levels.ts";
import type { FloorResult } from "./browser-floor.ts";

/** The plain lines the owner reads. Each equals its key in src/locales/en.json, which a test checks. */
export const DECIDE_LINES = {
  matches: "This matches your request.", // browserExt.intent.matches
  mismatch: "This may not match your request.", // browserExt.intent.mismatch
  blocked: "Murage paused this step because it does not match what you asked for. Review it and choose Continue or Stop.", // browserExt.checker.blocked
  unavailable: "Murage could not run its action check, so it stopped before this step. Nothing was changed. Try again, or continue by approving this step yourself.", // browserExt.checker.unavailable
  askEachStep: "Ask each step until the action check is available.", // browserExt.checker.askEachStepUntil
} as const;

export type DecideStage = "binding" | "site" | "clipboard" | "floor" | "level" | "intent" | "checker" | "mode";
export type DecideOutcome = "floor" | "refuse" | "skip" | "site-card" | "card" | "pass" | "pause";
export type DecidedBy = "policy" | "intent" | "checker";

export interface DecideInput {
  /** The task is live and the caller is its owner's audience (a contact or an unproven message is not). */
  bindingActive: boolean;
  ownerAudience: boolean;
  siteAccess?: "allow" | "ask" | "never";
  category: SiteCategory;
  clipboard?: boolean;
  /** The floor on the facts of the moment: null = nothing found; undefined (never checked) is the floor. */
  floor: FloorResult | null | undefined;
  operation: string;
  key?: string;
  facts: LevelFacts;
  textHasNewline?: boolean;
  mode: ApprovalMode;
  routine: boolean;
  grants: { l1: boolean; l2: boolean };
  siteAllowedAlways: boolean;
  /** T27 input without the level (decide supplies it) and without the probe flag and mode. */
  intent: Omit<IntentInput, "action" | "probeFlagged" | "mode"> & { action: Omit<IntentAction, "level"> };
  /** T26: the content probe flagged instruction-like text since the owner's last message. */
  probeFlagged: boolean;
  /** Undefined = no transport: the bot is treated as Ask each step and the plain line goes to the owner. */
  checker?: { input: Omit<CheckerInput, "action"> & { action: Omit<CheckerAction, "level"> }; deps: CheckerDeps; tally: CheckerTally };
}

export interface Decision {
  outcome: DecideOutcome;
  level?: BrowserLevel;
  /** The stage that settled it. */
  stage: DecideStage;
  rule: string;
  reason: string;
  /** Plain lines for the card or the refusal (intent lines, the checker copy). Murage's own words. */
  line?: string;
  decidedBy: DecidedBy;
  /** L2/L3 card note from the checker's judgement: matches or may not match. */
  checkerNote?: string;
  checker?: CheckerVerdict;
  /** The checker had no transport, so this bot was treated as Ask each step. */
  checkerMissing?: boolean;
  trace: DecideStage[];
}

export interface DecideDeps {
  classifyLevel: (input: LevelInput) => LevelResult;
  checkIntent: (input: IntentInput) => IntentResult;
  checkAction: (input: CheckerInput, deps: CheckerDeps) => Promise<CheckerVerdict>;
}
const REAL: DecideDeps = { classifyLevel, checkIntent, checkAction };

const unavailable = (code: string): CheckerVerdict => ({ decision: "block", code, stage: 1, reason: CHECKER_REASONS.checker_unavailable });
const DECISIONS = new Set(["allow", "ask", "block"]);

/** The checker call, wrapped so a throw, a hang's rejection or a junk value is a block. */
async function judge(deps: DecideDeps, input: CheckerInput, checker: NonNullable<DecideInput["checker"]>): Promise<CheckerVerdict> {
  let verdict: unknown;
  try { verdict = await deps.checkAction(input, checker.deps); } catch { return unavailable("checker_unavailable"); }
  const v = verdict as Partial<CheckerVerdict> | null | undefined;
  if (!v || typeof v !== "object" || typeof v.decision !== "string" || !DECISIONS.has(v.decision)) return unavailable("checker_unavailable");
  return { decision: v.decision as CheckerVerdict["decision"], code: String(v.code ?? ""), stage: v.stage === 2 ? 2 : 1, reason: String(v.reason ?? "") };
}

const FAILURE_CODES = new Set(["checker_unavailable", "checker_model_not_allowed", "checker_model_not_permitted"]);
const failureLine = (code: string) => code === "checker_model_not_allowed" || code === "checker_model_not_permitted" ? CHECKER_REASONS[code] : DECIDE_LINES.unavailable;

export async function decide(input: DecideInput, deps: DecideDeps = REAL): Promise<Decision> {
  const trace: DecideStage[] = [];
  const done = (d: Omit<Decision, "trace">): Decision => ({ ...d, trace });
  const refuse = (stage: DecideStage, rule: string, reason: string, extra: Partial<Decision> = {}): Decision => done({ outcome: "refuse", stage, rule, reason, decidedBy: "policy", ...extra });
  try {
    trace.push("binding");
    if (!input.bindingActive || !input.ownerAudience) return refuse("binding", "binding", "This browser task is not the owner's to act on right now.");
    trace.push("site");
    if (input.siteAccess === "never") return refuse("site", "site-never", "This site is set to Never for the bot, so the action is refused.");
    if (input.category === "handover" || input.category === "neverDefault") return refuse("site", `category-${input.category}`, "This site is for the owner in person or is set to Never, so the action is refused.");
    trace.push("clipboard");
    if (input.clipboard === true) return refuse("clipboard", "clipboard", "Pasting, copying and select-all are not available in the owner's browser.");
    trace.push("floor");
    const given = input.floor;
    if (given === undefined || (given !== null && (typeof given !== "object" || (given as { floor?: unknown }).floor !== null))) {
      return done({ outcome: "floor", level: "floor", stage: "floor", rule: "floor", reason: (given as FloorResult | null | undefined)?.reason || "This step needs the owner in person.", decidedBy: "policy" });
    }

    // Level (T12), with no verdicts yet: it settles which stages apply and fixes the level for the rest.
    trace.push("level");
    const base: Omit<LevelInput, "intent" | "checker" | "mode"> = {
      operation: input.operation, ...(input.key !== undefined ? { key: input.key } : {}), facts: input.facts, floor: input.floor ?? null,
      category: input.category, routine: input.routine, grants: input.grants, siteAllowedAlways: input.siteAllowedAlways,
      ...(input.textHasNewline !== undefined ? { textHasNewline: input.textHasNewline } : {}),
    };
    const pre = deps.classifyLevel({ ...base, mode: input.mode });
    if (pre.level === "floor") return done({ outcome: "floor", level: "floor", stage: "level", rule: pre.rule, reason: pre.reason, decidedBy: "policy" });
    if (pre.refuse) return refuse("level", pre.rule, pre.reason, { level: pre.level });
    if (pre.skip) return done({ outcome: "skip", level: pre.level, stage: "level", rule: pre.rule, reason: pre.reason, decidedBy: "policy" });
    const level = pre.level;

    // I-rules (T27). I4 (hidden target) is the first thing they check, so it settles before the checker is asked.
    trace.push("intent");
    const intent = deps.checkIntent({ ...input.intent, mode: input.mode, probeFlagged: input.probeFlagged === true, ...(input.routine ? { unattended: true } : {}), action: { ...input.intent.action, level } });
    if (intent.result === "refuse") return refuse("intent", intent.rule ?? "intent", intent.line ?? "The intent check refused this action.", { level, decidedBy: "intent", ...(intent.line ? { line: intent.line } : {}) });

    // Checker (T23): every L2 and L3, never L1. No transport means Ask each step. A failure is a block.
    let verdict: CheckerVerdict | undefined;
    let checkerMissing = false;
    let effectiveMode: ApprovalMode = input.mode;
    if (level === "L2" || level === "L3") {
      trace.push("checker");
      if (!input.checker) { checkerMissing = true; effectiveMode = "step"; }
      else if (input.checker.tally.needsHuman) {
        return done({ outcome: "pause", level, stage: "checker", rule: "checker-needs-human", reason: "Too many checks in a row stopped this step.", line: DECIDE_LINES.blocked, decidedBy: "checker" });
      } else {
        verdict = await judge(deps, { ...input.checker.input, action: { ...input.checker.input.action, level } }, input.checker);
        input.checker.tally.record(verdict);
        if (input.checker.tally.needsHuman) {
          return done({ outcome: "pause", level, stage: "checker", rule: "checker-needs-human", reason: "Too many checks in a row stopped this step.", line: DECIDE_LINES.blocked, decidedBy: "checker", checker: verdict });
        }
      }
    }

    // Mode and grants (T12 again, with the verdicts). Attended, a block is a card; a routine has no one to ask, so it refuses.
    trace.push("mode");
    const checkerInput: LevelInput["checker"] = verdict ? (verdict.decision === "block" && input.routine ? "block" : verdict.decision === "allow" ? "allow" : "ask") : undefined;
    const final = deps.classifyLevel({ ...base, mode: effectiveMode, intent: intent.result, ...(checkerInput ? { checker: checkerInput } : {}) });
    // A later stage never changes the level or lifts the floor.
    if (final.level === "floor") return done({ outcome: "floor", level: "floor", stage: "mode", rule: final.rule, reason: final.reason, decidedBy: "policy" });
    if (final.level !== level) return done({ outcome: "floor", level: "floor", stage: "mode", rule: "level-changed", reason: "The level changed between stages, so the owner takes this step.", decidedBy: "policy" });

    const judged = verdict !== undefined && !FAILURE_CODES.has(verdict.code);
    const checkerNote = judged ? (verdict!.decision === "allow" ? DECIDE_LINES.matches : DECIDE_LINES.mismatch) : undefined;
    const lines: string[] = [];
    if (intent.line) lines.push(intent.line);
    if (verdict && verdict.decision === "block") lines.push(judged ? DECIDE_LINES.blocked : failureLine(verdict.code));
    if (checkerMissing) lines.push(DECIDE_LINES.askEachStep);
    const checkerRaised = verdict !== undefined && verdict.decision !== "allow";
    const common = { level, stage: "mode" as const, rule: final.rule, reason: final.reason, ...(lines.length ? { line: lines.join("\n") } : {}), ...(checkerNote ? { checkerNote } : {}), ...(verdict ? { checker: verdict } : {}), ...(checkerMissing ? { checkerMissing } : {}) };
    if (final.refuse) return done({ ...common, outcome: "refuse", decidedBy: checkerRaised ? "checker" : intent.result !== "pass" ? "intent" : "policy" });
    if (final.skip) return done({ ...common, outcome: "skip", decidedBy: "policy" });
    // Belt and braces: whatever the classifier said, a card the intent check or the checker raised stays a card.
    const needsCard = final.needsCard || intent.result !== "pass" || checkerRaised || checkerMissing;
    if (!needsCard) return done({ ...common, outcome: "pass", decidedBy: "policy" });
    return done({ ...common, outcome: final.siteCard ? "site-card" : "card", decidedBy: intent.result !== "pass" ? "intent" : checkerRaised && (final.rule === "tightened" || final.rule === "mode-full-checker") ? "checker" : "policy" });
  } catch {
    // A throw anywhere is the floor: unsure means the owner takes this step.
    return done({ outcome: "floor", level: "floor", stage: "mode", rule: "decide-error", reason: "The decision could not be made, so the owner takes this step.", decidedBy: "policy" });
  }
}
