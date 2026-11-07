// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// L-COPY r3 (design section 5): the help panel's words follow the app's
// language and never show English Help in another language. Tests (b) to (i),
// the search over a language's Help pack, and the localized "What we send".
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import {
  canonicalCode, enHelp, ensureHelp, helpLoaders, helpStatus, hx, readyHelpPack, resetHelpCopyForTests, HELP_CODES,
  type HelpCode, type HelpPack,
} from "@/lib/help-copy-store";
import { searchHelpPack } from "@/lib/help-pack-search";
import { SCREENS, screenEntry } from "@/lib/screens-index";
import { buildFeedbackRequest, feedbackEnvelopeForPicked, feedbackEnvelopeForScreen, FEEDBACK_CHOICE_WORDS, resolveHelpScreen } from "@/lib/screen-envelope";
import { LazyBoundary, LAZY_RETRY_TEXT, PANEL_ERROR_TEXT, PANEL_ERROR_RETRY } from "@/components/LazyBoundary";
import { HelpFrame, HelpHost, helpBoundaryLabels } from "./HelpHost";
import { HelpPanel, HelpReady, helpSearchMode, visibleSearchState, type HelpPanelProps } from "./HelpPanel";
import { FeedbackForm, previewFields } from "./FeedbackForm";
import { modWord } from "./help-copy";
import { tokenize } from "../../../shared/help-tokenize";

const LOCALES = fileURLToPath(new URL("../../locales/", import.meta.url));
const readJson = (path: string) => JSON.parse(readFileSync(LOCALES + path, "utf8")) as Record<string, string>;
const mainPack = (code: string) => readJson(`${code}.json`);
const helpPack = (code: string) => readJson(`help/${code}.json`) as HelpPack;
const originalLoaders = { ...helpLoaders };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const spyAllLoaders = () => Object.fromEntries(HELP_CODES.map((code) => {
  const spy = vi.fn(() => Promise.resolve(helpPack(code)));
  helpLoaders[code] = spy;
  return [code, spy];
})) as Record<HelpCode, ReturnType<typeof vi.fn>>;

beforeEach(async () => {
  await setLocale("en");
  resetHelpCopyForTests();
});
afterEach(async () => {
  Object.assign(helpLoaders, originalLoaders);
  await setLocale("en");
  resetHelpCopyForTests();
  vi.restoreAllMocks();
});

const screen = resolveHelpScreen({ activeView: "today", connected: true });
const entry = screen.entry!;
const panelProps = (over: Partial<HelpPanelProps> = {}): HelpPanelProps => ({
  entry,
  params: { ...screen.params, mod: modWord(false) },
  title: hx(entry.title, screen.params),
  envelope: feedbackEnvelopeForScreen(screen),
  surface: "desktop",
  noEngine: false,
  onClose: vi.fn(),
  onOpenEngines: vi.fn(),
  onAskBot: vi.fn(),
  ...over,
});
/** The open panel behind its gate, as HelpOpen draws it (HelpOpen itself needs the app store). */
const renderGated = (over: Partial<HelpPanelProps> = {}) =>
  renderToStaticMarkup(createElement(HelpReady, { onClose: vi.fn(), children: createElement(HelpPanel, panelProps(over)) }));
const screenWords = (code: string) => {
  const pack = code === "en" ? enHelp : helpPack(code);
  return [entry.title, entry.intro, ...entry.tips, entry.why].map((key) => pack[key]!).filter((text) => !text.includes("{"));
};
const esc = (text: string) => renderToStaticMarkup(createElement("span", null, text)).slice(6, -7);

