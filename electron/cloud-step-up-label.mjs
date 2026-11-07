// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// B3 WP4: what a step-up confirmation SAYS. When a Cloud home asks for step-up, the person is shown (and, on a Mac,
// Touch ID is asked for) a plain sentence about the action, never "approve this request". The sentence comes from:
//   - the method and path, mapped to a human label through STEP_UP_LABELS (the routes server/route-policy.ts marks
//     step-up / credential / browser-step-up, plus the paths cloudRouteDecision escalates by shape), and
//   - a short summary of the body where it matters: which bot, and which settings (names only, never values).
// An unknown route still gets a plain fallback sentence with the method and path; it is never an opaque blob.
//
// Pure module: no Electron import. electron/cloud-step-up-label.test.mjs checks it against the real ROUTE_POLICY.
//
// STEPUP-LOCALES 1.0.18: the words are shown in the app's language (step-up-locale.mjs). The English labels below
// stay the table's own text and each is also a "label.*" value in electron/locales/step-up/en.json, the source the
// other 7 packs translate (cloud-step-up-locale.test.mjs fails a label that is missing there).

import { STEP_UP_BASELINE, STEP_UP_EN, stepUpText } from "./step-up-locale.mjs";

const ID = String.raw`[\w-]+`;
const rx = (source) => new RegExp(`^${source}$`);
const ANY = "*";

