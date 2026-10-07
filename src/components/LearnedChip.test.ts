// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The chip under a reply (design 12a and 16): what it says, when it shows,
// what a tap offers, and that it can be reached and read without a pointer.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { KEEP_WINDOW_MS, TEMPLATE_COUNTS, buildChip, chipClause, chipsByReply, keepAvailable, pickTemplate, templateKey, type ChipItem } from "../../shared/learned-chip";
import { LearnedChip, chipHeadline, sheetActions } from "./LearnedChip";
import { chipHandlers, fetchChips } from "@/lib/learned-chips";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCALES = join(HERE, "..", "locales");
const NOW = 1_700_000_000_000;
const handlers = { undo: vi.fn(), keep: vi.fn(), edit: vi.fn(), keepSuggestion: vi.fn() };

const lesson = (over: Partial<ChipItem> = {}): ChipItem => ({
  eventId: "e1", kind: "lesson", group: "lesson", template: 1, text: "lead with the decision", state: "active", replyMessageId: "r1", lessonId: "l1", lessonVersion: 1,
  actions: { edit: true, undo: true, forget: false, notQuite: true, notExample: false, restorable: true }, ...over,
});
const remembered = (over: Partial<ChipItem> = {}): ChipItem => ({
  eventId: "e2", kind: "remembered", group: "remembered", template: 1, text: "your board meets on the first Tuesday", state: "active", replyMessageId: "r1",
  actions: { edit: true, undo: false, forget: true, notQuite: false, notExample: false, restorable: false }, ...over,
});
const kept = (over: Partial<ChipItem> = {}): ChipItem => ({
  eventId: "e3", kind: "kept", group: "praise", template: 1, text: "short openers", state: "active", replyMessageId: "r1",
  actions: { edit: false, undo: false, forget: false, notQuite: false, notExample: true, restorable: false }, ...over,
});
const render = (items: ChipItem[], extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(LearnedChip, { botName: "Ember", items, handlers, now: NOW, ...extra }));

describe("honesty: a chip only when something was stored", () => {
  it("renders nothing with no items, with an item that has no event id, or with an undone item past its Keep window", () => {
    expect(render([])).toBe("");
    expect(render([lesson({ eventId: "" })])).toBe("");
    expect(render([lesson({ state: "undone", undoneAt: NOW - KEEP_WINDOW_MS - 1 })])).toBe("");
    expect(buildChip([], NOW)).toBeNull();
  });
  it("an undone item stays for exactly the Keep window", () => {
    const item = lesson({ state: "undone", undoneAt: NOW - KEEP_WINDOW_MS });
    expect(keepAvailable(item, NOW)).toBe(true);
    expect(keepAvailable(item, NOW + 1)).toBe(false);
  });
  it("the app drops a chip with no stored event even if the harness sent one", async () => {
    const request = vi.fn(async () => ({ chips: [lesson(), { ...lesson(), eventId: "" }, { ...lesson({ eventId: "e9" }), replyMessageId: "" }] }));
    const byReply = await fetchChips(request, "ember", "t 1");
    expect(request).toHaveBeenCalledWith("/api/bots/ember/lessons?threadId=t%201");
    expect([...byReply.keys()]).toEqual(["r1"]);
    expect(byReply.get("r1")).toHaveLength(1);
  });
});

