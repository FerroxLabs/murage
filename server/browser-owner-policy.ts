// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What a Cloud home's owner browser (scope `remembered-owner`) may do, route by route.
//
// The browser the owner signed in with an emailed code acts as the owner for setup, settings, credentials and everyday
// approvals, but it is never "the computer". Each request gets one of four tiers:
//
//   plain       allowed, no code.
//   fresh-door  durable reach for someone or something other than this browser (channels, script access, webhooks, taking
//               control). Plain within DOOR_FRESH_MS of the emailed door proof, otherwise a fresh emailed code.
//   code        a fresh 6-digit emailed code, bound to the exact request.
//   refused     never, whatever is proven.
//
// A request with no rule here is refused: a route added later stays closed until someone decides it. The rules are an
// ordered table, first match wins. Body markers (full access, no limits, a standing computer grant and so on) and field
// allowlists then raise the answer; they never lower it. route-policy.ts turns the answer into a decision and
// cloud-request-auth.ts into the 403 the page answers with a code dialog.
//
// browser-owner-policy.test.ts walks every ROUTE_POLICY entry against this table.

import { ENGINE_LOGIN_PATH } from "./cloud-home/engine-login-engines.ts";

export type BrowserOwnerTier = "plain" | "code" | "fresh-door" | "refused";

/** The fixed words the control plane puts in the code email. The wire contract (WIRE.md) lists exactly these. */
export const OWNER_CODE_LABELS = [
  "full_access", "allow_request", "folder_trust", "restore_release", "delete", "bot_reach", "new_skill", "mcp_server", "traffic_moved",
  "computer_viewer", "computer_command", "bot_widen", "device_remove", "config_change", "take_down_site", "fresh_door",
  "publish_allow", "other",
] as const;
export type OwnerCodeLabel = typeof OWNER_CODE_LABELS[number];

export interface BrowserOwnerAnswer {
  tier: BrowserOwnerTier;
  /** The email's fixed wording, for the code and fresh-door tiers. */
  label?: OwnerCodeLabel;
  /** One short cleaned word for the email (a bot name), at most 60 characters. */
  labelArg?: string;
  why: string;
}

export interface BrowserOwnerRule {
  methods: readonly string[] | "*";
  path: string | RegExp;
  tier: BrowserOwnerTier;
  why: string;
  label?: OwnerCodeLabel;
  /** The route has no ROUTE_POLICY entry: answered in cloud-request-auth.ts or added by a later lane. Without this flag a
   *  path with no entry is denied before the table is read. */
  entryless?: boolean;
  /** Raises or sets the answer from the request body. Returns nothing to keep the rule's own tier. */
  decide?: (input: { method: string; path: string; body: unknown; match: RegExpExecArray | null }) => Partial<BrowserOwnerAnswer> | undefined;
}

const ID = String.raw`[\w-]+`;
const WRITES = ["POST", "PUT", "PATCH", "DELETE"] as const;
const READS = ["GET", "HEAD", "OPTIONS"] as const;
const re = (source: string) => new RegExp(`^${source}$`);

/** The shipped starter profile ids (server/starter-profiles.ts STARTER_PROFILE_IDS; a test keeps the two equal). */
export const BROWSER_PLAIN_STARTER_PROFILE_IDS: readonly string[] = ["starter-personal-home", "starter-solo-business", "starter-business-team"];

const RANK: Record<BrowserOwnerTier, number> = { plain: 0, "fresh-door": 1, code: 2, refused: 3 };
const worse = (a: BrowserOwnerAnswer, b: BrowserOwnerAnswer): BrowserOwnerAnswer => RANK[b.tier] > RANK[a.tier] ? b : a;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

// ── body markers ────────────────────────────────────────────────────────────────────────────────────────────────────

const REFUSED_MARKERS: readonly RegExp[] = [
  /"noLimits"\s*:\s*true/, /"acknowledgeNoLimits"\s*:\s*true/, /"permissionMode"\s*:\s*"unlimited"/,
  /"computer"\s*:\s*"local"/, /"hostComputerConsent"\s*:\s*"allowed"/, /"acknowledgeLocalAuto"\s*:\s*true/, /"alwaysAllow"\s*:/,
];
const CODE_MARKERS: readonly RegExp[] = [
  /"(?:fullAccess|fullAccessChannelMessages|fullAccessSetupRequests|autoApprove)"\s*:\s*true/,
  /"acknowledge[A-Z][A-Za-z]*"\s*:\s*true/,
  /"permissionMode"\s*:\s*"(?:auto|full)"/,
];
const URL_MARKER = /"(?:baseUrl|base_url|baseURL|apiBase|endpoint|url)"\s*:/;

function markerAnswer(body: unknown): BrowserOwnerAnswer {
  const serialized = body !== null && typeof body === "object" ? JSON.stringify(body) : "";
  if (REFUSED_MARKERS.some(marker => marker.test(serialized))) return { tier: "refused", why: "A standing grant of the computer, no limits or an Always list: no code opens it." };
  if (CODE_MARKERS.some(marker => marker.test(serialized))) return { tier: "code", label: "full_access", why: "Turns off the Owner's cards for a bot: one fresh code." };
  return { tier: "plain", why: "" };
}

// ── field allowlists ────────────────────────────────────────────────────────────────────────────────────────────────

type FieldTier = BrowserOwnerTier | ((value: unknown) => BrowserOwnerTier);
interface FieldSpec { tier: FieldTier; label?: OwnerCodeLabel }
const plain: FieldSpec = { tier: "plain" };
const code = (label: OwnerCodeLabel): FieldSpec => ({ tier: "code", label });
const narrowing = (isNarrow: (value: unknown) => boolean, label: OwnerCodeLabel = "bot_widen"): FieldSpec => ({ tier: value => isNarrow(value) ? "plain" : "code", label });
const emptyish = (value: unknown) => value === false || value === null || value === "" || (Array.isArray(value) && value.length === 0);