/** Ordered: the first matching entry wins. `methods` is "*" or a list. */
export const STEP_UP_LABELS = Object.freeze([
  // The home itself, its devices and account.
  { methods: ["POST"], path: rx("/api/cloud/pairing"), label: "Add a new device to your Cloud home", summary: "device" },
  { methods: ANY, path: /^\/api\/cloud\/(?:devices\/[^/]+|account|recovery\/.*)$/, label: "Change the devices or the account on your Cloud home" },
  { methods: ["POST"], path: rx(String.raw`/api/cloud/model-signins/(?:chatgpt|supergrok)/start`), label: "Start a model sign-in on your Cloud home" },
  { methods: ["POST"], path: rx(String.raw`/api/cloud/model-signins/(?:chatgpt|supergrok)/sign-out`), label: "Sign a model out of your Cloud home" },
  { methods: ["POST"], path: /^\/api\/cloud\/model-signins\/(?:chatgpt|supergrok)\/attempts\/[^/]+\/cancel$/, label: "Cancel a model sign-in on your Cloud home" },
  { methods: ["DELETE"], path: rx(String.raw`/api/cloud/model-signins/(?:chatgpt|supergrok)`), label: "Remove a model connection from your Cloud home" },
  { methods: ANY, path: /^\/api\/cloud\/own-server(?:\/(?:confirm|test))?$/, label: "Change the server your bots use as a computer" },
  { methods: ANY, path: /^\/api\/engine-login\/(?:codex|claudeAgent|grokAgent|kimiAgent|opencodeGo)$/, label: "Sign in or out of an engine on your Cloud home" },

  // Bots.
  { methods: ["POST"], path: rx("/api/bots"), label: "Create a bot", summary: "bot" },
  { methods: ["DELETE"], path: rx(`/api/bots/${ID}`), label: "Delete a bot and its conversations", summary: "bot" },
  { methods: ["PATCH"], path: rx(`/api/bots/${ID}`), label: "Change a bot's settings", summary: "settings" },
  { methods: ["PATCH"], path: rx(`/api/bots/${ID}/profile`), label: "Change a bot's name, personality or voice", summary: "settings" },
  { methods: ["POST", "PATCH"], path: rx(`/api/bots/${ID}/tasks/${ID}`), label: "Change a task of a bot", summary: "settings" },
  // 1.0.8 A-UI: a raised default applied to the bot's open chats, after its preview.
  { methods: ["POST"], path: rx(`/api/bots/${ID}/permissions/refresh`), label: "Give the bot's open chats its new default permissions" },
  // 1.0.4 SL-K / SL-I: copy the bot's permissions onto one chat, and the engine that takes over at the bot's limit.
  { methods: ["POST"], path: rx(`/api/bots/${ID}/tasks/${ID}/permissions/refresh`), label: "Give a chat the bot's current permissions" },
  { methods: ["PUT", "DELETE"], path: rx(`/api/bots/${ID}/limit-backup`), label: "Change the engine that takes over when a bot hits its limit" },
  { methods: ANY, path: rx(`/api/bots/${ID}/access`), label: "Change who can ask a bot to work", summary: "settings" },
  { methods: ANY, path: rx(`/api/bots/${ID}/sharing`), label: "Change how a bot is shared", summary: "settings" },
  { methods: ["POST"], path: rx(`/api/bots/${ID}/sharing/skills`), label: "Share a bot's skills", summary: "settings" },
  { methods: ["POST"], path: rx(`/api/bots/${ID}/sharing/copy`), label: "Make a copy of a bot for a team", summary: "settings" },
  { methods: ["POST"], path: rx(`/api/bots/${ID}/always-allow(?:/remove)?`), label: "Change what a bot is always allowed to do", summary: "settings" },
  { methods: ["POST"], path: rx(`/api/bots/${ID}/task-allow/(?:remove|clear)`), label: "Take back what a bot was allowed to do for a task" },
  { methods: ["POST"], path: rx(`/api/bots/${ID}/(?:assistant-profile|skills|skills/library)`), label: "Change a bot's skills", summary: "settings" },
  { methods: ANY, path: rx(`/api/bots/${ID}/skills/[a-z0-9-]+(?:/history|/rollback)?`), label: "See, switch on or off, or remove a bot's skill, or restore an earlier version", summary: "settings" },
  { methods: ["POST"], path: rx(`/api/bots/${ID}/held-continuations/${ID}/retry`), label: "Let a bot continue a paused step" },
  { methods: ["POST"], path: rx(`/api/restore-holds/(?:output_receipt|shared_result)/${ID}/release`), label: "Release an item held back when you restored your data" },
  { methods: ["PATCH"], path: rx(`/api/bots/${ID}/message-allow`), label: "Change who a bot can message", summary: "settings" },
  { methods: ["POST"], path: rx(`/api/bots/${ID}/secret-cards/${ID}/(?:provided|resume|dismiss|value)`), label: "Answer a bot's request for a key" },
  { methods: ANY, path: rx(`/api/bots/${ID}/connector-cards/${ID}/(?:authorize|status|timeout|resume|dismiss)`), label: "Answer a bot's request to connect an app" },
  { methods: ["POST"], path: rx(`/api/bots/${ID}/mcp-sign-in-cards/${ID}/(?:resume|dismiss)`), label: "Answer a bot's request to sign in to a tool" },
  // 1.0.4 MCP-118-175: Turn on (or Not now) for a tool server a bot added switched off.
  { methods: ["POST"], path: rx(`/api/bots/${ID}/mcp-enable-cards/${ID}/(?:enable|dismiss)`), label: "Turn on a tool server a bot added" },
  { methods: ANY, path: rx(`/api/bots/${ID}/published-sites(?:/${ID}/take-down)?`), label: "Change or take down a site a bot published" },
  { methods: ["POST"], path: rx(`/api/bots/${ID}/computer/join`), label: "Open a bot's cloud computer" },
  { methods: ["POST"], path: rx(`/api/bots/${ID}/computer/(?:provision|sleep|exec|screenshot|remove)`), label: "Control a bot's cloud computer" },
  { methods: ANY, path: rx(`/api/bots/${ID}/local-computer(?:/run|/stop|/remove|/screenshot|/keepalive)?`), label: "Control a bot's host computer" },
  { methods: ANY, path: /^\/api\/bots\/[^/]+\/browser-extension\/(?:activity|mode|sites|check|start-task)$/, label: "Change a bot's browser access" },
  { methods: ANY, path: rx("/api/browser-extension/clients"), label: "Turn outside app access to your browser on or off, add an outside app (this adds a bot), or remove one" },
  { methods: ANY, path: rx("/api/browser/linux-sandbox/enable"), label: "Enable the bot browser on this Linux computer" },

  // Teams, projects and groups.
  { methods: ["PATCH"], path: rx(`/api/groups/${ID}/project/budget`), label: "Change a project's budget", summary: "settings" },
  { methods: ["POST"], path: rx(`/api/groups/${ID}/project/budget`), label: "Set a project's budget", summary: "settings" },
  { methods: ["PUT"], path: rx(`/api/groups/${ID}/project/work-roots`), label: "Choose the folders a project can work in" },
  { methods: ["PATCH"], path: rx(`/api/groups/${ID}/project/work-profile`), label: "Change a project's work profile", summary: "settings" },
  { methods: ["PATCH"], path: rx(`/api/groups/${ID}/project/settings`), label: "Change a project's settings", summary: "settings" },
  // CROSS-CHAT-READ: the owner's answer on a share card, and the owner's ask from a room's composer.
  { methods: ["POST"], path: rx(`/api/room-shares/${ID}/(?:share|decline)`), label: "Share or keep private what a bot found in its other chats" },
  { methods: ["POST"], path: rx(`/api/groups/${ID}/room-shares`), label: "Ask a bot to look in its other chats for this room" },
  { methods: ["PATCH"], path: rx(`/api/groups/${ID}`), label: "Change a team or group", summary: "settings" },
  { methods: ["DELETE"], path: rx(`/api/groups/${ID}`), label: "Delete a team or group" },
  { methods: ["POST"], path: /^\/api\/teams\/(?:import|export)$/, label: "Import or export a team" },
  { methods: ["POST"], path: rx("/api/team-library/github"), label: "Download a team from GitHub" },
  { methods: ["POST"], path: rx("/api/team-library/grok"), label: "Bring in a Grok Bot" },
  { methods: ["POST"], path: /^\/api\/packages\/(?:import|export)$/, label: "Import or export a package" },
  { methods: ["POST"], path: rx("/api/starter-profiles"), label: "Install a starter profile" },
  { methods: ANY, path: /^\/api\/(?:move|lend)\/(?:commit|undo|scopes).*$/, label: "Move or lend a bot's work between teams" },

  // Settings and connections. Names of what changes are shown; values never are.
  { methods: ["PATCH", "PUT"], path: rx("/api/config"), label: "Change app settings", summary: "settings" },
  { methods: ANY, path: /^\/api\/flux-connection(?:\/.*)?$/, label: "Change your Flux connection", summary: "none" },
  { methods: ANY, path: /^\/api\/provider-connections(?:\/.*)?$/, label: "Change a model provider connection", summary: "none" },
  { methods: ANY, path: /^\/api\/local-models(?:\/.*)?$/, label: "Change the local models", summary: "none" },
  { methods: ANY, path: /^\/api\/claude-accounts(?:\/.*)?$/, label: "Change a Claude account", summary: "none" },
  { methods: ANY, path: /^\/api\/(?:telegram|slack|discord)\/(?:status|pair|resume|revoke)$/, label: "Change a Telegram, Slack or Discord connection", summary: "none" },
  { methods: ANY, path: /^\/api\/whatsapp\/(?:status|link|approve|dismiss|resume|revoke|unlink|groups)$/, label: "Change the WhatsApp connection", summary: "none" },
  { methods: ANY, path: /^\/api\/memory(?:\/.*)?$/, label: "Change memory", summary: "settings" },
  { methods: ANY, path: /^\/api\/skills(?:\/.*)?$/, label: "Change the skills collection", summary: "settings" },
  { methods: ANY, path: /^\/api\/mcp\/servers(?:\/.*)?$/, label: "Install or change a tool server", summary: "settings" },
  { methods: ["POST"], path: rx("/api/mcp/inspect"), label: "Check a tool server" },
  { methods: ANY, path: rx("/api/folder-trust"), label: "Change which folders an engine trusts" },
  { methods: ANY, path: /^\/api\/local-computer(?:\/.*)?$/, label: "Control the host computer" },
  { methods: ["POST"], path: rx("/api/cli-test"), label: "Run this program to see if it starts", summary: "program" },
  { methods: ["GET", "POST"], path: rx(String.raw`/api/engine-management/[\w.-]+`), label: "Install or change an engine" },
  { methods: ["PATCH"], path: rx(String.raw`/api/instances/[\w.-]+`), label: "Change how an engine starts", summary: "settings" },
  { methods: ["POST"], path: rx(String.raw`/api/instances/[\w.-]+/claude-update`), label: "Update Claude Code" },
  { methods: ["POST"], path: rx("/api/hermes/profiles/import"), label: "Add Hermes profiles as engines" },
  // 1.0.14 engine sign-in and set-up check (desktop only; route-policy marks them step-up).
  { methods: ["POST"], path: rx("/api/engine-setup-check"), label: "Check that an engine can answer" },
  { methods: ["POST"], path: rx("/api/engine-signin-recipe"), label: "Start signing in to an engine" },
  { methods: ["POST"], path: rx("/api/engine-signin-probe"), label: "Check whether an engine is signed in" },
  // 1.0.9 bot email owner routes (server/email/owner-routes.ts); route-policy marks all of /api/email/ step-up.
  { methods: ["POST"], path: rx("/api/email/account"), label: "Turn bot email on or off for this account", summary: "none" },
  { methods: ["POST"], path: rx(`/api/email/other-setups/${ID}/remove`), label: "Remove an email address from another setup", summary: "none" },
  { methods: ["POST"], path: rx(`/api/email/bots/${ID}/[a-z-]+`), label: "Change a bot's email address or who can email it", summary: "none" },
  { methods: ANY, path: /^\/api\/email(?:\/.*)?$/, label: "Change bot email", summary: "none" },
  // 1.0.18 HighLevel owner routes (server/index.ts, read only); route-policy marks every write under /api/highlevel credential.
  // summary "none": the body is never described, so no location id or token detail reaches the confirmation.
  { methods: ["POST"], path: rx("/api/highlevel/token/check"), label: "Check a HighLevel location", summary: "none" },
  { methods: ["POST"], path: rx("/api/highlevel/token/[0-9a-f-]{36}/confirm"), label: "Connect a HighLevel location", summary: "none" },
  { methods: ["PUT"], path: rx(`/api/highlevel/bots/${ID}/access`), label: "Change what a bot can read in HighLevel", summary: "none" },
  { methods: ["DELETE"], path: rx("/api/highlevel/connections/hl_[A-Za-z0-9]{4,64}"), label: "Disconnect your HighLevel location", summary: "none" },
  { methods: ANY, path: /^\/api\/highlevel(?:\/.*)?$/, label: "Change your HighLevel connection", summary: "none" },
  // 1.0.4 SL-H: route-policy denies this on every Cloud home; the label is here so the sentence is never the fallback.
  { methods: ["POST"], path: rx("/api/storage/attachments/remove"), label: "Remove attachment files for good" },
  { methods: ["POST"], path: rx("/api/publish/netlify/check"), label: "Check a Netlify connection", summary: "none" },
  // 1.0.17 C31: route-policy allows this on the paired owner desktop only, after step-up.
  { methods: ["POST"], path: rx("/api/tts/voices/add"), label: "Add a Voice Library voice to your ElevenLabs account", summary: "none" },
  { methods: ["GET", "POST"], path: rx("/api/mcp-grants"), label: "Create script access for a bot", summary: "settings" },
  { methods: ["DELETE"], path: rx(`/api/mcp-grants/${ID}`), label: "Turn off an access permission for scripts" },
  // BOT-CALLS: owner setup, settings, cancellation and sharing. Never summarize credentials or call contents.
  { methods: ANY, path: /^\/api\/phone-calls(?:\/|$)/, label: "Manage bot phone calls", summary: "none" },
  // 1.0.9 bot calls: the owner's call settings, from a chat-only Cloud browser.
  { methods: ["PUT"], path: rx(`/api/bots/${ID}/calls/rules`), label: "Change when a bot can call you", summary: "bot" },
  { methods: ["POST"], path: rx("/api/calls/off-today"), label: "Turn bot calls off for today" },
  { methods: ["POST"], path: rx("/api/no-limits/terms"), label: "Accept the No limits terms" },
  { methods: ["POST"], path: rx("/api/calls/rearm"), label: "Turn bot calls back on" },
  // 1.0.14: Call me when this finishes.
  { methods: ["POST"], path: rx("/api/calls/turn-end"), label: "Call you when this task finishes" },

  // Routines, webhooks, connectors.
  { methods: ["POST"], path: rx("/api/routines"), label: "Create a routine", summary: "settings" },
  { methods: ["POST"], path: rx(`/api/routines/${ID}/run`), label: "Run a routine now" },
  { methods: ["POST"], path: rx(`/api/routines/${ID}/always-allow(?:/remove)?`), label: "Change what a routine is always allowed to do" },
  { methods: ["PATCH"], path: rx(`/api/routines/${ID}`), label: "Change a routine", summary: "settings" },
  { methods: ["DELETE"], path: rx(`/api/routines/${ID}`), label: "Delete a routine" },
  { methods: ["GET", "POST"], path: rx("/api/webhooks"), label: "Create or list external triggers", summary: "settings" },
  { methods: ["PATCH", "DELETE"], path: rx(`/api/webhooks/${ID}`), label: "Change or delete an external trigger", summary: "settings" },
  { methods: ["POST"], path: rx(`/api/webhooks/${ID}/(?:rotate|test)`), label: "Change an external trigger's key or test the trigger" },
  { methods: ["POST"], path: rx(`/api/connectors/${ID}/authorize`), label: "Connect an app" },
  { methods: ["DELETE"], path: rx(`/api/connectors/${ID}(?:/accounts/[A-Za-z0-9][A-Za-z0-9_-]{0,127})?`), label: "Disconnect an app" },
]);

