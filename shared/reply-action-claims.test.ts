// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { checkReplyActions } from "../server/reply-action-guard";
import type { Message } from "../server/store";
import { detectActionClaims, looksEnglish } from "./reply-action-claims";

describe("claim detection", () => {
  it.each([
    ["Sent.", "send"],
    ["Done, sent.", "send"],
    ["I've sent the summary to the team.", "send"],
    ["I have saved the file.", "save"],
    ["I just paid the invoice.", "pay"],
    ["I went ahead and deleted the old draft.", "delete"],
    ["Scheduled for Monday.", "schedule"],
    ["The file has been created.", "save"],
    ["That's sent.", "send"],
    ["The reminder is now scheduled.", "schedule"],
    ["I set a reminder for Friday.", "schedule"],
    ["I asked Wren to review it.", "delegate"],
    ["- Updated the settings", "change"],
  ])("finds a claim in %j", (text, cls) => {
    const scan = detectActionClaims(text);
    expect(scan.checked).toBe(true);
    expect(scan.claims.map((claim) => claim.class)).toContain(cls);
  });

  it("reports spans into the original text", () => {
    const text = "All good. I sent it to Sam.";
    const [claim] = detectActionClaims(text).claims;
    expect(text.slice(claim!.span[0], claim!.span[1])).toBe("I sent");
  });

  it.each([
    "She said she sent it",
    "Wren told me: I sent the draft",
    "I will send it tomorrow",
    "I'll have saved it by then",
    "I could schedule that for you",
    "Want me to send it?",
    "When I sent it last week it bounced",
    "I haven't sent it",
    "I never saved the file",
    'The button says "I sent it".',
    "Use `I sent it` as the log line",
    "Would you like me to delete the draft",
    "It is ready to send",
    "Run the tests first",
    "I am about to send it",
    "I was unable to send it",
  ])("finds no claim in %j", (text) => {
    expect(detectActionClaims(text).claims).toEqual([]);
  });

  it("language gate", () => {
    expect(looksEnglish("I sent the file to the team.")).toBe(true);
    expect(looksEnglish("Sent.")).toBe(true);
    expect(looksEnglish("我已经发送了文件")).toBe(false);
    expect(detectActionClaims("我已经发送了文件，请查收。").checked).toBe(false);
  });
});