/** PATCH /api/bots/:id, field by field (read from the handler in server/index.ts and parseBotProfilePatch). An unknown field is `code`. */
export const BOT_PATCH_FIELDS: Readonly<Record<string, FieldSpec>> = {
  // profile (server/bot-profile.ts)
  name: plain, title: plain, description: plain, persona: plain, notifications: plain, avatarUrl: plain, avatarCrop: plain, avatarZoom: plain, avatarFocusX: plain, avatarFocusY: plain, mascotBody: plain,
  voice: plain, voiceProvider: plain, speakReplies: plain,
  // the owner's ordinary settings
  sidebarHidden: plain, section: plain, unread: plain, color: plain, mascotExpression: plain, pinned: plain, hidden: plain, pinnedMessageId: plain,
  // previewId and ifRev only bind a level change to the preview and revision it was shown; the fields it changes are decided below
  previewId: plain, ifRev: plain, baseRevision: plain, disclosureKey: plain,
  modelSelection: plain, requireAvailableModel: plain, settingsScope: plain, cwd: plain, teamBrief: plain, aboutMe: plain, continuity: plain,
  continuityOptions: plain, composio: plain, browser: plain, chiefOfStaff: plain, chiefScope: plain, individual: plain, computer: plain,
  // the markers (value checked in markerAnswer): false and absent are plain
  autoApprove: plain, fullAccess: plain, noLimits: plain, acknowledgeFullAccess: plain, acknowledgeNoLimits: plain, acknowledgeLocalAuto: plain,
  hostComputerConsent: plain, alwaysAllow: plain,
  // reach: only the narrowing value is plain
  phoneApps: narrowing(emptyish), useMyChrome: narrowing(value => value === false), browserTransport: narrowing(value => value === null),
  browserChoice: code("bot_widen"), browserExtensionBrowser: code("bot_widen"),
  browserExtensionProfileId: narrowing(value => value === null), browserProfile: narrowing(value => value === null || value === "" || value === "guest"),
  approvePeerComms: narrowing(value => value === false),
  // widening
  autoReview: code("bot_widen"), cloudBackend: code("bot_widen"), autoStartVps: code("bot_widen"),
};
/** PATCH /api/bots/:id/tasks/:id and /api/groups/:id/tasks/:id (the handler's own supported list). */
export const TASK_PATCH_FIELDS: Readonly<Record<string, FieldSpec>> = {
  title: plain, modelSelection: plain, autoApprove: plain, fullAccess: plain, acknowledgeFullAccess: plain, noLimits: plain, acknowledgeNoLimits: plain,
  cwd: plain, unread: plain, pinned: plain, link: plain, requireAvailableModel: plain, acknowledgeLocalAuto: plain, ifRev: plain,
};
/** PATCH /api/groups/:id (the handler's body keys). */
export const GROUP_PATCH_FIELDS: Readonly<Record<string, FieldSpec>> = {
  name: plain, title: plain, section: plain, unread: plain, hidden: plain, pinnedMessageId: plain, bulletin: plain, defaultResponder: plain,
  memberIds: plain, cwd: plain, channelProject: code("bot_reach"),
};
/** The reach fields a new bot must not arrive with unless they narrow. POST /api/bots has no allowlist (first run creates bots with
 *  many fields), so only these widening names are checked there. */
const CREATE_WIDENING_FIELDS = ["phoneApps", "useMyChrome", "browserTransport", "browserExtensionProfileId", "browserProfile", "approvePeerComms", "autoReview", "cloudBackend", "autoStartVps"] as const;

type ConfigSpec = FieldSpec & { sub?: Readonly<Record<string, FieldSpec>>; subDefault?: FieldSpec };
const channelPair: FieldSpec = { tier: "fresh-door", label: "fresh_door" };
/** PUT and PATCH /api/config, top-level field by field (appConfigPatchSchema in server/config.ts). An unknown field is `code`. */
export const CONFIG_PATCH_FIELDS: Readonly<Record<string, ConfigSpec>> = {
  profile: plain, language: plain, notifications: plain, newBots: plain, automationsPaused: plain,
  webSearch: plain, tts: plain, imageGen: plain, composio: plain, box: plain, opencodeGo: plain,
  // a key is plain, a caller-chosen address moves every prompt
  xai: { tier: "code", sub: { key: plain }, subDefault: code("traffic_moved") },
  openaiCompat: { tier: "code", sub: { key: plain, model: plain, provider: plain }, subDefault: code("traffic_moved") },
  flux: { tier: "code", sub: { apiKey: plain, memory: plain }, subDefault: code("config_change") },
  decider: { tier: "code", sub: { enabled: plain, provider: plain, jobs: plain, byoKey: plain }, subDefault: code("traffic_moved") },
  // channel credentials and owner binding
  telegram: channelPair, slack: channelPair, discord: channelPair, whatsapp: channelPair,
  // not for a browser, or unknown
  spend: code("config_change"), highlevel: code("config_change"), computer: code("config_change"), claudeCodeImport: code("config_change"),
  features: code("config_change"), rooms: code("config_change"), localVm: code("config_change"), vps: code("config_change"),
  browserProfiles: code("config_change"), engineDiscovery: code("config_change"), modelProviders: code("config_change"),
};