export const FALLBACK_LABEL = "Make a change on your Cloud home";

/** English label text to its pack key ("label.*" in electron/locales/step-up/en.json). */
const LABEL_KEYS = new Map(Object.entries(STEP_UP_EN).filter(([key]) => key.startsWith("label.")).map(([key, text]) => [text, key]));
/** The pack key of an English label, or null when en.json lacks it (the test fails that). */
export function stepUpLabelKey(label) {
  return LABEL_KEYS.get(label) ?? null;
}
/** A label in a language: the pack's words, or the English label itself when no key or translation exists. */
function localLabel(label, t) {
  const key = stepUpLabelKey(label);
  return key ? t(key) || label : label;
}

/** Body flags the home treats as raising authority (server/route-policy.ts `elevated`), as pack keys for the words a person would use. */
const ELEVATED_FLAGS = Object.freeze({
  fullAccess: "flag.fullAccess", noLimits: "flag.noLimits", acknowledgeFullAccess: "flag.fullAccess", acknowledgeNoLimits: "flag.noLimits",
  fullAccessChannelMessages: "flag.fullAccessChannelMessages", fullAccessSetupRequests: "flag.fullAccessSetupRequests",
  autoApprove: "flag.autoApprove", acknowledgeLocalAuto: "flag.localAuto",
});
const WIRE_ONLY = new Set(["acknowledgeFullAccess", "acknowledgeNoLimits", "acknowledgeLocalAuto", "settingsScope"]);

