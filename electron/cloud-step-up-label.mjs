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
  // 1.0.4 SL-K / SL-I: copy the bot's permissions onto one chat, and the engine that takes over at the bot's limit.
  { methods: ["POST"], path: rx(`/api/bots/${ID}/tasks/${ID}/permissions/refresh`), label: "Give a chat the bot's current permissions" },
  { methods: ["PUT", "DELETE"], path: rx(`/api/bots/${ID}/limit-backup`), label: "Change the engine that takes over when a bot hits its limit" },
  { methods: ANY, path: rx(`/api/bots/${ID}/access`), label: "Change who can ask a bot to work", summary: "settings" },
  { methods: ANY, path: rx(`/api/bots/${ID}/sharing`), label: "Change how a bot is shared", summary: "settings" },
  { methods: ["POST"], path: rx(`/api/bots/${ID}/sharing/skills`), label: "Share a bot's skills", summary: "settings" },
  { methods: ["POST"], path: rx(`/api/bots/${ID}/sharing/copy`), label: "Make a copy of a bot for a team", summary: "settings" },
  { methods: ["POST"], path: rx(`/api/bots/${ID}/always-allow(?:/remove)?`), label: "Change what a bot is always allowed to do", summary: "settings" },
  { methods: ["POST"], path: rx(`/api/bots/${ID}/(?:assistant-profile|skills|skills/library)`), label: "Change a bot's skills", summary: "settings" },
  { methods: ANY, path: rx(`/api/bots/${ID}/skills/[a-z0-9-]+(?:/history|/rollback)?`), label: "Change or roll back a bot's skill", summary: "settings" },
  { methods: ["POST"], path: rx(`/api/bots/${ID}/held-continuations/${ID}/retry`), label: "Let a held step of a bot continue" },
  { methods: ["POST"], path: rx(`/api/restore-holds/(?:output_receipt|shared_result)/${ID}/release`), label: "Release an item your restore kept" },
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
  { methods: ANY, path: rx("/api/browser-extension/clients"), label: "Pair or remove a browser client" },
  { methods: ANY, path: rx("/api/browser/linux-sandbox/enable"), label: "Enable the bot browser on this Linux computer" },

  // Teams, projects and groups.
  { methods: ["PATCH"], path: rx(`/api/groups/${ID}/project/budget`), label: "Change a project's budget", summary: "settings" },
  { methods: ["POST"], path: rx(`/api/groups/${ID}/project/budget`), label: "Set a project's budget", summary: "settings" },
  { methods: ["PUT"], path: rx(`/api/groups/${ID}/project/work-roots`), label: "Choose the folders a project can work in" },
  { methods: ["PATCH"], path: rx(`/api/groups/${ID}/project/work-profile`), label: "Change a project's work profile", summary: "settings" },
  { methods: ["PATCH"], path: rx(`/api/groups/${ID}/project/settings`), label: "Change a project's settings", summary: "settings" },
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
  { methods: ["POST"], path: rx("/api/cli-test"), label: "Run a command-line check" },
  { methods: ["GET", "POST"], path: rx(String.raw`/api/engine-management/[\w.-]+`), label: "Install or change an engine" },
  { methods: ["PATCH"], path: rx(String.raw`/api/instances/[\w.-]+`), label: "Change how an engine starts", summary: "settings" },
  { methods: ["POST"], path: rx(String.raw`/api/instances/[\w.-]+/claude-update`), label: "Update Claude Code" },
  { methods: ["POST"], path: rx("/api/hermes/profiles/import"), label: "Add Hermes profiles as engines" },
  // 1.0.4 SL-H: route-policy denies this on every Cloud home; the label is here so the sentence is never the fallback.
  { methods: ["POST"], path: rx("/api/storage/attachments/remove"), label: "Remove attachment files for good" },
  { methods: ["POST"], path: rx("/api/publish/netlify/check"), label: "Check a Netlify connection", summary: "none" },
  { methods: ["GET", "POST"], path: rx("/api/mcp-grants"), label: "Create script access for a bot", summary: "settings" },
  { methods: ["DELETE"], path: rx(`/api/mcp-grants/${ID}`), label: "Switch off a script access" },

  // Routines, webhooks, connectors.
  { methods: ["POST"], path: rx("/api/routines"), label: "Create a routine", summary: "settings" },
  { methods: ["POST"], path: rx(`/api/routines/${ID}/run`), label: "Run a routine now" },
  { methods: ["POST"], path: rx(`/api/routines/${ID}/always-allow(?:/remove)?`), label: "Change what a routine is always allowed to do" },
  { methods: ["PATCH"], path: rx(`/api/routines/${ID}`), label: "Change a routine", summary: "settings" },
  { methods: ["DELETE"], path: rx(`/api/routines/${ID}`), label: "Delete a routine" },
  { methods: ["GET", "POST"], path: rx("/api/webhooks"), label: "Create or list external triggers", summary: "settings" },
  { methods: ["PATCH", "DELETE"], path: rx(`/api/webhooks/${ID}`), label: "Change or delete an external trigger", summary: "settings" },
  { methods: ["POST"], path: rx(`/api/webhooks/${ID}/(?:rotate|test)`), label: "Rotate or test an external trigger" },
  { methods: ["POST"], path: rx(`/api/connectors/${ID}/authorize`), label: "Connect an app" },
  { methods: ["DELETE"], path: rx(`/api/connectors/${ID}(?:/accounts/[A-Za-z0-9][A-Za-z0-9_-]{0,127})?`), label: "Disconnect an app" },
]);

