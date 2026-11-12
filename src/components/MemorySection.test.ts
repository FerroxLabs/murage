// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, Children, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EventRow, MemorySectionContent, renderActionBtnResult } from "./MemorySection";
import { AdvancedHost, AdvancedSection } from "./SettingsPrimitives";
import {
  ceilingState, formatTokens, learnAsWeTalk, learnAsWeTalkPatch, raisedCeiling, requestLearningAction, skippedSliceRetry,
  type LearningEvent, type MemoryLearning,
} from "@/lib/memory-learning";
import { ceilingStatusLine, learningStatusLine, memoryStatusLine } from "@/lib/memory-learning-text";

const ceilingRow: import("../../shared/memory-learning-contract.ts").LearningCeilingStatus = { month: "2026-10", input: 100_000_000, output: 15_000_000, inputUsed: 2_100_000, outputUsed: 300_000, paused: false };
const learning: MemoryLearning = {
  revision: 4,
  settings: { version: 3, automaticFacts: true, automaticProcedures: true, reviewMode: false, perCallOutputTokens: { extraction: 2000, grounding: 64, reflection: 8000 }, ceiling: { input: 100_000_000, output: 15_000_000 }, callsPerMinute: 6, learnFrom: { chats: true, channels: true }, botsPaused: [] },
  connection: { instanceId: "@murage/flux-fast", source: "default", label: "Flux Router · Fast" }, defaultOn: true, ceiling: ceilingRow,
};
const event: LearningEvent = { id: "event", kind: "activated", record_id: "fact", record_version: 1, created_at: 1, undone_at: null, kept_at: null, record: { id: "fact", version: 1, state: "active", text: null }, scopeLabel: "Workspace", source: { threadId: "thread", messageId: "message", botName: "Ember", roomName: null } };
const skipped: LearningEvent = { id: "skip", kind: "run-completed", record_id: null, record_version: null, created_at: 2, undone_at: null, kept_at: null, record: null, scopeLabel: "Workspace", source: null, detail: JSON.stringify({ outcome: "slice-skipped", sourceId: "src-1", cursor: 4096, length: 800, retry: { action: "retry-skipped", sourceId: "src-1", cursor: 4096 } }) };
const props = () => ({
  status: {
    mode: "active" as const, learning, records: { candidate: 0, active: 3412, archived: 0, superseded: 0, deleted: 0 }, semantic: { state: "ready" as "ready" | "indexing" | "keyword-only", done: 0, total: 0 },
    configuration: { extractorInstanceId: null },
    extractors: [{ instanceId: "@murage/flux-fast", label: "Flux Router · Fast", eligible: true }, { instanceId: "native", label: "Native sign-in", eligible: false, reason: "This connection does not provide text-only learning." }],
  },
  bots: [{ id: "bot", name: "Ember" }], events: [event], cursor: "next" as string | null, filter: "", busy: false, historyBusy: false, refusals: {} as Record<string, string>, workspace: null, waiting: 2,
  onAction: vi.fn(), onFilter: vi.fn(), onMore: vi.fn(), onOpen: vi.fn(), onRefresh: vi.fn(), onOpenAdvanced: vi.fn(),
  retried: undefined as ReadonlySet<string> | undefined, onRetried: vi.fn(),
});
const html = (p = props()) => renderToStaticMarkup(createElement(MemorySectionContent, p));
function nodes(node: ReactNode): Array<{ [key: string]: unknown }> { return Children.toArray(node).flatMap(child => isValidElement<{ children?: ReactNode }>(child) ? [child.props, ...nodes(child.props.children)] : []); }
const tree = (p: ReturnType<typeof props>) => nodes(MemorySectionContent(p));
const find = (all: Array<{ [key: string]: unknown }>, label: string) => { const node = all.find(n => n.label === label); expect(node, label).toBeTruthy(); return node!; };
const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