// Cut on whole graphemes (cutWhole), so a long name never ends in half an emoji or a letter without its accent.
// Every Unicode direction mark (Bidi_Control: U+061C, U+200E, U+200F, U+202A-U+202E, U+2066-U+2069) is removed, the
// same class the language packs refuse (step-up-locale.mjs usableText), so a name cannot reorder the line around it.
const clean = (value, max = 60) => cutWhole(String(value).replace(/[\u0000-\u001f\u007f-\u009f\p{Bidi_Control}]/gu, " ").replace(/\s+/g, " ").trim(), max).trim();
const stripQuery = (path) => String(path).split("?")[0].split("#")[0];
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** The label table entry for a request, or null. */
export function findStepUpLabel(method, path) {
  const verb = String(method).toUpperCase();
  const target = stripQuery(path);
  return STEP_UP_LABELS.find((entry) => (entry.methods === ANY || entry.methods.includes(verb)) && entry.path.test(target)) ?? null;
}

/** The bot id in a /api/bots/<id>... path, or null. */
export function botIdOfPath(path) {
  return /^\/api\/(?:email\/)?bots\/([\w-]+)(?:\/|$)/.exec(stripQuery(path))?.[1] ?? null;
}

function elevatedFrom(body, t) {
  const named = new Set();
  if (!isPlainObject(body)) return [];
  for (const [key, textKey] of Object.entries(ELEVATED_FLAGS)) if (body[key] === true) named.add(t(textKey));
  if (typeof body.permissionMode === "string" && ["auto", "full", "unlimited"].includes(body.permissionMode)) named.add(t("flag.permissionMode", { mode: clean(body.permissionMode, 20) }));
  if (body.computer === "local") named.add(t("flag.hostComputerBot"));
  if (body.hostComputerConsent === "allowed") named.add(t("flag.hostComputerConsent"));
  if (Object.hasOwn(body, "alwaysAllow")) named.add(t("flag.alwaysAllow"));
  return [...named];
}

