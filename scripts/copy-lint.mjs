// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// L-COPY LINT r3 (Murage 1.0.18): the copy lint's engine, plain ESM so both the GATE test
// (src/locales/copy-final.test.ts) and the review CLI (scripts/copy-review.mjs) run the very same rules.
// Design: L-COPY-LINT-R3-1018.md, sections 1 to 4.
//
//   section 1: deterministic rules on normalise(value) for every string of en main, en Help, 7 main and 7 Help packs;
//   section 2: review records (copy-lint/reviews/<date>-<slug>-<h12>.json) and the ledger (copy-lint/reviewed.json);
//   section 3: completeness of both partitions in every pack;
//   section 4: the pinned lint files (same-as-english.json, links.json, reviewers.json, english-only.json).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  LOCALES_DIR,
  PACK_CODES,
  duplicateKeys,
  exactHash,
  levelFold,
  normalise,
  readPack,
  readPartitions,
} from "./locale-partitions.mjs";

/**
 * Review ledger presence: every shipped string and pinned file needs a valid ledger entry, except the ids listed in
 * copy-lint/pending-review.json at their exact listed hash.
 */
export const LEDGER_REQUIRED = true;

/** The only keys pending-review.json may list, in any language. Its list must be empty at the release cut. */
export const PENDING_KEYS = Object.freeze([
  "ux.l1.confirm.unlimitedBody",
  "ux.l1.level.unlimitedDetail",
  "ux.lcopyb.level.unlimited",
  "ux.lcopyb.level.unlimitedHere",
]);

export const LANGS = Object.freeze(["en", ...PACK_CODES]);
export const COPY_LINT_DIR = "copy-lint";
export const REVIEWS_DIR = "reviews";
export const LEDGER_FILE = "reviewed.json";
/** Lint files pinned in the ledger under `files`, each by a record that holds its full text (section 4). */
export const PENDING_FILE = "pending-review.json";
export const PINNED_FILES = Object.freeze(["links.json", "same-as-english.json", "reviewers.json", "english-only.json", PENDING_FILE]);

// ---------------------------------------------------------------------------------------------------------------
// Loading

/**
 * The third source: the main-process catalogues of the Cloud step-up confirmation (Touch ID reason, Confirm dialog),
 * electron/locales/step-up/<code>.json next to src/locales. Keys starting with "@" are metadata (the English source
 * hash), not copy. A locales folder with no step-up catalogues beside it (a fixture) has none.
 */
export const STEP_UP_PREFIX = "stepup/";
function readStepUp(dir, problems) {
  const folder = join(dir, "..", "..", "electron", "locales", "step-up");
  const read = (code) => {
    const path = join(folder, `${code}.json`);
    if (!existsSync(path)) { problems.push(`electron/locales/step-up/${code}.json: missing`); return {}; }
    const text = readFileSync(path, "utf8");
    for (const key of duplicateKeys(text)) problems.push(`electron/locales/step-up/${code}.json: ${key}: listed twice`);
    return Object.fromEntries(Object.entries(JSON.parse(text)).filter(([key]) => !key.startsWith("@")));
  };
  if (!existsSync(join(folder, "en.json"))) return { source: {}, packs: Object.fromEntries(PACK_CODES.map((code) => [code, {}])) };
  return { source: read("en"), packs: Object.fromEntries(PACK_CODES.map((code) => [code, read(code)])) };
}

/**
 * Every shipped string: en main, en Help, each main pack and each Help pack (id = "<locale>:<key>"), and the step-up
 * catalogues (id = "stepup/<locale>:<key>").
 */
export function loadCopy(dir = LOCALES_DIR) {
  const { main, help, problems } = readPartitions(dir);
  const packs = {};
  const helpPacks = {};
  for (const code of PACK_CODES) {
    packs[code] = readPack(dir, "main", code, problems);
    helpPacks[code] = readPack(dir, "help", code, problems);
  }
  const { source: stepUp, packs: stepUpPacks } = readStepUp(dir, problems);
  for (const key of Object.keys(stepUp)) if (Object.hasOwn(main, key) || Object.hasOwn(help, key)) problems.push(`electron/locales/step-up/en.json: ${key}: also an app key`);
  const english = { ...main, ...help, ...stepUp };
  const entries = [];
  const add = (locale, partition, catalogue) => {
    for (const [key, value] of Object.entries(catalogue)) {
      if (typeof value === "string") entries.push({ id: `${locale}:${key}`, locale, partition, key, value });
    }
  };
  add("en", "main", main);
  add("en", "help", help);
  for (const code of PACK_CODES) {
    add(code, "main", packs[code]);
    add(code, "help", helpPacks[code]);
  }
  const addStepUp = (locale, catalogue) => {
    for (const [key, value] of Object.entries(catalogue)) {
      if (typeof value === "string") entries.push({ id: `${STEP_UP_PREFIX}${locale}:${key}`, locale, partition: "stepup", key, value });
    }
  };
  addStepUp("en", stepUp);
  for (const code of PACK_CODES) addStepUp(code, stepUpPacks[code]);
  return { main, help, stepUp, english, packs, helpPacks, stepUpPacks, entries, problems };
}