describe("the words", () => {
  it("a lesson chip uses a shipped template with the bot's name and the lesson", () => {
    const model = buildChip([lesson()], NOW)!;
    expect(chipHeadline(model, "Ember")).toBe("Ember will do this differently: lead with the decision");
    expect(chipHeadline(buildChip([lesson({ template: 2, text: "no emojis in client emails" })], NOW)!, "Ember")).toBe("Changed: no emojis in client emails");
    expect(chipHeadline(buildChip([remembered({ template: 2 })], NOW)!, "Ember")).toBe("Kept in memory: your board meets on the first Tuesday");
    expect(chipHeadline(buildChip([kept()], NOW)!, "Ember")).toBe("Ember learned from that. Keeping: short openers");
    expect(chipHeadline(buildChip([kept({ group: "win", template: 2, text: "the follow-up timing" })], NOW)!, "Dax")).toBe("Dax learned from this win: the follow-up timing");
  });
  it("a memory entry is cut to 80 characters on one line", () => {
    const long = `the board meets\non the first Tuesday ${"of every month ".repeat(10)}`;
    const clause = chipClause(long);
    expect(clause.length).toBeLessThanOrEqual(80);
    expect(clause).not.toContain("\n");
    expect(clause.endsWith("…")).toBe(true);
  });
  it("several things merge into one chip with counts", () => {
    const model = buildChip([remembered(), remembered({ eventId: "e4" }), lesson()], NOW)!;
    expect(chipHeadline(model, "Ember")).toBe("Ember will remember 2 things and learned 1 thing");
    expect(chipHeadline(buildChip([lesson(), lesson({ eventId: "e5" })], NOW)!, "Ember")).toBe("Ember learned 2 things");
    expect(chipHeadline(buildChip([remembered(), lesson()], NOW)!, "Ember")).toBe("Ember will remember 1 thing and learned 1 thing");
  });
  it("at most one chip per reply", () => {
    const grouped = chipsByReply([lesson(), remembered(), lesson({ eventId: "e6", replyMessageId: "r2" })], NOW);
    expect([...grouped.keys()].sort()).toEqual(["r1", "r2"]);
    const html = render([lesson(), remembered(), kept()]);
    expect(html.match(/data-testid="learned-chip"/g)).toHaveLength(1);
  });
  it("template rotation never returns the previous one and covers the whole set", () => {
    for (const [group, count] of Object.entries(TEMPLATE_COUNTS) as [keyof typeof TEMPLATE_COUNTS, number][]) {
      expect(count).toBeGreaterThanOrEqual(6); expect(count).toBeLessThanOrEqual(8);
      const seen = new Set<number>();
      for (let previous = 1; previous <= count; previous += 1) for (let seed = 0; seed < 2 * count; seed += 1) {
        const picked = pickTemplate(group, previous, seed);
        expect(picked).not.toBe(previous); expect(picked).toBeGreaterThanOrEqual(1); expect(picked).toBeLessThanOrEqual(count);
        seen.add(picked);
      }
      expect(seen.size).toBe(count);
    }
  });
});

describe("the shipped template set, every language", () => {
  const en = JSON.parse(readFileSync(join(LOCALES, "en.json"), "utf8")) as Record<string, string>;
  const codes = readdirSync(LOCALES).filter(name => name.endsWith(".json") && name !== "en.json" && name !== "source-hashes.json");
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  const chipKeys = Object.keys(en).filter(name => name.startsWith("learnedChip."));

  it("has every template in English and the placeholders each needs", () => {
    for (const [group, count] of Object.entries(TEMPLATE_COUNTS)) for (let n = 1; n <= count; n += 1) {
      const text = en[templateKey(group as keyof typeof TEMPLATE_COUNTS, n)];
      expect(text, `${group}.${n}`).toBeTruthy();
      expect(placeholders(text!)).toContain("text");
    }
  });
  it("is translated into every app language with the same placeholders", () => {
    expect(codes.length).toBeGreaterThanOrEqual(7);
    for (const code of codes) {
      const pack = JSON.parse(readFileSync(join(LOCALES, code), "utf8")) as Record<string, string>;
      for (const name of chipKeys) {
        expect(pack[name], `${code} ${name}`).toBeTruthy();
        expect(placeholders(pack[name]!), `${code} ${name}`).toEqual(placeholders(en[name]!));
      }
    }
  });
  it("follows the copy rules: no em dashes, no safety words, no vendor name, no price talk, no always-on", () => {
    for (const code of ["en.json", ...codes]) {
      const pack = JSON.parse(readFileSync(join(LOCALES, code), "utf8")) as Record<string, string>;
      for (const name of chipKeys) {
        const text = pack[name]!;
        expect(text, `${code} ${name}`).not.toMatch(/[—–]/);
        expect(text, `${code} ${name}`).not.toMatch(/\b(safe|safely|safety|unsafe|composio|free|price|always-on)\b/i);
      }
    }
  });
});