/**
 * The lines under the label. `names` is an optional resolver result (the bot's display name).
 * Setting NAMES are listed, never values, so a key or token in a body is never put on screen.
 * `language` picks the words (step-up-locale.mjs); ids, setting names, the key fingerprint and the request stay as sent.
 */
/**
 * The longest name or id the dialog shows whole (UTF-16 units), the most setting names it lists, the longest setting
 * name it shows whole (UTF-16 units), and the most setting names Touch ID's one line may carry: a longer list always
 * uses the dialog (STEPUP-LOOKUPS-R2-1018 rules 4 and 4b).
 */
export const SHOW_MAX = 300;
export const SETTINGS_MAX = 40;
export const SETTING_NAME_MAX = 40;
export const TOUCH_ID_SETTINGS_MAX = 8;

export function summarizeStepUpBody(input) {
  return summarize(input).lines;
}

/** The longest program location the dialog shows (UTF-16 units). A longer one is refused, never cut: a cut can hide the real file name. */
export const PROGRAM_SHOW_MAX = 300;
// What the dialog can show exactly: printable ASCII but "&" (a Windows dialog may read it as a shortcut marker, hide it and
// underline the next letter) and the left-to-right scripts named here. Script_Extensions, so a
// combining mark counts only when it belongs to one of these scripts. Everything else is refused, so a character added
// to Unicode or a right-to-left script no one listed fails closed: controls, line separators, lone surrogates, the
// replacement character, and right-to-left letters, marks and digits such as Hebrew and Arabic, which reorder a path on screen.
const SHOWN_EXACTLY = /^[\x20-\x25\x27-\x7E\p{scx=Latin}\p{scx=Greek}\p{scx=Cyrillic}\p{scx=Armenian}\p{scx=Georgian}\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}\p{scx=Devanagari}]+$/u;
// Some of those carry characters that cannot be seen or look like a plain space: bidi marks, zero-width characters,
// tag and variation characters, any space but U+0020.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Bidi_Control}\p{Default_Ignorable_Code_Point}]|[^\P{Zs} ]/u;

