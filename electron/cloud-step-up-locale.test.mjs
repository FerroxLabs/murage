// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// STEPUP-LOCALES 1.0.18: the Cloud step-up confirmation (label, summary lines, Touch ID reason, Confirm dialog) in all
// 8 app languages. Every label resolves in every language, a missing key reads in English (never a raw key), the
// Touch ID reason stays inside REASON_MAX with the action never cut, and the names that carry the security meaning
// (products, providers) are kept in every translation; the level names read in the pack's own words, as in the app.
//
// Length source: Apple, LAContext evaluatePolicy(_:localizedReason:reply:) ("The app-provided reason ... displays in the
// authentication dialog"; "Make the message short and clear"; no maximum is documented), and Microsoft, TASKDIALOGCONFIG
// (pszWindowTitle, pszMainInstruction, pszContent: null-terminated strings, no maximum documented). Electron's
// systemPreferences.promptTouchID(reason) and dialog.showMessageBox docs also document no maximum. So REASON_MAX (200
// UTF-16 units) is this app's own ceiling, and the checks below hold every language to it, plus a short title and
// buttons. A character count does not prove the visual fit on every screen; it keeps every language inside one budget.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { resolveLocale } from "../src/lib/i18n.ts";
import { localeCodes } from "../src/locales/index.ts";
import { createNativeStepUpConfirm } from "./cloud-home-client.mjs";
import { FALLBACK_LABEL, REASON_MAX, SHOW_MAX, STEP_UP_LABELS, cutWhole, describeStepUp, stepUpLabelKey } from "./cloud-step-up-label.mjs";
import { STEP_UP_BASELINE, STEP_UP_EN, STEP_UP_LANGUAGES, desktopStepUpLanguage, resolveStepUpLanguage, savedAppLanguage, stepUpLanguage, stepUpPack, stepUpText, usableText } from "./step-up-locale.mjs";

// Reviewed by hand, independent of the packs: what the two buttons say in each language. A pack that swapped them,
// or put another word on Confirm, fails here.
const BUTTONS = {
  en: ["Confirm", "Cancel"], de: ["Bestätigen", "Abbrechen"], es: ["Confirmar", "Cancelar"], fr: ["Confirmer", "Annuler"],
  hi: ["पुष्टि करें", "रद्द करें"], ja: ["確認", "キャンセル"], "pt-br": ["Confirmar", "Cancelar"], zh: ["确认", "取消"],
};

