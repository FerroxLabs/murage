// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { ANNOUNCE_GAP_MS, createAnnouncer, detailView, settingsDescription, stripView, type StripView } from "./memory-integrity-view";
import { setLocale } from "@/lib/i18n";
import { MemoryIntegrityStripView } from "@/components/MemoryIntegrityStrip";
import { MemoryStorageReclaimView, MemoryUpgradeDetailView, spaceLabel } from "@/components/MemoryUpgradeDetail";
import { sampleState, type UpgradeState } from "../../shared/upgrade-contract.mjs";
import { initialContext, reduce, type MachineContext, type MachineEvent } from "../../shared/upgrade-machine.mjs";

const BANNED = /\b(database|validate[ds]?|validation|verif\w*|integrity|repair\w*|fix\w*|corrupt\w*|broken|safe\w*|unsafe|safety)\b|—/i;
const L1 = "a".repeat(64);
let seq = 0;
/** A background reading; `over` replaces fields. */
const working = (over: Partial<UpgradeState> = {}): UpgradeState => sampleState({ launch: L1, seq: ++seq, stage: "background", phase: "references", overall: 0.42, step: { awakeElapsedMs: 0, unit: "none" }, eta: { stable: false }, ...over });
const feed = (events: MachineEvent[], ctx: MachineContext = initialContext("app")) => events.reduce((c, e) => reduce(c, e), ctx);
const reading = (at: number, state: UpgradeState): MachineEvent => ({ type: "READING", at, state: { ...state, seq: ++seq } });