/**
 * POST /api/cli-test spawns body.cli on the home (server/index.ts), so the person approving must see that exact value.
 * Returns it unchanged, or null when it cannot be shown exactly: then the action is refused (describeStepUp `refused`).
 * The server trims the value, so an untrimmed one would run as something other than what is shown.
 */
export function programToShow(body) {
  const value = isPlainObject(body) ? body.cli : undefined;
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > PROGRAM_SHOW_MAX || !SHOWN_EXACTLY.test(value) || INVISIBLE.test(value)) return null;
  return value;
}

/**
 * The summary lines, and `cut`: whether anything in them was shortened (so Touch ID is not enough and the dialog
 * marks it). Names and ids are shown whole up to SHOW_MAX, setting names up to SETTING_NAME_MAX, and up to
 * SETTINGS_MAX of them; past that the text is cut on a whole grapheme and marked "..." (a list: "+N"), never shortened
 * silently. A list over TOUCH_ID_SETTINGS_MAX is shown whole in the dialog but counts as `cut`, so Touch ID is not used.
 */
/** The line must carry the program: a pack or en.json line without exactly one {path} gives way to the built-in words. */
export function programLine(t, program) {
  if (t("line.program").split("{path}").length === 2) return t("line.program", { path: program });
  return STEP_UP_BASELINE["line.program"].replace("{path}", () => program);
}

