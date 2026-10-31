// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The screen envelope: what the help panel says about the screen the owner is
// on, for a help ask (L4B, 1.0.14) and for a feedback item (POST /api/feedback,
// lane L-FB). The shape is shared/screen-envelope.schema.json.
//
// AN ALLOWLIST, BY CONSTRUCTION. Every field is copied by name from a narrow
// input, checked against the schema's pattern and length, and dropped when it
// does not fit. Nothing is read off the page: no message text, no draft, no
// file contents, no keys, no memory, no connected-app data, no logs. Control
// labels come from the screens index (static copy), never from the DOM, so a
// label cannot carry what the owner typed. The desktop relay and the control
// plane check the same shape again and refuse unknown fields.
import { en } from "@/locales";
import "./help-screen-copy";
import { SCREENS, screenEntry, type ScreenIndexEntry } from "./screens-index";

export interface ScreenGate { id: string; reason: string }
export interface ScreenControl { id: string; label: string; address: string }
export interface ScreenEnvelopeState {
  page?: string;
  botId?: string;
  section?: string;
  openFolds?: string[];
  selectedCard?: string;
  gates?: ScreenGate[];
}
export interface ScreenEnvelope {
  screen: string;
  title: string;
  state: ScreenEnvelopeState;
  controls: ScreenControl[];
}

/** The schema's limits, mirrored (screen-envelope.test.ts keeps them equal). */
export const ENVELOPE_LIMITS = {
  screen: 80,
  title: 120,
  folds: 20,
  gates: 20,
  reason: 200,
  controls: 40,
  label: 80,
  address: 200,
} as const;

const SCREEN_ID = /^[a-z][a-z0-9-]*(:[A-Za-z0-9_.-]{1,128})*$/;
const PLAIN_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const BOT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CARD_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const GATE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const ADDRESS = /^murage:\/\/[A-Za-z0-9_./:?=&-]{1,190}$/;

const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" ? scrubSecrets(value.replace(/\s+/g, " ").trim()).slice(0, max) : undefined;
/** An id that fits its shape, or "removed" when it holds a secret shape (the
 *  relay does the same, so the preview and the stored row agree). */
const id = (value: unknown, shape: RegExp): string | undefined =>
  typeof value === "string" && shape.test(value) ? (scrubSecrets(value) === value ? value : "removed") : undefined;

/** What a screen may say about itself. Anything else the caller has is not
 *  accepted here, so it cannot reach the envelope. */
export interface EnvelopeInput {
  screen: string;
  title: string;
  page?: string;
  botId?: string;
  section?: string;
  openFolds?: readonly string[];
  selectedCard?: string;
  gates?: readonly ScreenGate[];
  controls?: readonly ScreenControl[];
}

export function buildScreenEnvelope(input: EnvelopeInput): ScreenEnvelope {
  const screenId = input.screen.length <= ENVELOPE_LIMITS.screen ? id(input.screen, SCREEN_ID) : undefined;
  const screen = screenId === "removed" ? "removed" : screenId ?? "unknown";
  const state: ScreenEnvelopeState = {};
  const page = id(input.page, PLAIN_ID);
  if (page) state.page = page;
  const botId = id(input.botId, BOT_ID);
  if (botId) state.botId = botId;
  const section = id(input.section, PLAIN_ID);
  if (section) state.section = section;
  const folds = (input.openFolds ?? []).filter((fold) => PLAIN_ID.test(fold)).slice(0, ENVELOPE_LIMITS.folds);
  if (folds.length) state.openFolds = [...folds];
  const card = id(input.selectedCard, CARD_ID);
  if (card) state.selectedCard = card;
  const gates = (input.gates ?? [])
    .map((gate) => ({ id: id(gate.id, GATE_ID), reason: text(gate.reason, ENVELOPE_LIMITS.reason) }))
    .filter((gate): gate is ScreenGate => Boolean(gate.id) && gate.reason !== undefined)
    .slice(0, ENVELOPE_LIMITS.gates);
  if (gates.length) state.gates = gates;
  const controls = (input.controls ?? [])
    .map((control) => ({ id: id(control.id, GATE_ID), label: text(control.label, ENVELOPE_LIMITS.label), address: id(control.address, ADDRESS) }))
    .filter((control): control is ScreenControl => Boolean(control.id && control.label && control.address))
    .slice(0, ENVELOPE_LIMITS.controls);
  return { screen, title: text(input.title, ENVELOPE_LIMITS.title) || screen, state, controls };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): string | null => {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  return extra ?? null;
};
const str = (value: unknown, max: number, shape?: RegExp): boolean =>
  typeof value === "string" && value.length <= max && (!shape || shape.test(value));