function fieldAnswer(body: unknown, spec: Readonly<Record<string, FieldSpec>>, unknownLabel: OwnerCodeLabel, what: string): BrowserOwnerAnswer {
  let answer: BrowserOwnerAnswer = { tier: "plain", why: `${what}: every field is on the plain list.` };
  for (const [key, value] of Object.entries(object(body))) {
    const field = Object.hasOwn(spec, key) ? spec[key]! : undefined;
    const tier = field === undefined ? "code" : typeof field.tier === "function" ? field.tier(value) : field.tier;
    const label = field?.label ?? unknownLabel;
    answer = worse(answer, { tier, ...(tier === "plain" ? {} : { label }), why: field === undefined ? `${what}: "${key}" is not on the plain list.` : `${what}: "${key}" widens reach.` });
  }
  return answer;
}

function configAnswer(body: unknown): BrowserOwnerAnswer {
  let answer: BrowserOwnerAnswer = { tier: "plain", why: "Settings: every field is on the plain list." };
  for (const [key, value] of Object.entries(object(body))) {
    const field = Object.hasOwn(CONFIG_PATCH_FIELDS, key) ? CONFIG_PATCH_FIELDS[key]! : undefined;
    if (!field) { answer = worse(answer, { tier: "code", label: "config_change", why: `Settings: "${key}" is not on the plain list.` }); continue; }
    if (field.sub) {
      for (const subKey of Object.keys(object(value))) {
        const sub = Object.hasOwn(field.sub, subKey) ? field.sub[subKey]! : field.subDefault ?? { tier: "code" as const, label: "config_change" as const };
        const tier = typeof sub.tier === "function" ? sub.tier(undefined) : sub.tier;
        answer = worse(answer, { tier, ...(tier === "plain" ? {} : { label: sub.label ?? "config_change" }), why: `Settings: "${key}.${subKey}" ${tier === "plain" ? "is plain" : "needs a code"}.` });
      }
      if (Object.keys(object(value)).length === 0 && field.tier !== "plain") answer = worse(answer, { tier: field.tier as BrowserOwnerTier, label: field.label ?? "config_change", why: `Settings: "${key}" needs a code.` });
      continue;
    }
    const tier = typeof field.tier === "function" ? field.tier(value) : field.tier;
    answer = worse(answer, { tier, ...(tier === "plain" ? {} : { label: field.label ?? "config_change" }), why: `Settings: "${key}" ${tier === "plain" ? "is plain" : "needs a code or the door proof"}.` });
  }
  return answer;
}

// ── the rule table ──────────────────────────────────────────────────────────────────────────────────────────────────

const rule = (methods: BrowserOwnerRule["methods"], path: string | RegExp, tier: BrowserOwnerTier, why: string, extra: Partial<BrowserOwnerRule> = {}): BrowserOwnerRule =>
  ({ methods, path, tier, why, ...extra });
const refuse = (path: string | RegExp, why: string, methods: BrowserOwnerRule["methods"] = "*", extra: Partial<BrowserOwnerRule> = {}) => rule(methods, path, "refused", why, extra);
const needCode = (label: OwnerCodeLabel, path: string | RegExp, why: string, methods: BrowserOwnerRule["methods"] = WRITES, extra: Partial<BrowserOwnerRule> = {}) =>
  rule(methods, path, "code", why, { label, ...extra });
const door = (label: OwnerCodeLabel, path: string | RegExp, why: string, methods: BrowserOwnerRule["methods"] = WRITES, extra: Partial<BrowserOwnerRule> = {}) =>
  rule(methods, path, "fresh-door", why, { label, ...extra });
const ok = (path: string | RegExp, why: string, methods: BrowserOwnerRule["methods"] = WRITES, extra: Partial<BrowserOwnerRule> = {}) => rule(methods, path, "plain", why, extra);

const action = (body: unknown): string => { const value = object(body).action; return typeof value === "string" ? value : ""; };

/** Memory actions that are an everyday tidy or a setting. Anything not listed is `code` (fail closed). */
const MEMORY_PLAIN_ACTIONS = new Set([
  "learning-history", "learning-undo", "learning-keep", "waiting-summary", "waiting-list", "waiting-sources", "review-keep", "review-keep-all", "review-later",
  "review-back", "review-edit", "review-undo", "learning-bot", "evolution-history", "evolution-retry", "procedure-evaluation-preview", "procedure-evaluation-retry",
  "pip-proposals", "pip-proposal-confirm", "pip-proposal-dismiss", "pip-keep", "pip-reflect-status", "pip-reflect-retry", "pip-reflect-exclude", "humans",
  "human-share", "list", "scope-labels", "inspect", "approve", "archive", "restore-archive", "pin", "correct", "remember", "promote", "bind", "project", "configure",
  "import-preview", "import-inventory", "import-review-list", "identity-read", "identity-write", "continuity-read", "continuity-write", "model-download",
]);
const MEMORY_CODE_LABEL: Readonly<Record<string, OwnerCodeLabel>> = {
  forget: "delete", "identity-delete": "delete", "import-stop-tracking": "delete", "rebuild-index": "delete",
  "review-as-skill": "new_skill", "import-commit": "new_skill", "enable-and-import": "new_skill",
  "evolution-authorize": "bot_reach", "evolution-authorize-classification": "bot_reach", "evolution-rollback": "bot_reach", "procedure-evaluation-authorize": "bot_reach",
};