describe("the Memory page, first screen", () => {
  it("renders the sections in order with labelled switches and the status lines", () => {
    const out = html();
    const order = ["aria-label=\"Memory\"", "aria-label=\"How it learns\"", "aria-label=\"Your bots\"", "aria-label=\"What it learned\""].map(label => out.indexOf(label));
    expect(order.every(at => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(out).toContain("3,412 saved memories · 2 waiting for you. Memory is on: your bots remember between conversations. Smart search ready.");
    expect(out).toContain("Learning is on. Uses Flux Fast.");
    expect(out).toContain("Learning this month: 2.1M tokens read, 0.3M written.");
    const switches = out.match(/<button[^>]*role="switch"[^>]*>/g) ?? [];
    expect(switches.length).toBeGreaterThanOrEqual(8);
    for (const tag of switches) expect(tag, tag).toMatch(/aria-labelledby="[^"]+"/);
    for (const label of ["Memory on", "Learn as we talk", "Review before using", "Learn from chats", "Learn from channels", "Learn facts", "Learn how you like things done"]) expect(out).toContain(label);
    expect(out).toContain("From your chat with Ember");
    expect(out).toContain("See all");
    expect(out).not.toContain("<details");
    expect(out).not.toMatch(/allowance/i);
  });

  it("says Indexing for smart search while the bundled model catches up, and Keyword memory without it", () => {
    const p = props(); p.status.semantic = { state: "indexing", done: 10, total: 25 };
    expect(html(p)).toContain("Indexing for smart search, 10 of 25.");
    const q = props(); q.status.semantic = { state: "keyword-only", done: 0, total: 0 };
    expect(html(q)).toContain("Memory search uses keywords until smart search is ready.");
  });

  it("explains a paused month with a Raise it action, and an off limit with a way to Advanced", () => {
    const p = props(); p.status.learning = { ...learning, ceiling: { ...ceilingRow, paused: true, inputUsed: 100_000_000 } };
    const out = html(p);
    expect(out).toContain("Learning paused: it reached this month&#x27;s learning limit.");
    expect(out).toContain("Raise it");
    (find(tree(p), "Raise it").run as () => void)();
    expect(p.onAction).toHaveBeenCalledWith({ action: "configure", ceiling: { input: 200_000_000, output: 30_000_000 }, learningRevision: 4 });
    const z = props(); z.status.learning = { ...learning, settings: { ...learning.settings, ceiling: { input: 0, output: 0 } }, ceiling: { ...ceilingRow, input: 0, output: 0, paused: true } };
    const off = html(z);
    expect(off).toContain("Learning is off. The learning limit is set to 0.");
    expect(off).toContain("Open Advanced");
    expect(off).not.toContain("Raise it");
  });

  it("writes nothing on load", () => {
    const p = props(); html(p); tree(p);
    expect(p.onAction).not.toHaveBeenCalled();
  });
});

describe("the status helpers", () => {
  it("reads tokens in M and k with one decimal", () => {
    expect([formatTokens(2_100_000), formatTokens(300_000), formatTokens(100_000_000), formatTokens(850), formatTokens(12_400)]).toEqual(["2.1M", "0.3M", "100M", "850", "12.4k"]);
  });
  it("tells off, paused and open apart", () => {
    expect(ceilingState({ input: 0, output: 5, paused: true })).toBe("off");
    expect(ceilingState({ input: 5, output: 5, paused: true })).toBe("paused");
    expect(ceilingStatusLine({ ...ceilingRow, paused: false }).follow).toBe("none");
    expect(raisedCeiling({ input: 0, output: 0 })).toEqual({ input: 2, output: 2 });
    expect(raisedCeiling({ input: 900_000_000_000, output: 1 }).input).toBe(1_000_000_000_000);
  });
  it("builds the status sentence from the learning line, the counts and smart search", () => {
    expect(memoryStatusLine({ mode: "active", learning, memories: 1, waiting: 0, semantic: { state: "indexing", done: 10, total: 25 } })).toBe("Learning is on. Uses Flux Fast. 1 memory. Indexing for smart search, 10 of 25.");
    expect(memoryStatusLine({ mode: "active", learning, memories: 5000, memoriesMore: true, waiting: 1 })).toBe("Learning is on. Uses Flux Fast. 5,000+ memories, 1 waiting in Needs you.");
  });
  it("reports review defaults, unavailable connections and paused memory truthfully", () => {
    expect(learningStatusLine("active", { ...learning, defaultOn: false })).toBe("Learning is on. Memories that need your yes wait in Needs you.");
    expect(learningStatusLine("off", learning)).toContain("Learning is paused");
    expect(learningStatusLine("active", { ...learning, connection: { instanceId: null, label: "No connection", source: "none" } })).toBe("Learning is paused: add your Flux key or choose a connection.");
  });
});

describe("Learn as we talk", () => {
  const combos: Array<[boolean, boolean, boolean, "facts" | "procedures" | null]> = [[true, true, true, null], [false, false, false, null], [true, false, true, "facts"], [false, true, true, "procedures"]];
  it.each(combos)("facts=%s procedures=%s shows on=%s partial=%s", (automaticFacts, automaticProcedures, on, partial) => {
    expect(learnAsWeTalk({ automaticFacts, automaticProcedures })).toEqual({ on, partial });
    const p = props(); p.status.learning = { ...learning, settings: { ...learning.settings, automaticFacts, automaticProcedures } };
    const out = html(p);
    if (partial) expect(out).toContain(`Partly on: ${partial} only`);
    else expect(out).not.toContain("Partly on");
    // The switch writes both flags in one patch: off when anything is on, on when both are off.
    (find(tree(p), "Learn as we talk").run as () => void)();
    expect(p.onAction).toHaveBeenCalledTimes(1);
    expect(p.onAction).toHaveBeenCalledWith({ action: "configure", learning: learnAsWeTalkPatch({ automaticFacts, automaticProcedures }), learningRevision: 4 });
    expect(learnAsWeTalkPatch({ automaticFacts, automaticProcedures })).toEqual(on ? { automaticFacts: false, automaticProcedures: false } : { automaticFacts: true, automaticProcedures: true });
  });
  it("leaves every other stored value alone: each switch sends only its own field, at the current revision", () => {
    const p = props(); const all = tree(p);
    (find(all, "Review before using").run as () => void)();
    (find(all, "Learn from chats").run as () => void)();
    (find(all, "Learn facts").run as () => void)();
    expect(p.onAction.mock.calls.map(call => call[0])).toEqual([
      { action: "configure", learning: { reviewMode: true }, learningRevision: 4 },
      { action: "configure", learning: { learnFrom: { chats: false, channels: true } }, learningRevision: 4 },
      { action: "configure", learning: { automaticFacts: false }, learningRevision: 4 },
    ]);
  });
  it("Memory on writes the mode only, and sends no v2 field anywhere", () => {
    const p = props(); const all = tree(p);
    (find(all, "Memory on").run as () => void)();
    (find(all, "Capture only").run as () => void)();
    expect(p.onAction.mock.calls.map(call => call[0])).toEqual([{ action: "configure", mode: "paused" }, { action: "configure", mode: "capture" }]);
    for (const file of ["./MemorySection.tsx", "./MemorySettings.tsx", "../lib/memory-learning.ts"]) expect(read(file), file).not.toMatch(/dailyInputTokens|dailyOutputTokens|\.allowance\b|version: 2/);
  });
});

describe("history", () => {
  it("wires the bot switch, Keep and Undo to revision-aware actions and opens source messages", () => {
    const p = props(); const all = tree(p);
    (find(all, "Ember").run as () => void)();
    expect(p.onAction).toHaveBeenCalledWith({ action: "learning-bot", botId: "bot", enabled: false, learningRevision: 4 });
    const row = nodes(EventRow({ event, busy: false, onAction: p.onAction, onOpen: p.onOpen }) as ReactNode);
    (find(row, "Keep").run as () => void)();
    expect(p.onAction).toHaveBeenCalledWith({ action: "learning-keep", eventId: "event" });
    (find(row, "Undo").run as () => void)();
    expect(p.onAction).toHaveBeenCalledWith({ action: "learning-undo", eventId: "event" });
    const link = row.find(n => typeof n.href === "string");
    (link!.onClick as (e: { preventDefault(): void }) => void)({ preventDefault() {} });
    expect(p.onOpen).toHaveBeenCalledWith(event.source);
  });
  it("renders room provenance and keeps Undo disabled with a server refusal", () => {
    const p = props(); p.refusals = { event: "This memory changed since it was learned." }; p.events = [{ ...event, source: { ...event.source!, roomName: "Launch room" } }];
    const out = html(p);
    expect(out).toContain("From Launch room");
    expect(out).toContain("This memory changed since it was learned.");
    expect(out).toMatch(/disabled=""[^>]*>Undo</);
  });
  it("offers Try again for a skipped part and sends retry-skipped", () => {
    const retry = skippedSliceRetry(skipped);
    expect(retry).toEqual({ action: "retry-skipped", sourceId: "src-1", cursor: 4096 });
    expect(skippedSliceRetry({ ...skipped, detail: JSON.parse(skipped.detail as string) })).toEqual(retry);
    expect(skippedSliceRetry({ ...skipped, kind: "activated" })).toBeNull();
    expect(skippedSliceRetry({ kind: "run-completed", detail: JSON.stringify({ outcome: "complete" }) })).toBeNull();
    expect(skippedSliceRetry({ kind: "run-completed", detail: "not json" })).toBeNull();
    const p = props(); p.events = [skipped];
    const out = html(p);
    expect(out).toContain("Could not learn from part of this conversation.");
    expect(out).toContain("Try again");
    expect(out).not.toContain(">Keep<");
    const row = nodes(EventRow({ event: skipped, busy: false, onAction: p.onAction, onOpen: p.onOpen }) as ReactNode);
    (find(row, "Try again").run as () => void)();
    expect(p.onAction).toHaveBeenCalledWith({ action: "retry-skipped", sourceId: "src-1", cursor: 4096 });
  });
  it("marks a skipped part retried after a successful press and shows a note instead of Try again", async () => {
    const p = props(); p.events = [skipped]; p.onAction = vi.fn().mockResolvedValue(undefined);
    const onRetried = vi.fn();
    const row = nodes(EventRow({ event: skipped, busy: false, onRetried, onAction: p.onAction, onOpen: p.onOpen }) as ReactNode);
    await (find(row, "Try again").run as () => Promise<void>)();
    expect(onRetried).toHaveBeenCalledTimes(1);
    const after = renderToStaticMarkup(createElement(EventRow, { event: skipped, busy: false, retried: true, onAction: p.onAction, onOpen: p.onOpen }));
    expect(after).not.toContain("Try again");
    expect(after).toContain("Retried. New results will show up here.");
    p.retried = new Set(["skip"]);
    expect(html(p)).not.toContain("Try again");
  });
  it("does not mark a part retried when the press fails", async () => {
    const onRetried = vi.fn(), onAction = vi.fn().mockRejectedValue(new Error("nope"));
    const row = nodes(EventRow({ event: skipped, busy: false, onRetried, onAction, onOpen: vi.fn() }) as ReactNode);
    await expect((find(row, "Try again").run as () => Promise<void>)()).rejects.toThrow("nope");
    expect(onRetried).not.toHaveBeenCalled();
  });
  it("treats a 404 on retry-skipped as already retried, not as a failure", () => {
    const src = read("./MemorySection.tsx");
    expect(src).toMatch(/isAlreadyRetried\(cause\)\) \{[\s\S]*?\breturn;/);
    expect(src).toContain("MEMORY_SKIPPED_SLICE_UNKNOWN");
    expect(src).toMatch(/status === 404/);
  });
  it("posts only the selected owner action and v3 settings", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true });
    const action = { action: "configure" as const, ceiling: { input: 1, output: 2 }, learningRevision: 4 };
    await requestLearningAction(request, action);
    expect(request).toHaveBeenCalledWith("/api/memory/action", { method: "POST", body: JSON.stringify(action) });
  });
});

