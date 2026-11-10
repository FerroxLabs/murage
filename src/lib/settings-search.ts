// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The words that find each Settings page: the Settings search box, and the
// command palette's Settings group ("images" jumps to Settings > Images).
// Apart from lib/settings-sections.ts so the words stay out of the first
// paint: the modal is a lazy chunk, and the palette loads this when it opens.
//
// 1.0.3: the words live on the cards (lib/settings-card-registry.ts) and a
// card that moves takes its words with it. Search lists cards and rows, never
// pages (searchSettingsCards); the palette still matches a section by its
// label, its group's name and the words of the cards that section names.
//
// SETTINGS-UX-1011 S3: one ranker over the one index (lib/settings-index.ts), no library. Tokenised AND across an
// entry's fields, stems, prefixes, one typo on 5+ letter tokens, a fixed rank order, 12 results and the rest under
// "More results". The word matcher itself is lib/palette-rank.ts, shared with the palette's name lists.
import { cloudCardBlocked, cloudCardHidden } from "./cloud-settings";
import { isCloudOrigin } from "./cloud-workspace";
import { SECTION_ALIASES, SECTION_PAGES } from "./settings-pages";
import { cardsForSurface, type SettingsCard } from "./settings-cards";
import { SETTINGS_CARDS, cardLabel, cardNameWords } from "./settings-card-registry";
import { SETTINGS_EXPLAINERS, SETTINGS_INDEX, type ExplainerIndexEntry, type SettingsIndexEntry } from "./settings-index";
import { findStem, findTokens, queryTokens, withinOneEdit } from "./palette-rank";
import { t } from "./i18n";
import { BOT_SETTINGS_SECTIONS, botSettingsSectionLabel } from "@/components/bot-settings-sections";
import {
  SETTINGS_SECTIONS,
  settingsGroupLabel,
  settingsPageLabel,
  settingsSectionLabel,
  type AppSettingsSection,
  type SettingsSectionEntry,
} from "./settings-sections";

const PAGE_IDS = new Set<string>(SECTION_PAGES.map((entry) => entry.id));

/** The words that find a section: a page takes the words of its own cards, an alias the words of the card it lands on. */
function wordsFor(id: AppSettingsSection): readonly string[] {
  const alias = (SECTION_ALIASES as Readonly<Record<string, { section: string; anchor: string }>>)[id];
  if (alias) return SETTINGS_CARDS.filter((card) => card.anchor === alias.anchor).flatMap((card) => card.words);
  if (!PAGE_IDS.has(id)) return [];
  const aliasAnchors = new Set(Object.values(SECTION_ALIASES).map((entry) => entry.anchor));
  return SETTINGS_CARDS.filter((card) => card.section === id && !aliasAnchors.has(card.anchor)).flatMap((card) => card.words);
}

export const SETTINGS_KEYWORDS = Object.fromEntries(SETTINGS_SECTIONS.map((entry) => [entry.id, wordsFor(entry.id)])) as Readonly<Record<AppSettingsSection, readonly string[]>>;

/** True when `query` (already trimmed and lower-cased) finds this section. */
export function settingsSectionMatches(section: Pick<SettingsSectionEntry, "id" | "group">, query: string): boolean {
  if (!query) return true;
  return [settingsSectionLabel(section.id), settingsGroupLabel(section.group), ...SETTINGS_KEYWORDS[section.id]]
    .some((part) => part.toLowerCase().includes(query));
}

/** The desktop sections the settings search box keeps for `query`. */
export function settingsSearchResults(query: string): AppSettingsSection[] {
  const q = query.trim().toLowerCase();
  return SETTINGS_SECTIONS.filter((entry) => settingsSectionMatches(entry, q)).map((entry) => entry.id);
}

export interface SettingsSearchHit {
  card: SettingsCard;
  label: string;
  /** "Bots > Advanced" style path, as plain parts. */
  page: string;
  advanced: boolean;
}

/** A synonym family: `core` members admit an entry, `also` members are plain words other cards say for their own
 *  meaning, so they are matched once an entry has joined and never admit one (SETTINGS-SEARCH-RANKER-1019 R3). */
export interface SynonymFamily {
  core: readonly string[];
  also?: readonly string[];
}