export function readLintFile(dir, name) {
  const path = join(dir, COPY_LINT_DIR, name);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Section 1: deterministic rules

/** Token grammar for links and domains (section 1), applied in order on the normalised text. */
const SCHEME_URL = /[a-z][a-z0-9+.-]*:\/\/[^\s]*/gi;
const PROTOCOL_RELATIVE = /(?<![:\w])\/\/[^\s/]+/g;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
/** Exactly four parts: a fifth part ("9.007.199.254.740.991", a grouped number) is not an address. */
const IPV4 = /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?!\.?\d)\S*/g;
const HOST = /(?<![\p{L}\p{N}@.-])[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+(?:\/\S*)?/gu;
export const FILE_EXTENSIONS = new Set(
  "md json ts tsx js mjs cjs txt csv log pdf png jpg jpeg gif svg zip yaml yml toml env ps1 exe dmg msi pem key html css".split(" "),
);

/** Link tokens in a string: { kind, token (as found), lower, outright (fails whatever links.json says) }. */
export function linkTokens(value) {
  const text = normalise(value);
  const taken = [];
  const found = [];
  const overlaps = (start, end) => taken.some(([s, e]) => start < e && end > s);
  const take = (kind, regex, accept = () => true) => {
    for (const match of text.matchAll(regex)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (overlaps(start, end) || !accept(match[0])) continue;
      taken.push([start, end]);
      found.push({ kind, token: match[0], lower: match[0].toLowerCase(), start, outright: outrightReason(kind, match[0]) });
    }
  };
  take("url", SCHEME_URL);
  take("protocol-relative", PROTOCOL_RELATIVE);
  take("email", EMAIL);
  take("ipv4", IPV4);
  take("host", HOST, (token) => {
    const labels = token.split("/")[0].split(".");
    const last = labels.at(-1) ?? "";
    if (!/^\p{L}{2,}$/u.test(last)) return false;
    if (labels.length === 2 && FILE_EXTENSIONS.has(last.toLowerCase())) return false;
    return true;
  });
  return found.sort((a, b) => a.start - b.start);
}

function outrightReason(kind, token) {
  if (kind === "protocol-relative") return "a protocol-relative address";
  if (token.includes("\\")) return "a backslash in an address";
  if (kind === "url") {
    try {
      const url = new URL(token);
      if (url.username || url.password) return "userinfo in an address";
    } catch {
      // An unparsable placeholder ("https://") is not outright; links.json must still name it.
    }
  }
  return undefined;
}

/** Purchase cues per language: top up, buy, renew, upgrade, subscribe, pay, recharge. */
export const PURCHASE_CUES = {
  en: /\b(?:top[ -]?up|top[ -]?ups|buy|buying|purchas\w*|renew\w*|upgrad\w*|subscrib\w*|pay|paying|payment\w*|recharg\w*)\b/i,
  de: /aufladen|aufgeladen|\blad(?:e|en|t)\b[^.!?]*\bauf\b|\bkauf\w*|erneuer\w*|verlänger\w*|upgrade\w*|abonnier\w*|\babo\b|bezahl\w*|\bzahl(?:en|ung)\b/i,
  es: /recarg\w*|\bcompr(?:a|as|ar|e|es|o|ado|ada)\b|\bcómpr\w*|renov\w*|mejora el plan|suscr[ií]\w*|\bpag(?:ar|a|o|ue)\b/i,
  fr: /recharg\w*|ach[eè]t\w*|\bachat\w*|renouvel\w*|abonn\w*|\bpay(?:er|e|ez)\b|paiement/i,
  hi: /रिचार्ज|टॉप अप|टॉप-अप|ख़रीद|खरीद|नवीनीकरण|रिन्यू|अपग्रेड|सदस्यता|भुगतान/,
  ja: /チャージ|購入|買う|買い|アップグレード|サブスク|購読|支払|課金|更新料|契約を更新/,
  "pt-br": /recarreg\w*|recarga|\bcompr(?:a|as|ar|e|ou|ado|ada)\b|renov\w*|upgrade|\bassin(?:ar|e|atura|aturas|ou)\b|\bpag(?:ar|ue|amento)\b/i,
  zh: /充值|购买|续费|续订|升级|订阅|支付|付款/,
};

const VERSION_CUE = /(?:murage|fuigo|flux|sable|version|versión|versão|संस्करण|バージョン|版本|(?<![\p{L}\p{N}])v)\s*[:-]?\s*$/iu;
const THOUSANDS = /^\d{1,3}(?:\.\d{3})+$/;
const THOUSANDS_LOCALES = new Set(["de", "es", "fr", "pt-br", "hi"]);

/** Four-or-more-part numbers that fail: after a cue always; without one unless a listed IPv4 or grouped thousands. */
export function versionHits(value, locale, listedTokens = new Set()) {
  const text = normalise(value);
  const hits = [];
  for (const match of text.matchAll(/(?<![\d.])\d+(?:\.\d+)+/g)) {
    const number = match[0];
    if (number.split(".").length < 4) continue;
    const before = text.slice(0, match.index ?? 0);
    if (VERSION_CUE.test(before)) { hits.push(number); continue; }
    const ipv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(number)
      && [...listedTokens].some((token) => token === number || token.startsWith(`${number}:`) || token.startsWith(`${number}/`));
    if (ipv4) continue;
    if (THOUSANDS_LOCALES.has(locale) && THOUSANDS.test(number)) continue;
    hits.push(number);
  }
  return hits;
}

// Price words per language. English "free" keeps its other senses (free disk space, a free slot, free up, feel free,
// jargon-free) but the -free compounds of cost are prices.
const COST_FREE = /\b(?:cost|charge|fee|price|payment)-free\b/i;
const FREE_SENSES = /\bfree (?:disk )?space\b|\bfree slots?\b|\bfree up\b|\bfeel free\b|\b\w+-free\b/gi;
export const PRICE_WORDS = {
  en: /\bfree\b|\bno (?:extra )?charge\b|\bat no (?:extra )?cost\b|\bcosts? nothing\b|\bwithout (?:any )?(?:cost|charge)\b|\bfree of charge\b/i,
  de: /kostenlos|kostenfrei|gebührenfrei|gratis|umsonst|ohne (?:zusätzliche )?kosten/i,
  es: /gratis|gratuit[oa]s?|gratuitamente|sin (?:coste|costo|cargo)/i,
  fr: /gratuit(?:e|s|es|ement)?|gratis|sans frais/i,
  hi: /मुफ़्त|मुफ्त|निःशुल्क|नि:शुल्क|निशुल्क/,
  ja: /無料|タダ|無償/,
  "pt-br": /grátis|gratuit[oa]s?|gratuitamente|gratis|sem (?:custo|cobrança)/i,
  zh: /免费|无偿|不收费/,
};
function priceHit(value, locale) {
  if (locale === "en") return COST_FREE.test(value) || PRICE_WORDS.en.test(value.replace(FREE_SENSES, " "));
  return (PRICE_WORDS[locale] ?? PRICE_WORDS.en).test(value);
}

// A fix worded as breakage: English words, and per language a problem word together with a done-fix word.
// "X is fixed" reports a fix; "until this is fixed" or "once it is fixed" is a condition, not a report.
const BREAKAGE_EN = /\b(?:bugs?|buggy|broken|broke|glitch\w*|crash(?:ed|es|ing)?|no longer (?:crash|fail|break|hang|freez)\w*|(?:was|were|has been|have been|is now|are now) fixed|(?<!\b(?:until|once|when|after|before|unless|if) (?:\w+ ){0,3})(?:is|are) fixed|we fixed|fixed (?:an? |the )?(?:\w+ ){0,3}(?:crash|freeze|hang|bug|glitch|failure|error|problem|issue)s?)\b/i;
export const BREAKAGE = {
  de: [/Absturz|Abstürze|\bBugs?\b|Fehler|Hänger|Einfrieren|Problem/i, /behoben|repariert|beseitigt/i],
  es: [/fallos?|cierres? inesperados?|errores?|\bbugs?\b|bloqueos?|cuelgues?|problemas?/i, /corregid[oa]s?|arreglad[oa]s?|solucionad[oa]s?|reparad[oa]s?/i],
  fr: [/plantages?|\bbugs?\b|bogues?|erreurs?|blocages?|problèmes?/i, /corrigée?s?|réparée?s?|résolue?s?/i],
  hi: [/क्रैश|बग|गड़बड़ी|ख़राबी|खराबी|समस्या|दिक्कत/, /ठीक कर दिया|ठीक किया गया|ठीक कर दी|ठीक हो गया|ठीक हो गई|सुधार दिया|सुधारा गया/],
  ja: [/クラッシュ|バグ|不具合|フリーズ|問題/, /修正しました|修正済み|直しました|直りました|解消しました/],
  "pt-br": [/falhas?|travamentos?|\bbugs?\b|erros?|problemas?/i, /corrigid[oa]s?|consertad[oa]s?|resolvid[oa]s?/i],
  // "修复" alone is an instruction ("fix it in one step"); only the done forms report a fix.
  zh: [/崩溃|错误|故障|漏洞|闪退|卡死|问题|\bbug\b/i, /已修复|修复了|已修正|已解决|修好了/],
};
function breakageHit(value, locale) {
  if (locale === "en") return BREAKAGE_EN.test(value);
  const pair = BREAKAGE[locale];
  return Boolean(pair && pair[0].test(value) && pair[1].test(value));
}

// Engines by display name, the longest first so "Claude Code" and "Flux Router" are one mention.
const ENGINES = /(?<![\w-])(Flux Router|Claude Code|Fuigo|Flux|Claude|Codex|Gemini|Grok|Copilot|OpenCode|Kimi|Antigravity|ChatGPT|Ollama|Cursor|Qwen)(?![\w-])/g;
const OURS = new Set(["Fuigo", "Flux", "Flux Router"]);
const LIST_GAP = 8;
/** Joiners between two engine names in one list: , 、 ， ; ； • / & + · and the and/or words (newline is folded). */
const LIST_JOINER = /^\s*[,、，;；•/&+·]?\s*(?:and|or|und|oder|y|o|e|u|et|ou|और|या|と|や|または|和|或|及)?\s*$/i;

/** True when, in every list of two or more engines, every Fuigo or Flux comes before every other engine. */
export function enginesLead(value) {
  const text = normalise(value);
  const mentions = [...text.matchAll(ENGINES)].map((m) => ({ name: m[1], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
  let group = [];
  const groups = [];
  for (const mention of mentions) {
    const last = group.at(-1);
    const gap = last ? text.slice(last.end, mention.start) : "";
    if (last && gap.length <= LIST_GAP && LIST_JOINER.test(gap)) group.push(mention);
    else { if (group.length) groups.push(group); group = [mention]; }
  }
  if (group.length) groups.push(group);
  return groups.every((g) => {
    const firstOther = g.findIndex((m) => !OURS.has(m.name));
    return firstOther < 0 || g.slice(firstOther).every((m) => !OURS.has(m.name));
  });
}

const LEVEL_NAMES = /(?<![a-z-])(?:ask|auto|full access|no limits)(?![a-z-])/;
/** An English level name in a translated string: Cf stripped, lookalikes folded, casefolded; CJK does not protect. */
export function levelNameHit(value, locale) {
  if (locale === "en") return false;
  return LEVEL_NAMES.test(levelFold(value).replace(/\{\w+\}/g, " "));
}

/** Names that read the same in every language; with placeholders, numbers and punctuation they never need words. */
const SAME_EVERYWHERE = /\{\w+\}|\b(?:Murage(?: Desktop)?|Fuigo|Flux(?: Router)?|Sable|Claude(?: Code)?|Codex|Gemini|Grok|ChatGPT|Copilot|OpenCode|Ollama|Telegram|WhatsApp|Slack|Discord|GitHub|Gmail|Google|Netlify|X-API-Key|Authorization|Bearer|OK|AI|https?|v)\b|[\p{N}\p{P}\p{S}\s]/gu;
export function needsWords(value) {
  return /\p{L}/u.test(String(value).replace(SAME_EVERYWHERE, ""));
}

/** A pack string that is the English copied: equal after normalise, and the English has words to translate. */
export function copiedEnglish(value, english) {
  return english !== undefined && normalise(value) === normalise(english) && needsWords(english);
}

/**
 * The rule ids a string trips. ctx: { english, links (that string's links.json entries), sameOk (on same-as-english) }.
 * The links rule returns "link" for an unlisted or outright token and "purchase-link" for any domain next to a cue.
 */
export function ruleIds(entry, ctx = {}) {
  const { locale, value } = entry;
  const text = normalise(value);
  const ids = [];
  if (/—|\s–\s/u.test(text)) ids.push("em-dash");
  if (/(?<![a-z])forge(?![a-z])/i.test(text)) ids.push("forge");
  if (levelNameHit(value, locale)) ids.push("english-level-name");
  const listed = new Set((ctx.links ?? []).map((link) => link.token));
  const tokens = linkTokens(value);
  if (tokens.some((t) => t.outright || !listed.has(t.lower))) ids.push("link");
  if (tokens.length > 0 && (PURCHASE_CUES[locale] ?? PURCHASE_CUES.en).test(text)) ids.push("purchase-link");
  if (versionHits(value, locale, new Set(tokens.filter((t) => t.kind === "ipv4" && listed.has(t.lower)).map((t) => t.lower))).length) ids.push("four-part-version");
  if (locale !== "en" && !ctx.sameOk && copiedEnglish(value, ctx.english)) ids.push("copied-english");
  if (priceHit(text, locale)) ids.push("price");
  if (locale === "en" && /\b(?:un)?saf(?:e|ely|ety)\b/i.test(text)) ids.push("safe");
  if (breakageHit(text, locale)) ids.push("breakage");
  if (!enginesLead(value)) ids.push("engine-lead");
  return ids;
}

export const RULE_NAMES = {
  "em-dash": "an em dash or spaced en dash",
  forge: "the word Forge",
  "english-level-name": "an English level name in a translated string",
  link: "a link or domain not listed for this string in copy-lint/links.json",
  "purchase-link": "a domain next to a purchase cue (never allowed)",
  "four-part-version": "a four-part version",
  "copied-english": "the English copied unchanged",
  price: "free in the price sense",
  safe: "safe, safely, safety or unsafe",
  breakage: "a fix worded as breakage",
  "engine-lead": "a list of engines where Fuigo or Flux does not lead",
};

/** Section 1 over every shipped string, with the pinned links and same-as-english lists. */
export function ruleFindings(copy, { links = {}, same = {} } = {}) {
  const found = [];
  for (const entry of copy.entries) {
    const ids = ruleIds(entry, {
      english: copy.english[entry.key],
      links: links[entry.id],
      sameOk: Object.hasOwn(same, entry.id),
    });
    for (const id of ids) found.push(`${entry.id}: ${id}: ${RULE_NAMES[id]}: ${entry.value.slice(0, 120)}`);
  }
  return found;
}

/** links.json problems: shape, unknown locale:key, an entry that matches no token of its string (stale). */
export function linksProblems(links, copy) {
  const problems = [];
  if (!links || typeof links !== "object" || Array.isArray(links)) return ["links.json: must be an object"];
  const byId = new Map(copy.entries.map((entry) => [entry.id, entry]));
  for (const [id, list] of Object.entries(links)) {
    const entry = byId.get(id);
    if (!entry) { problems.push(`links.json: ${id}: no such shipped string`); continue; }
    if (!Array.isArray(list) || list.length === 0) { problems.push(`links.json: ${id}: must be a non-empty list`); continue; }
    const tokens = new Set(linkTokens(entry.value).map((t) => t.lower));
    const seen = new Set();
    for (const item of list) {
      if (!item || typeof item.token !== "string" || typeof item.reason !== "string" || !item.reason.trim()) {
        problems.push(`links.json: ${id}: each entry needs a token and a reason`);
        continue;
      }
      if (item.token !== item.token.toLowerCase()) problems.push(`links.json: ${id}: ${item.token}: tokens are lowercase`);
      if (seen.has(item.token)) problems.push(`links.json: ${id}: ${item.token}: listed twice`);
      seen.add(item.token);
      if (!tokens.has(item.token)) problems.push(`links.json: ${id}: ${item.token}: stale (matches nothing in the string)`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// Section 3: completeness

export function completenessProblems(copy) {
  const problems = [...copy.problems];
  for (const [partition, source, packs] of [["main", copy.main, copy.packs], ["help", copy.help, copy.helpPacks], ["step-up", copy.stepUp ?? {}, copy.stepUpPacks ?? {}]]) {
    for (const code of PACK_CODES) {
      const pack = packs[code] ?? {};
      const label = partition === "help" ? `help/${code}.json` : partition === "step-up" ? `electron/locales/step-up/${code}.json` : `${code}.json`;
      for (const key of Object.keys(source)) {
        if (!Object.hasOwn(pack, key)) problems.push(`${label}: ${key}: not translated`);
        else if (typeof pack[key] !== "string" || !pack[key].trim()) problems.push(`${label}: ${key}: empty`);
      }
      for (const key of Object.keys(pack)) if (!Object.hasOwn(source, key)) problems.push(`${label}: ${key}: not a ${partition} key (extra or stale)`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// Section 4: same-as-english.json and english-only.json

/** same-as-english.json = { "<code>:<key>": exactHash(English) }: unknown, unequal, unneeded and English-moved fail. */
export function sameAsEnglishProblems(same, copy) {
  if (!same || typeof same !== "object" || Array.isArray(same)) return ["same-as-english.json: must be an object"];
  const problems = [];
  const byId = new Map(copy.entries.map((entry) => [entry.id, entry]));
  for (const [id, hash] of Object.entries(same)) {
    const rawCode = id.slice(0, id.indexOf(":"));
    const code = rawCode.startsWith(STEP_UP_PREFIX) ? rawCode.slice(STEP_UP_PREFIX.length) : rawCode;
    const key = id.slice(id.indexOf(":") + 1);
    const entry = byId.get(id);
    const english = copy.english[key];
    if (!PACK_CODES.includes(code) || !entry || english === undefined) { problems.push(`same-as-english.json: ${id}: unknown locale or key`); continue; }
    if (typeof hash !== "string" || hash !== exactHash(english)) problems.push(`same-as-english.json: ${id}: the English changed (hash differs); review it again`);
    if (normalise(entry.value) !== normalise(english)) problems.push(`same-as-english.json: ${id}: stale (the pack text is not the English)`);
    else if (!needsWords(english)) problems.push(`same-as-english.json: ${id}: unneeded (names, numbers and placeholders pass without it)`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// Section 2: review records and the ledger

const RECORD_NAME = /^(\d{4}-\d{2}-\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)-([0-9a-f]{12})\.json$/;

/** First 12 hex of the sha256 of a record's bytes (the record never contains its own name). */
export function recordH12(text) {
  return exactHash(text).slice(0, 12);
}

export function recordId(date, slug, text) {
  return `${date}-${slug}-${recordH12(text)}`;
}

export function readReviewInputs(dir = LOCALES_DIR) {
  const recordsDir = join(dir, COPY_LINT_DIR, REVIEWS_DIR);
  const records = {};
  if (existsSync(recordsDir)) {
    for (const file of readdirSync(recordsDir).filter((name) => name.endsWith(".json")).sort()) {
      records[file.slice(0, -".json".length)] = readFileSync(join(recordsDir, file), "utf8");
    }
  }
  const ledgerText = readLintFile(dir, LEDGER_FILE);
  const reviewersText = readLintFile(dir, "reviewers.json");
  const files = Object.fromEntries(PINNED_FILES.map((name) => [name, readLintFile(dir, name)]));
  return { records, ledgerText, reviewersText, files };
}

/** The ledger's entry ids (a key opening an object) that appear more than once in the raw text. */
export function duplicateEntries(text) {
  const seen = new Set();
  const dups = new Set();
  for (const match of String(text).matchAll(/"((?:[^"\\]|\\.)*)"\s*:\s*\{/g)) {
    const key = JSON.parse(`"${match[1]}"`); // decoded, so "a\/b" and "a/b" are one key, as JSON.parse reads them
    if (seen.has(key)) dups.add(key);
    seen.add(key);
  }
  return [...dups].sort();
}

/** The ids pending-review.json lists: id -> sha256 of the text. A missing file lists nothing; a bad one reports it. */
export function readPendingList(text, problems = []) {
  if (text === undefined) return {};
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    problems.push(`${PENDING_FILE}: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
    return {};
  }
  if (doc?.version !== 1 || typeof doc.strings !== "object" || doc.strings === null || Array.isArray(doc.strings)) {
    problems.push(`${PENDING_FILE}: expected { "version": 1, "strings": { "<id>": "<sha256>" } }`);
    return {};
  }
  return doc.strings;
}

function parseOrProblem(text, label, problems) {
  try {
    return JSON.parse(text);
  } catch (error) {
    problems.push(`${label}: not valid JSON (${error instanceof Error ? error.message : String(error)})`);
    return undefined;
  }
}

/**
 * Why a review date cannot stand, or undefined when it can. The newest date decides a string, so a date after today
 * would beat every real later review for good. There is no slack beyond the UTC day.
 */
export function reviewDateProblem(date) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return "must be YYYY-MM-DD";
  const day = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== date) return "must be a real day";
  const today = new Date().toISOString().slice(0, 10);
  return date > today ? `must not be after today UTC (${today})` : undefined;
}

/** An English source string: it has no translation to compare with today's English. */
function isEnglishId(id) {
  return id.startsWith("en:") || id.startsWith(`${STEP_UP_PREFIX}en:`);
}

function readReviewers(reviewersText, problems) {
  const doc = reviewersText === undefined ? { version: 1, reviewers: [] } : parseOrProblem(reviewersText, "reviewers.json", problems);
  const reviewers = new Map();
  for (const reviewer of doc?.reviewers ?? []) {
    if (!reviewer || !["agent", "human"].includes(reviewer.kind) || typeof reviewer.name !== "string" || typeof reviewer.account !== "string") {
      problems.push("reviewers.json: each reviewer needs kind (agent or human), name and account");
      continue;
    }
    reviewers.set(reviewer.name, reviewer);
  }
  return reviewers;
}

/**
 * One record's checks. problems: every reason it cannot decide anything. usable: the record when its shape holds, even
 * if its reviewer does not. text: whatever its bytes parse to, valid or not. dateIssue: why its date cannot stand.
 */
function checkRecord(id, text, reviewers) {
  const problems = [];
  let parsedText;
  try {
    parsedText = JSON.parse(text);
  } catch {
    parsedText = undefined;
  }
  let dateIssue;
  if (parsedText !== undefined) {
    const dateProblem = reviewDateProblem(parsedText?.date);
    if (dateProblem) dateIssue = `date ${dateProblem}: ${parsedText?.date}`;
    else if (!id.startsWith(`${parsedText.date}-`)) dateIssue = `date ${parsedText.date} differs from its name`;
  } else {
    // Unreadable bytes cannot say their date, so the name's date has to stand on its own.
    const nameDate = /^(\d{4}-\d{2}-\d{2})-/.exec(id)?.[1];
    const dateProblem = nameDate === undefined ? undefined : reviewDateProblem(nameDate);
    if (dateProblem) dateIssue = `date ${dateProblem}: ${nameDate}`;
  }
  let usable;
  const name = RECORD_NAME.exec(`${id}.json`);
  if (!name) problems.push(`reviews/${id}.json: name must be <YYYY-MM-DD>-<slug>-<h12>.json`);
  else if (name[3] !== recordH12(text)) problems.push(`reviews/${id}.json: h12 ${name[3]} does not match the file bytes (${recordH12(text)}); a record is never edited`);
  else {
    const record = parseOrProblem(text, `reviews/${id}.json`, problems);
    const who = record?.reviewer;
    if (record !== undefined && (record === null || record.version !== 1 || !who || typeof record.author !== "string" || typeof record.date !== "string" || typeof record.base !== "string")) {
      problems.push(`reviews/${id}.json: expected version 1 with reviewer, author, date and base`);
    } else if (record) {
      if (dateIssue) problems.push(`reviews/${id}.json: ${dateIssue}`);
      const listed = reviewers.get(who.name);
      if (!listed) problems.push(`reviews/${id}.json: reviewer ${who.name} is not on reviewers.json`);
      else if (listed.kind !== who.kind || listed.account !== who.account) problems.push(`reviews/${id}.json: reviewer ${who.name} does not match reviewers.json`);
      if (who.name === record.author) problems.push(`reviews/${id}.json: the reviewer is the author (${record.author})`);
      const isSection = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
      if (!isSection(record.strings) || !isSection(record.files)) problems.push(`reviews/${id}.json: strings and files must both be objects`);
      for (const [section, needsEnglish] of [[record.strings, true], [record.files, false]]) {
        for (const [itemId, item] of Object.entries(isSection(section) ? section : {})) {
          if (!isSection(item) || typeof item.text !== "string") problems.push(`reviews/${id}.json: ${itemId}: needs text`);
          else if (needsEnglish && typeof item.en !== "string" && !isEnglishId(itemId)) problems.push(`reviews/${id}.json: ${itemId}: needs its English`);
          if (!["pass", "fail"].includes(item?.verdict)) problems.push(`reviews/${id}.json: ${itemId}: verdict must be pass or fail`);
        }
      }
      usable = record;
    }
  }
  return { problems, usable, parsedText, dateIssue };
}

/**
 * The one rule for what the records give, used by the lint, record and rebuild. A record with any problem decides
 * nothing (ignored names it). For each string or lint file: collect every valid record holding its live text and, for
 * a translation, today's English; take only the newest date among them. Any fail on that date means no entry, whichever
 * record name comes first, because a known fail counts at once. Otherwise a pass gives an entry. Older dates neither
 * decide nor block. Several passes on that date all hold the live text, so the first by record name only keeps the
 * output stable. badDates: records whose date cannot stand; record and rebuild refuse on these.
 */
export function resolveLedger({ shipped, english, records, files, reviewersText }) {
  const reviewers = readReviewers(reviewersText, []);
  const newest = (held, label, id, date, verdict) => {
    const known = held.get(label);
    if (known && known.date > date) return;
    const at = known && known.date === date ? known : { date, passes: [], fails: [] };
    (verdict === "pass" ? at.passes : at.fails).push(id);
    held.set(label, at);
  };
  const heldStrings = new Map();
  const heldFiles = new Map();
  const badDates = [];
  const ignored = [];
  for (const id of Object.keys(records).sort()) {
    const { problems, usable: doc, dateIssue } = checkRecord(id, records[id], reviewers);
    if (dateIssue) badDates.push(`${id}: ${dateIssue}`);
    if (problems.length > 0 || !doc) {
      ignored.push(`${id}: decides nothing: ${problems[0] ?? "not valid"}`);
      continue;
    }
    for (const [sid, item] of Object.entries(doc.strings ?? {})) {
      if (typeof item?.text !== "string" || shipped.get(sid) !== item.text) continue;
      const key = sid.slice(sid.indexOf(":") + 1);
      if (!isEnglishId(sid) && item.en !== english[key]) continue;
      newest(heldStrings, sid, id, doc.date, item.verdict);
    }
    for (const [name, item] of Object.entries(doc.files ?? {})) {
      if (typeof item?.text !== "string" || files[name] !== item.text) continue;
      newest(heldFiles, name, id, doc.date, item.verdict);
    }
  }
  const conflicts = [];
  const failed = new Map();
  const decide = (held, liveText) => {
    const entries = {};
    for (const label of [...held.keys()].sort()) {
      const { date, passes, fails } = held.get(label);
      if (fails.length > 0) failed.set(label, fails[0]);
      if (fails.length > 0 && passes.length > 0) conflicts.push(`${label}: ${fails.join(", ")} fails it and ${passes.join(", ")} passes it on ${date}; the fail wins, no entry`);
      if (fails.length === 0 && passes.length > 0) entries[label] = { review: passes[0], sha256: exactHash(liveText(label)) };
    }
    return entries;
  };
  const ledger = { version: 1, strings: decide(heldStrings, (sid) => shipped.get(sid)), files: decide(heldFiles, (name) => files[name]) };
  return { ledger, conflicts, failed, ignored, badDates, valid: new Set(Object.keys(records).filter((id) => !ignored.some((line) => line.startsWith(`${id}: `)))) };
}

/**
 * Every section 2 problem. shipped: Map id -> live text; english: key -> English; pack ids are not "en:".
 * records: { "<record id>": file text }; files: { name: live text }; required: LEDGER_REQUIRED.
 */
export function ledgerProblems({ shipped, english, records, ledgerText, reviewersText, files, required = LEDGER_REQUIRED }) {
  const problems = [];
  const reviewers = readReviewers(reviewersText, problems);
  const ledger = ledgerText === undefined ? { version: 1, strings: {}, files: {} } : parseOrProblem(ledgerText, LEDGER_FILE, problems);
  if (ledger === undefined) return problems;
  const isSection = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
  if (!isSection(ledger) || ledger.version !== 1 || !isSection(ledger.strings) || !isSection(ledger.files)) {
    problems.push(`${LEDGER_FILE}: expected { "version": 1, "strings": {...}, "files": {...} }`);
    return problems;
  }
  // Entries are the keys that open an object; "review" and "sha256" repeat in every entry, so they are not duplicates.
  if (ledgerText !== undefined) for (const key of duplicateEntries(ledgerText)) problems.push(`${LEDGER_FILE}: ${key}: listed twice`);

  // The pending list: only its fixed keys, each at its exact listed text, and never beside a review entry.
  const pending = readPendingList(files[PENDING_FILE], problems);
  for (const [id, hash] of Object.entries(pending)) {
    const separator = id.indexOf(":");
    if (separator < 0 || !LANGS.includes(id.slice(0, separator)) || !PENDING_KEYS.includes(id.slice(separator + 1))) {
      problems.push(`${PENDING_FILE}: ${id}: not one of its ${PENDING_KEYS.length} allowed keys`);
      continue;
    }
    if (!shipped.has(id)) { problems.push(`${PENDING_FILE}: ${id}: orphan (names no shipped string)`); continue; }
    if (hash !== exactHash(shipped.get(id))) problems.push(`${PENDING_FILE}: ${id}: the live text changed since it was listed (needs a review record)`);
    if (Object.hasOwn(ledger.strings, id)) problems.push(`${PENDING_FILE}: ${id}: has a review entry, remove it from this list`);
  }

  // Records: name, h12, shape, date, reviewer, verdicts.
  const parsed = {};
  const evidence = new Set();
  for (const [id, text] of Object.entries(records)) {
    const checked = checkRecord(id, text, reviewers);
    problems.push(...checked.problems);
    if (checked.usable) parsed[id] = checked.usable;
    if (recordHoldsFail(checked.parsedText)) evidence.add(id);
  }

  // What the records give. An entry must agree with it, so a fail merged without a rebuild still counts.
  const resolved = resolveLedger({ shipped, english, records, files, reviewersText });
  const referenced = new Set();
  const checkEntry = (kind, id, entry, liveText, enText) => {
    if (!entry || typeof entry.review !== "string" || typeof entry.sha256 !== "string") {
      problems.push(`${LEDGER_FILE}: ${kind} ${id}: needs review and sha256`);
      return;
    }
    referenced.add(entry.review);
    if (liveText === undefined) { problems.push(`${LEDGER_FILE}: ${kind} ${id}: orphan (names no shipped ${kind === "string" ? "string" : "file"})`); return; }
    if (entry.sha256 !== exactHash(liveText)) problems.push(`${LEDGER_FILE}: ${kind} ${id}: the live text changed since review (sha256 differs)`);
    const record = parsed[entry.review];
    if (!record) {
      if (!Object.hasOwn(records, entry.review)) problems.push(`${LEDGER_FILE}: ${kind} ${id}: record ${entry.review} does not exist`);
      else problems.push(`${LEDGER_FILE}: ${kind} ${id}: record ${entry.review} is invalid`);
      return;
    }
    const reviewed = (kind === "string" ? record.strings : record.files)?.[id];
    if (!reviewed || typeof reviewed.text !== "string") { problems.push(`${LEDGER_FILE}: ${kind} ${id}: record ${entry.review} does not hold it`); return; }
    if (exactHash(reviewed.text) !== entry.sha256) problems.push(`${LEDGER_FILE}: ${kind} ${id}: record ${entry.review} holds different text`);
    if (reviewed.verdict !== "pass") problems.push(`${LEDGER_FILE}: ${kind} ${id}: record ${entry.review} says ${reviewed.verdict ?? "nothing"}`);
    if (kind === "string" && enText !== undefined && !id.startsWith("en:") && !id.startsWith(`${STEP_UP_PREFIX}en:`) && reviewed.en !== enText) {
      problems.push(`${LEDGER_FILE}: string ${id}: the English moved since review (re-review)`);
    }
    // Only an entry with nothing else wrong: changed text already has its own problem above.
    if (reviewed.verdict === "pass" && exactHash(reviewed.text) === entry.sha256 && entry.sha256 === exactHash(liveText) && resolved.valid.has(entry.review)) {
      const given = (kind === "string" ? resolved.ledger.strings : resolved.ledger.files)[id];
      const englishMoved = kind === "string" && enText !== undefined && !id.startsWith("en:") && !id.startsWith(`${STEP_UP_PREFIX}en:`) && reviewed.en !== enText;
      if (!englishMoved && given?.review !== entry.review) {
        problems.push(`${LEDGER_FILE}: ${kind} ${id}: differs from what the records give (${given ? `record ${given.review}` : "no entry"}); run copy-review.mjs rebuild`);
      }
    }
  };
  for (const [id, entry] of Object.entries(ledger.strings)) {
    const key = id.slice(id.indexOf(":") + 1);
    checkEntry("string", id, entry, shipped.get(id), english[key]);
  }
  for (const [name, entry] of Object.entries(ledger.files)) checkEntry("file", name, entry, files[name], undefined);

  // A listed string is excused from needing a pass, never from a fail: a known fail counts at once.
  for (const id of Object.keys(pending)) {
    if (resolved.failed.has(id)) problems.push(`${PENDING_FILE}: ${id}: record ${resolved.failed.get(id)} fails this text`);
  }
  if (required) {
    for (const id of shipped.keys()) {
      if (!Object.hasOwn(ledger.strings, id) && !Object.hasOwn(pending, id)) problems.push(`${LEDGER_FILE}: string ${id}: no review entry`);
    }
    for (const name of Object.keys(files)) if (!Object.hasOwn(ledger.files, name)) problems.push(`${LEDGER_FILE}: file ${name}: no review entry`);
  }
  for (const id of Object.keys(records)) {
    if (!referenced.has(id) && !evidence.has(id)) problems.push(`reviews/${id}.json: orphan record (no ledger entry points to it; delete it)`);
  }
  return problems;
}

/** A fail stays as evidence and still decides its text, so a record holding one is kept with no ledger entry. */
export function recordHoldsFail(doc) {
  return [...Object.values(doc?.strings ?? {}), ...Object.values(doc?.files ?? {})].some((item) => item?.verdict === "fail");
}

/** What clears a text with a pass and a fail on one date. The fail wins at once, whichever record name comes first. */
export const SAME_DATE_FAIL_ROUTES = [
  "A pass and a fail of one text on one date: the fail wins and the text has no review entry, so copy-final stays red until one of these:",
  "  - new text gets a new review; or",
  "  - a pass of this text arrives on a later UTC date; or",
  "  - the fail is wrong and has not merged yet: drop that record from your lane, then run rebuild.",
  "A record is never edited.",
].join("\n");

/** What copy-final prints when the ledger check fails: every id it names, then how to clear it. */
export function ledgerFailureMessage(problems) {
  return [
    ...problems,
    "",
    `${problems.length} copy review problem(s). For each string or file named above:`,
    "  1. node scripts/copy-review.mjs propose <bundle.json> --base <sha> --author <lane> (--only <ids> keeps it to your strings; leave it off for a lint file)",
    "  2. Sol reads the bundle and fills every verdict; a person or agent never writes a pass for Sol",
    "  3. node scripts/copy-review.mjs record <bundle.json> --reviewer sol --slug <lane>",
    "A merge conflict in copy-lint/reviewed.json: never merge it by hand. Keep every record in copy-lint/reviews, then run",
    "  node scripts/copy-review.mjs rebuild",
    "which writes the ledger again from the records alone.",
    SAME_DATE_FAIL_ROUTES,
  ].join("\n");
}

/**
 * Why generate-locale --accept must refuse this pack: every ledger problem except one that names a string of another
 * language. A bad ledger, a bad record or a changed lint file stops every pack.
 */
export function acceptReviewProblems(code, dir = LOCALES_DIR) {
  const copy = loadCopy(dir);
  const problems = ledgerProblems({ ...readReviewInputs(dir), shipped: shippedMap(copy), english: copy.english, required: true });
  const otherLanguage = (problem) => {
    const named = new RegExp(`^(?:${LEDGER_FILE}: (?:string )?|${PENDING_FILE}: )([^\\s:]+):`).exec(problem)?.[1];
    if (named === undefined) return false;
    const locale = named.startsWith(STEP_UP_PREFIX) ? named.slice(STEP_UP_PREFIX.length) : named;
    return LANGS.includes(locale) && locale !== code && locale !== "en";
  };
  return problems.filter((problem) => !otherLanguage(problem));
}

/** The release cut: every id still listed, or the reason the list cannot be read. Empty means the release may go on. */
export function releasePendingProblems(dir = LOCALES_DIR) {
  const text = readLintFile(dir, PENDING_FILE);
  if (text === undefined) return [`${PENDING_FILE}: missing`];
  const problems = [];
  const pending = readPendingList(text, problems);
  for (const id of Object.keys(pending)) problems.push(`${PENDING_FILE}: ${id}: still has no review record`);
  return problems;
}

/** Map of every shipped string id to its live text. */
export function shippedMap(copy) {
  return new Map(copy.entries.map((entry) => [entry.id, entry.value]));
}