describe("the screen Help shows is the screen it speaks about", () => {
  it("route results never show while a language searches its own pack", () => {
    const done = { phase: "done", results: [{ id: "a", title: "English", heading: "", text: "English", where: "", url: "https://x" }] } as Parameters<typeof visibleSearchState>[1];
    expect(visibleSearchState("pack", done)).toEqual({ phase: "idle" });
    expect(visibleSearchState("pack", { phase: "failed" })).toEqual({ phase: "idle" });
    expect(visibleSearchState("route", done)).toBe(done);
    const panel = readFileSync(fileURLToPath(new URL("./HelpPanel.tsx", import.meta.url)), "utf8");
    const body = panel.slice(panel.indexOf("function HelpSearch("), panel.indexOf("// ── the panel"));
    expect(body.slice(body.lastIndexOf("  return (\n"))).not.toContain("state.phase");
  });

  it("a picked result gives Ask and feedback that screen, and nothing of the one behind it", () => {
    const picked = SCREENS.find((entry) => entry.key.startsWith("settings:"))!;
    const envelope = feedbackEnvelopeForPicked(picked);
    expect(envelope.screen).toBe(picked.key);
    expect(envelope.state.gates).toBeUndefined();
    expect(envelope).toEqual(feedbackEnvelopeForScreen({ key: picked.key, gates: [] }));
    const panel = readFileSync(fileURLToPath(new URL("./HelpPanel.tsx", import.meta.url)), "utf8");
    expect(panel).toContain("envelope={picked ? feedbackEnvelopeForPicked(picked) : envelope}");
    expect(panel).toContain("onAsk={(question) => onAskChief(question, title)}");
    expect(panel).toContain("askChiefAboutScreen(state.bots, screenTitle ?? title, question,");
  });
});