describe("the strip in the app (words for the reducer's selection)", () => {
  it("says chat works, the percent and about how long, once the estimate is steady", () => {
    const eta = { eta: { stable: true as const, ms: 360_000 }, step: { awakeElapsedMs: 9000, unit: "none" as const } };
    let ctx = feed([reading(0, working(eta))]);
    expect(stripView(ctx)?.text).toBe("You can chat as usual. Checking earlier memory, 42%. Bots pick up their earlier replies again when this is done.");
    ctx = feed([reading(2000, working(eta))], ctx);
    const view = stripView(ctx)!;
    expect(view.text).toBe("You can chat as usual. Checking earlier memory, 42%, about 6 minutes left. Bots pick up their earlier replies again when this is done.");
    expect(view.role).toBe("status");
    expect(view.phaseLabel).toBe("Checking links");
  });

  it("UX-03: the launch-wide overall is the percent and never goes down", () => {
    const pct = (ctx: MachineContext, overall: number, at: number) => { const next = feed([reading(at, working({ overall }))], ctx); return [next, stripView(next)!.percent] as const;  };
    let ctx = feed([]); const seen: Array<number | null> = [];
    for (const [i, o] of [0.3, 0.2, 0.7].entries()) { const [next, p] = pct(ctx, o, i * 1000); ctx = next; seen.push(p); }
    expect(seen).toEqual([30, 30, 70]);
  });

  it("keeps the last view when a reading fails, and says finished only after the server said so, for a few seconds", () => {
    let ctx = feed([reading(0, working())]);
    const first = stripView(ctx);
    ctx = feed([{ type: "READ_FAILED", at: 1000 }], ctx);
    expect(stripView(ctx)?.text).toBe(first?.text);
    ctx = feed([reading(2000, working({ stage: "idle", phase: "none", complete: true, overall: 1 }))], ctx);
    expect(stripView(ctx)?.text).toBe("Earlier memory is checked. Everything is in place.");
    ctx = feed([{ type: "TICK", at: 2000 + 6001 }], ctx);
    expect(stripView(ctx)).toBeNull();
  });

  it("UX-04: an empty reading is not completion: the strip stays and nothing is claimed finished", () => {
    let ctx = feed([reading(0, working({ overall: 0.81 }))]);
    ctx = feed([reading(2000, working({ stage: "idle", phase: "none", complete: "unknown", overall: "unknown" }))], ctx);
    expect(stripView(ctx)?.kind).toBe("working");
    expect(stripView(ctx)?.percent).toBe(81);
  });

  it("UX-11 / r2-7: a counter appears for a counted phase from exact figures: messages walked, conversations put in order, sets converted", () => {
    const view = (state: Partial<UpgradeState>) => stripView(feed([reading(0, working(state))]))!;
    expect(view({ phase: "message-index", step: { awakeElapsedMs: 1, unit: "messages", done: 612_345, total: 1_234_567 } }).counter).toBe("612,000 of 1.2 million messages");
    expect(view({ phase: "lineage", step: { awakeElapsedMs: 1, unit: "conversations", done: 300, total: 4800 } }).counter).toBe("300 of 4,800 conversations");
    expect(view({ phase: "storage", step: { awakeElapsedMs: 1, unit: "sets", done: 5, total: 90 } }).counter).toBe("5 of 90 sets");
    expect(view({ phase: "references" }).counter).toBeNull();
    expect(view({ phase: "message-index", step: { awakeElapsedMs: 1, unit: "none" } }).phaseLabel).toBe("Getting messages ready to search");
    expect(view({ phase: "search-index" }).phaseLabel).toBe("Getting search ready");
  });

  it("says nothing when nothing ever ran", () => {
    expect(stripView(initialContext("app"))).toBeNull();
    expect(stripView(feed([reading(0, working({ stage: "idle", phase: "none", complete: true, overall: 1 }))]))).toBeNull();
  });

  it("UX-01 and UX-08: a hold is an alert in the app's own reviewed words that promise nothing about later recording; the key is never shown as prose", () => {
    const ctx = feed([reading(0, working({ held: true, holdKey: "SOMETHING_NEW", capture: "off", recall: "off" }))]);
    const view = stripView(ctx)!;
    expect(view.kind).toBe("hold");
    expect(view.role).toBe("alert");
    expect(view.text).toBe("Earlier memory is set aside for now. Your chats work as usual. New things are not added to memory while it is set aside.");
    expect(view.text).not.toMatch(/installation-recovery|export-damaged|INVALID_|SOMETHING_NEW|contact support|wait until|sorted|later/i);
  });

  it("UX-09: the spoken sentence changes at most every ten seconds, and a hold is spoken at once", () => {
    let clock = 0;
    const announcer = createAnnouncer(ANNOUNCE_GAP_MS, () => clock);
    let ctx = initialContext("app");
    const view = (percent: number) => { ctx = feed([reading(clock, working({ overall: percent / 100 }))], ctx); return stripView(ctx); };
    expect(announcer.offer(view(10))).toEqual({ text: expect.stringContaining("10%"), retryInMs: null });
    clock = 2000;
    const held = announcer.offer(view(12));
    expect(held.text).toContain("10%");
    expect(held.retryInMs).toBe(8000);
    clock = 9000;
    expect(announcer.offer(view(15)).text).toContain("10%");
    clock = 10_000;
    expect(announcer.offer(view(16)).text).toContain("16%");
    clock = 10_500;
    ctx = feed([reading(clock, working({ held: true, holdKey: "memoryStrip.hold", capture: "off", recall: "off", overall: 0.16 }))], ctx);
    const alert = announcer.offer(stripView(ctx));
    expect(alert.text).toContain("set aside");
    expect(alert.retryInMs).toBeNull();
    expect(announcer.offer(null)).toEqual({ text: "", retryInMs: null });
  });

  it("renders as a polite status (calm) or an assertive alert, and nothing for no view", () => {
    const calmView = stripView(feed([reading(0, working())]));
    const calm = renderToStaticMarkup(createElement(MemoryIntegrityStripView, { view: calmView }));
    expect(calm).toContain('role="status"');
    expect(calm).toContain("Checking earlier memory, 42%");
    // UX-09: the changing visible sentence is not itself the live region; a separate quiet line is
    expect(calm).toMatch(/<span aria-hidden="true">You can chat as usual[^<]*<\/span>/);
    expect(calm).toMatch(/<span class="sr-only" role="status" aria-live="polite">/);
    expect(renderToStaticMarkup(createElement(MemoryIntegrityStripView, { view: calmView, announced: "an earlier sentence" }))).toContain(">an earlier sentence<");
    const alert = renderToStaticMarkup(createElement(MemoryIntegrityStripView, { view: stripView(feed([reading(0, working({ held: true, holdKey: "memoryStrip.hold", capture: "off", recall: "off" }))])) }));
    expect(alert).toContain('role="alert"');
    expect(renderToStaticMarkup(createElement(MemoryIntegrityStripView, { view: null }))).toBe("");
  });

  it("the detail row names the step, how far and how long", () => {
    const html = renderToStaticMarkup(createElement(MemoryUpgradeDetailView, { view: detailView(feed([reading(0, working())])) }));
    expect(html).toContain("Checking links, 42% done.");
    expect(html).toContain("Earlier memory");
  });
});