describe("Advanced", () => {
  it("holds mode and the learning connection (the monthly limit moved to Usage)", () => {
    const out = html();
    for (const text of ["Memory mode", "Capture only", "Learning connection"]) expect(out).toContain(text);
    expect(out).toContain("Flux Fast (default)");
    expect(out).toContain('value="native" disabled=""');
    expect(out).toContain("Native sign-in: This connection does not provide text-only learning.");
    expect(out).toContain('aria-pressed="true"');
  });
  it.each([true, false])("shows one default Flux Fast choice with key available=%s", eligible => {
    const p = props(); p.status.extractors[0].eligible = eligible;
    const out = html(p);
    expect(out.match(/Flux Fast \(default[^<]*/g)).toEqual([eligible ? "Flux Fast (default)" : "Flux Fast (default, add your key)"]);
  });
  it("sends the new limit as a v3 ceiling patch from the editor, which now lives on Usage", () => {
    expect(read("./LearningLimitCard.tsx")).toContain('{ action: "configure", ceiling: next, learningRevision: learning.revision }');
    expect(read("./MemorySection.tsx")).not.toContain("LimitCard");
  });
  it("is one Advanced toggle on the page, with no <details> left in the files this page owns", () => {
    const closed = renderToStaticMarkup(createElement(AdvancedSection, { section: "memory", summary: "Memory mode", open: false, onOpenChange: () => undefined, children: null }));
    expect(closed.match(/aria-expanded/g)).toHaveLength(1);
    expect(closed).toContain('aria-controls="settings-advanced-memory"');
    const section = read("./MemorySection.tsx");
    expect(section.match(/<AdvancedSection /g)).toHaveLength(1);
    for (const file of ["MemorySection", "MemorySettings", "LearningSettings", "MemoryLearningControls", "MemoryEvolutionControls", "ProcedureEvaluationAdmissions"]) {
      expect(read(`./${file}.tsx`).replace(/\/\*[\s\S]*?\*\//g, ""), file).not.toContain("<details");
    }
  });
  it("renders every memory anchor its cards name", () => {
    const source = ["MemorySection", "MemorySettings", "MemoryLearningControls", "ProcedureEvaluationAdmissions", "LearningLimitCard"].map(file => read(`./${file}.tsx`)).join("\n") + read("./SettingsModal.tsx") + read("./settings/pages/UsagePage.tsx");
    for (const anchor of ["memory-heading", "memory-browser-heading", "memory-how-heading", "memory-bots-heading", "memory-learned-heading", "memory-people-heading", "memory-import-heading", "memory-mode-heading", "memory-limit-heading", "memory-connection-heading", "memory-audience-heading", "memory-procedures-heading", "memory-health-heading"]) expect(source.includes(`id="${anchor}"`) || source.includes(`anchor: "${anchor}"`) || read("./settings/pages/MemoryPage.tsx").includes(`"${anchor}"`), anchor).toBe(true);
  });
});

it.each([
  { input: 1000, output: 500, inputUsed: 2000, outputUsed: 1, pausedBy: "limit" as const },
  { input: 1000, output: 500, inputUsed: 1, outputUsed: 1001, pausedBy: "limit" as const },
  { input: 1e12, output: 10000, inputUsed: 1e12, outputUsed: 1, pausedBy: "limit" as const },
  { input: 10000, output: 1e12, inputUsed: 10, outputUsed: 1e12, pausedBy: "limit" as const },
  { input: 1e12, output: 1e12, inputUsed: 1e12, outputUsed: 1, pausedBy: "limit" as const },
  { input: 1e12, output: 1e12, inputUsed: 10, outputUsed: 1, pausedBy: "unseen" as const },
])("31: the Memory page renders no ineffective raise: %j", ceiling => {
  const p = props();
  p.status.learning = { ...learning, ceiling: { ...ceilingRow, ...ceiling, paused: true } };
  const closed=renderToStaticMarkup(createElement(AdvancedHost,null,createElement(MemorySectionContent,p)));
  expect(closed).not.toContain("Raise it");
  expect(closed).not.toContain("Resets on the 1st.");
  expect(closed).not.toContain("Change limit");
  // The real page portals the limit editor into Advanced. The separate Needs you card is the way out.
  expect(closed).toMatch(/Needs you|waiting for you/);
  expect(closed).toContain(ceilingStatusLine(p.status.learning.ceiling).text.replaceAll("'","&#x27;"));
  expect(tree(p).some(node => node.label === "Raise it")).toBe(false);
  expect(ceilingStatusLine(p.status.learning.ceiling).follow).toBe("none");
});

it("F: raising caps the output side near the maximum", () => {
  expect(raisedCeiling({input:1,output:900_000_000_000})).toEqual({input:2,output:1_000_000_000_000});
});

import * as actionHooks from "@/lib/use-action";
it.each([false,true])("A4: Raise uses returned paused=%s before showing its result", async paused => {
  const p=props();p.status.learning={...learning,ceiling:{...ceilingRow,paused:true}};
  const response={learning:{ceiling:{paused}}};p.onAction.mockResolvedValue(response);
  const actions=vi.spyOn(actionHooks,"useAction");
  try {
    html(p);
    const [press,options]=actions.mock.calls.find(([,opts])=>opts?.idle==="Raise it")!;
    expect((options!.success as (value:unknown)=>string)(await press())).toBe(paused?"Learning paused for the rest of the month":"Limit raised. Learning resumes as soon as a run fits your limit.");
    const source=read("./MemorySection.tsx");
    expect(source).toContain("if (pauseOnResult) setStillPaused(learningStillPaused(result))");
    expect(source).toContain('if (stillPaused) return <span role="status">');
    expect(source).toContain("return answer;");
  } finally {actions.mockRestore();}
});

import { learningStillPaused } from "@/lib/learning-limit";
it("A4: a still-paused Raise result renders the month title without another raise or success line", async () => {
  const p = props(); p.status.learning = { ...learning, ceiling: { ...ceilingRow, paused: true } };
  p.onAction.mockResolvedValue({ learning: { ceiling: { paused: true } } });
  const actions = vi.spyOn(actionHooks, "useAction");
  try {
    html(p);
    const [press] = actions.mock.calls.find(([, opts]) => opts?.idle === "Raise it")!;
    const result = await press();
    const button = createElement("button", null, "Raise it", createElement("span", null, "Limit raised."));
    expect(renderToStaticMarkup(renderActionBtnResult(false, button))).toContain("Raise it");
    const out = renderToStaticMarkup(renderActionBtnResult(learningStillPaused(result), button));
    expect(out).toContain("Learning paused for the rest of the month");
    expect(out).not.toContain("Raise it");
    expect(out).not.toContain("Limit raised.");
  } finally { actions.mockRestore(); }
});
