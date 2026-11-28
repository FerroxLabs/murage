// W15 (TEACH-ENTRY 1.0.23 D9.1): the teach detector matches only a bare offer
// to teach the bot a procedure; everything else is a normal turn.
import { describe, expect, it } from "vitest";
import { teachIntent, teachTaskPrefill } from "./teach-intent";

const POSITIVE: Array<[string, "teach-you" | "show-you" | "remember-how", string]> = [
  ["I want to teach you something", "teach-you", ""],
  ["Let me teach you how to file invoices", "teach-you", "File invoices"],
  ["Can I teach you to rename these photos?", "teach-you", "Rename these photos"],
  ["I'd like to teach you a skill.", "teach-you", ""],
  ["I'll teach you how we do payroll", "teach-you", "Payroll"],
  ["Hey Dax, let me teach you how to book travel please", "teach-you", "Book travel"],
  ["let me show you how I file the weekly expense report", "show-you", "File the weekly expense report"],
  ["I'll show you how we close the month", "show-you", "Close the month"],
  ["Can I show you how to rename files?", "show-you", "Rename files"],
  ["Watch me do the invoices", "show-you", "The invoices"],
  ["Remember how to do this", "remember-how", ""],
  ["Remember how I do the expense report", "remember-how", "The expense report"],
  ["Learn how I file receipts.", "remember-how", "File receipts"],
  ["ok, remember how to export the ledger now", "remember-how", "Export the ledger"],
];

// [sentence, the guard that rejects it]
const NEGATIVE: Array<[string, string]> = [
  ["teach me how to file expenses", "learner is the owner"],
  ["can you teach me Excel", "learner is the owner"],
  ["show me how you do it", "learner is the owner"],
  ["I want to teach him how to file expenses", "object must be you"],
  ["Let me show them how I do payroll", "object must be you"],
  ["I don't want to teach you anything", "negation"],
  ["I don't want to teach you how to file invoices", "negation"],
  ["I never want to show you how I do payroll", "negation"],
  ["teach my kids chess", "someone else is taught"],
  ["remember that my dentist is at 5", "a fact, not a procedure"],
  ["remember how we laughed", "remember-how never takes how we"],
  ["> let me show you how I do payroll", "quoted line"],
  ["```\nlet me show you how I do payroll\n```", "code fence"],
  ["let me show you how I run `make deploy`", "inline code"],
  [`Let me show you how I file ${"the very long quarterly expense report for the regional office ".repeat(4)}`, "after character 240"],
  ["/teacher", "not the slash command"],
  // r3 (Fable H1 / Opus H1): a request after the offer is answered as a request
  ["Remember how I do the expense report? Do it again for October.", "anything after the offer"],
  ["Let me show you how I fixed the login bug: the token expired. Now do the same in billing.", "anything after the offer"],
  ["Let me show you how I want the report formatted: Title, Date, Total", "anything after the offer"],
  ["I'll show you how we close the month: 1. export 2. reconcile", "anything after the offer"],
  ["Let me show you how I do payroll; then run it for March", "anything after the offer"],
  ["Remember how I do the expense report, and do it again for October", "comma-joined request (r3 Fable M2)"],
  ["Can you remember how to reset the router?", "a question to the bot"],
  ["Can you remember how to get to my office?", "a question to the bot"],
  ["Remember how I do the expense report?", "a question (imperative only)"],
  ["let me show you the error", "show-you needs how"],
  ["Let me teach you something about Acme", "not a procedure"],
];

describe("W15 teachIntent", () => {
  it.each(POSITIVE)("matches %j", (text, kind, task) => {
    expect(teachIntent(text, "Dax")).toEqual({ via: "phrase", kind, task });
  });

  it.each(NEGATIVE)("null for %j (%s)", (text) => {
    expect(teachIntent(text, "Dax")).toBeNull();
  });

  it("slash command: bare, with a task, and not a longer word", () => {
    expect(teachIntent("/teach")).toEqual({ via: "slash", task: "" });
    expect(teachIntent("/teach weekly invoices")).toEqual({ via: "slash", task: "Weekly invoices" });
    expect(teachIntent("/TEACH weekly invoices")).toEqual({ via: "slash", task: "Weekly invoices" });
    expect(teachIntent("/teach-notes x")).toBeNull();
  });

  it("task pre-fill is cut at a word to at most 60 characters", () => {
    const words = "file the quarterly expense report for the regional office in Leeds";
    expect(words.length).toBeGreaterThan(60);
    const task = teachTaskPrefill(words);
    expect(task.length).toBeLessThanOrEqual(60);
    expect(task).toBe("File the quarterly expense report for the regional office in");
    expect(teachIntent(`let me show you how I ${words}`)).toEqual({ via: "phrase", kind: "show-you", task });
  });

  // D9 cost: the detector is a pure function with no model call; N=1 and N=10 and N=1000 turns, every 10th a match, find exactly those.
  it.each([1, 10, 1000])("N=%i turns, every 10th a bare offer: exactly the offers match", (n) => {
    const texts = Array.from({ length: n }, (_, i) => (i % 10 === 0 ? "I want to teach you something" : `please summarise item ${i}`));
    const matched = texts.filter((text) => teachIntent(text, "Dax") !== null).length;
    expect(matched).toBe(Math.ceil(n / 10));
  });
});