describe("Help copy follows the app's language (design section 5)", () => {
  it("(b) a language change with help closed loads no Help pack", async () => {
    const spies = spyAllLoaders();
    renderToStaticMarkup(createElement(HelpHost, { surface: "desktop", noEngines: false, enginesOff: false, firstRun: null }));
    await setLocale("de");
    await setLocale("fr");
    await setLocale("en");
    await flush();
    for (const code of HELP_CODES) expect(spies[code], code).not.toHaveBeenCalled();
  });

  it("(c) a de owner who opens help before its words arrive sees the de loading line, never English Help, then the de words", async () => {
    const load = deferred<HelpPack>();
    helpLoaders.de = vi.fn(() => load.promise);
    await setLocale("de");
    const before = renderGated();
    expect(before).toContain(esc(mainPack("de")["ux.l4a.panel.loading"]!));
    expect(before).toContain('role="status"');
    for (const text of screenWords("en")) expect(before, text).not.toContain(esc(text));
    expect(before).not.toContain("Opening help.");
    load.resolve(helpPack("de"));
    await flush();
    const after = renderGated();
    expect(after).toContain(esc(helpPack("de")[entry.intro]!));
    for (const text of screenWords("en")) if (!screenWords("de").includes(text)) expect(after, text).not.toContain(esc(text));
    expect(helpLoaders.de).toHaveBeenCalledOnce();
  });

  it("(d) a slow de load that finishes after a switch to fr writes nothing into fr, and fr shows fr", async () => {
    spyAllLoaders();
    const slowDe = deferred<HelpPack>();
    helpLoaders.de = vi.fn(() => slowDe.promise);
    await setLocale("de");
    ensureHelp("de");
    await setLocale("fr");
    ensureHelp("fr");
    await flush();
    expect(helpStatus("fr")).toBe("ready");
    const fr = helpPack("fr");
    expect(hx(entry.intro)).toBe(fr[entry.intro]);
    slowDe.resolve(helpPack("de"));
    await flush();
    expect(hx(entry.intro)).toBe(fr[entry.intro]);
    expect(readyHelpPack("fr")).toEqual(fr);
    expect(readyHelpPack("de")).toEqual(helpPack("de"));
  });

  it("(d) a load whose attempt is no longer current writes nothing", async () => {
    const stale = deferred<HelpPack>();
    helpLoaders.de = vi.fn(() => stale.promise);
    await setLocale("de");
    ensureHelp("de");
    resetHelpCopyForTests();
    const fresh = deferred<HelpPack>();
    helpLoaders.de = vi.fn(() => fresh.promise);
    ensureHelp("de");
    stale.resolve({ [entry.intro]: "STALE" });
    await flush();
    expect(helpStatus("de")).toBe("loading");
    expect(hx(entry.intro)).toBe(mainPack("de")["ux.l4a.panel.loading"]);
    fresh.resolve(helpPack("de"));
    await flush();
    expect(hx(entry.intro)).toBe(helpPack("de")[entry.intro]);
  });

  it("(e) a switch to English during a pending de load shows English Help at once", async () => {
    helpLoaders.de = vi.fn(() => deferred<HelpPack>().promise);
    await setLocale("de");
    ensureHelp("de");
    expect(hx(entry.intro)).toBe(mainPack("de")["ux.l4a.panel.loading"]);
    await setLocale("en");
    expect(hx(entry.intro)).toBe(enHelp[entry.intro]);
    expect(renderGated()).toContain(esc(enHelp[entry.intro]!));
  });

  it("(f) reopening help in a language already loaded shows it with no new load", async () => {
    const spies = spyAllLoaders();
    await setLocale("es");
    renderGated();
    await flush();
    const first = renderGated();
    const second = renderGated();
    expect(first).toContain(esc(helpPack("es")[entry.intro]!));
    expect(second).toBe(first);
    expect(spies.es).toHaveBeenCalledOnce();
  });

  it("(g) Portuguese reads help/pt-br.json", async () => {
    const spies = spyAllLoaders();
    await setLocale("pt");
    expect(canonicalCode("pt")).toBe("pt-br");
    renderGated();
    await flush();
    expect(spies["pt-br"]).toHaveBeenCalledOnce();
    expect(Object.hasOwn(helpLoaders, "pt")).toBe(false);
    expect(hx(entry.intro)).toBe(helpPack("pt-br")[entry.intro]);
  });

  it("(h) a failed load says so with Try again in the app's language, and Try again loads it", async () => {
    helpLoaders.de = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(helpPack("de"));
    await setLocale("de");
    renderGated();
    await flush();
    expect(helpStatus("de")).toBe("failed");
    const failed = renderGated();
    const de = mainPack("de");
    expect(failed).toContain(esc(de["ux.l4a.panel.loadFailed"]!));
    expect(failed).toContain(esc(de["ux.l4a.panel.retry"]!));
    expect(failed).toContain("data-help-failed");
    for (const text of screenWords("en")) expect(failed, text).not.toContain(esc(text));
    // opening help again keeps the failure on screen with its Try again (no fetch loop)...
    expect(renderGated()).toContain("data-help-failed");
    expect(helpLoaders.de).toHaveBeenCalledOnce();
    // ...and the button's handler (HelpPanel.tsx) asks again
    expect(readFileSync(fileURLToPath(new URL("./HelpPanel.tsx", import.meta.url)), "utf8")).toContain("onClick={() => ensureHelp(code)}");
    ensureHelp("de");
    expect(helpStatus("de")).toBe("loading");
    await flush();
    expect(helpStatus("de")).toBe("ready");
    expect(renderGated()).toContain(esc(helpPack("de")[entry.intro]!));
    expect(helpLoaders.de).toHaveBeenCalledTimes(2);
  });

  it("(i) the help chunk failing, or the panel throwing, says so in the app's language", async () => {
    await setLocale("de");
    const de = mainPack("de");
    const labels = helpBoundaryLabels();
    expect(labels).toEqual({ errorLabel: de["ux.l4a.panel.loadFailed"], retryLabel: de["ux.l4a.panel.retry"], closeLabel: de["ux.l4a.panel.close"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onClose = vi.fn();
    const make = () => new LazyBoundary({
      children: createElement("span", null, "panel"), inline: true, onRetry: vi.fn(), onDismiss: onClose, reload: vi.fn(),
      frame: (alert) => createElement(HelpFrame, { onClose, children: alert }), ...labels,
    });
    const chunk = make();
    chunk.state = { ...chunk.state, ...LazyBoundary.getDerivedStateFromError(new TypeError("Failed to fetch dynamically imported module: /assets/HelpPanel-x.js")) };
    const chunkHtml = renderToStaticMarkup(chunk.render() as ReactElement);
    expect(chunkHtml).toContain(esc(de["ux.l4a.panel.loadFailed"]!));
    expect(chunkHtml).toContain(esc(de["ux.l4a.panel.retry"]!));
    expect(chunkHtml).toContain(`aria-label="${esc(de["ux.l4a.panel.close"]!)}"`);
    expect(chunkHtml).not.toContain(esc(LAZY_RETRY_TEXT));
    const broken = make();
    broken.state = { ...broken.state, ...LazyBoundary.getDerivedStateFromError(new Error("render threw")) };
    const brokenHtml = renderToStaticMarkup(broken.render() as ReactElement);
    expect(brokenHtml).toContain(esc(de["ux.l4a.panel.loadFailed"]!));
    expect(brokenHtml).toContain(`>${esc(de["ux.l4a.panel.retry"]!)}<`);
    expect(brokenHtml).toContain(`>${esc(de["ux.l4a.panel.close"]!)}<`);
    expect(brokenHtml).not.toContain(esc(PANEL_ERROR_TEXT));
    expect(brokenHtml).not.toMatch(new RegExp(`>${PANEL_ERROR_RETRY}<|>Close<`));
    // ...and the always-loaded part never draws the global English lines in help (its labels go to the boundary)
    const host = readFileSync(fileURLToPath(new URL("./HelpHost.tsx", import.meta.url)), "utf8");
    expect(host).toContain("{...helpBoundaryLabels()}");
    expect(host).not.toMatch(/from "\.\/help-copy"|help-copy-store/);
  });

  it("the loading line and the frame's labels come from the main pack, in every language", async () => {
    for (const code of ["de", "ja", "hi"]) {
      helpLoaders[code as HelpCode] = vi.fn(() => deferred<HelpPack>().promise);
      await setLocale(code);
      const html = renderGated();
      const pack = mainPack(code);
      expect(html, code).toContain(esc(pack["ux.l4a.panel.loading"]!));
      expect(html, code).toContain(`aria-label="${esc(pack["ux.l4a.panel.close"]!)}"`);
    }
  });

  it("every catalogue in en-help/ is in English Help, and English Help is in no main pack", () => {
    const dir = LOCALES + "en-help/";
    const keys = readdirSync(dir).filter((name) => name.endsWith(".json")).flatMap((name) => Object.keys(readJson(`en-help/${name}`)));
    expect(keys.length).toBeGreaterThan(50);
    expect(keys.filter((key) => !Object.hasOwn(enHelp, key))).toEqual([]);
    expect(Object.keys(enHelp).length).toBe(keys.length);
  });

  it("the feedback request stays English in every language: titles from English Help", async () => {
    spyAllLoaders();
    await setLocale("de");
    ensureHelp("de");
    await flush();
    expect(feedbackEnvelopeForScreen(screen).title).toBe(enHelp[entry.title]);
  });
});

describe("search help in a language other than English (option C)", () => {
  const ready = async (code: string) => {
    spyAllLoaders();
    await setLocale(code);
    ensureHelp(code);
    await flush();
    expect(helpStatus(code)).toBe("ready");
  };
  // {mod} is filled with the language's own modifier word (main pack ux.l4a.mod.*), read after the switch.
  const params = { name: "Nova", get mod() { return modWord(false); } } as Record<string, string>;
  /** Every string a result may show in this language: the Help pack, filled from its own main pack, and the main pack. */
  const shownIn = (code: string) => {
    const pack = helpPack(code), main = mainPack(code);
    const fill = (text: string) => text.replace(/\{name\}/g, "Nova").replace(/\{mod\}/g, main["ux.l4a.mod.other"]!);
    return new Set([
      ...SCREENS.flatMap((item) => [item.title, item.intro, ...item.tips, item.why].map((key) => fill(pack[key]!))),
      ...Object.values(main),
    ]);
  };

  it("an open panel follows a language change: the modifier word and the pack search results", () => {
    const panel = readFileSync(fileURLToPath(new URL("./HelpPanel.tsx", import.meta.url)), "utf8");
    const body = panel.slice(panel.indexOf("function HelpOpenBody("));
    expect(body.indexOf("useHelpCopy();")).toBeGreaterThan(-1);
    expect(body.indexOf("useHelpCopy();")).toBeLessThan(body.indexOf("modWord("));
    expect(panel).toContain("searchHelpPack(words, hx, params) : []), [words, params, code])");
  });

  it("a de owner off the Mac reads the de modifier word in the tips (Strg K on Chats)", async () => {
    await ready("de");
    expect(modWord(false)).toBe(mainPack("de")["ux.l4a.mod.other"]);
    expect(modWord(false)).toBe("Strg");
    expect(modWord(true)).toBe(mainPack("de")["ux.l4a.mod.mac"]);
    const chats = resolveHelpScreen({ activeView: "all-chats", connected: true });
    const html = renderGated({ entry: chats.entry, params: { ...chats.params, mod: modWord(false) } });
    expect(html).toContain("Strg K");
    expect(html).not.toMatch(/\b(?:Ctrl|Cmd)\b/);
  });

  it("only English asks the docs route", () => {
    expect(helpSearchMode("en")).toBe("route");
    for (const code of ["de", "es", "fr", "hi", "ja", "pt", "pt-br", "zh"]) expect(helpSearchMode(code), code).toBe("pack");
  });

  it("a de search shows only de pack text and never calls the route", async () => {
    await ready("de");
    const de = helpPack("de");
    const word = tokenize(de[entry.intro]!).sort((a, b) => b.length - a.length)[0]!;
    const results = searchHelpPack(word, hx, params);
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(5);
    expect(results.map((result) => result.key)).toContain(entry.key);
    const allowed = shownIn("de");
    for (const result of results) {
      expect(allowed.has(result.title), result.title).toBe(true);
      expect(allowed.has(result.line), result.line).toBe(true);
    }
    const route = vi.fn(async () => []);
    const html = renderGated({ search: route, initialSearch: word });
    expect(html).toContain("data-help-pack-results");
    expect(html).toContain(esc(mainPack("de")["ux.l4a.panel.openScreenHelp"]!));
    for (const result of results) expect(html).toContain(esc(result.line));
    expect(html).not.toMatch(/href="https?:/);
    expect(route).not.toHaveBeenCalled();
  });

  it("a ja query finds the ja backups tip", async () => {
    await ready("ja");
    const results = searchHelpPack("バックアップ", hx, params);
    expect(results.map((result) => result.key)).toContain("settings:backups");
    const hit = results.find((result) => result.key === "settings:backups")!;
    expect(hit.title + hit.line).toContain("バックアップ");
  });

  it("a zh two-character query matches through its bigram", async () => {
    await ready("zh");
    const zh = helpPack("zh");
    const backups = screenEntry("settings:backups")!;
    // the title's two-character word that the fewest screens share
    const runs = zh[backups.title]!.match(/\p{scx=Han}{2,}/gu)!;
    const screenText = SCREENS.map((item) => [item.title, item.intro, ...item.tips, item.why].map((key) => zh[key]).join(" "));
    const pairs = runs.flatMap((run) => {
      const chars = [...run];
      return chars.slice(0, -1).map((char, at) => char + chars[at + 1]);
    });
    const query = pairs.sort((a, b) => screenText.filter((text) => text.includes(a)).length - screenText.filter((text) => text.includes(b)).length)[0]!;
    expect([...query]).toHaveLength(2);
    expect(tokenize(query)).toEqual([...query, query]);
    const results = searchHelpPack(query, hx, params);
    expect(results.map((result) => result.key)).toContain("settings:backups");
  });

  it("a hi word with matras is one token and finds the hi tip", async () => {
    await ready("hi");
    for (const word of ["याद", "टीम"]) {
      expect(tokenize(word)).toEqual([word]);
      const results = searchHelpPack(word, hx, params);
      expect(results.length, word).toBeGreaterThan(0);
      for (const result of results) expect(tokenize(`${result.title} ${result.line}`), word).toContain(word);
    }
  });

  it("no match shows the localized no-results line", async () => {
    await ready("fr");
    expect(searchHelpPack("zzqxwv", hx, params)).toEqual([]);
    const html = renderGated({ search: vi.fn(async () => []), initialSearch: "zzqxwv" });
    expect(html).toContain(esc(mainPack("fr")["ux.l4a.panel.noResults"]!));
  });
});

describe("What we send, in a language other than English", () => {
  it("de lists the fields in de, with no English Help title and no English choice sentence", async () => {
    spyAllLoaders();
    await setLocale("de");
    ensureHelp("de");
    await flush();
    const now = new Date("2026-11-06T12:00:00Z");
    const screens = [
      resolveHelpScreen({ activeView: "today", connected: false, noEngines: true }),
      resolveHelpScreen({ activeView: "chat", bot: { id: "b1", name: "Nova" }, connected: true }),
      resolveHelpScreen({ activeView: "all-chats", connected: true }),
      resolveHelpScreen({ activeView: "chat", settingsPage: "general" }),
    ];
    const de = new Set([...Object.values(mainPack("de")), ...Object.values(helpPack("de"))]);
    for (const shown of screens) {
      const envelope = feedbackEnvelopeForScreen(shown);
      const html = renderToStaticMarkup(createElement(FeedbackForm, {
        envelope, surface: "desktop", onCancel: vi.fn(), onAskBot: vi.fn(), initialChoice: "complicated", name: shown.params.name, now: () => now,
      }));
      expect(html).not.toContain("<pre data-feedback-preview");
      expect(html).toContain(esc(mainPack("de")["ux.l4a.feedback.previewEnglish"]!));
      expect(html).not.toContain(esc(FEEDBACK_CHOICE_WORDS.complicated));
      if (enHelp[screenEntry(envelope.screen)!.title] !== helpPack("de")[screenEntry(envelope.screen)!.title]) {
        expect(html).not.toContain(`>${esc(envelope.title)}<`);
      }
      const request = buildFeedbackRequest({ envelope, choice: "complicated", surface: "desktop", now });
      for (const field of previewFields(request, "complicated", shown.params.name)) {
        if (field.id === "createdAt") { expect(field.text).toBe(now.toLocaleString("de")); continue; }
        // every shown string is a de pack value, or one filled with the name the panel shows
        const filled = [...de].some((value) => value === field.text || (value.includes("{mod}") && value.replace("{mod}", modWord(false)) === field.text) || (value.includes("{name}") && value.replace("{name}", shown.params.name || "\u0000") === field.text)
          || (value.includes("{name}") && [mainPack("de")["ux.l4a.feedback.chatWord"], mainPack("de")["ux.l4a.feedback.groupWord"]].some((word) => value.replace("{name}", word!) === field.text)));
        expect(filled, `${shown.key} ${field.id}: ${field.text}`).toBe(true);
        expect(field.text).not.toMatch(/^[a-z][a-z0-9:-]*$/);
      }
      // the request itself is unchanged: English title, English sentence
      expect(request.title).toBe(envelope.title);
      expect(request.words).toBe(FEEDBACK_CHOICE_WORDS.complicated);
    }
  });

  it("English keeps the raw request", async () => {
    const envelope = feedbackEnvelopeForScreen(screen);
    const html = renderToStaticMarkup(createElement(FeedbackForm, { envelope, surface: "desktop", onCancel: vi.fn(), onAskBot: vi.fn(), initialChoice: "complicated" }));
    expect(html).toContain("<pre data-feedback-preview");
    expect(html).toContain(esc(FEEDBACK_CHOICE_WORDS.complicated));
  });
});