/** The schema, checked by hand (no validator library on the renderer). Returns
 *  the first problem, or null. Unknown fields are a problem, never ignored. */
export function checkScreenEnvelope(value: unknown): string | null {
  if (!isObject(value)) return "envelope is not an object";
  const extra = onlyKeys(value, ["screen", "title", "state", "controls"]);
  if (extra) return `unknown field ${extra}`;
  if (!str(value.screen, ENVELOPE_LIMITS.screen, SCREEN_ID)) return "screen";
  if (!str(value.title, ENVELOPE_LIMITS.title) || !(value.title as string).trim()) return "title";
  const state = value.state;
  if (!isObject(state)) return "state";
  const extraState = onlyKeys(state, ["page", "botId", "section", "openFolds", "selectedCard", "gates"]);
  if (extraState) return `unknown field state.${extraState}`;
  if (state.page !== undefined && !str(state.page, 64, PLAIN_ID)) return "state.page";
  if (state.botId !== undefined && !str(state.botId, 128, BOT_ID)) return "state.botId";
  if (state.section !== undefined && !str(state.section, 64, PLAIN_ID)) return "state.section";
  if (state.selectedCard !== undefined && !str(state.selectedCard, 128, CARD_ID)) return "state.selectedCard";
  if (state.openFolds !== undefined) {
    if (!Array.isArray(state.openFolds) || state.openFolds.length > ENVELOPE_LIMITS.folds) return "state.openFolds";
    if (!state.openFolds.every((fold) => str(fold, 64, PLAIN_ID))) return "state.openFolds";
  }
  if (state.gates !== undefined) {
    if (!Array.isArray(state.gates) || state.gates.length > ENVELOPE_LIMITS.gates) return "state.gates";
    for (const gate of state.gates) {
      if (!isObject(gate)) return "state.gates";
      const extraGate = onlyKeys(gate, ["id", "reason"]);
      if (extraGate) return `unknown field state.gates.${extraGate}`;
      if (!str(gate.id, 64, GATE_ID) || !str(gate.reason, ENVELOPE_LIMITS.reason)) return "state.gates";
    }
  }
  const controls = value.controls;
  if (!Array.isArray(controls) || controls.length > ENVELOPE_LIMITS.controls) return "controls";
  for (const control of controls) {
    if (!isObject(control)) return "controls";
    const extraControl = onlyKeys(control, ["id", "label", "address"]);
    if (extraControl) return `unknown field controls.${extraControl}`;
    if (!str(control.id, 64, GATE_ID) || !str(control.label, ENVELOPE_LIMITS.label) || !str(control.address, ENVELOPE_LIMITS.address, ADDRESS)) return "controls";
  }
  return null;
}

// ── secret shapes in the envelope ────────────────────────────────────────
// The envelope's labels and ids are app copy plus names such as a bot's; the
// relay and the control plane scrub again (L-FB). Scrubbing here too means the
// "What we send" fold shows exactly what leaves the computer. Owner-typed
// words are not sent in 1.0.12 (see the feedback request below); they come
// with the shared scrubber in 1.0.13. Shapes from server/redact.ts
// KEY_PREFIXES, plus bearer values, JWTs, private-key blocks and key=value pairs.
const SECRET_SHAPES: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bnpm_[A-Za-z0-9]{20,}/g,
  /\bxai-[A-Za-z0-9_-]{20,}/g,
  /\bgsk_[A-Za-z0-9]{40,}/g,
  /\bhf_[A-Za-z0-9]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];
