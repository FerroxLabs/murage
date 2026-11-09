// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Settings L6: Usage and the Needs you card. Reads the sources (the repo's style for component copy and wiring) and runs the pure helpers.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { doubleLimitRequest, doubledCeiling, ceilingPercent, readLine, writtenLine, canRaiseCeiling, learningStillPaused } from "@/lib/learning-limit";
import { usageCsv } from "./UsageSection";
import { en } from "@/locales";

const read = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");
const card = read("./LearningPausedCard.tsx"), usage = read("./UsageSection.tsx"), inbox = read("./Inbox.tsx");

describe("the learning limit helpers", () => {
  it("doubles both sides, capped at what a limit may be, and carries the revision", () => {
    expect(doubledCeiling({ input: 100_000_000, output: 15_000_000 })).toEqual({ input: 200_000_000, output: 30_000_000 });
    expect(doubledCeiling({ input: 900_000_000_000, output: 1 })).toEqual({ input: 1_000_000_000_000, output: 2 });
    expect(doubleLimitRequest({ input: 10, output: 4 }, 7)).toEqual({ action: "configure", ceiling: { input: 20, output: 8 }, learningRevision: 7 });
  });
  it("reads real figures as tokens and percent", () => {
    expect(readLine({ input: 100_000_000, inputUsed: 2_100_000 })).toBe("Read: 2.1M of 100M");
    expect(writtenLine({ output: 15_000_000, outputUsed: 300_000 })).toBe("Written: 300k of 15M");
    expect(ceilingPercent(2_100_000, 100_000_000)).toBe(2);
    expect(ceilingPercent(5, 0)).toBe(100);
    expect(ceilingPercent(999, 100)).toBe(100);
  });
  it("exports the table's own numbers", () => {
    expect(usageCsv([{ name: 'Sable, "S"', replies: 3, tokens: 1200 }])).toBe('Bot,Replies,Tokens\n"Sable, ""S""",3,1200\n');
  });
});

