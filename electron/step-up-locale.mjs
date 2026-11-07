// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// STEPUP-LOCALES 1.0.18: the words of the Cloud step-up confirmation (cloud-step-up-label.mjs labels, the Touch ID
// reason and the Confirm dialog) in the app's 8 languages. The packs are plain JSON in electron/locales/step-up/
// (en.json is the source; every other pack carries every key, checked by cloud-step-up-locale.test.mjs and linted by
// src/locales/copy-final.test.ts). Packs are read lazily with fs (asar-aware), once each.
//
// Which language: the app's saved setting first (the `language` field the Settings picker writes: the Cloud home's
// own config, as its Cloud window shows it, else this desktop's config.json; "" follows the system), then the system
// language (Electron app.getLocale()), then English. Tags resolve exactly as the renderer does (src/lib/i18n.ts
// resolveLocale), so an unknown saved language reads in English. A missing key, an unreadable pack or a pack value that
// is not a usable string reads in English (built-in words back en.json), never as the raw key.
//
// Pure module apart from fs: no Electron import.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The app's languages (src/locales/index.ts localeChoices), English first. */
export const STEP_UP_LANGUAGES = Object.freeze(["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh"]);
const ALIASES = Object.freeze({ pt: "pt-br" });

const packFile = (code) => fileURLToPath(new URL(`./locales/step-up/${code}.json`, import.meta.url));

function readPack(code) {
  try {
    const parsed = JSON.parse(readFileSync(packFile(code), "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const cache = new Map();
/** A pack by code, read once ({} when it cannot be read). Tests may pass their own `read`. */
export function stepUpPack(code, read = readPack) {
  if (read !== readPack) return read(code);
  if (!cache.has(code)) cache.set(code, readPack(code));
  return cache.get(code);
}

/**
 * English words built into the code for every key that is not a route label, so the dialog title, the buttons and the
 * summary lines (which name the permissions being turned on) still read in English if en.json cannot be read or holds
 * a bad value. Route labels have the same guarantee from the label table itself (cloud-step-up-label.mjs).
 * cloud-step-up-locale.test.mjs checks these equal en.json.
 */
export const STEP_UP_BASELINE = Object.freeze({
  "label.fallback": "Make a change on your Cloud home",
  "flag.fullAccess": "Full access",
  "flag.noLimits": "No limits",
  "flag.fullAccessChannelMessages": "Full access for channel messages",
  "flag.fullAccessSetupRequests": "Full access for setup requests",
  "flag.autoApprove": "Auto-approve",
  "flag.localAuto": "Auto-approve on the host computer",
  "flag.permissionMode": "Permission mode \"{mode}\"",
  "flag.hostComputerBot": "A bot using the host computer",
  "flag.hostComputerConsent": "Host computer access",
  "flag.alwaysAllow": "An always-allow rule",
  "line.bot": "Bot: {bot}",
  "line.name": "Name: {name}",
  "line.deviceType": "Device type: {type}",
  "line.deviceKey": "Device key: {key}",
  "line.settings": "Settings: {names}",
  "line.turnsOn": "Turns on: {flags}",
  "line.unknown": "unknown",
  "line.program": "Program: {path}",
  "line.programRefused": "This can't be confirmed, so nothing was run. The program's location is missing, too long or has characters this window can't show exactly, such as Hebrew or Arabic letters. Run the check on the computer itself instead.",
  "dialog.title": "Confirm on your Cloud",
  "dialog.confirm": "Confirm",
  "dialog.cancel": "Cancel",
  "dialog.close": "Close",
});

/** Control characters and direction marks: a pack value holding one is not shown (it could cut or reorder native text). */
const UNSAFE_TEXT = /[\x00-\x1f\x7f-\x9f\p{Bidi_Control}]/u;
/** A pack value that may be shown: a non-empty string with no control character or direction mark. */
export const usableText = (value) => typeof value === "string" && value.trim().length > 0 && !UNSAFE_TEXT.test(value);

/** English as shown: the built-in words, then every usable en.json value over them. */
export function mergeEnglish(pack) {
  const merged = { ...STEP_UP_BASELINE };
  if (pack !== null && typeof pack === "object") for (const [key, value] of Object.entries(pack)) if (usableText(value)) merged[key] = value;
  return Object.freeze(merged);
}

/** The English pack: the source of every key. */
export const STEP_UP_EN = mergeEnglish(readPack("en"));

const AVAILABLE = new Set([...STEP_UP_LANGUAGES, ...Object.keys(ALIASES)]);
/**
 * The renderer's rule exactly (src/lib/i18n.ts resolveLocale): trim, lower case, "_" to "-", the whole tag if it is a
 * registered code, else its first part, else English. "pt" and "pt-PT" read as pt-br, "zh-Hans-CN" as zh,
 * "de.UTF-8" and a blank tag as English. Returns null for a missing tag.
 */
export function resolveStepUpLanguage(tag) {
  if (typeof tag !== "string" || !tag) return null;
  const lower = tag.trim().toLowerCase().replace(/_/g, "-");
  const code = AVAILABLE.has(lower) ? lower : AVAILABLE.has(lower.split("-")[0] ?? "") ? lower.split("-")[0] : "en";
  return Object.hasOwn(ALIASES, code) ? ALIASES[code] : code;
}

/**
 * The language a confirmation is written in, as the renderer picks it (src/App.tsx: setLocale(language ||
 * navigator.language)): `setting` is the saved app language ("" or absent = follow the system); `system` is the
 * system language. A saved language the app has no pack for reads in English.
 */
export function stepUpLanguage({ setting, system } = {}) {
  if (typeof setting === "string" && setting) return resolveStepUpLanguage(setting) ?? "en";
  return resolveStepUpLanguage(system) ?? "en";
}

const fill = (template, params) => template.replace(/\{(\w+)\}/g, (match, name) => (Object.hasOwn(params, name) ? String(params[name]) : match));

/**
 * A lookup for one language: t(key, params). A key the pack lacks (or holds as an empty, non-string or unsafe value)
 * reads in English; a key English lacks returns "" so a typo never reaches the screen as a raw key. Tests may pass
 * `read` (a pack reader) and `english` (an en.json as read, merged over the built-in words like the real one).
 */
export function stepUpText(language = "en", { read, english } = {}) {
  const code = resolveStepUpLanguage(language) ?? "en";
  const en = english === undefined ? STEP_UP_EN : mergeEnglish(english);
  const pack = code === "en" ? en : stepUpPack(code, read);
  return (key, params = {}) => {
    const own = Object.hasOwn(pack, key) ? pack[key] : undefined;
    const fallback = Object.hasOwn(en, key) ? en[key] : "";
    return fill(usableText(own) ? own : fallback, params);
  };
}

/**
 * The language of every security confirmation, Cloud homes included: THIS computer's saved app language (config.json),
 * then the system language, then English. Never the home's own setting, so a home cannot make the dialog unreadable
 * (MurageMain 2026-11-06). A Cloud window set to another language can therefore differ from its confirmations.
 */
export function desktopStepUpLanguage({ readDesktopConfig, system }) {
  return stepUpLanguage({ setting: savedAppLanguage(readDesktopConfig ?? (() => { throw new Error("no desktop config"); })), system });
}

/** The saved app language from a data directory's config.json, or undefined (missing, unreadable, not a string). */
export function savedAppLanguage(readConfigText) {
  try {
    const value = JSON.parse(readConfigText())?.language;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}