/** SETTINGS-LOCKED-1019 section 6, from settings-model.json: word families matched, never shown. An entry joins a
 *  family by a core member in its words or a one-word core member in its label; an also-member is matched once joined
 *  and never admits. A joined entry is found by every member, a tier below its own words. "advanced" finds every card
 *  under an Advanced fold. */
export const SETTINGS_SYNONYMS: readonly SynonymFamily[] = [
  { core: ["approve all", "bulk approve"] }, { core: ["no limits", "full access", "yolo", "unlimited"] },
  { core: ["ollama", "lm studio", "lmstudio", "offline"], also: ["local"] },
  { core: ["login item", "autostart", "launch at startup", "start at login"] }, { core: ["advanced"] },
  { core: ["link", "deep link"], also: ["address"] }, { core: ["balance", "credits", "top up", "add money", "credit"] },
  { core: ["secret", "api"], also: ["key", "token"] }, { core: ["model", "engine", "provider", "llm"], also: ["ai"] },
  { core: ["approval", "approve", "permission", "autonomy"], also: ["ask", "level", "trust"] },
  { core: ["folder", "directory", "workspace", "cwd"], also: ["files", "path"] },
  { core: ["email", "mail", "inbox"], also: ["address"] }, { core: ["notify", "alert", "sound", "ping", "badge"] },
  { core: ["phone", "mobile", "iphone", "android"], also: ["pair"] }, { core: ["backup", "restore", "recovery"], also: ["export"] },
  { core: ["computer", "vm", "vps", "sandbox"], also: ["server", "box"] }, { core: ["search", "internet", "lookup"], also: ["web"] },
  { core: ["picture", "image", "photo", "draw"] }, { core: ["voice", "speech", "transcribe", "dictate"], also: ["talk"] },
  { core: ["dark", "light", "theme", "skin"] }, { core: ["cost", "spend", "usage", "billing"], also: ["tokens", "limit"] },
  { core: ["delete", "forget", "erase", "wipe"], also: ["remove"] }, { core: ["wifi", "tailscale", "remote access"] },
  { core: ["mcp"], also: ["tools", "servers"] }, { core: ["ring", "phone call"], also: ["call"] },
];