function summarize({ path, body, summary, botName, language = "en" }) {
  const t = stepUpText(language);
  // The one line that shows a body value, byte for byte. `cut`, so it always uses the dialog: Touch ID's one line belongs
  // to the system, which may shorten it.
  if (summary === "program") {
    const program = programToShow(body);
    return { lines: program === null ? [] : [programLine(t, program)], cut: true };
  }
  const lines = [];
  let cut = false;
  const c = (value, max = SHOW_MAX) => { const whole = clean(value, Infinity); if (whole.length <= max) return whole; cut = true; return `${cutWhole(whole, max - 3).trim()}...`; };
  const botId = botIdOfPath(path);
  if (botId || (isPlainObject(body) && typeof body.name === "string" && summary === "bot")) {
    const display = botName ? `${c(botName)} (${c(botId ?? "")})` : c(botId ?? body.name);
    lines.push(t("line.bot", { bot: display }));
    // A change to an existing bot's name is part of what is approved: shown as its own line.
    if (botId && isPlainObject(body) && typeof body.name === "string") lines.push(t("line.name", { name: c(body.name) }));
  } else if (isPlainObject(body) && typeof body.name === "string" && body.name && summary !== "none") {
    lines.push(t("line.name", { name: c(body.name) }));
  }
  if (summary === "device" && isPlainObject(body)) {
    lines.push(t("line.deviceType", { type: body.scope == null ? t("line.unknown") : c(body.scope) }));
    lines.push(t("line.deviceKey", { key: typeof body.publicKey === "string" && body.publicKey ? fingerprint(body.publicKey) : t("line.unknown") }));
  }
  if ((summary === "settings" || summary === "bot") && isPlainObject(body)) {
    const all = Object.keys(body).filter((key) => key !== "name" && !WIRE_ONLY.has(key) && !Object.hasOwn(ELEVATED_FLAGS, key));
    const keys = all.slice(0, SETTINGS_MAX);
    if (all.length > TOUCH_ID_SETTINGS_MAX) cut = true;
    if (keys.length) lines.push(t("line.settings", { names: `${keys.map((key) => c(key, SETTING_NAME_MAX)).join(", ")}${all.length > keys.length ? `, +${all.length - keys.length}` : ""}` }));
  }
  const elevated = elevatedFrom(body, t);
  if (elevated.length) lines.push(t("line.turnsOn", { flags: elevated.join(", ") }));
  return { lines, cut };
}

/** Short stable fingerprint of a PEM public key, for "is this the device in front of me". */
export function fingerprint(publicKey) {
  if (typeof publicKey !== "string" || !publicKey) return "unknown";
  let hash = 0x811c9dc5;
  for (const char of publicKey) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(16).padStart(8, "0").replace(/(.{4})(.{4})/, "$1-$2");
}

/**
 * The longest Touch ID reason, in characters (UTF-16 units, as Electron passes the string to LAContext).
 * Neither Apple (LAContext evaluatePolicy localizedReason: "Make the message short and clear") nor Microsoft
 * (TASKDIALOGCONFIG pszMainInstruction / pszContent) documents a hard maximum; 200 is this app's own ceiling, so a long
 * bot name can never push the action off a small prompt. The label always comes first and is never cut.
 */