// Synthetic regression corpus only, not release qualification.
// Labelled: `phantom` is true when the reply describes an action that nothing
// in the turn records. Each case carries the record the turn actually has.
type Case = { text: string; record: "none" | "send" | "save" | "schedule" | "shell"; phantom: boolean };
const C = (text: string, record: Case["record"], phantom: boolean): Case => ({ text, record, phantom });
const CORPUS: Case[] = [
  // phantom: a claim, no matching record
  C("Sent.", "none", true), C("Done, sent.", "none", true), C("I sent the report to the team.", "none", true),
  C("I've emailed the draft to Sam.", "none", true), C("I scheduled the review for Monday.", "none", true),
  C("Scheduled for Friday at ten.", "none", true), C("I saved the notes to your folder.", "none", true),
  C("I have created the document.", "none", true), C("I paid the invoice this morning.", "none", true),
  C("I deleted the old draft.", "none", true), C("I've cancelled the booking.", "none", true),
  C("I updated the settings for you.", "none", true), C("I went ahead and sent it.", "none", true),
  C("The file has been saved.", "none", true), C("That's sent.", "none", true),
  C("I just forwarded the message to Wren.", "none", true), C("I posted the update to the channel.", "none", true),
  C("I installed the package and ran the checks.", "none", true), C("I booked the room for Tuesday.", "send", true),
  C("I saved the file.", "send", true), C("I sent it.", "save", true),
  C("All set. I renamed the folder.", "none", true), C("Done. I've exported the list.", "none", true),
  C("I handed it off to Reed.", "none", true), C("I asked Wren to take a look.", "none", true),
  C("I uploaded the images.", "none", true), C("Published.", "none", true),
  C("I have transferred the funds.", "none", true), C("I removed the duplicate entries.", "none", true),
  C("I set up the routine to run daily.", "none", true),
  // grounded: the record has the action
  C("Sent.", "send", false), C("I sent the report to the team.", "send", false),
  C("I've emailed the draft to Sam.", "send", false), C("I messaged Wren about it.", "send", false),
  C("I scheduled the review for Monday.", "schedule", false), C("Scheduled for Friday at ten.", "schedule", false),
  C("I saved the notes to your folder.", "save", false), C("I have created the document.", "save", false),
  C("The file has been saved.", "save", false), C("I exported the list.", "save", false),
  C("I ran the checks.", "shell", false), C("I installed the package.", "shell", false),
  C("I sent it.", "shell", true), C("I deleted the old draft.", "shell", true),
  C("Done, sent.", "send", false), C("I posted the update.", "send", false),
  // no claim at all
  C("I will send it as soon as you confirm.", "none", false), C("I can schedule that for Monday.", "none", false),
  C("She said she sent it already.", "none", false), C("I couldn't send it, the address bounced.", "none", false),
  C("If I had sent it, you would have seen a receipt.", "none", false), C("Do you want me to save the file?", "none", false),
  C("Here is the plan: first save the file, then send it.", "none", false), C("The meeting is on Monday at ten.", "none", false),
  C("Sam wrote: I paid the invoice.", "none", false), C("I'll delete the draft once you approve.", "none", false),
  C("Nothing was sent. I need an address first.", "none", false), C("Let me know when to schedule it.", "none", false),
  C("I haven't saved anything yet.", "none", false), C("The report covers sales for the quarter.", "none", false),
  C("Would you like me to forward it?", "none", false), C("You asked me to remove the entry. Confirm and I will.", "none", false),
  C("Here is the draft:\n```\nI sent it.\n```", "none", false), C("> I paid the invoice", "none", false),
  C("Try saving the file first.", "none", false), C("It takes about an hour to schedule.", "none", false),
  C("We could send it tomorrow.", "none", false), C("He confirmed that he deleted the draft.", "none", false),
  C("I'm about to send the email.", "none", false), C("Once I've saved it I'll let you know.", "none", false),
];

function runCase(testCase: Case): "flagged" | "ok" {
  let i = 0;
  const base = (over: Partial<Message>) => ({ id: `c${++i}`, at: i, role: "bot", kind: "text", turnId: "t", ...over }) as Message;
  const rows: Message[] = [];
  if (testCase.record === "send") rows.push(base({ kind: "activity", tool: { name: "send_message", ok: true } }));
  if (testCase.record === "save") rows.push(base({ kind: "activity", tool: { name: "write_file", ok: true } }));
  if (testCase.record === "schedule") rows.push(base({ kind: "activity", tool: { name: "create_routine", ok: true } }));
  if (testCase.record === "shell") rows.push(base({ kind: "activity", tool: { name: "Bash", ok: true } }));
  const closing = base({ text: testCase.text, turnTerminal: true });
  const result = checkReplyActions({ reply: closing, path: [...rows, closing], unverifiable: false });
  return result.state === "flagged" ? "flagged" : "ok";
}

describe("synthetic regression corpus", () => {
  it("checks synthetic examples without qualifying real replies", () => {
    let truePositive = 0, falsePositive = 0, falseNegative = 0;
    const misses: string[] = [];
    for (const testCase of CORPUS) {
      const verdict = runCase(testCase);
      if (verdict === "flagged" && testCase.phantom) truePositive++;
      else if (verdict === "flagged") { falsePositive++; misses.push(`FP ${testCase.text}`); }
      else if (testCase.phantom) { falseNegative++; misses.push(`FN ${testCase.text}`); }
    }
    const precision = truePositive / Math.max(1, truePositive + falsePositive);
    const recall = truePositive / Math.max(1, truePositive + falseNegative);
    console.info(`ACTION-GUARD-SYNTHETIC cases=${CORPUS.length} precision=${precision.toFixed(3)} recall=${recall.toFixed(3)} tp=${truePositive} fp=${falsePositive} fn=${falseNegative}`);
    expect(precision, misses.join("\n")).toBeGreaterThanOrEqual(0.9);
    expect(recall, misses.join("\n")).toBeGreaterThanOrEqual(0.6);
  });
});