/** An entry's own words (plus "advanced" under a fold), and apart from them the members of every family it joins. */
export function withSynonyms(words: readonly string[], label: string, advanced: boolean): { words: readonly string[]; synonyms: readonly string[] } {
  const said = new Set(words.map((word) => word.toLowerCase()));
  const labelTokens = new Set(label.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const own = advanced ? [...words, "advanced"] : [...words];
  const synonyms: string[] = [];
  for (const family of SETTINGS_SYNONYMS) {
    const members = [...family.core, ...(family.also ?? [])];
    // A one-member family ("advanced") adds nothing.
    if (members.length < 2) continue;
    if (family.core.some((member) => said.has(member) || (!member.includes(" ") && labelTokens.has(member)))) synonyms.push(...members.filter((member) => !said.has(member)));
  }
  return { words: own, synonyms };
}

/** The query tokens that name a listed bot (a whole name token, or the start of one at 3+ letters), when at least one
 *  other token remains: they keep that bot's rows only and are not scored (SETTINGS-SEARCH-RANKER-1019 R1). A query that
 *  is nothing but a bot's name has no scope: every token is scored, the name against the page field. */
export function scopeTokens(tokens: readonly string[], bots: readonly FindBot[]): { bots: Set<string>; rest: string[]; nameOnly: boolean } {
  const named = bots.map((bot) => ({ id: bot.id, tokens: findTokens(bot.name) }));
  const scoped = new Set<string>(), claimed = new Set<number>(), rest: string[] = [];
  // A whole multi-word name said in the query wins, the longest first: "nova prime calls" with a Nova and a Nova Prime
  // scopes to Nova Prime alone, because its name tokens are claimed before the bare word "nova" can name both. A
  // one-word name claims nothing: "nova calls" still scopes to every bot whose name has a "nova" token.
  // The name is read like the query (queryTokens drops filler words), so "Nova The Prime" is said by "nova the prime".
  const phrases: Array<{ id: string; at: number; length: number }> = [];
  for (const bot of bots) {
    const words = queryTokens(bot.name);
    for (let at = 0; words.length > 1 && at + words.length <= tokens.length; at += 1) {
      if (words.every((word, i) => tokens[at + i] === word)) phrases.push({ id: bot.id, at, length: words.length });
    }
  }
  // Bots that share the same span (equal names, in any roster order) are all scoped; a different span that overlaps is not.
  const spanOf = new Map<number, string>(), crossed = new Set<string>();
  for (const phrase of phrases.sort((a, b) => b.length - a.length)) {
    const span = Array.from({ length: phrase.length }, (_, i) => phrase.at + i), key = `${phrase.at}:${phrase.length}`;
    if (span.some((i) => claimed.has(i) && spanOf.get(i) !== key)) { crossed.add(phrase.id); continue; }
    span.forEach((i) => { claimed.add(i); spanOf.set(i, key); });
    scoped.add(phrase.id);
  }
  // A bot whose whole name crossed a longer name's span stays out: its leftover word must not bring it back by prefix.
  tokens.forEach((token, i) => {
    if (claimed.has(i)) return;
    const hits = named.filter((bot) => !crossed.has(bot.id) && bot.tokens.some((word) => word === token || (token.length >= 3 && word.startsWith(token))));
    if (hits.length) hits.forEach((bot) => scoped.add(bot.id));
    else rest.push(token);
  });
  // Nothing but names: every token is scored, the name against the page field (the only place a name is scored).
  return rest.length ? { bots: scoped, rest, nameOnly: false } : { bots: new Set(), rest: [...tokens], nameOnly: scoped.size > 0 };
}

/** Results shown before "More results" (section 4). */
export const SETTINGS_RESULT_CAP = 12;

/** Rank bands, best first (section 4, the ordering rule in the 40-query table): a label token with the query's stem,
 *  a label token the query starts, then the words, the words a synonym family adds, the section, the page (a bot's
 *  name, only when the query is nothing but that name), the group or gate line; a one-typo match on the label or the
 *  words ranks last. An entry's band is its weakest token's. */
export const FIND_TIER = { label: 1, labelPrefix: 2, words: 3, synonym: 4, section: 5, page: 6, group: 7, fuzzy: 8 } as const;

interface FindFields {
  label: string;
  /** The name a plain label stands for (cardNameWords): counts as the label. */
  nameWords?: readonly string[];
  words: readonly string[];
  /** Members of the synonym families the entry joins (withSynonyms): a tier below its own words. */
  synonyms: readonly string[];
  section: string;
  page: string;
  group: readonly string[];
}

/** Every field split once into tokens, with stems alongside. */
interface TokenFields {
  label: string[];
  words: string[];
  synonyms: string[];
  section: string[];
  page: string[];
  group: string[];
}

function tokenFields(fields: FindFields): TokenFields {
  return {
    label: [...findTokens(fields.label), ...(fields.nameWords ?? []).flatMap(findTokens)],
    words: fields.words.flatMap(findTokens),
    synonyms: fields.synonyms.flatMap(findTokens),
    section: findTokens(fields.section),
    page: findTokens(fields.page),
    group: fields.group.flatMap(findTokens),
  };
}

/** 0 the same word (or stem), 1 the query starts it (a one-letter query only ever matches whole), -1 neither. */
function wordMatch(query: string, field: string): -1 | 0 | 1 {
  if (query === field) return 0;
  const qs = findStem(query), fs = findStem(field);
  if (qs === fs) return 0;
  if (query.length >= 2 && (field.startsWith(query) || fs.startsWith(qs))) return 1;
  return -1;
}

const fieldHas = (query: string, field: readonly string[]) => field.some((token) => wordMatch(query, token) !== -1);
const typoIn = (query: string, field: readonly string[]) => query.length >= 5 && field.some((token) => token.length >= 5 && withinOneEdit(query, token));

export interface FindScore {
  tier: number;
  /** Query tokens the label says as typed: "tool" leads with "Show tool calls" over "Connected tools details". */
  exact: number;
  /** Share of the label's tokens the query met: "Bot email" (1/2) leads "Your name and email" (1/4). */
  coverage: number;
}

/** The band an entry earns for these query tokens, or null when some token matches no field (AND across fields). */
export function findScore(tokens: readonly string[], fields: TokenFields): FindScore | null {
  if (!tokens.length) return null;
  let tier = 0, exact = 0;
  const covered = new Set<number>();
  for (const token of tokens) {
    let best = -1;
    if (fields.label.includes(token)) exact += 1;
    fields.label.forEach((word, i) => {
      const match = wordMatch(token, word);
      if (match === -1) return;
      covered.add(i);
      const band = match === 0 ? FIND_TIER.label : FIND_TIER.labelPrefix;
      if (best === -1 || band < best) best = band;
    });
    if (best === -1) {
      if (fieldHas(token, fields.words)) best = FIND_TIER.words;
      else if (fieldHas(token, fields.synonyms)) best = FIND_TIER.synonym;
      else if (fieldHas(token, fields.section)) best = FIND_TIER.section;
      else if (fieldHas(token, fields.page)) best = FIND_TIER.page;
      else if (fieldHas(token, fields.group)) best = FIND_TIER.group;
      else if (typoIn(token, fields.label) || typoIn(token, fields.words)) best = FIND_TIER.fuzzy;
      else return null;
    }
    tier = Math.max(tier, best);
  }
  return { tier, exact, coverage: fields.label.length ? covered.size / fields.label.length : 0 };
}

/** A bot as find needs it. */
export interface FindBot {
  id: string;
  name: string;
}

export interface SettingsFindContext {
  /** The confirmed desktop: `true` lists desktop entries, anything else only entries for every surface. */
  desktop: boolean | undefined;
  /** A Cloud window: app cards on a page blocked there are not listed. */
  cloud?: boolean;
  /** The bots whose rows search lists, the Chief first. None: app entries only. */
  bots?: readonly FindBot[];
  /** The bot whose window is open: its rows rank above other bots' and above the app's. */
  currentBotId?: string;
}

export interface SettingsIndexHit {
  /** A control (app card or bot row) or an explainer row (Approve all). Open goes by the entry's existing anchor. */
  entry: SettingsIndexEntry | ExplainerIndexEntry;
  /** The bot a bot row belongs to. */
  bot?: FindBot;
  label: string;
  /** Plain parts: ["Nova", "Access", "Working folder"], ["Connected apps", "Bot email"],
   *  ["Models & engines", "Advanced", "Engine command lines"]. */
  path: string[];
  tier: number;
}

export interface SettingsFindResult {
  /** At most SETTINGS_RESULT_CAP. */
  hits: SettingsIndexHit[];
  /** Everything after the cap, in rank order, for "More results". */
  more: SettingsIndexHit[];
}

const BOTS_GROUP = () => t("settings.page.botDefaults");
const sectionEntry = (id: string) => BOT_SETTINGS_SECTIONS.find((section) => section.id === id)!;

/** The window's own rows lead inside a band: the app's in the app window (and on a phone), the open bot's in a bot
 *  window, then the app's, then other bots'. */
function scopeBand(hit: SettingsIndexHit, context: SettingsFindContext): number {
  if (context.currentBotId) return hit.bot?.id === context.currentBotId ? 0 : hit.entry.scope !== "bot" ? 1 : 2;
  return hit.entry.scope !== "bot" ? 0 : 1;
}

/** Settings search over the whole index: app cards and every bot's rows (SETTINGS-UX-1011 sections 4 and 8.2).
 *  Sort key: band, then top-level before Advanced, then the window's own rows, then query words the label says as typed
 *  (a plural or other stem after), then label coverage (more first), then registry order (the same control across bots
 *  stays together, the Chief first). */
export function searchSettingsIndex(query: string, context: SettingsFindContext, entries: readonly SettingsIndexEntry[] = SETTINGS_INDEX, explainers: readonly ExplainerIndexEntry[] = SETTINGS_EXPLAINERS): SettingsFindResult {
  const queried = queryTokens(query);
  if (!queried.length) return { hits: [], more: [] };
  // R1: "nova no limits" keeps Nova's rows and scores "no limits"; the bot's name is a scope, not a match.
  const scope = scopeTokens(queried, context.bots ?? []);
  const scoped = scope.bots.size > 0;
  const tokens = scope.rest;
  const bots = scoped ? (context.bots ?? []).filter((bot) => scope.bots.has(bot.id)) : context.bots ?? [];
  const cloud = context.cloud ?? isCloudOrigin();
  const ranked: Array<{ hit: SettingsIndexHit; band: number; exact: number; coverage: number; at: number }> = [];
  let at = 0;
  for (const entry of [...entries, ...explainers]) {
    if (entry.surface === "desktop" && context.desktop !== true) continue;
    if (scoped && entry.scope !== "bot") continue;
    const label = entry.label();
    const gate = entry.gate ? [entry.gate.reason()] : [];
    const { words, synonyms } = withSynonyms(entry.words, label, entry.advanced);
    if (entry.scope === "explainer") {
      const path = entry.path();
      const score = findScore(tokens, tokenFields({ label, words, synonyms, section: path.join(" "), page: "", group: [] }));
      if (score) {
        const hit: SettingsIndexHit = { entry, label, path: [...path, label], tier: score.tier };
        ranked.push({ hit, band: scopeBand(hit, context), exact: score.exact, coverage: score.coverage, at: at++ });
      }
      continue;
    }
    if (entry.scope === "app") {
      // A Cloud window leaves out a card on a page it cannot use, and keeps a computer-only card: it renders a stub there.
      if (cloudCardBlocked(entry.card, cloud) && !cloudCardHidden(entry.anchor, cloud)) continue;
      const page = settingsPageLabel(entry.section);
      const score = findScore(tokens, tokenFields({ label, nameWords: cardNameWords(entry.id), words, synonyms, section: page, page: "", group: gate }));
      if (score) {
        const hit: SettingsIndexHit = { entry, label, path: [page, ...(entry.advanced ? [t("settings.l1.advancedPath")] : []), label], tier: score.tier };
        ranked.push({ hit, band: scopeBand(hit, context), exact: score.exact, coverage: score.coverage, at: at++ });
      }
      continue;
    }
    const section = sectionEntry(entry.section);
    for (const bot of bots) {
      // The bot's name is a page match only for a query that is nothing but a name (R1); a mixed query never scores it.
      const score = findScore(tokens, tokenFields({ label, words, synonyms, section: section.label, page: scope.nameOnly ? bot.name : "", group: [BOTS_GROUP(), ...gate] }));
      if (!score) continue;
      const named = botSettingsSectionLabel(section, bot.name);
      const path = label === named ? [bot.name, label] : [bot.name, named, label];
      const hit: SettingsIndexHit = { entry, bot, label, path, tier: score.tier };
      ranked.push({ hit, band: scopeBand(hit, context), exact: score.exact, coverage: score.coverage, at: at++ });
    }
  }
  const sorted = ranked
    .sort((a, b) => a.hit.tier - b.hit.tier || Number(a.hit.entry.advanced) - Number(b.hit.entry.advanced) || a.band - b.band || b.exact - a.exact || b.coverage - a.coverage || a.at - b.at)
    .map((item) => item.hit);
  return { hits: sorted.slice(0, SETTINGS_RESULT_CAP), more: sorted.slice(SETTINGS_RESULT_CAP) };
}

/** The app cards (and rows) a query finds, best first, through the same ranker: by name, then by the words people
 *  type, then by the page's own name. `cardsForSurface` first, so a phone or browser door never lists a desktop
 *  card's row, and nothing while `desktop` is still undefined. In a Cloud window a card on a page SettingsModal blocks
 *  there is not listed (cloudCardBlocked). Uncapped: the Settings results list shows every hit until it folds the
 *  rest under "More results" (S4). */
export function searchSettingsCards(
  query: string,
  desktop: boolean | undefined,
  cards: readonly SettingsCard[] = SETTINGS_CARDS,
  labelOf: (card: SettingsCard) => string = cardLabel,
  pageLabelOf: (page: SettingsCard["section"]) => string = settingsPageLabel,
  cloud: boolean = isCloudOrigin(),
): SettingsSearchHit[] {
  const tokens = queryTokens(query);
  if (!tokens.length) return [];
  const ranked: Array<{ hit: SettingsSearchHit; score: FindScore; at: number }> = [];
  cardsForSurface(cards, desktop).filter((card) => !cloudCardBlocked(card, cloud)).forEach((card, at) => {
    const label = labelOf(card), page = pageLabelOf(card.section);
    const score = findScore(tokens, tokenFields({ label, nameWords: cardNameWords(card.id), words: card.words, synonyms: [], section: page, page: "", group: [] }));
    if (score) ranked.push({ hit: { card, label, page, advanced: card.advanced }, score, at });
  });
  return ranked
    .sort((a, b) => a.score.tier - b.score.tier || Number(a.hit.advanced) - Number(b.hit.advanced) || b.score.exact - a.score.exact || b.score.coverage - a.score.coverage || a.at - b.at)
    .map((entry) => entry.hit);
}