export const REASON_MAX = 200;

const GRAPHEME_EXTEND = String.raw`[\p{M}\p{Emoji_Modifier}\u{E0020}-\u{E007F}]*`;
const GRAPHEME_FALLBACK = new RegExp(String.raw`[\u{1F1E6}-\u{1F1FF}]{2}|\P{M}${GRAPHEME_EXTEND}(?:\p{Join_Control}\P{M}${GRAPHEME_EXTEND}|(?<=[्্੍્୍్್്])\p{L}${GRAPHEME_EXTEND})*|[\p{M}\p{Emoji_Modifier}]+`, "gu");

/** `text` cut to at most `max` UTF-16 units on a whole grapheme, so no letter, accent or emoji is split. */
export function cutWhole(text, max) {
  if (text.length <= max) return text;
  let out = "";
  // Electron always has Intl.Segmenter. The fallback keeps together what a cut could otherwise split: a letter and its
  // marks, skin-tone modifiers, flag pairs, tag-sequence flags, emoji joined by ZWJ and Indic conjuncts (virama + letter).
  const parts = typeof Intl.Segmenter === "function" ? Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (s) => s.segment)
    : (text.match(GRAPHEME_FALLBACK) ?? []);
  for (const part of parts) { if (out.length + part.length > max) break; out += part; }
  return out;
}

/**
 * Everything a confirmation shows, in `language` (step-up-locale.mjs; English by default).
 * @returns {{ label: string, known: boolean, request: string, lines: string[], message: string, reason: string, reasonComplete: boolean, refused: boolean }}
 *   `message`: the dialog body; `reason`: one line (<= REASON_MAX chars) for Touch ID; `reasonComplete`: that line
 *   was not cut (Touch ID may be used only then); `refused`: this cannot be approved, because what would run cannot be
 *   shown exactly (programToShow).
 */
export function describeStepUp({ method, path, body, botName, language = "en" }) {
  const t = stepUpText(language);
  const verb = String(method).toUpperCase();
  const target = stripQuery(path);
  const entry = findStepUpLabel(verb, target);
  const label = localLabel(entry?.label ?? FALLBACK_LABEL, t);
  const { lines, cut } = summarize({ path: target, body, summary: entry?.summary, botName, language });
  // The request line: method and path as sent. A query is never shown (it can hold a token) but is marked "?...",
  // and a path too long to show is marked "...", so nothing is shortened silently.
  const shownPath = clean(target, 120);
  const request = `${verb} ${shownPath}${shownPath !== clean(target, Infinity) ? "..." : ""}${String(path).includes("?") ? "?..." : ""}`;
  const message = [label, ...lines, "", request].join("\n");
  // Touch ID shows one line: the label, then what the change turns on (Full access, No limits ...), then every other
  // summary line (which bot, the device type and key, the settings).
  const turnsOn = lines.find((line) => line === t("line.turnsOn", { flags: elevatedFrom(body, t).join(", ") }));
  const parts = [...new Set([turnsOn, ...lines].filter(Boolean))].join("; ");
  const room = REASON_MAX - label.length - 3; // " (" and ")"
  const detail = parts && room > 3 ? (parts.length <= room ? parts : `${cutWhole(parts, room - 3)}...`) : "";
  const reason = detail ? `${label} (${detail})` : label;
  // `reasonComplete`: a known action whose one line holds the whole label and every summary line, nothing in them
  // shortened. Otherwise (an unknown route included, whose request line Touch ID cannot show) the Confirm dialog is
  // used and shows everything (createNativeStepUpConfirm).
  const reasonComplete = Boolean(entry) && !cut && detail === parts && reason.length <= REASON_MAX;
  const refused = entry?.summary === "program" && programToShow(body) === null;
  return { label, known: Boolean(entry), request, lines, message, reason: cutWhole(reason, REASON_MAX), reasonComplete, refused };
}