describe("handing back disk space is the owner's choice", () => {
  const noop = () => undefined;
  it("offers the button with the size when the space can be handed back", () => {
    const html = renderToStaticMarkup(createElement(MemoryStorageReclaimView, { storage: { state: "reclaim-available", freeBytes: 14.2 * 1024 ** 3 }, running: false, failed: false, onReclaim: noop }));
    expect(html).toContain("Hand back 14.2 GB");
    expect(html).toContain("This takes a few minutes");
    expect(html).toContain("<button");
  });
  it("shows nothing while converting or idle, progress while running, the server's sentence when waiting for disk", () => {
    const view = (storage: Parameters<typeof MemoryStorageReclaimView>[0]["storage"], running = false) => renderToStaticMarkup(createElement(MemoryStorageReclaimView, { storage, running, failed: false, onReclaim: noop }));
    expect(view({ state: "idle" })).toBe("");
    expect(view({ state: "converting" })).toBe("");
    expect(view({ state: "reclaim-available", freeBytes: 1 }, true)).toContain("Handing back the space");
    const waiting = view({ state: "waiting-for-disk", message: "Free up some space." });
    expect(waiting).toContain("Murage needs more free disk space to hand back the space. Make some room, then try again.");
    expect(waiting).not.toContain("Free up some space.");
    expect(waiting).toContain("<button");
    expect(waiting).toContain("Try again");
  });
  it("UX-10: the retry button is wired to the retry action, and the offer button to the explicit request", () => {
    const calls: string[] = [];
    const tree = MemoryStorageReclaimView({ storage: { state: "waiting-for-disk" }, running: false, failed: false, onReclaim: () => calls.push("reclaim"), onRetry: () => calls.push("retry") }) as unknown as { props: { children: Array<{ type?: string; props?: { onClick?: () => void } } | false> } };
    const button = tree.props.children.find(child => child && typeof child === "object" && child.type === "button") as { props: { onClick: () => void } };
    button.props.onClick();
    expect(calls).toEqual(["retry"]);
  });
  it("rounds sizes up", () => { expect(spaceLabel(1)).toBe("1 MB"); expect(spaceLabel(1.31 * 1024 ** 3)).toBe("1.4 GB"); });
});