describe("what a tap shows", () => {
  it("a closed chip is one button: reachable, named, with a visible focus ring, and not a dialog", () => {
    const html = render([lesson()]);
    expect(html).toContain('<button type="button"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("aria-controls=");
    expect(html).toContain('aria-label="Ember kept something from that reply. Details"');
    expect(html).toContain("focus-visible:outline-2");
    expect(html).not.toContain("aria-modal");
    expect(html).not.toContain("role=\"dialog\"");
    expect(html).not.toContain("tabindex=\"-1\"");
  });
  it("a lesson offers Edit, Undo and Not quite, and says Undo leaves what was sent alone", () => {
    const html = render([lesson({ first: true })], { defaultOpen: true });
    for (const label of ["Edit", "Undo", "Not quite"]) expect(html).toContain(`>${label}</button>`);
    expect(html).toContain("lead with the decision");
    expect(html).toContain("Undo does not change what was already sent.");
    expect(html).toContain("Lessons like this live in Settings &gt; Learning, where you can edit or undo them.");
    expect(html).not.toContain("aria-modal");
    expect(render([lesson({ first: false })], { defaultOpen: true })).not.toContain("live in Settings");
  });
  it("a memory entry offers Edit and Forget; a praised example offers Not an example", () => {
    const memory = render([remembered()], { defaultOpen: true });
    expect(memory).toContain(">Edit</button>"); expect(memory).toContain(">Forget</button>"); expect(memory).not.toContain(">Undo</button>");
    const example = render([kept()], { defaultOpen: true });
    expect(example).toContain(">Not an example</button>"); expect(example).not.toContain(">Edit</button>");
  });
  it("after Undo the chip reads Undone with Keep, and nothing else", () => {
    const item = lesson({ state: "undone", undoneAt: NOW - 5000 });
    expect(sheetActions(item, NOW)).toEqual(["keep"]);
    const html = render([item]);
    expect(html).toContain(">Undone<");
    const open = render([item], { defaultOpen: true });
    expect(open).toContain(">Keep</button>");
    expect(open).not.toContain(">Edit</button>");
    expect(sheetActions(lesson({ state: "undone", undoneAt: NOW - KEEP_WINDOW_MS - 1 }), NOW)).toEqual([]);
  });
  it("action order follows what the item allows", () => {
    expect(sheetActions(lesson(), NOW)).toEqual(["edit", "undo", "notQuite"]);
    expect(sheetActions(remembered(), NOW)).toEqual(["edit", "forget"]);
    expect(sheetActions(kept(), NOW)).toEqual(["notExample"]);
  });
});

describe("the taps", () => {
  it("Undo, Forget and Keep go through the same two learning actions the lists use; Edit patches the lesson at its version", async () => {
    const request = vi.fn(async () => ({}));
    const taps = chipHandlers(request, "ember");
    await taps.undo(lesson()); await taps.keep(lesson());
    expect(request).toHaveBeenNthCalledWith(1, "/api/memory/action", { method: "POST", body: JSON.stringify({ action: "learning-undo", eventId: "e1" }) });
    expect(request).toHaveBeenNthCalledWith(2, "/api/memory/action", { method: "POST", body: JSON.stringify({ action: "learning-keep", eventId: "e1" }) });
    await taps.edit(lesson({ lessonVersion: 3 }), "No emojis");
    const [path, init] = request.mock.calls[2] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(path).toBe("/api/bots/ember/lessons/l1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ expectedRevision: 3, text: "No emojis" });
    expect(init.headers["Idempotency-Key"].length).toBeGreaterThanOrEqual(8);
    await expect(taps.edit(remembered(), "x")).rejects.toThrow();
  });
});

describe("the component source", () => {
  const source = readFileSync(join(HERE, "LearnedChip.tsx"), "utf8");
  it("has no modal, no toast and no timer that hides a change", () => {
    expect(source).not.toMatch(/role="(?:alert)?dialog"|aria-modal|createPortal|<dialog|window\.confirm|alert\(/);
    expect(source).toContain("onKeyDown");
    expect(source).toContain("Escape");
  });
});

describe("the memory chip from the live event (B5m)", () => {
  it("offers only Forget: no Edit, Undo or Keep", () => {
    const item = remembered({ actions: { edit: false, undo: false, forget: true, notQuite: false, notExample: false, restorable: false } });
    expect(sheetActions(item, NOW)).toEqual(["forget"]);
    expect(chipHeadline(buildChip([item], NOW)!, "Ember")).toBe("Ember will remember that: your board meets on the first Tuesday");
  });
  it("Forget is the existing memory undo on the activation event", async () => {
    const request = vi.fn(async () => ({}));
    await chipHandlers(request, "ember").undo(remembered());
    const [path, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/memory/action");
    expect(JSON.parse(String(init.body))).toMatchObject({ action: "learning-undo", eventId: "e2" });
  });
  it("a memory and a lesson under one reply make one chip", () => {
    const model = buildChip([remembered(), lesson({ eventId: "e5" })], NOW)!;
    expect(model.mode).toBe("merged");
    expect(chipHeadline(model, "Ember")).toBe("Ember will remember 1 thing and learned 1 thing");
    expect((render([remembered(), lesson({ eventId: "e5" })]).match(/data-testid="learned-chip"/g) ?? []).length).toBe(1);
  });
});

describe("the improved chip (B7c)", () => {
  const improved = (over: Partial<ChipItem> = {}): ChipItem => ({
    eventId: "e9", kind: "improved", group: "improved", template: 1, text: "Weekly brief", state: "active", undoneAt: null, replyMessageId: "m1", procedureKind: "skill",
    actions: { edit: false, undo: true, forget: false, notQuite: false, notExample: false, restorable: false }, ...over,
  });
  it("names what improved and offers one-tap Undo, nothing else", () => {
    expect(chipHeadline(buildChip([improved()], NOW)!, "Ember")).toBe("Ember improved how it does Weekly brief");
    expect(sheetActions(improved(), NOW)).toEqual(["undo"]);
  });
  it("Undo is the existing learning undo on the change's event", async () => {
    const request = vi.fn(async () => ({}));
    await chipHandlers(request, "ember").undo(improved());
    const [path, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/memory/action");
    expect(JSON.parse(String(init.body))).toMatchObject({ action: "learning-undo", eventId: "e9" });
  });
  it("counts as something learned when it merges with other chips", () => {
    expect(chipHeadline(buildChip([improved(), improved({ eventId: "e10" })], NOW)!, "Ember")).toBe("Ember learned 2 things");
  });
});

describe("a waiting suggestion: Learned ... Keep it? (Tier 1 allowlist)", () => {
  const waiting = (over: Partial<ChipItem> = {}): ChipItem => ({
    eventId: "l9", kind: "lesson", group: "lesson", template: 1, text: "use the order number from their first email.", state: "suggested", replyMessageId: "r1", lessonId: "l9", lessonVersion: 1, keepScope: "thread",
    actions: { edit: false, undo: false, forget: false, notQuite: false, notExample: false, restorable: false, keepIt: true }, ...over,
  });
  it("reads as one quiet line with one tap, no sheet, no dialog and no dismiss button", () => {
    const html = render([waiting()]);
    expect(html).toContain("Learned: use the order number from their first email. Keep it?");
    expect(html).toContain(">Keep it<");
    expect(html).not.toContain("role=\"dialog\"");
    expect(html).not.toMatch(/Dismiss|Not now|Cancel|Undo/);
    expect(html).not.toContain("aria-expanded");
  });
  it("keeps its own Keep it when something else was learned under the same reply (review AL-07)", () => {
    const html = render([lesson(), waiting()]);
    expect(html).toContain("data-testid=\"learned-chip\""); // the learned chip
    expect(html).toContain("Learned: use the order number from their first email. Keep it?");
    expect(html).toContain(">Keep it<");
    const approvals = render([lesson(), waiting({ aboutApprovals: true, actions: { edit: false, undo: false, forget: false, notQuite: false, notExample: false, restorable: false, keepIt: false } })]);
    expect(approvals).toContain("follows your Access settings for approvals");
  });
  it("offers Keep it and nothing else in the tap sheet, and nothing when it is about approvals", () => {
    expect(sheetActions(waiting(), NOW)).toEqual(["keepIt"]);
    expect(sheetActions(waiting({ actions: { edit: false, undo: false, forget: false, notQuite: false, notExample: false, restorable: false, keepIt: false } }), NOW)).toEqual([]);
  });
  it("a suggestion about approvals points to Access instead of offering Keep it", () => {
    const html = render([waiting({ aboutApprovals: true, actions: { edit: false, undo: false, forget: false, notQuite: false, notExample: false, restorable: false, keepIt: false } })]);
    expect(html).toContain("Ember follows your Access settings for approvals. Change them in Access.");
    expect(html).not.toContain(">Keep it<");
  });
  it("the shipped copy has no em dash and never says safe, safely, safety or unsafe", () => {
    const en = JSON.parse(readFileSync(join(LOCALES, "en.json"), "utf8")) as Record<string, string>;
    for (const key of ["learnedChip.suggested", "learnedChip.keepIt", "learnedChip.keptHere", "learnedChip.keptChats", "learnedChip.keptCustomers", "learnedChip.keptEverywhere", "learnedChip.approvalsNote", "learnedChip.openAccess", "learningScreen.waiting.intro", "learningScreen.widen", "learningScreen.approvals.note", "learningScreen.approvals.open"]) {
      expect(en[key], key).toBeTypeOf("string");
      expect(en[key], key).not.toContain("\u2014");
      expect(en[key], key).not.toMatch(/\b(?:safe|safely|safety|unsafe)\b/i);
    }
  });
  it("Keep it calls the suggestion handler for that lesson", async () => {
    const calls: ChipItem[] = [];
    const keepSuggestion = async (item: ChipItem) => { calls.push(item); };
    const item = waiting();
    await keepSuggestion(item);
    expect(calls).toEqual([item]);
    expect(chipHandlers(async () => ({}), "ember").keepSuggestion).toBeTypeOf("function");
  });
});
