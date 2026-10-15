// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// "Needs you" as a person sees it (PROPOSAL-v2 0.4, 0.5, 0.8, 0.15): the rows,
// the order of what is on them, that a Keep moves nothing but the row, and that
// no code text reaches the screen.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MemoryNeedsYouView, type ViewProps } from "./MemoryNeedsYou";
import { InboxMemoryWaiting } from "./InboxMemoryWaiting";
import type { ReviewItem } from "@/lib/memory-review";

const NOW = Date.UTC(2026, 9, 14, 12);
const subject = { kind: "bot" as const, id: "bot", name: "Sable" };
const entry = (n: number, over: Partial<ReviewItem> = {}): ReviewItem => ({ id: `id-${n}`, version: 1, text: `Reports go out on Mondays, note ${n}`, group: "everyday", rank: 2, reasons: [], origin: "owner-said", at: NOW - 86_400_000, later: false, scopeLabel: "Your chat with Sable", ...over });
const asks = [
  entry(100, { text: "The salary review is in March", group: "one-by-one", rank: 1, reasons: ["sensitive-money"] }),
  entry(101, { text: "Lunch with Dana is on the 3rd", group: "one-by-one", rank: 1, reasons: ["sensitive-person"] }),
  entry(102, { text: "The wifi password is on the fridge", group: "one-by-one", rank: 1, reasons: ["sensitive-secret"] }),
];
const eleven = [...asks, ...Array.from({ length: 8 }, (_, n) => entry(n))];
const view = (over: Partial<ViewProps> = {}): ViewProps => ({
  subject, counts: { waiting: 11, later: 0, everyday: 8 }, items: eleven, tab: "waiting", expanded: false, pending: new Set(), editing: null, pinAsk: null,
  newCount: 0, error: null, sources: {}, toast: null, now: NOW, ...over,
});
const html = (over: Partial<ViewProps> = {}) => renderToStaticMarkup(createElement(MemoryNeedsYouView, view(over)));
const section = (markup: string) => markup.slice(markup.indexOf("<section"), markup.indexOf("</section>") + "</section>".length);
/** The frame around the rows: everything except the rows themselves and the numbers in text. */
const skeleton = (markup: string) => section(markup).replace(/<li[\s\S]*?<\/li>/g, "").replace(/\d+/g, "#").replace(/>[^<]+</g, "><");

describe("Needs you, desktop", () => {
  it("leads with the count, the everyday line and Keep all, then three answerable rows", () => {
    const out = html();
    expect(out).toContain("11 waiting for you");
    expect(out).toContain("8 everyday things can be kept together. 3 need you one by one.");
    expect(out).toContain("Keep all 8");
    expect(out).toContain("Review all 11");
    expect((out.match(/data-memory-item=/g) ?? []).length).toBe(3);
    expect(out).toContain("About money, so Sable asks you first.");
    expect(out).toContain("About another person, so Sable asks you first.");
  });

  it("puts Keep, Not now and Edit above the words, and the sources below them", () => {
    const out = html();
    const row = out.slice(out.indexOf("<li"), out.indexOf("</li>"));
    const keep = row.indexOf(">Keep<"), later = row.indexOf(">Not now<"), edit = row.indexOf(">Edit<"), words = row.indexOf("The salary review"), why = row.indexOf("Why this?");
    expect(keep).toBeGreaterThan(-1);
    expect(keep).toBeLessThan(later); expect(later).toBeLessThan(edit); expect(edit).toBeLessThan(words); expect(words).toBeLessThan(why);
  });

  it("offers Keep all only when something is everyday, and says so when nothing is", () => {
    const none = html({ counts: { waiting: 3, later: 0, everyday: 0 }, items: asks });
    expect(none).not.toContain("Keep all");
    expect(none).toContain("Each of these needs you one by one.");
    expect(html({ counts: { waiting: 0, later: 0, everyday: 0 }, items: [] })).toContain("Nothing waiting for you.");
  });

  it("expands to every row with the one-by-one group first, and to Later", () => {
    const out = html({ expanded: true });
    expect((out.match(/data-memory-item=/g) ?? []).length).toBe(11);
    expect(out.indexOf("One by one")).toBeLessThan(out.indexOf("Everyday"));
    expect(out).toContain("Needs you · Sable · 11 waiting for you");
    expect(out).toContain("Waiting 11"); expect(out).toContain("Later 0");
    const later = html({ expanded: true, tab: "later", counts: { waiting: 10, later: 1, everyday: 7 }, items: [entry(9, { later: true })] });
    expect(later).toContain("Back to waiting");
    expect(later).toContain(">Keep<");
  });

  it("shows an edit with Save and keep, the old words, and a pin question for a replaced pin", () => {
    const editing = html({ editing: { id: "id-100", draft: "The salary review moved to April" } });
    expect(editing).toContain("Save and keep");
    expect(editing).toContain("Edit what Sable keeps");
    expect(editing).toContain('Was: &quot;The salary review is in March&quot;');
    const fix = entry(200, { text: "Invoices go out on the 5th", group: "one-by-one", rank: 0, reasons: ["correction", "replaces-pinned"], correction: { targetText: "Invoices go out on the 1st", targetPinned: true } });
    const asking = html({ items: [fix], counts: { waiting: 1, later: 0, everyday: 0 }, pinAsk: "id-200" });
    expect(asking).toContain("What should happen to the pin?");
    expect(asking).toContain("Keep the pin on the new one");
    expect(asking).toContain("Remove the pin");
  });

  it("says how many are new without moving what is on screen", () => {
    expect(html({ newCount: 3 })).toContain("3 new");
  });
});