export const FALLBACK_LABEL = "Make a change on your Cloud home";

/** Body flags the home treats as raising authority (server/route-policy.ts `elevated`), with the words a person would use. */
const ELEVATED_FLAGS = Object.freeze({
  fullAccess: "Full access", noLimits: "No limits", acknowledgeFullAccess: "Full access", acknowledgeNoLimits: "No limits",
  fullAccessChannelMessages: "Full access for channel messages", fullAccessSetupRequests: "Full access for setup requests",
  autoApprove: "Auto-approve", acknowledgeLocalAuto: "Auto-approve on the host computer",
});
const WIRE_ONLY = new Set(["acknowledgeFullAccess", "acknowledgeNoLimits", "acknowledgeLocalAuto", "settingsScope"]);

const clean = (value, max = 60) => String(value).replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
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
  return /^\/api\/bots\/([\w-]+)(?:\/|$)/.exec(stripQuery(path))?.[1] ?? null;
}

function elevatedFrom(body) {
  const named = new Set();
  if (!isPlainObject(body)) return [];
  for (const [key, label] of Object.entries(ELEVATED_FLAGS)) if (body[key] === true) named.add(label);
  if (typeof body.permissionMode === "string" && ["auto", "full", "unlimited"].includes(body.permissionMode)) named.add(`Permission mode "${clean(body.permissionMode, 20)}"`);
  if (body.computer === "local") named.add("A bot using the host computer");
  if (body.hostComputerConsent === "allowed") named.add("Host computer access");
  if (Object.hasOwn(body, "alwaysAllow")) named.add("An always-allow rule");
  return [...named];
}

/**
 * The lines under the label. `names` is an optional resolver result (the bot's display name).
 * Setting NAMES are listed, never values, so a key or token in a body is never put on screen.
 */
export function summarizeStepUpBody({ method, path, body, summary, botName }) {
  const lines = [];
  const botId = botIdOfPath(path);
  if (botId || (isPlainObject(body) && typeof body.name === "string" && summary === "bot")) {
    const display = botName ? `${clean(botName)} (${clean(botId ?? "", 40)})` : clean(botId ?? body.name);
    lines.push(`Bot: ${display}`);
  } else if (isPlainObject(body) && typeof body.name === "string" && body.name && summary !== "none") {
    lines.push(`Name: ${clean(body.name)}`);
  }
  if (summary === "device" && isPlainObject(body)) {
    lines.push(`Device type: ${clean(body.scope ?? "unknown", 20)}`);
    lines.push(`Device key: ${fingerprint(body.publicKey)}`);
  }
  if ((summary === "settings" || summary === "bot") && isPlainObject(body)) {
    const all = Object.keys(body).filter((key) => key !== "name" && !WIRE_ONLY.has(key) && !Object.hasOwn(ELEVATED_FLAGS, key));
    const keys = all.slice(0, 8);
    if (keys.length) lines.push(`Settings: ${keys.map((key) => clean(key, 32)).join(", ")}${all.length > keys.length ? ", ..." : ""}`);
  }
  const elevated = elevatedFrom(body);
  if (elevated.length) lines.push(`Turns on: ${elevated.join(", ")}`);
  return lines;
}

/** Short stable fingerprint of a PEM public key, for "is this the device in front of me". */
export function fingerprint(publicKey) {
  if (typeof publicKey !== "string" || !publicKey) return "unknown";
  let hash = 0x811c9dc5;
  for (const char of publicKey) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(16).padStart(8, "0").replace(/(.{4})(.{4})/, "$1-$2");
}

/**
 * Everything a confirmation shows.
 * @returns {{ label: string, known: boolean, request: string, lines: string[], message: string, reason: string }}
 *   `message`: the dialog body; `reason`: one line (<= 200 chars) for Touch ID.
 */
export function describeStepUp({ method, path, body, botName }) {
  const verb = String(method).toUpperCase();
  const target = stripQuery(path);
  const entry = findStepUpLabel(verb, target);
  const label = entry?.label ?? FALLBACK_LABEL;
  const lines = summarizeStepUpBody({ method: verb, path: target, body, summary: entry?.summary, botName });
  const request = `${verb} ${clean(target, 120)}`;
  const message = [label, ...lines, "", request].join("\n");
  const reason = `${label}${lines[0] ? ` (${lines[0]})` : ""}`.slice(0, 200);
  return { label, known: Boolean(entry), request, lines, message, reason };
}
