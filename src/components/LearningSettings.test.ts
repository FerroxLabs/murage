// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The Learning screen (design section 16): what each part shows from stored
// data, that every word goes through t(), and that all eight languages have it.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { LearningEvent } from "@/lib/memory-learning";
import type { Lesson } from "@/lib/learning-screen";
import { KEEP_WINDOW_MS } from "@/lib/learning-screen";
import { LearningView, emptyLearningData, type LearningData, type LearningHandlers } from "./LearningSettings";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");
const NOW = 1_700_000_000_000;
const noop = vi.fn(async () => undefined);
const handlers = new Proxy({}, { get: () => noop }) as unknown as LearningHandlers;

const lesson = (id: string, over: Partial<Lesson> = {}): Lesson => ({ id, version: 1, kind: "lesson", text: `Lesson ${id}`, origin: "typed", state: "active", createdAt: NOW - Number(id.replace(/\D/g, "") || 0) * 1000, learningEventId: `ev-${id}`, ...over });
const event = (id: string, over: Partial<LearningEvent> = {}): LearningEvent => ({
  id, kind: "activated", record_id: `r-${id}`, record_version: 1, created_at: NOW - Number(id.replace(/\D/g, "") || 0), undone_at: null, kept_at: null,
  record: { id: `r-${id}`, version: 1, state: "active", text: `Memory ${id}` }, scopeLabel: "", source: null, ...over,
});
const loaded = (over: Partial<LearningData> = {}): LearningData => ({
  ...emptyLearningData, loading: false,
  state: { settings: { enabled: true, askFirst: false, prospectLearning: false, prospectThreadIds: [] }, revision: 1, readiness: { ready: false, outcomes: 0, examples: 0 } },
  lessons: { lessons: [], revision: 1 }, outcomes: { won: 0, lost: 0, good: 0, bad: 0, proposed: 0 }, history: { events: [], nextCursor: null }, memory: { mode: "active" },
  counts: { counts: { month: "2026-10", lessons: 14, memories: 9, wins: 3, undone: 2 }, unseen: 0 }, ...over,
});
const render = (data: LearningData, extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(LearningView, { botName: "Dax", data, tasks: [], handlers, now: NOW, ...extra }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("the top of the screen", () => {
  it("shows the switch, the intro and the month line with undone", () => {
    const html = text(render(loaded()));
    expect(html).toContain("Learns from you");
    expect(html).toContain("Dax learns from your feedback, edits and marks. Permissions still decide what it may do.");
    expect(html).toContain("This month: learned 14, remembers 9, 2 undone");
    expect(render(loaded())).toMatch(/role="switch"[^>]*aria-checked="true"|aria-checked="true"[^>]*role="switch"/);
  });
  it("omits the undone count when none, and the month line when counts failed", () => {
    expect(text(render(loaded({ counts: { counts: { month: "", lessons: 1, memories: 0, wins: 0, undone: 0 }, unseen: 0 } })))).not.toContain("undone");
    expect(text(render(loaded({ counts: null })))).not.toContain("This month");
  });
  it("waits quietly while loading and offers one retry when it failed", () => {
    expect(text(render({ ...emptyLearningData }))).toContain("Loading");
    const failed = text(render({ ...emptyLearningData, loading: false, loadFailed: true }));
    expect(failed).toContain("Could not load this. Try again.");
    expect(failed).toContain("Try again");
  });
  it("has Tell it something with the placeholder, a labelled field and Add", () => {
    const html = render(loaded());
    expect(html).toContain('placeholder="e.g. Keep client emails under 120 words"');
    expect(html).toContain('maxLength="280"');
    expect(text(html)).toContain("Tell it something");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Add<\/button>/);
  });
});

describe("What it learned", () => {
  const many = Array.from({ length: 8 }, (_, i) => lesson(`l${i + 1}`));
  it("counts active lessons, shows five, then Show more", () => {
    const html = text(render(loaded({ lessons: { lessons: [...many, lesson("x1", { state: "stale" }), lesson("x2", { state: "suggested" })], revision: 1 } })));
    expect(html).toContain("What it learned (8)");
    expect((html.match(/Lesson l\d/g) ?? []).length).toBe(5);
    expect(html).toContain("Show more (3)");
    expect(text(render(loaded({ lessons: { lessons: many, revision: 1 } }), { defaultExpanded: true }))).not.toContain("Show more");
  });
  it("each row says where it came from and offers Edit and Undo", () => {
    const html = text(render(loaded({ lessons: { lessons: [lesson("l1")], revision: 1 } })));
    expect(html).toContain("From Tell it something, today");
    expect(html).toContain("Edit");
    expect(html).toContain("Undo");
  });
  it("an undone lesson says Undone with Keep inside the window, and is gone after it", () => {
    const undone = lesson("l1", { state: "undone" });
    const data = (until: number) => loaded({ lessons: { lessons: [undone], revision: 2 }, undone: { l1: { lesson: undone, until } } });
    const inside = text(render(data(NOW + KEEP_WINDOW_MS)));
    expect(inside).toContain("Undone");
    expect(inside).toContain("Keep");
    expect(inside).not.toContain("Lesson l1");
    expect(text(render(data(NOW - 1)))).not.toContain("Keep");
  });
  it("says what to do when nothing is learned yet", () => { expect(text(render(loaded()))).toContain("What it learned (0)"); });
  it("lists unsure feedback with Yes and No, and nothing when there is none", () => {
    const html = render(loaded({ feedback: [{ id: "f1", text: "hmm ok", threadId: "t", createdAt: NOW, revision: 1 }] }));
    expect(text(html)).toContain('"hmm ok" Was that feedback?');
    expect(html).toMatch(/>Yes<\/button>/);
    expect(html).toMatch(/>No<\/button>/);
    expect(text(render(loaded()))).not.toContain("Unsure");
  });
});

describe("Remembers", () => {
  const events = Array.from({ length: 5 }, (_, i) => event(`m${i + 1}`));
  it("shows the three newest with Edit and Forget, and See all with the number when the page is everything", () => {
    const html = text(render(loaded({ history: { events, nextCursor: null } })));
    expect(html).toContain("Remembers (5)");
    const block = html.slice(html.indexOf("Remembers (5)"), html.indexOf("See all 5 in Memory"));
    expect((block.match(/Memory m\d/g) ?? []).length).toBe(3);
    expect(html).toContain("Forget");
    expect(html).toContain("See all 5 in Memory");
    expect(html).toContain("Memory is on");
  });
  it("leaves the number out when there is more than one page", () => {
    const html = text(render(loaded({ history: { events, nextCursor: "next" } })));
    expect(html).toContain("See all in Memory");
    expect(html).not.toContain("See all 5");
    expect(html).not.toContain("Remembers (");
  });
  it("when memory is off, says to turn it on and offers the way", () => {
    const html = render(loaded({ memory: { mode: "off" } }));
    expect(text(html)).toContain("Turn memory on in Settings > Memory to learn");
    expect(html).toContain(">Open Memory settings<");
    expect(text(html)).not.toContain("Memory is on");
  });
});

describe("Suggestions", () => {
  const suggestion = { id: "s1", version: 1, kind: "lesson" as const, text: "A better reply to price questions", origin: "feedback" as const, prospectDerived: false, createdAt: NOW };
  it("is hidden when there are none", () => { expect(text(render(loaded()))).not.toContain("Suggestions"); });
  it("shows Apply, Edit, Not now and why it was suggested", () => {
    const html = render(loaded({ suggestions: [suggestion] }));
    expect(text(html)).toContain("Suggestions (1)");
    expect(text(html)).toContain("Why this was suggested: You said something in a chat.");
    for (const label of ["Apply", "Edit", "Not now"]) expect(html).toContain(`>${label}</button>`);
  });
  it("marks customer-derived suggestions", () => {
    expect(text(render(loaded({ suggestions: [{ ...suggestion, prospectDerived: true }] })))).toContain("From customer messages.");
  });
});

describe("Results", () => {
  it("prints the marks line and no check button unless the server says ready", () => {
    const html = render(loaded({ outcomes: { won: 3, lost: 2, good: 7, bad: 0, proposed: 0 } }));
    expect(text(html)).toContain("12 marked: 3 won, 2 lost, 7 good.");
    expect(html).not.toContain("Check for improvements");
  });
  it("says how many more outcomes are needed", () => {
    expect(text(render(loaded({ outcomes: { won: 1, lost: 0, good: 0, bad: 0, proposed: 0 } })))).toContain("Not enough examples yet. Confirm 2 more outcomes.");
  });
  it("shows Check for improvements when ready", () => {
    const state = { ...loaded().state!, readiness: { ready: true, outcomes: 9, examples: 9 } };
    expect(render(loaded({ state, outcomes: { won: 5, lost: 0, good: 0, bad: 0, proposed: 0 } }))).toContain(">Check for improvements<");
  });
  it("shows nothing for results when the harness could not say", () => { expect(text(render(loaded({ outcomes: null })))).not.toContain("Results"); });
});

describe("More", () => {
  it("is a closed fold by default and holds the options", () => {
    const html = render(loaded());
    expect(html).toMatch(/<details(?![^>]*\sopen)[^>]*>/);
    for (const words of ["Ask me before it changes anything", "Learn from customer and audience messages", "Coming later.", "Recent changes", "Undo does not change what was already sent", "Restore original behavior", "Changes already applied to skills are not touched."]) expect(text(html), words).toContain(words);
  });
  it("customer-message learning is shown as coming later, with no switch and no chat picker (T1-17)", () => {
    const html = render(loaded(), { defaultMoreOpen: true, tasks: [{ threadId: "t1", title: "Acme call" }] });
    expect(text(html)).toContain("Coming later. Nothing is learned from customer or audience messages yet.");
    expect(html).not.toContain("learning-prospect-label");
    expect(html).not.toContain("Acme call");
    expect(text(html)).not.toContain("Turn on");
  });
  it("offers Forget this learning data as an inline confirmation", () => {
    const html = text(render(loaded(), { defaultMoreOpen: true }));
    expect(html).toContain("Forget this learning data");
    expect(html).toContain("Conversations stay.");
  });
  it("lists up to ten recent changes with Undo only where it applies", () => {
    const events = [
      ...Array.from({ length: 12 }, (_, i) => event(`c${i + 1}`)),
      event("run", { kind: "run-completed", created_at: NOW + 5, record: null }),
    ];
    const html = text(render(loaded({ history: { events, nextCursor: null } })));
    expect(html).toContain("Learning run finished");
    expect(html).toContain("Memory c9");
    expect(html).not.toMatch(/Memory c10\b/);
  });
  it("prints usage only from what memory status reports", () => {
    expect(text(render(loaded()))).not.toContain("Usage");
    const learning = { allowance: { day: "d", inputUsed: 1, outputUsed: 1, usedPercent: 12 } } as any;
    expect(text(render(loaded({ memory: { mode: "active", learning } })))).toContain("Usage today: 12% of the learning allowance.");
  });
  it("Restore turns into an inline confirmation, not a dialog", () => {
    const html = render(loaded(), { defaultConfirmRestore: true });
    expect(text(html)).toContain("Restore original behavior?");
    expect(html).toContain(">Yes, restore<");
    expect(html).not.toContain('role="dialog"');
  });
});

describe("keyboard, focus and widths", () => {
  const html = render(loaded({ lessons: { lessons: [lesson("l1")], revision: 1 }, suggestions: [{ id: "s1", version: 1, kind: "lesson", text: "x", origin: "edit", prospectDerived: false, createdAt: NOW }] }));
  it("every button has a visible focus style and a real tap target", () => {
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBeGreaterThan(6);
    for (const button of buttons) expect(button, button).toContain("focus-visible:outline");
    for (const button of html.match(/<button[^>]*class="[^"]*"[^>]*>(?=[A-Z])/g) ?? []) expect(button, button).toContain("min-h-11");
  });
  it("wraps and never forces a horizontal scroll", () => {
    expect(html).toContain("min-w-0");
    expect(html).toContain("flex-wrap");
    expect(html).toContain("break-words");
    expect(html).not.toMatch(/overflow-x-(scroll|auto)|whitespace-nowrap/);
  });
  it("gives focus somewhere to return to", () => {
    expect(html).toContain('data-learning-focus="heading:top"');
    expect(html).toContain('data-learning-focus="heading:learned"');
    expect(html).toContain('data-learning-focus="edit:l1"');
    expect(html).toContain('data-learning-focus="apply:s1"');
  });
});

describe("words", () => {
  const source = readFileSync(join(HERE, "LearningSettings.tsx"), "utf8");
  const lib = readFileSync(join(SRC, "lib", "learning-screen.ts"), "utf8");
  const locales = ["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh"] as const;
  const catalog = (code: string) => JSON.parse(readFileSync(join(SRC, "locales", `${code}.json`), "utf8")) as Record<string, string>;
  const ownKeys = (code: string) => Object.keys(catalog(code)).filter(key => key.startsWith("learningScreen."));

  it("every user-facing string in LearningSettings.tsx goes through t()", () => {
    const code = source.split("\n").filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
    expect(code).not.toMatch(/(placeholder|aria-label|title|alt)="[^"{]*[A-Za-z]{2}/);
    expect(code).not.toMatch(/(?<![=\-<])>\s*[A-Za-z][A-Za-z ,.'!?:]*\s*<\/?[A-Za-z]/);
    expect(code).not.toMatch(/\bt\("[A-Za-z]/); // the screen's own alias only, so every key carries the prefix
    expect(source).toContain('screenText as s');
  });
  it("every key the screen asks for exists in English, with the prefix", () => {
    const asked = new Set<string>();
    for (const match of (source + lib).matchAll(/\bs\("([\w.]+)"|screenText\("([\w.]+)"/g)) asked.add(match[1] ?? match[2]);
    for (const name of ["from.feedback", "from.edit", "from.mark", "from.typed", "from.suggested", "kind.won", "kind.lost", "kind.good", "kind.bad", "results.needOne", "results.needMany", "why.feedback", "why.edit", "why.mark", "why.other",
      "procedure.skill", "procedure.routine", "recent.procedure.auto", "recent.procedure.applied", "recent.procedure.suggested", "recent.procedure.undone", "recent.procedure.skill", "recent.procedure.routine"]) asked.add(name);
    const en = new Set(ownKeys("en"));
    for (const name of asked) expect(en.has(`learningScreen.${name}`), name).toBe(true);
    for (const key of en) expect(asked.has(key.slice("learningScreen.".length)), `unused ${key}`).toBe(true);
  });
  it("English follows the copy rules", () => {
    for (const [key, value] of Object.entries(catalog("en")).filter(([key]) => key.startsWith("learningScreen."))) {
      expect(value, key).not.toMatch(/[—–]/);
      expect(value, key).not.toMatch(/\b(safe|safely|safety|unsafe|composio|free|price|pricing|cheap|always-on)\b/i);
    }
  });
  it("all eight languages have every learningScreen key, with the same placeholders", () => {
    const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort().join(",");
    const en = catalog("en");
    for (const code of locales) {
      const pack = catalog(code);
      for (const key of ownKeys("en")) {
        expect(pack[key], `${code} ${key}`).toBeTruthy();
        expect(placeholders(pack[key]), `${code} ${key}`).toBe(placeholders(en[key]));
      }
      for (const key of Object.keys(pack).filter(key => key.startsWith("learningScreen."))) expect(en[key], `${code} extra ${key}`).toBeDefined();
    }
  });
  it("the other languages carry no em dashes or banned words either", () => {
    for (const code of locales) for (const key of ownKeys(code)) expect(catalog(code)[key], `${code} ${key}`).not.toMatch(/[—–]|composio/i);
  });
});