const OTHERS = STEP_UP_LANGUAGES.filter((code) => code !== "en");
const packFile = (code) => new URL(`./locales/step-up/${code}.json`, import.meta.url);
const raw = (code) => JSON.parse(readFileSync(packFile(code), "utf8"));
const placeholders = (text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
/** git's blob id of en.json with LF line ends: each pack records the English it was translated from. */
const englishSourceId = () => {
  const text = readFileSync(packFile("en"), "utf8").replace(/\r\n/g, "\n");
  return createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0${text}`).digest("hex");
};
// Names that carry the meaning of a label and stay in English in every pack: products and providers. The level names
// (Full access, No limits) read in the pack's own words, the same words as the app (slik.levelFull, slik.levelNoLimits).
const KEPT_NAMES = ["Flux", "Claude Code", "Claude", "GitHub", "Grok", "Hermes", "Netlify", "ElevenLabs", "Voice Library", "Telegram", "Slack", "Discord", "WhatsApp", "Linux"];

describe("step-up packs", () => {
  it("every table label and the fallback has a key in en.json, and en.json has no label the table lacks", () => {
    const labels = [...STEP_UP_LABELS.map((entry) => entry.label), FALLBACK_LABEL];
    expect(labels.filter((label) => !stepUpLabelKey(label)), "add a label.* key to electron/locales/step-up/en.json").toEqual([]);
    const keys = new Set(labels.map(stepUpLabelKey));
    expect(Object.keys(STEP_UP_EN).filter((key) => key.startsWith("label.") && !keys.has(key))).toEqual([]);
    expect(new Set(Object.values(STEP_UP_EN)).size, "two keys with the same English would share a translation").toBe(Object.keys(STEP_UP_EN).length);
  });

  it.each(OTHERS)("%s carries every English key with the same placeholders, and no other key", (code) => {
    const pack = raw(code);
    const keys = Object.keys(pack).filter((key) => !key.startsWith("@"));
    expect(keys.sort()).toEqual(Object.keys(STEP_UP_EN).sort());
    for (const key of keys) {
      expect(typeof pack[key] === "string" && pack[key].trim().length > 0, `${code} ${key} is empty`).toBe(true);
      expect(placeholders(pack[key]), `${code} ${key}`).toBe(placeholders(STEP_UP_EN[key]));
    }
  });

  it("the built-in English words equal en.json, so English reads the same if en.json cannot be read", () => {
    const file = raw("en");
    for (const [key, value] of Object.entries(STEP_UP_BASELINE)) expect(file[key], key).toBe(value);
  });

  it.each(STEP_UP_LANGUAGES)("%s: every value is usable (no control character or direction mark that could cut or reorder native text)", (code) => {
    const pack = raw(code);
    expect(Object.entries(pack).filter(([key, value]) => !key.startsWith("@") && !usableText(value)).map(([key]) => key)).toEqual([]);
  });

  it.each(STEP_UP_LANGUAGES)("%s: Confirm and Cancel say what they do, in that order", (code) => {
    const t = stepUpText(code);
    expect([t("dialog.confirm"), t("dialog.cancel")]).toEqual(BUTTONS[code]);
  });

  it.each(OTHERS)("%s was translated from the current English (re-translate the changed keys, then update @source)", (code) => {
    expect(raw(code)["@source"]).toBe(englishSourceId());
  });

  it.each(OTHERS)("%s keeps the names that carry the meaning (modes, products, providers)", (code) => {
    const pack = raw(code);
    const lost = [];
    for (const [key, english] of Object.entries(STEP_UP_EN)) {
      for (const name of KEPT_NAMES) if (english.includes(name) && !pack[key].includes(name)) lost.push(`${key}: ${name}`);
    }
    expect(lost).toEqual([]);
  });
});

describe("every label resolves in all 8 languages", () => {
  const samples = STEP_UP_LABELS.map((entry) => entry.label);
  it.each(STEP_UP_LANGUAGES)("%s: every label is its pack's words, never a raw key", (code) => {
    const t = stepUpText(code);
    const pack = stepUpPack(code);
    for (const label of [...samples, FALLBACK_LABEL]) {
      const key = stepUpLabelKey(label);
      const shown = t(key);
      expect(shown).toBe(code === "en" ? label : pack[key]);
      expect(shown.startsWith("label.")).toBe(false);
    }
  });

  it.each(STEP_UP_LANGUAGES)("%s: a real request is described in the language, with the request line unchanged", (code) => {
    const t = stepUpText(code);
    const d = describeStepUp({ method: "PATCH", path: "/api/bots/ember-1?x=1", body: { color: "green", fullAccess: true }, botName: "Ember", language: code });
    expect(d.label).toBe(t("label.botSettings"));
    expect(d.lines).toEqual([t("line.bot", { bot: "Ember (ember-1)" }), t("line.settings", { names: "color" }), t("line.turnsOn", { flags: t("flag.fullAccess") })]);
    // the query is never shown, but its presence is marked
    expect(d.request).toBe("PATCH /api/bots/ember-1?...");
    expect(d.message.split("\n").at(-1)).toBe("PATCH /api/bots/ember-1?...");
    // Touch ID gets every line: what it turns on first, then the bot and the settings
    expect(d.reason).toBe(`${t("label.botSettings")} (${t("line.turnsOn", { flags: t("flag.fullAccess") })}; ${t("line.bot", { bot: "Ember (ember-1)" })}; ${t("line.settings", { names: "color" })})`);
    const unknown = describeStepUp({ method: "POST", path: "/api/brand-new", language: code });
    expect([unknown.known, unknown.label]).toEqual([false, t("label.fallback")]);
  });
});

describe("length: the Touch ID reason and the dialog fit every language", () => {
  const longName = "W".repeat(80);
  const longId = "x".repeat(60);
  it.each(STEP_UP_LANGUAGES)("%s: the reason is at most REASON_MAX and always starts with the whole label", (code) => {
    for (const entry of [...STEP_UP_LABELS, { label: FALLBACK_LABEL }]) {
      const label = stepUpText(code)(stepUpLabelKey(entry.label));
      expect(label.length, `${code} ${entry.label}`).toBeLessThanOrEqual(120);
    }
    const d = describeStepUp({ method: "DELETE", path: `/api/bots/${longId}`, botName: longName, language: code });
    expect(d.reason.length).toBeLessThanOrEqual(REASON_MAX);
    expect(d.reason.startsWith(`${d.label} (`)).toBe(true);
    expect(d.reason.endsWith(")")).toBe(true);
    const t = stepUpText(code);
    for (const key of ["dialog.title", "dialog.confirm", "dialog.cancel"]) expect(t(key).length, `${code} ${key}`).toBeLessThanOrEqual(40);
  });

  it("a cut never splits a letter with its marks or an emoji", () => {
    expect(cutWhole("कि".repeat(5), 3)).toBe("कि");
    expect(cutWhole("ab👍🏽", 4)).toBe("ab");
    expect(cutWhole("short", 200)).toBe("short");
  });

  it("the same holds without Intl.Segmenter", () => {
    const segmenter = Intl.Segmenter;
    try {
      Intl.Segmenter = undefined;
      const accent = `e${String.fromCodePoint(0x301)}`;
      expect(cutWhole(`ab${accent}`, 3)).toBe("ab");
      expect(cutWhole("ab😀", 3)).toBe("ab");
      expect(cutWhole(`a${String.fromCodePoint(0x1f469, 0x200d, 0x1f4bb)}`, 4)).toBe("a");
      // Astra r2: skin tones, flag pairs, tag-sequence flags and Indic conjuncts stay whole too.
      expect(cutWhole("ab👍🏽", 4)).toBe("ab");
      expect(cutWhole("ab👍🏽cd", 6)).toBe("ab👍🏽");
      expect(cutWhole("ab🇯🇵", 4)).toBe("ab");
      expect(cutWhole("ab🇯🇵🇫🇷", 6)).toBe("ab🇯🇵");
      const england = String.fromCodePoint(0x1f3f4, 0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, 0xe007f);
      expect(cutWhole(`a${england}`, 3)).toBe("a");
      expect(cutWhole("aक्ष", 3)).toBe("a");
      expect(cutWhole("aक्षb", 4)).toBe("aक्ष");
      for (const text of ["ab👍🏽", "ab🇯🇵🇫🇷", `a${england}`, "aक्ष"]) for (let max = 0; max <= text.length; max += 1) expect(cutWhole(text, max).isWellFormed()).toBe(true);
    } finally {
      Intl.Segmenter = segmenter;
    }
  });

  it("a name is shown whole up to SHOW_MAX; past it, it is cut on a whole grapheme and marked", () => {
    const whole = describeStepUp({ method: "DELETE", path: "/api/bots/b1", botName: `${"a".repeat(80)}😀` });
    expect(whole.lines[0]).toBe(`Bot: ${"a".repeat(80)}😀 (b1)`);
    const head = "a".repeat(SHOW_MAX - 4);
    for (const name of [`${head}😀bbbb`, `${head}e${String.fromCodePoint(0x301)}bbbb`]) {
      const d = describeStepUp({ method: "DELETE", path: "/api/bots/b1", botName: name, language: "hi" });
      expect(d.lines[0].isWellFormed()).toBe(true);
      expect(d.reason.isWellFormed()).toBe(true);
      expect(d.lines[0]).toBe(stepUpText("hi")("line.bot", { bot: `${head}... (b1)` }));
      expect(d.reasonComplete).toBe(false);
    }
  });

  it.each(STEP_UP_LANGUAGES)("%s: Touch ID names what is turned on before which bot", (code) => {
    const t = stepUpText(code);
    const d = describeStepUp({ method: "PATCH", path: "/api/bots/b1", body: { fullAccess: true, noLimits: true }, language: code });
    expect(d.reason).toBe(`${t("label.botSettings")} (${t("line.turnsOn", { flags: `${t("flag.fullAccess")}, ${t("flag.noLimits")}` })}; ${t("line.bot", { bot: "b1" })})`);
  });

  it("a long Touch ID detail is cut on a whole grapheme and marked, and the label is never cut", () => {
    const body = { fullAccess: true, noLimits: true, fullAccessChannelMessages: true, fullAccessSetupRequests: true, autoApprove: true, acknowledgeLocalAuto: true, permissionMode: "unlimited", computer: "local", hostComputerConsent: "allowed", alwaysAllow: [] };
    for (const code of STEP_UP_LANGUAGES) {
      const d = describeStepUp({ method: "PATCH", path: `/api/bots/${"x".repeat(40)}`, body, botName: "😀".repeat(30), language: code });
      expect(d.reason.length).toBeLessThanOrEqual(REASON_MAX);
      expect(d.reason.startsWith(`${d.label} (`)).toBe(true);
      expect(d.reason.isWellFormed()).toBe(true);
      // Astra r2: a cut reason has lost the bot or flags, so it must never be the only thing shown.
      expect(d.reasonComplete, code).toBe(!d.reason.endsWith("...)"));
      if (code === "en") expect(d.reasonComplete).toBe(false);
    }
  });

  it.each(STEP_UP_LANGUAGES)("%s: a reason that holds everything is complete", (code) => {
    const d = describeStepUp({ method: "PATCH", path: "/api/bots/b1", body: { fullAccess: true, noLimits: true }, language: code });
    expect(d.reasonComplete).toBe(true);
  });

  it("Touch ID is enough only when every line fits whole", () => {
    expect(describeStepUp({ method: "DELETE", path: "/api/bots/b1", botName: "N".repeat(SHOW_MAX + 1) }).reasonComplete).toBe(false);
    expect(describeStepUp({ method: "DELETE", path: "/api/bots/b1", botName: "N".repeat(REASON_MAX) }).reasonComplete).toBe(false);
    // A settings list over 8 always uses the dialog (rule 4), even when the line would fit; 8 may use Touch ID.
    const eight = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`k${i}`, 1]));
    const d8 = describeStepUp({ method: "PATCH", path: "/api/bots/b1", body: eight });
    expect(d8.reasonComplete).toBe(true);
    expect(d8.reason).toContain("k7");
    const nine = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, 1]));
    const d9 = describeStepUp({ method: "PATCH", path: "/api/bots/b1", body: nine });
    expect(d9.reason.length).toBeLessThan(REASON_MAX);
    expect(d9.reasonComplete).toBe(false);
    expect(d9.lines[1]).toBe(`Settings: ${Object.keys(nine).join(", ")}`);
    // A setting name over 40 is cut and marked, and Touch ID is not used (rule 4b); 40 is shown whole.
    expect(describeStepUp({ method: "PATCH", path: "/api/bots/b1", body: { ["s".repeat(40)]: 1 } }).reasonComplete).toBe(true);
    const long = describeStepUp({ method: "PATCH", path: "/api/bots/b1", body: { ["s".repeat(41)]: 1 } });
    expect(long.reasonComplete).toBe(false);
    expect(long.lines[1]).toBe(`Settings: ${"s".repeat(37)}...`);
    expect(describeStepUp({ method: "PATCH", path: "/api/bots/b1", body: { k1: 1 } }).reasonComplete).toBe(true);
  });

  it("pairing: Touch ID names the device type and its key, or the dialog is used", () => {
    const d = describeStepUp({ method: "POST", path: "/api/cloud/pairing", body: { scope: "desktop", publicKey: "PEM" } });
    expect(d.reasonComplete).toBe(true);
    expect(d.reason).toContain(d.lines[0]);
    expect(d.reason).toContain(d.lines[1]);
  });

  it("a request line too long to show is marked, never cut silently", () => {
    const d = describeStepUp({ method: "POST", path: `/api/${"p".repeat(200)}` });
    expect(d.request.endsWith("...")).toBe(true);
    expect(d.request.length).toBeLessThanOrEqual("POST ".length + 120 + 3);
  });

  it("Touch ID is skipped when the reason was cut: the Confirm dialog shows the bot, every flag and the request", async () => {
    const body = { fullAccess: true, noLimits: true, fullAccessChannelMessages: true, fullAccessSetupRequests: true, autoApprove: true, acknowledgeLocalAuto: true, permissionMode: "unlimited", computer: "local", hostComputerConsent: "allowed", alwaysAllow: [] };
    const systemPreferences = { canPromptTouchID: () => true, promptTouchID: vi.fn(async () => undefined) };
    const d = { showMessageBox: vi.fn(async () => ({ response: 1 })) };
    const confirm = createNativeStepUpConfirm({ systemPreferences, dialog: d, platform: "darwin", language: "en" });
    expect(await confirm({ homeId: "h1", method: "PATCH", path: `/api/bots/${"x".repeat(40)}`, body })).toBe(false);
    expect(systemPreferences.promptTouchID).not.toHaveBeenCalled();
    const options = d.showMessageBox.mock.calls[0].at(-1);
    expect(options.detail).toContain("x".repeat(40));
    for (const flag of ["Full access", "No limits", "Auto-approve"]) expect(options.detail).toContain(flag);
    expect(options.detail).toContain(`PATCH /api/bots/${"x".repeat(40)}`);
    expect(options.defaultId).toBe(1);
    expect(options.cancelId).toBe(1);
  });
});

describe("a missing key reads in English, never as a raw key", () => {
  it("a pack without a key, with an empty or a non-string value, falls back to the English words", () => {
    const read = () => ({ "label.botCreate": "", "label.botDelete": 7, "dialog.title": "Titel" });
    const t = stepUpText("de", { read });
    expect(t("label.botCreate")).toBe("Create a bot");
    expect(t("label.botDelete")).toBe("Delete a bot and its conversations");
    expect(t("label.memory")).toBe("Change memory");
    expect(t("dialog.title")).toBe("Titel");
    expect(t("label.noSuchKey")).toBe("");
  });

  it("if en.json cannot be read or holds bad values, the title, buttons and summary lines still read in English", () => {
    for (const english of [{}, { "dialog.confirm": 7, "dialog.cancel": "", "flag.noLimits": null, "line.turnsOn": "Turns\u0000on" }]) {
      const en = stepUpText("en", { english });
      expect([en("dialog.title"), en("dialog.confirm"), en("dialog.cancel")]).toEqual(["Confirm on your Cloud", "Confirm", "Cancel"]);
      expect(en("line.turnsOn", { flags: en("flag.noLimits") })).toBe("Turns on: No limits");
      const de = stepUpText("de", { read: () => ({}), english });
      expect(de("flag.fullAccess")).toBe("Full access");
    }
  });

  it("a pack value with a control character or a direction mark reads in English", () => {
    const zero = String.fromCharCode(0);
    const rlo = String.fromCharCode(0x202e);
    const t = stepUpText("de", { read: () => ({ "dialog.confirm": `Best${zero}ätigen`, "dialog.cancel": `${rlo}nehcurbbA` }) });
    expect([t("dialog.confirm"), t("dialog.cancel")]).toEqual(["Confirm", "Cancel"]);
  });

  it("an unreadable pack reads in English", () => {
    const t = stepUpText("fr", { read: () => ({}) });
    expect(t("dialog.confirm")).toBe("Confirm");
  });

  it("an unknown language reads in English", () => {
    expect(stepUpText("it")("dialog.cancel")).toBe("Cancel");
    expect(describeStepUp({ method: "POST", path: "/api/bots", language: "xx" }).label).toBe("Create a bot");
  });
});

describe("which language", () => {
  it("the saved app language comes first, then the system language, then English", () => {
    expect(stepUpLanguage({ setting: "de", system: "ja-JP" })).toBe("de");
    expect(stepUpLanguage({ setting: "", system: "ja-JP" })).toBe("ja");
    expect(stepUpLanguage({ setting: undefined, system: "pt_BR" })).toBe("pt-br");
    expect(stepUpLanguage({ setting: "", system: "zh-Hans-CN" })).toBe("zh");
    expect(stepUpLanguage({ setting: "  ", system: "zh-Hans-CN" })).toBe("en"); // as the renderer: "  " is a pick, and not a language
    expect(stepUpLanguage({ setting: "it", system: "de-DE" })).toBe("en"); // as the renderer: an unknown pick is English
    expect(stepUpLanguage({ system: "ko-KR" })).toBe("en");
    expect(stepUpLanguage()).toBe("en");
  });

  it("system tags map to the 8 codes", () => {
    expect(["de-AT", "es-419", "fr_CA", "hi-IN", "ja", "pt", "PT-PT", "zh-TW", "en-GB", "en_US"].map(resolveStepUpLanguage)).toEqual(["de", "es", "fr", "hi", "ja", "pt-br", "pt-br", "zh", "en", "en"]);
    expect([undefined, "", 42].map(resolveStepUpLanguage)).toEqual([null, null, null]);
  });

  it("every tag resolves exactly as the renderer resolves it (src/lib/i18n.ts resolveLocale)", () => {
    const tags = ["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh", "pt", "pt-PT", "pt_BR", "de-AT", "de.UTF-8", "de@euro", " de ", "  ", "C", "it", "zh-Hans-CN", "ZH_tw", "es-419", "hi_IN", "ja-JP", "fr-CA", "x"];
    const renderer = (tag) => { const code = resolveLocale(tag, localeCodes()); return code === "pt" ? "pt-br" : code; };
    expect(tags.map(resolveStepUpLanguage)).toEqual(tags.map(renderer));
    for (const tag of tags) expect(stepUpLanguage({ setting: tag, system: "ja" }), tag).toBe(renderer(tag || "ja"));
  });

  it("security confirmations use this computer's language: its saved language, then the system, then English", () => {
    expect(desktopStepUpLanguage({ readDesktopConfig: () => JSON.stringify({ language: "fr" }), system: "de-DE" })).toBe("fr");
    expect(desktopStepUpLanguage({ readDesktopConfig: () => JSON.stringify({ language: "" }), system: "de-DE" })).toBe("de");
    expect(desktopStepUpLanguage({ readDesktopConfig: () => "{}", system: "hi-IN" })).toBe("hi");
    expect(desktopStepUpLanguage({ readDesktopConfig: () => { throw new Error("no data dir"); }, system: "ja-JP" })).toBe("ja");
    expect(desktopStepUpLanguage({ readDesktopConfig: () => { throw new Error("no data dir"); }, system: undefined })).toBe("en");
  });

  it("main.mjs never takes the confirm's language from the home, and looks bot names up only through fetchHomeInfo", () => {
    const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
    const wiring = main.slice(main.indexOf("confirmStepUp: createNativeStepUpConfirm("), main.indexOf("cloudPreload:"));
    expect(wiring).toContain("language: () => desktopStepUpLanguage(");
    expect(wiring).toContain('fetchHomeInfo(homeId, "/api/bots?messages=0", { signal })');
    expect(wiring).not.toMatch(/client\?*\.fetch\(|\/api\/config/);
  });

  it("the saved language is read from config.json, and a missing or broken file is no setting", () => {
    expect(savedAppLanguage(() => JSON.stringify({ language: "fr" }))).toBe("fr");
    expect(savedAppLanguage(() => JSON.stringify({ language: 3 }))).toBeUndefined();
    expect(savedAppLanguage(() => "{broken")).toBeUndefined();
    expect(savedAppLanguage(() => { throw new Error("The packaged desktop does not own this installation"); })).toBeUndefined();
  });
});

describe("the native confirm in the app's language", () => {
  const dialog = (response = 0) => ({ showMessageBox: vi.fn(async () => ({ response })) });

  it.each(OTHERS)("%s: the dialog title, buttons, heading and lines are translated; the request line is not", async (code) => {
    const d = dialog(0);
    const t = stepUpText(code);
    const confirm = createNativeStepUpConfirm({ systemPreferences: {}, dialog: d, platform: "win32", language: () => code });
    expect(await confirm({ homeId: "h", method: "POST", path: "/api/cloud/pairing", body: { scope: "desktop", publicKey: "PEM" } })).toBe(true);
    const options = d.showMessageBox.mock.calls[0][0];
    expect([options.title, options.buttons, options.message]).toEqual([t("dialog.title"), [t("dialog.confirm"), t("dialog.cancel")], t("label.cloudPairing")]);
    expect(options.buttons).not.toEqual(["Confirm", "Cancel"]);
    expect(options.detail.split("\n")[0]).toBe(t("line.deviceType", { type: "desktop" }));
    expect(options.detail.endsWith("\n\nPOST /api/cloud/pairing")).toBe(true);
    expect([options.defaultId, options.cancelId]).toEqual([1, 1]);
  });

  it("Touch ID: the reason is in the language", async () => {
    const systemPreferences = { canPromptTouchID: () => true, promptTouchID: vi.fn(async () => undefined) };
    const confirm = createNativeStepUpConfirm({ systemPreferences, dialog: dialog(1), platform: "darwin", language: "ja" });
    await confirm({ homeId: "h", method: "DELETE", path: "/api/bots/ember-1" });
    const t = stepUpText("ja");
    expect(systemPreferences.promptTouchID).toHaveBeenCalledWith(`${t("label.botDelete")} (${t("line.bot", { bot: "ember-1" })})`);
  });

  it("the language is read again at each confirmation, so a change in Settings applies at once", async () => {
    const d = dialog(0);
    const language = vi.fn().mockReturnValueOnce("zh").mockReturnValueOnce("de");
    const confirm = createNativeStepUpConfirm({ systemPreferences: {}, dialog: d, platform: "linux", language });
    await confirm({ homeId: "h1", method: "DELETE", path: "/api/routines/r1" });
    await confirm({ homeId: "h1", method: "DELETE", path: "/api/routines/r1" });
    expect(d.showMessageBox.mock.calls.map((call) => call[0].buttons)).toEqual([BUTTONS.zh, BUTTONS.de]);
  });

  // A rejected promise must be consumed: vitest fails the run on any unhandled rejection.
  it("a language that is not shipped, or a promise, reads in English", async () => {
    for (const language of [() => "ko", () => Promise.resolve("ja"), () => Promise.reject(new Error("no")), () => 7]) {
      const d = dialog(0);
      await createNativeStepUpConfirm({ systemPreferences: {}, dialog: d, platform: "linux", language })({ homeId: "h", method: "DELETE", path: "/api/routines/r1" });
      expect(d.showMessageBox.mock.calls[0][0].buttons).toEqual(BUTTONS.en);
    }
    await new Promise((resolve) => setTimeout(resolve, 0)); // let any unhandled rejection surface inside this test
  });

  it("a slow bot-name lookup never holds the prompt past the deadline, and is aborted before it opens", async () => {
    vi.useFakeTimers();
    try {
      const d = dialog(1);
      let seen;
      const resolveBotName = vi.fn((homeId, botId, { signal }) => { seen = signal; return new Promise(() => {}); }); // ignores its signal
      const pending = createNativeStepUpConfirm({ systemPreferences: {}, dialog: d, platform: "linux", language: () => "fr", resolveBotName })({ homeId: "h", method: "DELETE", path: "/api/bots/b1" });
      await vi.advanceTimersByTimeAsync(1999);
      expect(d.showMessageBox).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toBe(false);
      expect(seen.aborted).toBe(true);
      const options = d.showMessageBox.mock.calls[0][0];
      expect(options.buttons).toEqual(BUTTONS.fr);
      expect(options.detail).toContain("b1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("an oversized bot name is ignored before it is cleaned or cut", async () => {
    const d = dialog(1);
    await createNativeStepUpConfirm({ systemPreferences: {}, dialog: d, platform: "linux", resolveBotName: async () => "N".repeat(257) })({ homeId: "h", method: "DELETE", path: "/api/bots/b1" });
    expect(d.showMessageBox.mock.calls[0][0].detail.split("\n")[0]).toBe("Bot: b1");
  });

  it("a language source that throws, or none, gives English and never blocks the confirm", async () => {
    const d = dialog(1);
    const confirm = createNativeStepUpConfirm({ systemPreferences: {}, dialog: d, platform: "linux", language: () => { throw new Error("no data dir"); } });
    expect(await confirm({ homeId: "h", method: "POST", path: "/api/routines/r1/run" })).toBe(false);
    expect(d.showMessageBox.mock.calls[0][0]).toMatchObject({ title: "Confirm on your Cloud", buttons: ["Confirm", "Cancel"], message: "Run a routine now" });
  });
});