describe("the Needs you card and the Usage page", () => {
  it("answers through the shared action helper, with the stored-revision request", () => {
    expect(card).toContain("useAction");
    expect(card.match(/<ActionButton/g)).toHaveLength(2);
    expect(card).toContain("doubleLimitRequest(");
    expect(card).not.toMatch(/onClick=\{[^}]*\bapi\(/);
    // UX-L3A-2 (04a532bda) marks the export control for the registry (data-setting-control="usage-heading") before its action prop
    expect(usage).toMatch(/<ActionButton\b[^>]*\saction=\{exportCsv\}/);
  });
  it("sits in the Inbox decisions view, and Usage never prints a money figure", () => {
    expect(inbox).toContain("LearningPausedCard");
    expect(inbox).toContain('view === "decisions" || view === "all" ? result?.learningPaused');
    expect(usage).not.toMatch(/formatUsd|costUsd|\$\d/);
    expect(usage).not.toContain("allowance");
  });
  it("says it plainly: no em dash, no safe words, no price, no vendor name", () => {
    const words = Object.entries(en).filter(([key]) => key.startsWith("settings.l6.")).map(([, value]) => String(value));
    expect(words.length).toBeGreaterThan(10);
    for (const text of words) expect(text).not.toMatch(/—|\bsaf(?:e|ely|ety)\b|\bunsafe\b|composio|\$|price|dollar|cost/i);
    expect(en["settings.l6.paused.title"]).toBe("Learning paused for the rest of the month");
    expect(en["settings.l6.paused.double"]).toBe("Double the limit and resume");
    expect(en["settings.l6.paused.leave"]).toBe("Leave paused");
  });
});

describe("while learning is paused (PASTE-CAPTURE-FIX S1)", () => {
  it("says new chats are still noted, so learning picks up where it left off", () => {
    expect(en["settings.l6.paused.body"]).toContain("Murage keeps noting new chats so learning picks up where it left off.");
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LearningPausedCard, renderLearningPausedCard } from "./LearningPausedCard";
import { ceilingStatusLine } from "@/lib/memory-learning-text";
it.each([undefined,"limit","unseen"] as const)("31: pause cause %s selects the exact card and ceiling copy",pausedBy=>{
  const row={month:"2026-11",input:1000,output:500,inputUsed:10,outputUsed:1,learningRevision:1,pausedBy};
  const html=renderToStaticMarkup(createElement(LearningPausedCard,{row,onSettled:()=>{}}));
  const body=pausedBy==="unseen"?en["settings.l6.paused.bodyUnseen"]:en["settings.l6.paused.body"];
  expect(html).toContain(body.replaceAll("'","&#x27;"));
  expect(ceilingStatusLine({...row,paused:true}).text).toBe(en[pausedBy==="unseen"?"memoryLearning.ceiling.pausedUnseen":"memoryLearning.ceiling.paused"]);
});

it.each([
  { name: "doubling equals usage", input: 1000, output: 500, inputUsed: 2000, outputUsed: 1, pausedBy: "limit" as const },
  { name: "doubling stays below usage", input: 1000, output: 500, inputUsed: 1, outputUsed: 1001, pausedBy: "limit" as const },
  { name: "input exhausted at maximum", input: 1e12, output: 10000, inputUsed: 1e12, outputUsed: 1, pausedBy: "limit" as const },
  { name: "output exhausted at maximum", input: 10000, output: 1e12, inputUsed: 1, outputUsed: 1e12, pausedBy: "limit" as const },
  { name: "both maxima, limit pause", input: 1e12, output: 1e12, inputUsed: 1e12, outputUsed: 1, pausedBy: "limit" as const },
  { name: "both maxima, unseen pause", input: 1e12, output: 1e12, inputUsed: 10, outputUsed: 1, pausedBy: "unseen" as const },
  { name: "legacy cause, exhausted maximum", input: 1e12, output: 10000, inputUsed: 1e12, outputUsed: 1, pausedBy: undefined },
])("31: no raise button still renders a way out: $name", state => {
  const row = { ...state, month: "2026-11", learningRevision: 1 };
  const html = renderToStaticMarkup(createElement(LearningPausedCard, { row, onSettled: () => {} }));
  expect(html).not.toContain("Double the limit and resume");
  expect(html).toContain("Learning paused for the rest of the month");
  expect(html).toContain("Leave paused");
  expect(html.includes("Resume learning")).toBe(state.pausedBy === "unseen");
  expect(ceilingStatusLine({ ...row, paused: true }).follow).toBe("none");
});

it.each([[1e12, 10000], [10000, 1e12]])("31: one maximum with room keeps Double (%s, %s)", (input, output) => {
  for (const pausedBy of ["unseen", "limit"] as const) {
    const row = { month: "2026-11", input, output, inputUsed: pausedBy === "unseen" || input === 1e12 ? 10 : input, outputUsed: pausedBy === "unseen" || output === 1e12 ? 1 : output, learningRevision: 1, pausedBy };
    const html = renderToStaticMarkup(createElement(LearningPausedCard, { row, onSettled: () => {} }));
    expect(html).toContain("Double the limit and resume");
    expect(html).not.toContain("Resume learning");
    expect(ceilingStatusLine({ ...row, paused: true }).follow).toBe("raise");
  }
});

it("31: Resume sends the unchanged maximum and promises admission only when a run fits", () => {
  expect(doubleLimitRequest({ input: 1e12, output: 1e12 }, 7)).toEqual({ action: "configure", ceiling: { input: 1e12, output: 1e12 }, learningRevision: 7 });
  expect(en["settings.l6.paused.resumed"]).toBe("Usage that was not reported has been cleared. Learning resumes as soon as a run fits your limit.");
  expect(card).toContain('row.pausedBy === "unseen" ? "settings.l6.paused.resumed" : "settings.l6.paused.doubledFits"');
  expect(card).toContain('failure: t("settings.l6.paused.leaveFailed")');
  expect(card).toContain('"settings.l6.paused.resuming"');
});

import * as actionHooks from "@/lib/use-action";
import * as store from "@/state/store";
it.each([[1e12, 10000], [10000, 1e12], [1e12, 1e12]])("31: the card's press sends the capped ceiling (%s, %s)", async (input, output) => {
  const actions = vi.spyOn(actionHooks, "useAction");
  const api = vi.spyOn(store, "api").mockResolvedValue({});
  try {
    const row = { month: "2026-11", input, output, inputUsed: 10, outputUsed: 1, pausedBy: "unseen" as const, learningRevision: 7 };
    renderToStaticMarkup(createElement(LearningPausedCard, { row, onSettled: () => {} }));
    const [press, options] = actions.mock.calls[0];
    expect(options?.idle).toBe(input === 1e12 && output === 1e12 ? "Resume learning" : "Double the limit and resume");
    expect(options?.pending).toBe(input === 1e12 && output === 1e12 ? "Resuming learning" : en["settings.l6.paused.doubling"]);
    expect((options?.success as (result: unknown) => string)({})).toBe(en["settings.l6.paused.resumed"]);
    expect(options?.failure).toBe(en["settings.l6.paused.leaveFailed"]);
    await press();
    expect(api).toHaveBeenCalledWith("/api/memory/action", {
      method: "POST",
      body: JSON.stringify({ action: "configure", ceiling: { input: Math.min(1e12, input * 2), output: Math.min(1e12, output * 2) }, learningRevision: 7 }),
    });
  } finally {
    actions.mockRestore();
    api.mockRestore();
  }
});

it.each([undefined,"limit","unseen"] as const)("A1/A4: press cause %s uses returned pause status before success copy", async pausedBy => {
  const actions=vi.spyOn(actionHooks,"useAction");
  const response={learning:{ceiling:{paused:true}}};
  const api=vi.spyOn(store,"api").mockResolvedValue(response);
  try {
    renderToStaticMarkup(createElement(LearningPausedCard,{row:{month:"2026-11",input:1000,output:500,inputUsed:1000,outputUsed:1,learningRevision:1,pausedBy},onSettled:()=>{}}));
    const [press,options]=actions.mock.calls[0];
    const success=options!.success as (result:unknown)=>string;
    expect(success(await press())).toBe(en["settings.l6.paused.title"]);
    expect(success({learning:{ceiling:{paused:false}}})).toBe(en[pausedBy==="unseen"?"settings.l6.paused.resumed":"settings.l6.paused.doubledFits"]);
    expect(en["settings.l6.paused.doubledFits"]).toBe("Limit doubled. Learning resumes as soon as a run fits your limit.");
    expect(card).toContain("setStillPaused(learningStillPaused(result))");
    expect(card).toContain("!stillPaused && (resume || canRaiseCeiling(row))");
  } finally {actions.mockRestore();api.mockRestore();}
});

it("A4: a still-paused response renders the no-raise card, with Leave paused", async () => {
  const actions = vi.spyOn(actionHooks, "useAction");
  const api = vi.spyOn(store, "api").mockResolvedValue({ learning: { ceiling: { paused: true } } });
  try {
    const row = { month: "2026-11", input: 1000, output: 500, inputUsed: 1000, outputUsed: 1, learningRevision: 1 };
    renderToStaticMarkup(createElement(LearningPausedCard, { row, onSettled: () => {} }));
    const result = await actions.mock.calls[0][0]();
    const render = (paused: boolean) => renderToStaticMarkup(renderLearningPausedCard(row, paused,
      createElement("button", null, "Double the limit and resume"),
      createElement("button", null, "Leave paused")));
    expect(render(false)).toContain("Double the limit and resume");
    const html = render(learningStillPaused(result));
    expect(html).toContain("Learning paused for the rest of the month");
    expect(html).toContain("Leave paused");
    expect(html).not.toContain("Double the limit and resume");
    expect(html).not.toContain("Limit doubled.");
  } finally { actions.mockRestore(); api.mockRestore(); }
});
it.each(["input","output"] as const)("A3: exhausted %s must be strictly below the doubled capped limit", side => {
  const row={input:1000,output:1000,inputUsed:1,outputUsed:1};
  expect(canRaiseCeiling({...row,[`${side}Used`]:1999})).toBe(true);
  expect(canRaiseCeiling({...row,[`${side}Used`]:2000})).toBe(false);
  expect(canRaiseCeiling({...row,[side]:900e9,[`${side}Used`]:1e12})).toBe(false);
});