const BEARER = /(\bBearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi;
const KEY_VALUE = /(\b(?:api[_-]?key|apikey|secret|token|password|passwd|authorization|access[_-]?key|private[_-]?key)s?["']?\s*[=:]\s*["']?)[A-Za-z0-9._~+/=-]{8,}/gi;
export const REMOVED = "[removed]";

export function scrubSecrets(words: string): string {
  let out = words;
  for (const shape of SECRET_SHAPES) out = out.replace(shape, REMOVED);
  return out.replace(BEARER, `$1${REMOVED}`).replace(KEY_VALUE, `$1${REMOVED}`);
}

// ── which screen is this ─────────────────────────────────────────────────

/** The parts of app state the help panel reads to name the screen. Narrow on
 *  purpose: no transcript, no draft and no settings values can be passed in. */
export interface HelpScreenInput {
  activeView: "chat" | "team-map" | "routines" | "skill-recorder" | "all-chats";
  bot?: { id: string; name: string } | null;
  group?: { id: string; name: string } | null;
  /** The Settings page on screen (an alias already resolved to its page), or null when Settings is closed. */
  settingsPage?: string | null;
  botSettingsOpen?: boolean;
  pluginsOpen?: boolean;
  computerOpen?: boolean;
  inspectorOpen?: boolean;
  noEngines?: boolean;
  enginesOff?: boolean;
  connected?: boolean;
  /** Present while the first run owns the Chief's chat. */
  firstRun?: { next: string | null; chiefBotId?: string; blocked: readonly string[] } | null;
}

export interface HelpScreen {
  /** The index key (screens-index.ts) whose copy the panel shows. */
  key: string;
  entry: ScreenIndexEntry | undefined;
  /** Placeholder values for the copy ({name}). */
  params: Record<string, string>;
  /** The envelope input, before the title and labels are put into words. */
  screen: string;
  page?: string;
  botId?: string;
  section?: string;
  gates: { id: string; reasonKey: string }[];
}

export function resolveHelpScreen(input: HelpScreenInput): HelpScreen {
  const bot = input.bot ?? undefined;
  const group = input.group ?? undefined;
  const gates: HelpScreen["gates"] = [];
  if (input.connected === false) gates.push({ id: "offline", reasonKey: "ux.l4a.gate.offline" });
  if (input.enginesOff) gates.push({ id: "engines-off", reasonKey: "ux.l4a.gate.enginesOff" });
  else if (input.noEngines) gates.push({ id: "no-engine", reasonKey: "ux.l4a.gate.noEngine" });
  const make = (key: string, screen: string, extra: Partial<HelpScreen> = {}): HelpScreen => ({
    key,
    entry: screenEntry(key),
    params: { name: bot?.name ?? group?.name ?? "" },
    screen,
    gates,
    ...extra,
  });
  if (input.settingsPage) {
    const page = input.settingsPage;
    const key = screenEntry(`settings:${page}`) ? `settings:${page}` : "settings:general";
    return make(key, key, { page: key.slice("settings:".length) });
  }
  if (input.botSettingsOpen && bot) return make("bot", `bot:${bot.id}`, { botId: bot.id });
  if (input.pluginsOpen) return make("apps", "apps");
  if (input.computerOpen && bot) return make("computer", "computer", { botId: bot.id });
  if (input.inspectorOpen && bot) return make("inspector", "inspector", { botId: bot.id });
  switch (input.activeView) {
    case "all-chats": return make("chats", "chats");
    case "team-map": return make("map", "map");
    case "routines": return make("routines", "routines");
    case "skill-recorder": return make("skill-recorder", "skill-recorder");
    default: break;
  }
  if (input.noEngines && !input.enginesOff) return make("no-engines", "no-engines");
  const firstRun = input.firstRun;
  if (firstRun?.next && bot && (!firstRun.chiefBotId || firstRun.chiefBotId === bot.id)) {
    const key = screenEntry(`first-run:${firstRun.next}`) ? `first-run:${firstRun.next}` : "first-run:strip";
    for (const step of firstRun.blocked) {
      if (/^[a-z-]{1,40}$/.test(step)) gates.push({ id: `first-run:${step}`, reasonKey: "ux.l4a.gate.firstRunBlocked" });
    }
    return make(key, key, { botId: bot.id });
  }
  if (group) return make("group", `group:${group.id}`);
  if (bot) return make("chat", `chat:${bot.id}`, { botId: bot.id });
  return make("help", "help");
}

// ── the feedback envelope: fixed tables only (1.0.12) ────────────────────
// What the feedback request says about the screen comes ONLY from the shipped
// screens index and its English copy: no bot or group name, no ids from stored
// records, no search query, no DOM text. Every text field is a member of the
// tables below, and checkFeedbackRequest refuses anything that is not.
// Screen titles with a {name} take a fixed word in its place.
const english = (key: string): string | undefined =>
  Object.hasOwn(en, key) ? (en as Record<string, string>)[key] : undefined;
const FIXED_NAME: Readonly<Record<string, string>> = { chat: "Chat", group: "Group chat" };
const UNKNOWN_SCREEN = "unknown";
function fixedTitle(entry: ScreenIndexEntry): string {
  const filled = (english(entry.title) ?? entry.key).replace(/\{name\}/g, FIXED_NAME[entry.key] ?? "Bot");
  return /[{}]/.test(filled) || !filled.trim() ? entry.key : filled.slice(0, ENVELOPE_LIMITS.title);
}
/** The fixed reason copy key for each gate id the panel can name. */
const GATE_REASON_KEY: Readonly<Record<string, string>> = {
  offline: "ux.l4a.gate.offline",
  "engines-off": "ux.l4a.gate.enginesOff",
  "no-engine": "ux.l4a.gate.noEngine",
  ...Object.fromEntries(SCREENS.filter((entry) => entry.key.startsWith("first-run:")).map((entry) => [entry.key, "ux.l4a.gate.firstRunBlocked"])),
};

/** Every value a feedback request's text fields may hold. */
export const FEEDBACK_FIXED = (() => {
  const screens = new Set<string>([UNKNOWN_SCREEN]);
  const titles = new Map<string, string>([[UNKNOWN_SCREEN, UNKNOWN_SCREEN]]);
  const pages = new Set<string>();
  const controls = new Map<string, { label: string; address: string }>();
  for (const entry of SCREENS) {
    screens.add(entry.key);
    titles.set(entry.key, fixedTitle(entry));
    if (entry.key.startsWith("settings:")) pages.add(entry.key.slice("settings:".length));
    for (const control of entry.controls) {
      const label = english(control.label);
      // Only a fixed route: an address with a <botId> or any other part filled at run time is left out.
      if (label && !/[<>]/.test(control.address) && ADDRESS.test(control.address)) controls.set(control.id, { label, address: control.address });
    }
  }
  const gates = new Map<string, string>();
  for (const [gate, key] of Object.entries(GATE_REASON_KEY)) { const reason = english(key); if (reason) gates.set(gate, reason); }
  return { screens, titles, pages, gates, controls } as const;
})();

/** The envelope the feedback form sends, built from the fixed tables only. */
export function feedbackEnvelopeForScreen(screen: Pick<HelpScreen, "key" | "page" | "gates">): ScreenEnvelope {
  const entry = screenEntry(screen.key);
  const key = entry ? entry.key : UNKNOWN_SCREEN;
  const state: ScreenEnvelopeState = {};
  const page = key.startsWith("settings:") ? key.slice("settings:".length) : undefined;
  if (page && FEEDBACK_FIXED.pages.has(page)) state.page = page;
  const gates = screen.gates
    .filter((gate) => FEEDBACK_FIXED.gates.has(gate.id))
    .map((gate) => ({ id: gate.id, reason: FEEDBACK_FIXED.gates.get(gate.id)! }))
    .slice(0, ENVELOPE_LIMITS.gates);
  if (gates.length) state.gates = gates;
  const controls = (entry?.controls ?? [])
    .filter((control) => FEEDBACK_FIXED.controls.has(control.id) && FEEDBACK_FIXED.controls.get(control.id)!.address === control.address)
    .map((control) => ({ id: control.id, ...FEEDBACK_FIXED.controls.get(control.id)! }))
    .slice(0, ENVELOPE_LIMITS.controls);
  return { screen: key, title: FEEDBACK_FIXED.titles.get(key)!, state, controls };
}

/** Which field of a feedback envelope holds a value outside the fixed tables, or null. */
export function checkFeedbackFixed(value: { screen: unknown; title: unknown; state: unknown; controls: unknown }): string | null {
  if (typeof value.screen !== "string" || !FEEDBACK_FIXED.screens.has(value.screen)) return "screen";
  if (value.title !== FEEDBACK_FIXED.titles.get(value.screen)) return "title";
  const state = value.state;
  if (!isObject(state)) return "state";
  const extra = onlyKeys(state, ["page", "gates"]);
  if (extra) return `state.${extra}`;
  if (state.page !== undefined && (typeof state.page !== "string" || !FEEDBACK_FIXED.pages.has(state.page))) return "state.page";
  if (state.gates !== undefined) {
    if (!Array.isArray(state.gates)) return "state.gates";
    for (const gate of state.gates) {
      if (!isObject(gate) || typeof gate.id !== "string" || gate.reason !== FEEDBACK_FIXED.gates.get(gate.id)) return "state.gates";
    }
  }
  if (!Array.isArray(value.controls)) return "controls";
  for (const control of value.controls) {
    const fixed = isObject(control) && typeof control.id === "string" ? FEEDBACK_FIXED.controls.get(control.id) : undefined;
    if (!fixed || control.label !== fixed.label || control.address !== fixed.address) return "controls";
  }
  return null;
}

/** The envelope for a resolved screen, with its words filled in by `say`. */
export function envelopeForScreen(screen: HelpScreen, say: (key: string, params?: Record<string, string>) => string): ScreenEnvelope {
  const entry = screen.entry;
  const botId = screen.botId ?? "";
  return buildScreenEnvelope({
    screen: screen.screen,
    title: entry ? say(entry.title, screen.params) : screen.screen,
    page: screen.page,
    botId: screen.botId,
    section: screen.section,
    gates: screen.gates.map((gate) => ({ id: gate.id, reason: say(gate.reasonKey) })),
    controls: (entry?.controls ?? [])
      .filter((control) => !control.address.includes("<botId>") || botId)
      .map((control) => ({ id: control.id, label: say(control.label), address: control.address.replace("<botId>", botId) })),
  });
}

// ── the feedback request ─────────────────────────────────────────────────

export const FEEDBACK_WORDS_MAX = 2000;
import type { FeedbackSurface } from "./feedback-surface";
export { feedbackSurface, type FeedbackSurface } from "./feedback-surface";

/** POST /api/feedback, as the renderer sends it. The desktop relay adds
 *  installId, appVersion and os (lane L-FB) and checks this shape again. */
export interface FeedbackRequest extends ScreenEnvelope {
  surface: FeedbackSurface;
  words: string;
  createdAt: string;
}

export const FEEDBACK_REQUEST_FIELDS = ["surface", "screen", "title", "state", "controls", "words", "createdAt"] as const;

// What got in the way, as one choice about this screen. In 1.0.12 the owner
// picks a choice and never types: the request's `words` is the choice's fixed
// sentence below, so no text the owner typed can leave the computer from the
// help panel. Feedback by words comes in 1.0.13 with the shared scrubber
// (designs/L4A-SCRUBBER-REDESIGN-1012.md section 5). The sentences are fixed
// English, not the shown label, so every report reads the same to the team.
export const FEEDBACK_CHOICES = ["complicated", "cant-do", "cant-find"] as const;
export type FeedbackChoice = (typeof FEEDBACK_CHOICES)[number];
export const FEEDBACK_CHOICE_WORDS: Readonly<Record<FeedbackChoice, string>> = Object.freeze({
  complicated: "Something on this screen felt complicated.",
  "cant-do": "I couldn't do something on this screen.",
  "cant-find": "I couldn't find something on this screen.",
});
const CHOICE_SENTENCES: ReadonlySet<string> = new Set(Object.values(FEEDBACK_CHOICE_WORDS));

export function isFeedbackChoice(value: unknown): value is FeedbackChoice {
  return typeof value === "string" && (FEEDBACK_CHOICES as readonly string[]).includes(value);
}

export function buildFeedbackRequest(input: { envelope: ScreenEnvelope; choice: FeedbackChoice; surface: FeedbackSurface; now: Date }): FeedbackRequest {
  if (!isFeedbackChoice(input.choice)) throw new Error("unknown feedback choice");
  return {
    surface: input.surface,
    screen: input.envelope.screen,
    title: input.envelope.title,
    state: input.envelope.state,
    controls: input.envelope.controls,
    words: FEEDBACK_CHOICE_WORDS[input.choice],
    createdAt: input.now.toISOString(),
  };
}

/** The request's shape, checked before every send. `words` must be one of the
 *  fixed choice sentences: anything else (owner text included) is refused. */
export function checkFeedbackRequest(value: unknown): string | null {
  if (!isObject(value)) return "request is not an object";
  const extra = onlyKeys(value, FEEDBACK_REQUEST_FIELDS);
  if (extra) return `unknown field ${extra}`;
  if (value.surface !== "desktop" && value.surface !== "phone" && value.surface !== "cloud") return "surface";
  if (typeof value.words !== "string" || !CHOICE_SENTENCES.has(value.words) || value.words.length > FEEDBACK_WORDS_MAX) return "words";
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) return "createdAt";
  const { screen, title, state, controls } = value;
  return checkScreenEnvelope({ screen, title, state, controls }) ?? checkFeedbackFixed({ screen, title, state, controls });
}