export const BROWSER_OWNER_RULES: readonly BrowserOwnerRule[] = [
  // ── refused, whatever is proven (DESIGN 3.4) ──────────────────────────────────────────────────────────────────────
  refuse(/^\/api\/bots\/[^/]+\/browser-choice\/(preview|preflight|retry|cancel|switch-now|setup|open-chrome)$/, "Changing the host browser requires the owner desktop or paired phone."),
  refuse(/^\/api\/desktop(?:-secret|\/|$)/, "The desktop's own routes: no meaning for a browser."),
  refuse(/^\/api\/cloud\/(?:pairing|account|recovery)(?:\/|$)/, "Adding a device, the account and recovery belong to the site, behind their own hold.", "*", { entryless: true }),
  refuse(/^\/api\/(?:move|lend)(?:\/|$)/, "Moving or lending a home is the site's.", "*", { entryless: true }),
  refuse(/^\/api\/(?:internal|model-gateway)(?:\/|$)/, "A bot's own capability routes: a browser never calls them."),
  refuse(/^\/api\/browser-extension\/(?:mcp|clients)$/, "A paired Chrome client and its grants are a computer decision."),
  refuse(re(`/api/bots/${ID}/always-allow`), "Always grants are off on every Cloud surface."),
  refuse(re(`/api/routines/${ID}/always-allow`), "Always grants are off on every Cloud surface."),
  refuse(re(`/api/bots/${ID}/(?:tasks/${ID}/)?permissions/refresh`), "Permission refresh is a computer decision."),
    refuse(re(`/api/bots/${ID}/browser-extension/(?:check|start-task)`), "Standing browser grants are a computer decision."),
  refuse(re(`/api/bots/${ID}/browser-extension/mode`), "Loosening the browser's approval mode is a computer decision.", ["PATCH"], {
    decide: ({ body }) => object(body).mode === "full" ? undefined : { tier: "plain", why: "Tightening the mode (step or task) is plain; the handler refuses a loosening." } }),
  refuse(re(`/api/bots/${ID}/browser-extension/sites`), "Allowing a site is a computer decision; Revoke (ask) is plain.", ["POST"], {
    decide: ({ body }) => object(body).rule === "ask" && object(body).lowered !== true ? { tier: "plain", why: "Revoke: taking a site's Allow back to Ask." } : undefined }),
  refuse(re(`/api/threads/${ID}/browser-setup/${ID}`), "Set up registers a helper on a computer. Decline and continue are plain.", ["POST"], {
    decide: ({ body }) => ["decline", "continue"].includes(action(body)) ? { tier: "plain", why: "Decline or continue a browser set up card." } : undefined }),
  refuse(/^\/api\/(?:cli-test|cli-candidates|browser\/linux-sandbox\/enable|storage\/attachments\/remove|hermes\/profiles\/import|teams\/scout(?:\/directory)?)$/, "Local machine concerns, or spawning a supplied binary."),
  refuse(/^\/api\/(?:engine-setup-check|engine-signin-recipe|engine-signin-probe)$/, "Engine checks and the sign in recipe run on the owner's computer; a home answers 404 (next to cli-test).", ["POST"]),
  refuse("/api/no-limits/terms", "No limits is a computer decision; a bot's noLimits is refused the same way.", ["POST"]),
  refuse(re(String.raw`/api/instances/[\w.-]+(?:/claude-update)?`), "Engine instances are a local machine concern.", WRITES),
  refuse(re(String.raw`/api/engine-management/[\w.-]+`), "Engine management installs software on a computer.", ["POST"]),
  refuse(/^\/api\/phones\/self(?:\/|$)/, "The phone's own envelope: the phone proves itself in the route."),
  refuse("/api/phones/minted", "Pairing a phone is the site's.", WRITES),
  refuse(/^\/api\/media\/bytes(?:\/|$)/, "Signed media bytes are read-only.", WRITES),
  refuse(/^\/api\/media\/(?:resolve|reference)$/, "Resolving or referencing media reads files on the owner's computer; only the desktop app proves it is there, so a browser is refused here and the handler checks the same proof.", ["POST"]),

  needCode("folder_trust", "/api/folder-trust", "Trusting or forgetting a folder widens what a bot may touch: the owner's browser does it on a fresh emailed code.", WRITES),

  // ── auth layer (cloud-request-auth.ts answers these; no ROUTE_POLICY entry) ───────────────────────────────────────
  needCode("device_remove", /^\/api\/cloud\/devices\/[a-f0-9-]+$/, "Removing another device: a thief must not be able to lock the owner out.", ["DELETE"], { entryless: true }),
  needCode("device_remove", /^\/api\/cloud\/devices\/[a-f0-9-]+\/owner\/revoke$/, "Making a browser chat-only.", ["POST"], { entryless: true }),
  ok(/^\/api\/cloud\/owner-code\/(?:send|verify)$/, "The code dialog's own routes: they check the act token.", ["POST"], { entryless: true }),
  // Signing an engine in hands this home a new vendor account, so the ticket needs a fresh door proof (or a fresh emailed code) as well as the browser's own factor.
  door("fresh_door", "/api/cloud/engine-login/ticket", "A single-use, 30 second ticket for the engine sign-in terminal.", ["POST"], { entryless: true }),
  ok(ENGINE_LOGIN_PATH, "The engine sign-in terminal: allowed only with a redeemed ticket (cloudRouteDecision context).", ["GET"]),

  // ── fresh door ────────────────────────────────────────────────────────────────────────────────────────────────────
  door("fresh_door", /^\/api\/(?:telegram|slack|discord)\/pair$/, "Pairing a channel hands durable reach to someone else."),
  door("fresh_door", /^\/api\/whatsapp\/(?:link|approve)$/, "Linking WhatsApp hands durable reach to someone else."),
  door("bot_reach", "/api/mcp-grants", "Script access outlives this browser.", ["POST"]),
  door("bot_reach", "/api/webhooks", "A webhook outlives this browser.", ["POST"]),
  door("bot_reach", re(`/api/webhooks/${ID}`), "A webhook edit outlives this browser.", ["PATCH"]),
  door("bot_reach", re(`/api/webhooks/${ID}/(?:rotate|test)`), "A webhook secret or test.", ["POST"]),
  ok(re(`/api/webhooks/${ID}`), "Switching a webhook off takes access away.", ["DELETE"]),
  ok(re(`/api/mcp-grants/${ID}`), "Switching script access off takes access away.", ["DELETE"]),
  rule(["POST"], re(`/api/bots/${ID}/computer/control`), "plain", "Control of a bot's computer: take is the fresh door, the rest is plain.", {
    decide: ({ body }) => action(body) === "take" ? { tier: "fresh-door", label: "computer_command", why: "Taking direct control of a bot's computer." } : undefined }),
  rule(["POST"], /^\/api\/bots\/[^/]+\/browser$/, "plain", "A bot's browser: take is the fresh door, reclaim is the computer's, the rest is plain.", {
    decide: ({ body }) => action(body) === "take" ? { tier: "fresh-door", label: "computer_command", why: "Taking control of a bot's browser." }
      : action(body) === "reclaim" ? { tier: "refused", why: "Reclaiming control is the desktop owner's." } : undefined }),
  ok(/^\/api\/bots\/[^/]+\/browser\/frame$/, "Watching a bot's browser.", ["POST"]),
  ok(re(`/api/bots/${ID}/computer/viewer-close`), "Closing a viewer.", ["POST"]),
  ok(re(`/api/bots/${ID}/computer/(?:provision|sleep)`), "A bot's cloud computer: provision and sleep are settings.", ["POST"]),

  // ── code (DESIGN 3.2) ─────────────────────────────────────────────────────────────────────────────────────────────
  needCode("delete", re(`/api/(?:bots|groups)/${ID}`), "Deleting a bot or room cannot be undone.", ["DELETE"]),
  needCode("delete", re(`/api/bots/${ID}/computer/remove`), "Removing a bot's computer cannot be undone.", ["POST"]),
  needCode("restore_release", re(`/api/restore-holds/(?:output_receipt|shared_result)/${ID}/release`), "A release sends out what a restore held.", ["POST"]),
  needCode("restore_release", "/api/calls/rearm", "Turning calls back on after a restore.", ["POST"]),
  needCode("bot_reach", re(`/api/bots/${ID}/sharing`), "Sharing widens a bot's reach.", ["PATCH"]),
  needCode("bot_reach", re(`/api/bots/${ID}/sharing/(?:skills|copy)`), "Sharing widens a bot's reach.", ["POST"]),
  needCode("bot_reach", re(`/api/bots/${ID}/access`), "Changing what a bot can reach.", ["PUT"]),
  needCode("bot_reach", re(`/api/groups/${ID}/project/(?:budget|work-roots|work-profile|settings)`), "A project's budget, folders and work profile.", ["PATCH", "POST", "PUT"]),
  needCode("bot_reach", /^\/api\/teams\/(?:import|export)$/, "Moving whole teams in or out.", ["POST"]),
  needCode("new_skill", "/api/skills/import", "New executable instructions.", ["POST"]),
  needCode("new_skill", re(`/api/skills/[^/]+/duplicate`), "A copy of a skill into the collection.", ["POST"]),
  needCode("new_skill", re(`/api/skills/collection/[^/]+`), "Editing a collection skill changes executable instructions.", ["PUT"]),
  ok(re(`/api/skills/collection/[^/]+`), "Deleting a collection skill takes it away.", ["DELETE"]),
  rule(["PUT"], re(`/api/skills/[^/]+/bots/${ID}`), "plain", "Switching a skill on or off for a bot: off and the shipped library are plain, a collection skill is a code the handler asks for.", {
    decide: ({ path, body }) => {
      const ref = decodeURIComponent(path.split("/")[3] ?? "");
      if (object(body).on === false) return { tier: "plain", why: "Switching a skill off." };
      return /^(?:library|builtin):/.test(ref) ? { tier: "plain", why: "A skill from the shipped library." } : { tier: "plain", why: "A collection skill: handleSkillsApi asks for the code itself, bound to the scanned content hash (skillActDigest), so a reviewed skill cannot be swapped." };
    } }),
  ok(re(`/api/bots/${ID}/skills/library`), "A skill from the shipped library.", ["POST"]),
  needCode("new_skill", re(`/api/bots/${ID}/(?:assistant-profile|skills)`), "New executable instructions for a bot.", ["POST"]),
  rule(WRITES, re(`/api/bots/${ID}/skills/[a-z0-9-]+(?:/history|/rollback)?`), "code", "A bot's own skill: write and rollback are executable instructions; switching one off is plain.", {
    label: "new_skill", decide: ({ method, body }) => method === "PATCH" && object(body).enabled === false ? { tier: "plain", why: "Switching a skill off." } : undefined }),
  needCode("new_skill", /^\/api\/packages\/(?:import|export)$/, "Importing or exporting a package.", ["POST"]),
  needCode("new_skill", /^\/api\/team-library\/(?:github|grok)$/, "Importing from a link.", ["POST"]),
  needCode("mcp_server", /^\/api\/mcp\/servers(?:\/|$)/, "A tool server runs new code.", WRITES),
  needCode("mcp_server", "/api/mcp/inspect", "Starting a tool server to look at it.", ["POST"]),
  needCode("new_skill", re(`/api/bots/${ID}/mcp-enable-cards/${ID}/enable`), "Turning on a tool server.", ["POST"]),
  ok(re(`/api/bots/${ID}/mcp-enable-cards/${ID}/dismiss`), "Dismissing a card.", ["POST"]),
  needCode("traffic_moved", /^\/api\/local-models(?:\/|$)/, "A local model moves every prompt to an address someone chose.", WRITES),
  needCode("traffic_moved", /^\/api\/cloud\/own-server(?:\/(?:confirm|test))?$/, "Your own server moves where bots run.", WRITES),
  needCode("computer_viewer", re(`/api/bots/${ID}/computer/join`), "The provider's viewer link outlives this browser.", ["POST"]),
  needCode("computer_command", re(`/api/bots/${ID}/computer/(?:exec|screenshot)`), "Direct hands on a computer.", ["POST"]),
  needCode("computer_command", /^\/api\/(?:bots\/[\w-]+\/)?local-computer(?:\/|$)/, "Direct hands on a computer.", WRITES),
  needCode("take_down_site", re(`/api/bots/${ID}/published-sites(?:/${ID}/take-down)?`), "Taking a published site down, or assigning one, changes what the public sees.", WRITES),
  needCode("other", /^\/api\/email(?:\/|$)/, "Email access for bots.", WRITES),
  needCode("bot_widen", re(`/api/bots/${ID}/browser-extension`), "Connecting or removing the browser helper.", ["POST"], {
    decide: ({ body }) => ["connect", "remove"].includes(action(body)) ? undefined : { tier: "plain", why: "Pause, stop, end, revoke, resume: taking or pausing access." } }),
  ok(re(`/api/bots/${ID}/browser-extension/activity`), "Reading what the browser helper did.", WRITES),

  // ── body-dependent (allowlists and markers) ───────────────────────────────────────────────────────────────────────
  rule(["PATCH"], re(`/api/bots/${ID}`), "plain", "A bot's settings: the fields on the allowlist are plain, anything else is a code.", {
    decide: ({ body }) => fieldAnswer(body, BOT_PATCH_FIELDS, "bot_widen", "A bot's settings") }),
  rule(["PATCH"], re(`/api/(?:bots|groups)/${ID}/tasks/${ID}`), "plain", "A chat's settings.", {
    decide: ({ body }) => fieldAnswer(body, TASK_PATCH_FIELDS, "bot_widen", "A chat's settings") }),
  rule(["PATCH"], re(`/api/groups/${ID}`), "plain", "A room's settings.", {
    decide: ({ body }) => fieldAnswer(body, GROUP_PATCH_FIELDS, "bot_widen", "A room's settings") }),
  rule(["POST"], "/api/bots", "plain", "A new bot. Reach fields that widen are a code.", {
    decide: ({ body }) => { const b = object(body); const hit = CREATE_WIDENING_FIELDS.find(key => key in b && !(key === "useMyChrome" && b[key] === false) && !emptyish(b[key]));
      return hit ? { tier: "code", label: "bot_widen", why: `A new bot with "${hit}" widens reach.` } : undefined; } }),
  rule(["PUT", "PATCH"], "/api/config", "plain", "Settings: plain fields only; a channel credential is the fresh door; the rest is a code.", { decide: ({ body }) => configAnswer(body) }),
  rule(["POST"], "/api/starter-profiles", "plain", "A shipped starter profile is ours and checked by id; anything else is a code.", {
    decide: ({ body }) => { const b = object(body); return b.action === "catalog" || BROWSER_PLAIN_STARTER_PROFILE_IDS.includes(b.profileId as string) ? undefined
      : { tier: "code", label: "new_skill", why: "A profile that is not shipped." }; } }),
  rule(["POST"], "/api/memory/action", "plain", "Memory settings and tidy actions are plain; erasing, importing and authorising a rewrite are a code.", {
    decide: ({ body }) => { const name = action(body); if (MEMORY_PLAIN_ACTIONS.has(name)) return undefined; if (name === "human-link") return { tier: "fresh-door", label: "fresh_door", why: "Linking a person to a channel." };
      return { tier: "code", label: MEMORY_CODE_LABEL[name] ?? "other", why: "A memory action that is not on the plain list." }; } }),
  ok(/^\/api\/memory\/(?:storage\/reclaim|flux-memory)$/, "Memory housekeeping.", WRITES),
  rule(WRITES, /^\/api\/provider-connections(?:\/|$)/, "plain", "A provider key is plain; a caller-chosen address moves every prompt.", {
    decide: ({ body }) => typeof body === "object" && body !== null && URL_MARKER.test(JSON.stringify(body)) ? { tier: "code", label: "traffic_moved", why: "A connection with an address someone chose." } : undefined }),

  // ── plain, by area (DESIGN 3.1) ───────────────────────────────────────────────────────────────────────────────────
  ok(/^\/api\/flux-connection(?:\/|$)/, "The Flux key: the endpoint is fixed."),
  ok(/^\/api\/claude-accounts(?:\/|$)/, "Provider sign in accounts."),
  ok("/api/publish/netlify/check", "Checking a publish key.", ["POST"]),
  ok(/^\/api\/cloud\/engine-signins\/dismiss$/, "Hiding a sign in offer.", ["POST"]),
  ok(/^\/api\/cloud\/model-signins(?:\/|$)/, "Vendor sign in has its own proof at the vendor."),
  ok(re(`/api/bots/${ID}/engine-signin/code`), "Handing the sign in code to the waiting sign in.", ["POST"]),
  ok("/api/engine-setup-command", "The command a sign in prints.", ["POST"]),
  ok(re(`/api/connectors/${ID}/authorize`), "The vendor's page is the proof.", ["POST"]),
  ok(re(`/api/connectors/${ID}(?:/accounts/[A-Za-z0-9][A-Za-z0-9_-]{0,127})?`), "Disconnecting an app takes access away.", ["DELETE"]),
  ok(re(`/api/bots/${ID}/connector-cards/${ID}/(?:authorize|status|timeout|resume|dismiss)`), "A connect card.", WRITES),
  ok(re(`/api/bots/${ID}/mcp-sign-in-cards/${ID}/(?:resume|dismiss)`), "A tool sign in card.", ["POST"]),
  ok(re(`/api/bots/${ID}/secret-cards/${ID}/(?:provided|resume|dismiss|value)`), "A key the owner hands to a bot's card.", ["POST"]),
  ok(/^\/api\/(?:telegram|slack|discord)\/(?:status|resume|revoke)$/, "Status and subtractive acts.", WRITES),
  ok(/^\/api\/whatsapp\/(?:status|groups|resume|revoke|unlink|dismiss)$/, "Status and subtractive acts.", WRITES),
  ok(/^\/api\/phone\/bindings\/[\w-]{1,64}$/, "Rings for calls, on one phone.", ["PATCH"]),
  ok(/^\/api\/mobile\/push\//, "Push registration.", WRITES),
  ok("/api/terms/accept", "Accepting the terms records an agreement the owner already made.", WRITES),
  ok(/^\/api\/setup(?:\/|$)/, "First run.", WRITES),
  ok("/api/subscribe", "First run.", ["POST"]),
  ok(/^\/api\/(?:about-me|house-rules(?:\/reset)?|whats-new(?:\/seen)?|announcements(?:\/.*)?)$/, "Settings and notices.", WRITES),
  ok("/api/owner/timezone", "The home's time zone.", ["PUT"]),
  ok(re(`/api/bots/${ID}/intake`), "A new bot's intake.", ["POST"]),
  ok("/api/projects", "Projects.", ["POST"]),
  ok("/api/projects/proposal", "Projects.", ["POST"]),
  ok(re(`/api/groups/${ID}/project/(?:close|reopen|export-brief|viewed|brief|goals(?:/${ID})?|control/(?:stop|pause|resume|redirect))`), "Project housekeeping and steering.", WRITES),
  ok(re(`/api/groups/${ID}/board/(?:cards(?:/${ID})?|columns)`), "A project board.", WRITES),
  ok(re(`/api/groups/${ID}/requests/${ID}/(?:cancel|retry)`), "A room's queue.", ["POST"]),
  ok(re(`/api/groups/${ID}/setup`), "A room's setup.", ["PATCH"]),
  ok(re(`/api/groups/${ID}/queue/${ID}`), "A room's queue.", ["DELETE"]),
  ok(re(`/api/bots/${ID}/queue/${ID}`), "A bot's queue.", ["DELETE"]),
  ok("/api/groups", "A new room.", ["POST"]),
  ok(re(`/api/groups/${ID}/(?:messages|interrupt|read)`), "Chat.", ["POST"]),
  ok(re(`/api/(?:bots|groups)/${ID}/tasks`), "A new chat.", ["POST"]),
  ok(re(`/api/(?:bots|groups)/${ID}/tasks/${ID}`), "Chat.", ["POST", "DELETE"]),
  ok(re(`/api/bots/${ID}/(?:messages|interrupt|read|warm|typing|active-branch|avatar/generate)`), "Chat.", ["POST"]),
  ok(re(`/api/bots/${ID}/messages/${ID}/edit`), "Chat.", ["POST"]),
  ok(re(`/api/threads/${ID}/messages/${ID}/reactions`), "Chat.", ["POST"]),
  ok(re(`/api/(?:bots|threads)/${ID}/respond`), "Everyday approvals; a high risk card needs its own code at the handler.", ["POST"]),
  ok(re(`/api/threads/${ID}/widgets/${ID}/(?:respond|reopen)`), "A widget answer.", ["POST"]),
  ok(re(`/api/bots/${ID}/cards/${ID}`), "A card's state.", ["PATCH"]),
  ok(re(`/api/bots/${ID}/held-continuations/${ID}/retry`), "A held reply; the handler asks for a code when it was held by a restore.", ["POST"]),
  ok(re(`/api/bots/${ID}/message-allow`), "Narrowing reach is plain; the handler refuses a widening.", ["PATCH"]),
  ok(re(`/api/bots/${ID}/profile`), "A bot's name, persona and voice.", ["PATCH"]),
  ok(re(`/api/bots/${ID}/general-notes`), "A bot's notes.", ["PUT"]),
  ok(re(`/api/bots/${ID}/memory`), "A bot's memory file.", ["PUT"]),
  ok(re(`/api/bots/${ID}/checkpoints/restore`), "The bot's own folder.", ["POST"]),
  ok(re(`/api/bots/${ID}/(?:learning|outcomes|feedback|lessons)(?:/[\\w/-]*)?`), "A bot's own records.", WRITES),
  ok(re(`/api/bots/${ID}/shapes`), "A bot's shapes.", WRITES),
  ok(re(`/api/bots/${ID}/watch-proposal`), "A watch proposal.", ["POST"]),
  ok(re(`/api/bots/${ID}/(?:limit-backup)`), "A limit backup.", ["PUT", "DELETE"]),
  ok(re(`/api/bots/${ID}/threads/follow-model`), "Following the model.", ["POST"]),
  ok(re(`/api/bots/${ID}/voice-host`), "A call.", ["POST"]),
  ok(re(`/api/bots/${ID}/call-note`), "A call.", ["POST"]),
  ok(re(`/api/bots/${ID}/work-threads`), "A work thread.", ["POST"]),
  ok("/api/sidebar-sections", "Filing bots.", ["POST"]),
  ok(/^\/api\/team-sections(?:\/|$)/, "Filing bots.", WRITES),
  ok("/api/section-context", "A section's context.", ["PUT"]),
  ok("/api/inbox/state", "Inbox marks.", ["POST"]),
  ok("/api/inbox/learning-paused/leave", "Inbox.", ["POST"]),
  ok("/api/presence", "Presence.", ["POST"]),
  ok(/^\/api\/phones\/(?:ask-revoke)$/, "Asking a phone to leave is subtractive.", ["POST"]),
  needCode("device_remove", "/api/phones/revoke", "Removing a phone.", ["POST"]),
  ok(re(`/api/routines/${ID}/always-allow/remove`), "Removing an Always is subtractive.", ["POST"]),
  ok(re(`/api/bots/${ID}/always-allow/remove`), "Removing an Always is subtractive.", ["POST"]),
  ok(re(`/api/bots/${ID}/always-allow/undo`), "The card's Undo of an Always only removes keys, as Remove does.", ["POST"]),
  ok(re(`/api/bots/${ID}/task-allow/(?:remove|clear)`), "Taking back a task allowance is subtractive.", ["POST"]),
  ok(re(`/api/bots/${ID}/use-fuigo`), "Moving a bot to Fuigo is an engine pick, as modelSelection is.", ["POST"]),
  ok("/api/engine-health/recheck", "Health's Check again.", ["POST"]),
  ok("/api/feedback", "Tester feedback from the help panel: a screen name and a fixed sentence.", ["POST"]),
  ok("/api/routines", "Routines.", ["POST"]),
  ok(re(`/api/routines/${ID}`), "Routines.", ["PATCH", "DELETE"]),
  ok(re(`/api/routines/${ID}/(?:run|instructions/rollback)`), "Routines.", ["POST"]),
  ok(/^\/api\/routine-runs\/(?:seen-all|[\w-]+(?:\/(?:cancel|seen))?)$/, "Routine runs.", ["POST", "DELETE"]),
  ok(/^\/api\/calendar-calls(?:\/[\w-]+(?:\/room)?)?$/, "Calendar calls.", WRITES),
  ok(/^\/api\/calls\/(?:off-today|turn-end|sessions)$/, "Calls.", ["POST"]),
  ok(/^\/api\/calls\/sessions\/[\w-]{1,64}\/(?:ticket|end|live)$/, "Calls.", WRITES),
  ok(/^\/api\/calls\/[0-9a-f-]{36}\/(?:answer|decline|text-instead|never-again|seen)$/, "Calls.", ["POST"]),
  ok(re(`/api/bots/${ID}/calls/rules`), "Call rules.", ["PUT"]),
  ok(/^\/api\/delegations\/[\w-]{4,160}\/(?:stop|send-again|dismiss)$/, "Delegations.", ["POST"]),
  ok(/^\/api\/voice\/(?:transcribe|cleanup|stream(?:\/ticket)?)$/, "Voice.", WRITES),
  ok(/^\/api\/tts\/(?:speak|prepare)$/, "Voice.", ["POST"]),
  ok("/api/attachments", "Chat attachments.", ["POST"]),
  ok("/api/files", "Chat files.", ["POST"]),
  ok(/^\/api\/(?:workspace-files|artifacts)(?:\/|$)/, "The bot's own folder."),
  ok(/^\/api\/media(?:$|\/(?!bytes(?:\/|$)))/, "The bot's own media."),
  ok("/api/automation-admission", "Automation.", WRITES),
  ok("/api/backup-failure-notice", "Backup.", ["POST"]),
  ok("/api/backup-restart", "Backup.", ["POST"]),
  ok(re(`/api/shared-results/${ID}/dismiss`), "Restore housekeeping.", ["POST"]),
  ok(/^\/api\/deletions\/(?:retry|dismiss)$/, "Deletion housekeeping.", ["POST"]),
  ok(/^\/api\/thread-snoozes(?:\/|$)/, "Snoozes.", WRITES),
  ok("/api/images/settings", "Image settings.", WRITES),
  ok(/^\/api\/images\/(?:probe|library|prompt-blocks|reference-packs)(?:\/|$)/, "Images.", WRITES),

  // ── reads ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  ok(/^\/api(?:\/|$)/, "Every owner read: keys never leave these routes.", READS),
];

/** The first rule that answers this request, or undefined (no rule: refused). */
export function browserOwnerRule(method: string, path: string): BrowserOwnerRule | undefined {
  return BROWSER_OWNER_RULES.find(entry => (entry.methods === "*" || entry.methods.includes(method))
    && (typeof entry.path === "string" ? entry.path === path : entry.path.test(path)));
}

/** The tier a remembered-owner browser gets for this request. Fail closed: no rule is refused. */
export function browserOwnerTier(method: string, path: string, body?: unknown): BrowserOwnerAnswer {
  const entry = browserOwnerRule(method, path);
  if (!entry) return { tier: "refused", why: "No rule decides this route for a browser, so it stays closed." };
  let answer: BrowserOwnerAnswer = { tier: entry.tier, ...(entry.label ? { label: entry.label } : {}), why: entry.why };
  if (entry.decide) {
    const match = typeof entry.path === "string" ? null : entry.path.exec(path);
    const extra = entry.decide({ method, path, body, match });
    if (extra) answer = { ...answer, ...extra, ...(extra.tier === "plain" || extra.tier === "refused" ? { label: undefined } : {}) };
    if (answer.label === undefined) delete answer.label;
  }
  if (!READS.includes(method as typeof READS[number])) {
    // A marker raises the answer; when both are a code, the marker's words ("turn on Full access") are the better ones.
    const marked = markerAnswer(body);
    answer = marked.tier === "code" && answer.tier === "code" ? marked : worse(answer, marked);
  }
  if ((answer.tier === "code" || answer.tier === "fresh-door") && !answer.label) answer = { ...answer, label: "other" };
  return answer;
}

/** True when this request's answer can depend on its body, so the gate must read the body before deciding. */
export function browserOwnerNeedsBody(method: string, path: string): boolean {
  if (READS.includes(method as typeof READS[number])) return false;
  const entry = browserOwnerRule(method, path);
  if (!entry) return false;
  return Boolean(entry.decide) || entry.tier === "code" || entry.tier === "fresh-door";
}