describe("words", () => {
  it("UX-01 / r2-1: the settings line matrix: a hold overrides every cached mode, unknown never claims capture, only a source that says capture is on does", () => {
    const heldCtx = feed([reading(0, working({ held: true, holdKey: "memoryStrip.hold", capture: "off", recall: "off" }))]);
    const heldText = "Earlier memory is set aside for now. Your chats work as usual. New things are not added to memory while it is set aside.";
    for (const mode of ["active", "capture", "paused", "off"]) expect(settingsDescription(heldCtx, { mode }), mode).toBe(heldText);
    const none = initialContext("app");
    expect(settingsDescription(none, { mode: "paused" })).toBe("Memory is paused. Your chats work as usual.");
    expect(settingsDescription(none, { mode: "active" })).toBe("Memory is on.");
    expect(settingsDescription(none, { mode: "paused", held: false, capture: "on", recall: "off" })).toBe("Memory is paused. Your chats work as usual, and new things are still noted.");
    expect(settingsDescription(none, { mode: "capture", held: false, capture: "on", recall: "off" })).toBe("Capture is on. Recall is off.");
    expect(settingsDescription(none, { mode: "active", held: false, capture: "on", recall: "on" })).toBe("Capture and recall are on.");
    expect(settingsDescription(none, { mode: "off", held: false, capture: "off", recall: "off" })).toBe("Memory is off. Capture and recall are off.");
    expect(settingsDescription(none, { mode: "active", held: true, capture: "off", recall: "off" })).toBe(heldText);
    for (const text of [heldText, settingsDescription(none, { mode: "paused" })]) expect(text).not.toMatch(/still noted|still captured|are noted|wait until|later/i);
  });

  it("UX-08: every sentence the strip, the detail and the settings line can produce passes the word ban in all eight languages, with no internal code", async () => {
    const codes = ["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh"];
    try {
      for (const code of codes) {
        await setLocale(code);
        const texts: string[] = [];
        const push = (view: StripView | null) => { if (view) texts.push(view.text, view.phaseLabel ?? "", view.left ?? "", view.counter ?? ""); };
        let at = 0;
        for (const phase of ["output-index", "references", "learning", "lineage", "storage", "message-index", "search-index"] as const) {
          for (const eta of [1, 6, 15]) {
            let ctx = initialContext("app");
            for (let i = 0; i < 4; i++) { at += 3000; ctx = reduce(ctx, reading(at, working({ phase, eta: { stable: true, ms: eta * 60_000 }, step: { awakeElapsedMs: 9000 + i * 3000, unit: "none" } }))); push(stripView(ctx)); push(detailView(ctx)); }
            ctx = reduce(ctx, { type: "MALFORMED", at: at + 120_000, reason: "malformed" }); push(stripView(ctx));
          }
        }
        for (const [phase, unit] of [["message-index", "messages"], ["lineage", "conversations"], ["storage", "sets"]] as const) push(stripView(feed([reading(0, working({ phase, step: { awakeElapsedMs: 1, unit, done: 5, total: 10 } }))])));
        push(stripView(feed([reading(0, working({ held: true, holdKey: "INVALID_MEMORY_LESSON_EVENT", capture: "off", recall: "off" }))])));
        push(stripView(feed([reading(0, working()), reading(1000, working({ stage: "idle", phase: "none", complete: true, overall: 1 }))])));
        for (const mode of ["off", "capture", "active", "paused"]) for (const held of [true, false, undefined]) for (const capture of ["on", "off", undefined]) texts.push(settingsDescription(initialContext("app"), { mode, held, capture, recall: capture }));
        for (const state of [{ state: "waiting-for-disk" as const, message: "server prose" }, { state: "reclaim-available" as const, freeBytes: 2 ** 30 }]) {
          texts.push(renderToStaticMarkup(createElement(MemoryStorageReclaimView, { storage: state, running: false, failed: true, onReclaim: () => undefined })).replace(/<[^>]+>/g, " "));
        }
        for (const text of texts) {
          expect(text, `${code}: ${text}`).not.toMatch(BANNED);
          expect(text, `${code}: ${text}`).not.toMatch(/MEMORY_|INVALID_|installation-recovery|export-damaged|output-index|server prose|composio/i);
        }
        expect(texts.filter(Boolean).length).toBeGreaterThan(20);
      }
    } finally { await setLocale("en"); }
  });

  it("the held sentence of every language promises no later recording", () => {
    const dir = fileURLToPath(new URL("../locales/", import.meta.url));
    const later = /\b(later|until|once|after|wait\w*|sorted)\b|稍后|之后|等到|待機|あとで|後で|aguard\w+|espera\w*|später|bis |warten|plus tard|attend\w*|jusqu|इंतज़ार|बाद में|luego|hasta|depois|até/i;
    for (const code of ["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh"]) {
      const pack = JSON.parse(readFileSync(`${dir}${code}.json`, "utf8")) as Record<string, string>;
      for (const key of ["memoryStrip.hold", "memoryStrip.mode.held"]) expect(pack[key], `${code}.${key}`).not.toMatch(later);
      expect(pack["memoryStrip.hold"]).toBe(pack["memoryStrip.mode.held"]);
    }
    const zh = JSON.parse(readFileSync(`${dir}zh.json`, "utf8")) as Record<string, string>;
    expect(zh["memoryStrip.hold"]).toBe("之前的记忆暂时被搁置。你的聊天照常使用。在此期间,新的内容不会加入记忆。");
  });

  it("no new string in any language uses a banned word or an em dash", () => {
    const dir = fileURLToPath(new URL("../locales/", import.meta.url));
    for (const code of ["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh"]) {
      const pack = JSON.parse(readFileSync(`${dir}${code}.json`, "utf8")) as Record<string, string>;
      for (const [key, value] of Object.entries(pack)) if (key.startsWith("memoryStrip.") || key.startsWith("memoryStorage.")) {
        expect(value, `${code}.${key}`).not.toMatch(/installation-recovery|export-damaged|INVALID_/);
        expect(value, `${code}.${key}`).not.toMatch(BANNED);
        expect(value, `${code}.${key}`).not.toMatch(/composio|\$|MEMORY_|output-index/i);
      }
    }
  });
  it("every language has every new key with the same placeholders", () => {
    const dir = fileURLToPath(new URL("../locales/", import.meta.url));
    const read = (code: string) => JSON.parse(readFileSync(`${dir}${code}.json`, "utf8")) as Record<string, string>;
    const en = read("en"), keys = Object.keys(en).filter(k => k.startsWith("memoryStrip.") || k.startsWith("memoryStorage."));
    const names = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
    for (const code of ["de", "es", "fr", "hi", "ja", "pt-br", "zh"]) {
      const pack = read(code);
      for (const key of keys) { expect(pack[key], `${code}.${key}`).toBeTruthy(); expect(names(pack[key]!)).toEqual(names(en[key]!)); }
    }
  });
});

describe("lanes/upgui-review r3", () => {
  it("r3-9: the shapes phase has reviewed words in every language, a phase label and a time-so-far line, and no banned word", async () => {
    const ctx = feed([reading(0, working({ phase: "shapes", overall: 0.5, step: { awakeElapsedMs: 9000, unit: "none" } }))]);
    const view = detailView(ctx)!;
    expect(view.phaseLabel).toBe("Checking details of earlier memory");
    expect(view.counter).toBeNull();
    expect(view.elapsed).toBe("9s so far.");
    const html = renderToStaticMarkup(createElement(MemoryUpgradeDetailView, { view }));
    expect(html).toContain("Checking details of earlier memory, 50% done.");
    expect(html).toContain("9s so far.");
    for (const code of ["de", "es", "fr", "hi", "ja", "pt-br", "zh", "en"]) {
      await setLocale(code);
      const v = detailView(ctx)!;
      expect(v.phaseLabel, code).toBeTruthy();
      expect(v.elapsed, code).toBeTruthy();
      expect(`${v.phaseLabel} ${v.elapsed}`, code).not.toMatch(BANNED);
    }
    await setLocale("en");
  });
});