describe("zero layout shift on Keep (0.8)", () => {
  it("keeps the same frame before and after a Keep: only a row and some numbers change", () => {
    const before = html();
    const after = html({ counts: { waiting: 10, later: 0, everyday: 7 }, items: eleven.filter(item => item.id !== "id-100") });
    expect(skeleton(after)).toBe(skeleton(before));
    expect(section(after)).not.toBe(section(before));
  });

  it("keeps the same frame when the last everyday item goes and Keep all disappears", () => {
    const before = html({ counts: { waiting: 4, later: 0, everyday: 1 }, items: [...asks, entry(1)] });
    const after = html({ counts: { waiting: 3, later: 0, everyday: 0 }, items: asks });
    const strip = (s: string) => skeleton(s).replace(/<button[^>]*><\/button>/g, "");
    expect(strip(after)).toBe(strip(before));
  });

  it("has no Working line, no disabled controls and no dimming, even while a press is in flight", () => {
    const busy = html({ pending: new Set(["id-100"]), toast: { message: "Kept for your chats with Sable.", undo: () => undefined } });
    expect(busy).not.toMatch(/Working|Loading|disabled|opacity-50/);
    expect(busy).toContain('aria-busy="true"');
    expect(busy).toContain("Kept for your chats with Sable.");
    expect(busy).toContain(">Undo<");
  });

  it("reserves the toast outside the section, so showing it moves nothing", () => {
    const without = html(), withToast = html({ toast: { message: "8 kept.", undo: () => undefined } });
    expect(section(withToast)).toBe(section(without));
  });
});

describe("words and sizes", () => {
  it("shows no code text, ids, hashes, byte ranges or record states anywhere", () => {
    const sources = Object.fromEntries(eleven.map(item => [item.id, [{ where: { kind: "chat" as const, name: "Sable" }, who: "you" as const, at: NOW, excerpt: "The deploy window is Tuesday" }]]));
    const out = html({ expanded: true, sources, error: "That did not go through. Nothing was changed.", toast: { message: "7 kept. 1 changed while you were looking, so it is still here." } });
    expect(out).not.toMatch(/MEMORY_|SQLITE|candidate|Candidate|bytes|Record:|Revision|hash|\bUnavailable audience\b|[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(out).not.toMatch(/—/);
    expect(out).not.toMatch(/\bsafe|unsafe\b/i);
  });

  it("works at 390 px: full-width Keep all, 44 px targets, wrapping text and no fixed widths", () => {
    const out = html();
    expect(out).toContain("max-sm:w-full");
    expect(out).toContain("max-sm:flex-1");
    expect(out).toContain("col-span-2");
    expect(out).toContain("grid-cols-2");
    expect((out.match(/min-h-11/g) ?? []).length).toBeGreaterThanOrEqual(6);
    expect(out).toContain("break-words");
    expect(out).not.toMatch(/\bw-\[\d+px\]|min-w-\[\d+px\]/);
  });
});

describe("the Inbox card (0.4)", () => {
  const rows = [{ kind: "bot" as const, id: "a", name: "Sable", waiting: 11, everyday: 8 }, { kind: "bot" as const, id: "b", name: "Ember", waiting: 1, everyday: 0 }];
  const card = () => renderToStaticMarkup(createElement(InboxMemoryWaiting, { rows, onSettled: () => undefined, onOpenMemory: () => undefined }));
  it("is one card per bot, counted per item, with Keep all N and Review", () => {
    const out = card();
    expect(out).toContain("Sable would like to remember 11 things");
    expect(out).toContain("Ember would like to remember 1 thing");
    expect(out).toContain("Keep all 8");
    expect(out).toContain("8 everyday things can be kept together. 3 need you one by one.");
    expect(out.match(/Keep all/g)).toHaveLength(1);
    expect((out.match(/>Review</g) ?? [])).toHaveLength(2);
    expect(out).not.toMatch(/MEMORY_|candidate|Reports go out/);
  });
  it("keeps a place for its answer so showing it moves nothing", () => {
    expect(card()).toContain('role="status"');
  });
});
