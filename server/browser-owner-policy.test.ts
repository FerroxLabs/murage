// SPDX-License-Identifier: AGPL-3.0-or-later
// The owner's browser on a Cloud home (scope remembered-owner): its per-route tier table, the route decision built on it, the
// auth layer's 403 `email_code` answer, and the surface rules that keep it from ever being "the computer".
import { createHash, createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOT_PATCH_FIELDS, BROWSER_OWNER_RULES, BROWSER_PLAIN_STARTER_PROFILE_IDS, CONFIG_PATCH_FIELDS, OWNER_CODE_LABELS, TASK_PATCH_FIELDS, browserOwnerRule, browserOwnerTier } from "./browser-owner-policy.ts";
import { CloudSessions, DOOR_FRESH_MS } from "./cloud-sessions.ts";
import { createCloudRequestAuth, routeActDigest, stepPurpose, type CloudOwnerAct } from "./cloud-request-auth.ts";
import { cloudRouteDecision, cloudRouteNeedsBody, ROUTE_POLICY, routePolicy, SENTINEL_OWNER_ROUTE, HIGHLEVEL_REVIEW_ROUTE } from "./route-policy.ts";
import { cloudIdentity, isOwnerBrowser, ownerBrowserActs, ownerBrowserScope, setCloudIdentity } from "./cloud-request-identity.ts";
import { isDesktopApp, ownerSurface, skipsFreshAuth } from "./cloud-owner-surface.ts";
import { requestFromComputer, requestSurface } from "./sse-visibility.ts";
import { companionAuthorized } from "./companion-authority.ts";
import { cloudHomeCopy } from "./cloud-home/copy.ts";
import { STARTER_PROFILE_IDS } from "./starter-profiles.ts";
import { discoverRoutes } from "./testing/route-discovery.ts";

const origin = "https://home.example";
const ALL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const tier = (method: string, path: string, body?: unknown) => browserOwnerTier(method, path, body);

describe("the tier answers (DESIGN 3)", () => {
  const plain: [string, string, unknown?][] = [
    ["PUT", "/api/config", { profile: { name: "A" } }], ["PUT", "/api/config", { tts: { key: "k" }, language: "fr" }], ["PUT", "/api/config", { xai: { key: "k" } }],
    ["POST", "/api/flux-connection", { key: "k" }], ["DELETE", "/api/flux-connection"], ["POST", "/api/provider-connections/mutate", { preset: "google", key: "k" }],
    ["POST", "/api/starter-profiles", { profileId: "starter-solo-business" }], ["POST", "/api/starter-profiles", { action: "catalog" }],
    ["PATCH", "/api/bots/b1", { name: "x", persona: "y", modelSelection: {}, cwd: "/home/x", section: "s", fullAccess: false, autoApprove: false }],
    ["PATCH", "/api/bots/b1", { useMyChrome: false, browserTransport: null, phoneApps: [], approvePeerComms: false, computer: "cloud" }],
    ["PATCH", "/api/bots/b1/tasks/t1", { title: "x", modelSelection: {}, cwd: "/x" }], ["PATCH", "/api/groups/g1", { name: "r", memberIds: ["a"] }],
    ["POST", "/api/bots", { name: "New" }], ["POST", "/api/terms/accept", { version: "v" }], ["POST", "/api/setup/answer", {}], ["POST", "/api/routines", { title: "t" }],
    ["PUT", "/api/skills/library%3Afoo/bots/b1", { on: true }], ["PUT", "/api/skills/collection%3Afoo/bots/b1", { on: false }],
    ["POST", "/api/bots/b1/skills/library", {}], ["POST", "/api/memory/action", { action: "configure" }], ["POST", "/api/memory/action", { action: "list" }],
    ["DELETE", "/api/webhooks/w1"], ["DELETE", "/api/mcp-grants/g1"], ["POST", "/api/cloud/owner-code/send", {}], ["POST", "/api/cloud/owner-code/verify", {}],
    ["POST", "/api/bots/b1/always-allow/undo", {}], ["POST", "/api/bots/b1/task-allow/remove", {}], ["POST", "/api/bots/b1/task-allow/clear", {}], ["POST", "/api/bots/b1/use-fuigo", {}],
    ["POST", "/api/engine-health/recheck", {}], ["POST", "/api/feedback", {}],
    ["POST", "/api/bots/b1/respond", { behavior: "allow" }], ["POST", "/api/bots/b1/messages", { text: "hi" }], ["PATCH", "/api/bots/b1/message-allow", { mode: "team" }],
    ["POST", "/api/bots/b1/browser", { action: "release" }], ["POST", "/api/bots/b1/computer/control", { action: "release" }],
    ["POST", "/api/bots/b1/browser-extension", { action: "stop", bindingId: "x" }], ["PATCH", "/api/bots/b1/browser-extension/mode", { mode: "step" }],
    ["POST", "/api/bots/b1/browser-extension/sites", { origin: "https://a.example", rule: "ask" }], ["POST", "/api/threads/t1/browser-setup/m1", { action: "decline" }],
    ["POST", "/api/telegram/revoke", {}], ["DELETE", "/api/connectors/c1"], ["POST", "/api/connectors/c1/authorize", {}], ["PATCH", "/api/bots/b1/skills/foo", { enabled: false }],
  ];
  it("POST /api/cloud/engine-login/ticket is fresh-door: signing an engine in hands the home a new vendor account", () => {
    const answer = tier("POST", "/api/cloud/engine-login/ticket", { engine: "claudeAgent", action: "login" });
    expect(answer).toMatchObject({ tier: "fresh-door", label: "fresh_door" });
  });
  it.each(plain)("%s %s is plain", (method, path, body) => { expect(tier(method, path, body).tier, `${method} ${path} ${JSON.stringify(body)}`).toBe("plain"); });

  const code: [string, string, unknown, string][] = [
    ["POST", "/api/folder-trust", {}, "folder_trust"], ["DELETE", "/api/folder-trust", {}, "folder_trust"],
    ["PATCH", "/api/bots/b1", { fullAccess: true }, "full_access"], ["PATCH", "/api/bots/b1", { autoApprove: true }, "full_access"], ["PATCH", "/api/bots/b1/tasks/t1", { acknowledgeFullAccess: true }, "full_access"],
    ["PATCH", "/api/routines/r1", { fullAccessChannelMessages: true }, "full_access"], ["PATCH", "/api/bots/b1", { permissionMode: "auto" }, "full_access"], ["PATCH", "/api/bots/b1", { permissionMode: "full" }, "full_access"],
    ["PATCH", "/api/bots/b1", { phoneApps: ["x"] }, "bot_widen"], ["PATCH", "/api/bots/b1", { useMyChrome: true }, "bot_widen"], ["PATCH", "/api/bots/b1", { mystery: 1 }, "bot_widen"],
    ["PATCH", "/api/bots/b1", { approvePeerComms: true }, "bot_widen"], ["PATCH", "/api/bots/b1/tasks/t1", { mystery: 1 }, "bot_widen"], ["POST", "/api/bots", { name: "N", phoneApps: ["x"] }, "bot_widen"],
    ["PUT", "/api/config", { openaiCompat: { url: "https://x.example/v1" } }, "traffic_moved"], ["PUT", "/api/config", { mystery: 1 }, "config_change"], ["PATCH", "/api/config", { features: { browser: true } }, "config_change"],
    ["PUT", "/api/config", { profile: { name: "A" }, vps: { sshAlias: "x" } }, "config_change"],
    ["POST", "/api/starter-profiles", { profileId: "mine" }, "new_skill"], ["POST", "/api/skills/import", {}, "new_skill"],
    ["POST", "/api/bots/b1/skills", {}, "new_skill"], ["PUT", "/api/bots/b1/skills/foo", {}, "new_skill"], ["POST", "/api/mcp/servers", {}, "mcp_server"], ["POST", "/api/packages/import", {}, "new_skill"],
    ["POST", "/api/memory/action", { action: "forget" }, "delete"], ["POST", "/api/memory/action", { action: "nothing-known" }, "other"], ["DELETE", "/api/bots/b1", {}, "delete"], ["DELETE", "/api/groups/g1", {}, "delete"],
    ["POST", "/api/bots/b1/computer/remove", {}, "delete"], ["DELETE", "/api/cloud/devices/abc-123", {}, "device_remove"], ["POST", "/api/cloud/devices/abc-123/owner/revoke", {}, "device_remove"],
    ["POST", "/api/bots/b1/computer/exec", {}, "computer_command"], ["POST", "/api/bots/b1/computer/join", {}, "computer_viewer"], ["POST", "/api/local-computer/run", {}, "computer_command"],
    ["POST", "/api/bots/b1/published-sites/s1/take-down", {}, "take_down_site"], ["POST", "/api/bots/b1/published-sites", {}, "take_down_site"], ["POST", "/api/cloud/own-server", {}, "traffic_moved"],
    ["POST", "/api/local-models/servers", {}, "traffic_moved"], ["POST", "/api/restore-holds/shared_result/r1/release", {}, "restore_release"], ["POST", "/api/calls/rearm", {}, "restore_release"],
    ["PATCH", "/api/bots/b1/sharing", {}, "bot_reach"], ["PUT", "/api/bots/b1/access", {}, "bot_reach"], ["POST", "/api/provider-connections/mutate", { preset: "x", baseUrl: "https://a.example" }, "traffic_moved"],
    ["POST", "/api/bots/b1/browser-extension", { action: "connect" }, "bot_widen"], ["POST", "/api/bots/b1/browser-extension", { action: "remove" }, "bot_widen"],
  ];
  it.each(code)("%s %s is a code (%s)", (method, path, body, label) => { const answer = tier(method, path, body); expect(answer.tier, `${method} ${path}`).toBe("code"); expect(answer.label).toBe(label); });

  const door: [string, string, unknown, string][] = [
    ["POST", "/api/telegram/pair", {}, "fresh_door"], ["POST", "/api/slack/pair", {}, "fresh_door"], ["POST", "/api/discord/pair", {}, "fresh_door"], ["POST", "/api/whatsapp/link", {}, "fresh_door"],
    ["POST", "/api/whatsapp/approve", {}, "fresh_door"], ["POST", "/api/mcp-grants", {}, "bot_reach"], ["POST", "/api/webhooks", {}, "bot_reach"], ["PATCH", "/api/webhooks/w1", {}, "bot_reach"],
    ["POST", "/api/webhooks/w1/rotate", {}, "bot_reach"], ["POST", "/api/bots/b1/computer/control", { action: "take" }, "computer_command"], ["POST", "/api/bots/b1/browser", { action: "take" }, "computer_command"],
    ["POST", "/api/memory/action", { action: "human-link" }, "fresh_door"], ["PUT", "/api/config", { telegram: { botToken: "t" } }, "fresh_door"],
  ];
  it.each(door)("%s %s is the fresh door (%s)", (method, path, body, label) => { const answer = tier(method, path, body); expect(answer.tier, `${method} ${path}`).toBe("fresh-door"); expect(answer.label).toBe(label); });

  const refused: [string, string, unknown?][] = [
    ["PATCH", "/api/bots/b1", { noLimits: true }], ["PATCH", "/api/bots/b1", { permissionMode: "unlimited" }], ["PATCH", "/api/bots/b1", { computer: "local" }], ["PATCH", "/api/bots/b1", { name: "x", hostComputerConsent: "allowed" }],
    ["PATCH", "/api/bots/b1", { acknowledgeLocalAuto: true }], ["PATCH", "/api/bots/b1", { alwaysAllow: ["x"] }], ["PATCH", "/api/bots/b1/tasks/t1", { acknowledgeNoLimits: true }], ["POST", "/api/bots", { computer: "local" }],
    ["POST", "/api/bots/b1/always-allow", {}], ["POST", "/api/routines/r1/always-allow", {}], ["POST", "/api/bots/b1/permissions/refresh", {}], ["POST", "/api/bots/b1/tasks/t1/permissions/refresh", {}],
    ["POST", "/api/no-limits/terms", {}], ["POST", "/api/engine-setup-check", {}], ["POST", "/api/engine-signin-recipe", {}], ["POST", "/api/engine-signin-probe", {}],
    ["POST", "/api/cloud/pairing", {}], ["DELETE", "/api/cloud/account", {}], ["POST", "/api/cloud/recovery/cancel", {}], ["POST", "/api/cloud/recovery/hold", {}], ["POST", "/api/move/commit", {}],
    ["POST", "/api/lend/commit", {}], ["POST", "/api/cli-test", {}], ["PATCH", "/api/instances/i1", {}], ["POST", "/api/instances/i1/claude-update", {}], ["POST", "/api/engine-management/x", {}], ["POST", "/api/hermes/profiles/import", {}],
    ["POST", "/api/browser/linux-sandbox/enable", {}], ["POST", "/api/storage/attachments/remove", {}], ["POST", "/api/desktop/resource-ticket", {}], ["GET", "/api/desktop-secret"], ["GET", "/api/cli-candidates"], ["GET", "/api/teams/scout"],
    ["POST", "/api/bots/b1/browser", { action: "reclaim" }], ["POST", "/api/threads/t1/browser-setup/m1", { action: "accept" }], ["PATCH", "/api/bots/b1/browser-extension/mode", { mode: "full" }],
    ["POST", "/api/bots/b1/browser-extension/sites", { origin: "https://a.example", rule: "allow" }], ["POST", "/api/bots/b1/browser-extension/check", {}], ["POST", "/api/bots/b1/browser-extension/start-task", {}],
    ["POST", "/api/browser-extension/clients", {}], ["POST", "/api/browser-extension/mcp", {}], ["GET", "/api/internal/memory/get"], ["POST", "/api/model-gateway/x/v1/responses", {}], ["GET", "/api/phones/self"],
    ["POST", "/api/phones/minted", {}], ["POST", "/api/media/bytes/x", {}], ["POST", "/api/not-a-route-anyone-listed", {}], ["POST", "/api/terms", {}], ["PUT", "/api/bots/b1/browser-extension/mode", { mode: "step" }],
  ];
  it.each(refused)("%s %s is refused", (method, path, body) => { expect(tier(method, path, body).tier, `${method} ${path}`).toBe("refused"); });

  it("fails closed: a route with no rule is refused and says why", () => {
    expect(browserOwnerRule("POST", "/api/zz-new-route")).toBeUndefined();
    expect(tier("POST", "/api/zz-new-route", {})).toMatchObject({ tier: "refused" });
    expect(tier("GET", "/api/zz-new-route").tier).toBe("plain"); // reads are open at the table; the route decision denies a path with no ROUTE_POLICY entry (below)
    expect(cloudRouteDecision("GET", "/api/zz-new-route", "remembered-owner", {})).toBe("deny");
    expect(cloudRouteDecision("POST", "/api/zz-new-route", "remembered-owner", {})).toBe("deny");
  });
  it("body markers raise an answer and never lower it", () => {
    expect(tier("POST", "/api/bots/b1/respond", { behavior: "allow", fullAccess: true }).tier).toBe("code");
    expect(tier("POST", "/api/bots/b1/respond", { fullAccess: true, noLimits: true }).tier).toBe("refused");
    expect(tier("POST", "/api/cli-test", { name: "x" }).tier).toBe("refused");
    expect(tier("GET", "/api/config", { fullAccess: true }).tier).toBe("plain"); // a read has no body
    // a skill's "acknowledged" content hash is not an "acknowledge..." marker
    expect(tier("PUT", "/api/skills/library%3Afoo/bots/b1", { on: true, acknowledged: "a".repeat(64) }).tier).toBe("plain");
  });
  it("every field of the config patch schema, the bot and task patch handlers and the room patch handler is listed by name", () => {
    const config = readFileSync(join(import.meta.dirname, "config.ts"), "utf8");
    const start = config.indexOf("const appConfigSchema = z.object({"), end = config.indexOf("\n});", start);
    expect(start).toBeGreaterThan(0);
    const fields = [...config.slice(start, end).matchAll(/^  ([A-Za-z]+):/gm)].map(match => match[1]!).filter(name => !["instances", "mcpServers", "settingsDefaultMode", "hermesProfilesPinned", "noLimitsTermsVersion"].includes(name));
    expect(fields.length).toBeGreaterThan(20);
    expect(fields.filter(name => !Object.hasOwn(CONFIG_PATCH_FIELDS, name)), "config fields with no decision").toEqual([]);
    expect(Object.keys(CONFIG_PATCH_FIELDS).filter(name => !fields.includes(name)), "decisions for fields that no longer exist").toEqual([]);
    const index = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
    // the bot PATCH handler's body keys (a key the handler gains fails here until it is decided)
    const botStart = index.indexOf("const patchBotId = m[1]!;"), botEnd = index.indexOf("if (body.hidden !== undefined) return await botDeleteSerial.run", botStart);
    expect(botStart).toBeGreaterThan(0); expect(botEnd).toBeGreaterThan(botStart);
    const region = index.slice(botStart, botEnd);
    const botKeys = new Set([...region.matchAll(/\bbody\.([A-Za-z]+)/g)].map(match => match[1]!));
    for (const match of region.matchAll(/for \(const key of \[([^\]]*)\]/g)) for (const key of match[1]!.matchAll(/"([A-Za-z]+)"/g)) botKeys.add(key[1]!);
    const profile = readFileSync(join(import.meta.dirname, "bot-profile.ts"), "utf8");
    for (const match of profile.slice(profile.indexOf("const profilePatchSchema"), profile.indexOf("export type BotProfilePatchInput")).matchAll(/^  ([A-Za-z]+):/gm)) botKeys.add(match[1]!);
    expect(botKeys.size).toBeGreaterThan(30);
    expect([...botKeys].filter(key => !Object.hasOwn(BOT_PATCH_FIELDS, key)), "bot PATCH fields with no decision").toEqual([]);
    // the task PATCH handler's own supported list
    const taskList = /\[("title","modelSelection"[^\]]*)\]\.includes\(key\)/.exec(index)?.[1];
    expect(taskList).toBeTruthy();
    const taskKeys = [...taskList!.matchAll(/"([A-Za-z]+)"/g)].map(match => match[1]!);
    expect(taskKeys.filter(key => !Object.hasOwn(TASK_PATCH_FIELDS, key)), "task PATCH fields with no decision").toEqual([]);
    expect(tier("PUT", "/api/config", { zzNewField: 1 }).tier).toBe("code");
    expect(tier("PATCH", "/api/bots/b1", { zzNewField: 1 }).tier).toBe("code");
    expect(tier("PATCH", "/api/groups/g1", { zzNewField: 1 }).tier).toBe("code");
  });
  it("a collection skill switched on is asked for by the handler (bound to its content hash), not by the route table", () => {
    expect(tier("PUT", "/api/skills/collection%3Afoo/bots/b1", { on: true }).tier).toBe("plain");
    expect(readFileSync(new URL("./skills-api.ts", import.meta.url), "utf8")).toContain("skillActDigest(request.routeAct");
  });
  it("the plain starter profile ids are the shipped ones", () => { expect([...BROWSER_PLAIN_STARTER_PROFILE_IDS]).toEqual([...STARTER_PROFILE_IDS]); });
  it("every label is one the control plane knows (WIRE.md)", () => {
    for (const entry of BROWSER_OWNER_RULES) if (entry.label) expect(OWNER_CODE_LABELS).toContain(entry.label);
    expect(OWNER_CODE_LABELS).toHaveLength(18);
  });
  it("snapshot of the tier table", () => {
    const lines = BROWSER_OWNER_RULES.map(entry => `${entry.tier.padEnd(10)} ${entry.methods === "*" ? "*" : entry.methods.join(",")} ${typeof entry.path === "string" ? entry.path : entry.path.source}${entry.label ? ` [${entry.label}]` : ""}${entry.decide ? " +body" : ""}${entry.entryless ? " (no entry)" : ""}`);
    expect(lines).toMatchSnapshot();
  });
});

// ── the generated matrix over every route ─────────────────────────────────────────────────────────────────────────────

// Delegation-pack writes and the Claude Code import (desktop-only, refused on a home) arrived in the second merge (89cb1d2ac) and stay closed.
// 1.0.19 owner-app routes (the desktop app or the keyed phone app only: ownerAppSurface refuses a browser on a home), the HighLevel, phone-call, room-share and
// reply-speech owner blocks and two desktop-only moves have no owner-browser rule, so the table refuses them: closed until someone decides.
const INVENTORY_NO_RULE = [
  "DELETE /api/bots/a/browser",
  "DELETE /api/bots/a/browser-extension",
  "DELETE /api/bots/a/browser-extension/mode",
  "DELETE /api/bots/a/browser-extension/sites",
  "DELETE /api/bots/a/browser/frame",
  "DELETE /api/bots/a/computer/control",
  "DELETE /api/delegation-packs/A",
  "DELETE /api/delegation-packs/probe",
  "DELETE /api/highlevel",
  "DELETE /api/highlevel/connections/hl_AAAA",
  "DELETE /api/highlevel/probe",
  "DELETE /api/phone-calls",
  "DELETE /api/phone-calls/probe",
  "DELETE /api/restore-job/probe",
  "DELETE /api/sentinel/issues",
  "DELETE /api/sentinel/summary",
  "DELETE /api/signal/probe",
  "DELETE /api/skills",
  "DELETE /api/skills/probe",
  "DELETE /api/terms",
  "DELETE /api/threads/a/browser-setup/a",
  "PATCH /api/bots/a/browser",
  "PATCH /api/bots/a/browser-extension",
  "PATCH /api/bots/a/browser-extension/sites",
  "PATCH /api/bots/a/browser/frame",
  "PATCH /api/bots/a/computer/control",
  "PATCH /api/delegation-packs/A",
  "PATCH /api/delegation-packs/probe",
  "PATCH /api/highlevel",
  "PATCH /api/highlevel/probe",
  "PATCH /api/phone-calls",
  "PATCH /api/phone-calls/probe",
  "PATCH /api/restore-job/probe",
  "PATCH /api/sentinel/issues",
  "PATCH /api/sentinel/summary",
  "PATCH /api/signal/probe",
  "PATCH /api/skills",
  "PATCH /api/skills/probe",
  "PATCH /api/terms",
  "PATCH /api/threads/a/browser-setup/a",
  "POST /api/bots/a/browser-extension/mode",
  "POST /api/bots/a/review",
  "POST /api/claude-code-import",
  "POST /api/connector-incidents/000000000000000000000000000000000000",
  "POST /api/data-dir/confirm-root",
  "POST /api/delegation-packs/A",
  "POST /api/delegation-packs/probe",
  "POST /api/groups/a/room-shares",
  "POST /api/highlevel",
  // Main's durable credential protocol is never an owner-browser act.
  "POST /api/highlevel/credential-commit/commit",
  "POST /api/highlevel/credential-commit/prepare",
  "POST /api/highlevel/probe",
  "POST /api/highlevel/token/000000000000000000000000000000000000/confirm",
  "POST /api/highlevel/token/check",
  "POST /api/inbox/approve-all/apply",
  "POST /api/inbox/approve-all/caution",
  "POST /api/inbox/approve-all/preview",
  "POST /api/inbox/approve-all/surface",
  "POST /api/move-in/grok",
  "POST /api/owner-prefs/today-view",
  "POST /api/owner/first-run-jobs",
  "POST /api/phone-calls",
  "POST /api/phone-calls/A/cancel",
  "POST /api/phone-calls/A/share",
  "POST /api/phone-calls/probe",
  "POST /api/phone-calls/setup",
  "POST /api/plan-usage/refresh",
  "POST /api/restore-job/dismiss",
  "POST /api/restore-job/probe",
  "POST /api/restore-job/start",
  "POST /api/room-shares/a/decline",
  "POST /api/room-shares/a/share",
  "POST /api/sentinel/issues",
  "POST /api/sentinel/summary",
  "POST /api/signal/probe",
  "POST /api/skills",
  "POST /api/skills/probe",
  "POST /api/terms",
  "POST /api/tts/call/heard",
  "POST /api/tts/call/reply",
  "POST /api/tts/reply",
  "POST /api/tts/reply/cancel",
  "POST /api/tts/reply/session",
  "POST /api/tts/reply/target",
  "POST /api/tts/voices/add",
  "PUT /api/bots/a/browser",
  "PUT /api/bots/a/browser-extension",
  "PUT /api/bots/a/browser-extension/mode",
  "PUT /api/bots/a/browser-extension/sites",
  "PUT /api/bots/a/browser/frame",
  "PUT /api/bots/a/computer/control",
  "PUT /api/delegation-packs/A",
  "PUT /api/delegation-packs/probe",
  "PUT /api/highlevel",
  "PUT /api/highlevel/bots/a/access",
  "PUT /api/highlevel/probe",
  "PUT /api/phone-calls",
  "PUT /api/phone-calls/probe",
  "PUT /api/phone-calls/settings",
  "PUT /api/restore-job/probe",
  "PUT /api/sentinel/issues",
  "PUT /api/sentinel/summary",
  "PUT /api/signal/probe",
  "PUT /api/skills",
  "PUT /api/skills/probe",
  "PUT /api/terms",
  "PUT /api/threads/a/browser-setup/a",
];
const REFUSED_GET = /^\/api\/(?:internal|model-gateway|phones\/self|desktop|desktop-secret|cli-candidates|teams\/scout|browser\/linux-sandbox|browser-extension\/(?:mcp|clients)|bots\/[\w-]+\/browser-choice|bots\/[\w-]+\/browser-extension\/(?:check|start-task))(?:\/|$)/;

function requests() {
  const out: { method: string; sample: string; entry: NonNullable<ReturnType<typeof routePolicy>> }[] = [], seen = new Set<string>();
  for (const route of discoverRoutes()) for (const method of route.methods ?? ALL_METHODS) for (const sample of route.samples) {
    const entry = routePolicy(method, sample); const key = `${method} ${sample}`;
    if (!entry || seen.has(key)) continue;
    seen.add(key); out.push({ method, sample, entry });
  }
  return out;
}

describe("the matrix over every ROUTE_POLICY request", () => {
  const all = requests();
  it("covers a real set of routes", () => { expect(all.length).toBeGreaterThan(800); });

  it("anonymous and service answer exactly as before", () => {
    for (const { method, sample, entry } of all) {
      const read = ["GET", "HEAD"].includes(method);
      expect(cloudRouteDecision(method, sample, "anonymous", {}), `anonymous ${method} ${sample}`).toBe((entry.class === "health" && sample !== "/api/desktop-secret") || (entry.class === "media" && read) ? "allow" : "deny");
      const open = ["health", "internal", "media", "extension"].includes(entry.class) && sample !== "/api/desktop-secret" && !SENTINEL_OWNER_ROUTE.test(sample);
      expect(cloudRouteDecision(method, sample, "service", {}), `service ${method} ${sample}`).toBe(open ? "allow" : "deny");
    }
  });
  it("a chat-only browser never reaches an administering class and is never asked for a code", () => {
    for (const { method, sample, entry } of all) {
      const decision = cloudRouteDecision(method, sample, "browser", {});
      expect(decision, `browser ${method} ${sample}`).not.toBe("email-code required");
      if (["internal", "extension", "engine-login", "phone"].includes(entry.class)) expect(decision, `browser ${method} ${sample}`).toBe("deny");
    }
  });
  it("owner-phone and owner-desktop are never asked for an emailed code", () => {
    for (const { method, sample, entry } of all) for (const scope of ["owner-phone", "owner-desktop"] as const) {
      for (const stepped of [false, true]) expect(cloudRouteDecision(method, sample, scope, {}, stepped), `${scope} ${method} ${sample}`).not.toBe("email-code required");
      if (scope === "owner-phone" && !["GET", "HEAD", "OPTIONS"].includes(method) && entry.cloudWrite === "credential") expect(cloudRouteDecision(method, sample, scope, {}, true), `${scope} ${method} ${sample}`).toBe("deny");
    }
  });
  it("owner-desktop keeps its step-up on every sensitive write, as before", () => {
    expect(cloudRouteDecision("POST", "/api/provider-connections", "owner-desktop", {})).toBe("step-up required");
    expect(cloudRouteDecision("POST", "/api/provider-connections", "owner-desktop", {}, true)).toBe("allow");
    expect(cloudRouteDecision("GET", "/api/engine-login/codex", "owner-desktop", {})).toBe("step-up required");
    expect(cloudRouteDecision("PATCH", "/api/bots/b1", "owner-desktop", { fullAccess: true })).toBe("step-up required");
    expect(cloudRouteDecision("PATCH", "/api/bots/b1", "owner-phone", { fullAccess: true }, true)).toBe("deny");
  });
  it("remembered-owner: reads open except the machine and capability routes; a write follows its tier and a proof", () => {
    const deniedReads: string[] = [];
    for (const { method, sample, entry } of all) {
      const read = ["GET", "HEAD", "OPTIONS"].includes(method);
      const none = cloudRouteDecision(method, sample, "remembered-owner", {});
      const proven = cloudRouteDecision(method, sample, "remembered-owner", {}, false, { proof: "ok" });
      const fresh = cloudRouteDecision(method, sample, "remembered-owner", {}, false, { doorFresh: true });
      const answer = tier(method, sample, {});
      const label = `remembered-owner ${method} ${sample}`;
      expect(none, label).not.toBe("step-up required");
      if (entry.class === "engine-login") { expect(none, label).toBe("deny"); expect(cloudRouteDecision(method, sample, "remembered-owner", {}, false, { engineTicket: true }), label).toBe("allow"); continue; }
      if (HIGHLEVEL_REVIEW_ROUTE.test(sample)) { expect([none, proven, fresh], label).toEqual(["deny", "deny", "deny"]); continue; }
      if (SENTINEL_OWNER_ROUTE.test(sample)) { expect(none, label).toBe(read ? "allow" : "deny"); continue; }
      if (sample === "/api/desktop-secret" || sample === "/api/storage/attachments/remove") { expect(none, label).toBe("deny"); continue; }
      if (read) {
        expect(none, label).toBe(answer.tier === "refused" ? "deny" : "allow");
        if (none === "deny") deniedReads.push(sample);
        continue;
      }
      if (["internal", "extension", "media", "phone", "engine-login", "health"].includes(entry.class)) expect(none, label).toBe("deny");
      if (answer.tier === "refused") { expect([none, proven, fresh], label).toEqual(["deny", "deny", "deny"]); continue; }
      if (answer.tier === "plain") { expect([none, proven, fresh], label).toEqual(["allow", "allow", "allow"]); continue; }
      expect(none, label).toBe("email-code required");
      expect(proven, label).toBe("allow");
      expect(fresh, label).toBe(answer.tier === "fresh-door" ? "allow" : "email-code required");
    }
    for (const sample of deniedReads) expect(sample, `denied read ${sample}`).toMatch(REFUSED_GET);
    expect(deniedReads.length).toBeGreaterThan(30);
  });
  it("a route with an entry the browser reaches has a tier decision, and the ones without are an explicit inventory", () => {
    const unruled = all.filter(({ method, sample }) => !browserOwnerRule(method, sample)).map(({ method, sample }) => `${method} ${sample}`).sort();
    // Unsupported method/shape combinations and writes with no browser act are refused.
    // f5bbeb1190 requires new routes to stay closed until explicitly decided.
    // a628e9c486 adds Signal namespace probes; 4f6495f025 adds bot review;
    // c9f99951c2 adds connector incidents. Keep all six additions refused.
    // W2 restore writes are desktop-only; the browser keeps refusing every restore write and unsupported method.
    // A NEW route or a new
    // method on an old one that lands here shows up as a diff: decide it in browser-owner-policy.ts, or add it here on purpose.
    expect(unruled).toEqual(INVENTORY_NO_RULE);
    for (const line of unruled) { const [method, sample] = line.split(" ") as [string, string]; expect(tier(method, sample, {}).tier, line).toBe("refused"); }
  });
  it("every write a browser may reach carries a body read when its answer depends on the body", () => {
    for (const { method, sample } of all) {
      if (["GET", "HEAD", "OPTIONS"].includes(method)) continue;
      const answer = tier(method, sample, {}), rule = browserOwnerRule(method, sample);
      if (rule && (answer.tier === "code" || answer.tier === "fresh-door" || rule.decide)) expect(cloudRouteNeedsBody(method, sample), `${method} ${sample}`).toBe(true);
    }
  });
  it("every write a string-path ROUTE_POLICY entry lists has a rule or is in the inventory", () => {
    for (const entry of ROUTE_POLICY) {
      if (typeof entry.path !== "string") continue;
      for (const method of (entry.methods === "*" ? ["POST"] : entry.methods).filter(m => !["GET", "HEAD", "OPTIONS"].includes(m)))
        expect(browserOwnerRule(method, entry.path) !== undefined || INVENTORY_NO_RULE.includes(`${method} ${entry.path}`), `${method} ${entry.path}`).toBe(true);
    }
  });
});

describe("the auth layer's own handlers have a policy answer", () => {
  const source = readFileSync(join(import.meta.dirname, "cloud-request-auth.ts"), "utf8");
  // Answered by cloud-request-auth.ts BEFORE the route decision (they need no policy answer: door, bootstrap and HMAC routes) or by it as a route
  // that the policy table decides for a browser.
  const BEFORE_THE_DECISION = new Set(["/.well-known/murage/environment", "/api/cloud/door-state", "/api/cloud/enter", "/api/cloud/enter/report", "/api/cloud/stop", "/api/cloud/drain",
    "/api/cloud/revoke-sessions", "/api/cloud/account/resume", "/api/cloud/recovery/hold", "/api/cloud/devices/list", "/api/cloud/devices/revoke", "/api/cloud/devices", "/api/cloud/devices/forget",
    "/api/cloud/pairing", "/api/cloud/pair", "/api/cloud/challenge", "/api/cloud/refresh", "/api/cloud/recovery/cancel"]);
  it("every /api path the file names is accounted for", () => {
    const named = new Set([...source.matchAll(/"((?:\/\.well-known\/murage\/environment)|(?:\/api\/cloud\/[a-z/-]+))"/g)].map(match => match[1]!));
    expect(named.size).toBeGreaterThan(10);
    // Answered AFTER the route decision, so the policy table is what protects them: the account delete.
    const AFTER_THE_DECISION = new Map([["/api/cloud/account", "DELETE"]]);
    for (const path of named) {
      if (path === "/api/cloud/owner-code/send" || path === "/api/cloud/owner-code/verify") expect(tier("POST", path, {}).tier, path).toBe("plain");   // the code dialog's routes: plain here, then cloud-request-auth.ts checks the act token and an owner browser
      else if (path === "/api/cloud/engine-login/ticket") expect(tier("POST", path, {}).tier, path).toBe("fresh-door");   // answered after the decision: the policy table's fresh-door tier gates the ticket
      else if (AFTER_THE_DECISION.has(path)) expect(tier(AFTER_THE_DECISION.get(path)!, path, {}).tier, path).toBe("refused");
      else expect(BEFORE_THE_DECISION.has(path), `${path} is neither answered before the decision nor in the policy table`).toBe(true);
    }
  });
  it("the pairing, account and recovery routes are refused to the owner's browser, wherever they are answered", () => {
    for (const path of ["/api/cloud/pairing", "/api/cloud/account", "/api/cloud/recovery/cancel", "/api/cloud/recovery/hold", "/api/cloud/recovery/x"]) expect(tier("POST", path, {}).tier, path).toBe("refused");
    expect(tier("DELETE", "/api/cloud/account", {}).tier).toBe("refused");
  });
  it("the two regex handlers (remove another device, make chat-only) are a code", () => {
    expect(source).toContain("devices\\/([a-f0-9-]+)$/.exec(path)");
    expect(source).toContain("owner\\/revoke$/.exec(path)");
    expect(tier("DELETE", "/api/cloud/devices/0a1b-2c", {})).toMatchObject({ tier: "code", label: "device_remove" });
    expect(tier("POST", "/api/cloud/devices/0a1b-2c/owner/revoke", {})).toMatchObject({ tier: "code", label: "device_remove" });
    // the device's own list and forget stay answered before the decision for every device
    expect(BEFORE_THE_DECISION.has("/api/cloud/devices")).toBe(true);
  });
});

// ── real requests through createCloudRequestAuth ──────────────────────────────────────────────────────────────────────

let sessions: CloudSessions, upstream: Server, clock = Date.now();
beforeEach(() => { vi.stubEnv("MURAGE_CLOUD_ROLE", "home"); clock = Date.now(); });
afterEach(async () => {
  if (upstream?.listening) { const closed = once(upstream, "close"); upstream.close(); upstream.closeAllConnections(); await closed; }
  if (sessions?.db.isOpen) sessions.db.close(); vi.unstubAllEnvs();
});
const p256 = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = (key: { publicKey: import("node:crypto").KeyObject }) => key.publicKey.export({ format: "pem", type: "spki" }).toString();
const DAY = 24 * 60 * 60 * 1000;
function addBrowser(opts: { factor?: false | "remembered-owner"; proof?: "email" | "factor"; stepUpAt?: number; revoked?: boolean } = {}) {
  const key = p256(), confirm = p256(), id = randomUUID(), factor = opts.factor ?? "remembered-owner";
  sessions.db.prepare("INSERT OR IGNORE INTO cloud_meta VALUES ('account','owner')").run();
  sessions.db.prepare("INSERT INTO cloud_devices (id,account,scope,publicKey,assertionKey,revoked,addedAt,lastSeenAt) VALUES (?,?,?,?,?,0,0,0)").run(id, "owner", "browser", pem(key), pem(confirm));
  if (factor) {
    const keyHash = createHash("sha256").update(createPublicKey(pem(confirm)).export({ type: "spki", format: "der" })).digest("hex"), at = opts.stepUpAt ?? clock;
    sessions.db.prepare("INSERT INTO cloud_browser_factors (device,payload,kind,issuedAt,expiresAt,keyHash,stepUpAt,revokedAt) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, JSON.stringify({ kind: "remembered-owner", keyHash, proof: opts.proof ?? "email", stepUpAt: at }), "remembered-owner", clock, clock + 30 * DAY, keyHash, at, opts.revoked ? clock : null);
  }
  const issued = sessions.issue(id);
  return { id, ...issued, cookie: { cookie: `__Host-murage=${issued.accessToken}` } };
}
type Handler = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void | Promise<void>;
async function start(ownerAct?: CloudOwnerAct, handler?: Handler) {
  sessions = new CloudSessions(new DatabaseSync(":memory:"), () => clock, origin);
  const auth = createCloudRequestAuth({ sessions, publicOrigin: origin, bootstrapSecret: () => "fixture-bootstrap-key-32-characters", ...(ownerAct ? { ownerAct } : {}) });
  upstream = createServer(async (req, res) => {
    if (await auth(req, res, new URL(req.url!, origin))) return;
    if (handler) return handler(req, res);
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ reachedHandler: true }));
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  return (upstream.address() as AddressInfo).port;
}
function call(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: unknown, local = false) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request({ host: "127.0.0.1", port, method, path, agent: false, headers: { host: local ? `127.0.0.1:${port}` : "home.example", ...(local ? {} : { origin }), "content-type": "application/json", ...(data ? { "content-length": String(data.length) } : {}), ...headers } }, res => {
      const chunks: Buffer[] = []; res.on("data", c => chunks.push(c)); res.on("end", () => { const t = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode!, body: t ? JSON.parse(t) : null }); });
    }); req.on("error", reject); req.end(data);
  });
}

describe("the 403 email_code answer and the proof", () => {
  const acts: string[] = [];
  const ownerAct = (state: { fresh?: boolean } = {}): CloudOwnerAct => ({
    token: input => { acts.push(input.act); return `tok.${input.label}.${input.deviceId.slice(0, 4)}`; },
    verifyProof: (req, _device, act) => req.headers["x-murage-owner-proof"] === `proof-for-${act}`,
    doorFresh: () => state.fresh === true,
  });
  beforeEach(() => { acts.length = 0; });

  it("answers a code route with 403 email_code, the act token, the label, and runs no handler", async () => {
    let reached = false;
    const port = await start(ownerAct(), (_req, res) => { reached = true; res.end("{}"); });
    const r = addBrowser(), body = { fullAccess: true };
    const asked = await call(port, "PATCH", "/api/bots/b1", r.cookie, body);
    expect(asked.status).toBe(403);
    expect(asked.body).toMatchObject({ code: "email_code", label: "full_access", error: cloudHomeCopy.ownerCodeNeeded });
    expect(asked.body.actToken).toMatch(/^tok\.full_access\./);
    expect(acts).toEqual([routeActDigest("PATCH", "/api/bots/b1", body)]);
    expect(reached).toBe(false);
  });
  it("the act is the sha256 of the step-up purpose string, so it binds the method, the path with its query and the body", () => {
    expect(routeActDigest("PATCH", "/api/bots/b1?x=1", { a: 1 })).toBe(createHash("sha256").update(stepPurpose("PATCH", "/api/bots/b1?x=1", { a: 1 })).digest("hex"));
    expect(routeActDigest("PATCH", "/api/bots/b1", { a: 1 })).not.toBe(routeActDigest("PATCH", "/api/bots/b1", { a: 2 }));
    expect(routeActDigest("PATCH", "/api/bots/b1", { a: 1 })).not.toBe(routeActDigest("PATCH", "/api/bots/b2", { a: 1 }));
    expect(routeActDigest("PATCH", "/api/bots/b1", { a: 1 })).not.toBe(routeActDigest("PUT", "/api/bots/b1", { a: 1 }));
  });
  it("lets the same request through with a proof for exactly its act, and not with a proof for another body", async () => {
    const port = await start(ownerAct()), r = addBrowser(), body = { fullAccess: true }, other = { fullAccess: true, name: "x" };
    const good = `proof-for-${routeActDigest("PATCH", "/api/bots/b1", body)}`;
    expect((await call(port, "PATCH", "/api/bots/b1", { ...r.cookie, "x-murage-owner-proof": good }, body)).status).toBe(200);
    expect((await call(port, "PATCH", "/api/bots/b1", { ...r.cookie, "x-murage-owner-proof": good }, other)).status).toBe(403);
    expect((await call(port, "PATCH", "/api/bots/b1", { ...r.cookie, "x-murage-owner-proof": "nonsense" }, body)).status).toBe(403);
  });
  it("a proof never opens a refused route", async () => {
    const port = await start(ownerAct()), r = addBrowser(), body = { noLimits: true };
    const proof = `proof-for-${routeActDigest("PATCH", "/api/bots/b1", body)}`;
    const refused = await call(port, "PATCH", "/api/bots/b1", { ...r.cookie, "x-murage-owner-proof": proof }, body);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBeUndefined();
    expect(refused.body.error).toBe(cloudHomeCopy.pairedDeviceRequired);
  });
  it("with no code service the answer is still 403 email_code, with no token and the plain unavailable words", async () => {
    const port = await start(), r = addBrowser();
    const asked = await call(port, "DELETE", "/api/bots/b1", r.cookie, {});
    expect(asked.status).toBe(403);
    expect(asked.body).toMatchObject({ code: "email_code", error: cloudHomeCopy.ownerCodeUnavailable, label: "delete" });
    expect(asked.body.actToken).toBeUndefined();
    // and everything plain keeps working
    expect((await call(port, "PUT", "/api/config", r.cookie, { profile: { name: "A" } })).status).toBe(200);
  });
  it("a fresh door proof makes the fresh-door tier plain and leaves the code tier asking", async () => {
    const fresh = { fresh: true }, port = await start(ownerAct(fresh)), r = addBrowser({ stepUpAt: clock - 5 * 60_000 });
    expect((await call(port, "POST", "/api/telegram/pair", r.cookie, {})).status).toBe(200);
    expect((await call(port, "DELETE", "/api/bots/b1", r.cookie, {})).status).toBe(403);
    fresh.fresh = false;
    expect((await call(port, "POST", "/api/telegram/pair", r.cookie, {})).body).toMatchObject({ code: "email_code", label: "fresh_door" });
  });
  it("reads the door proof from the sessions when no code service is wired, at the 30 minute edge", async () => {
    const port = await start(), young = addBrowser({ stepUpAt: clock - DOOR_FRESH_MS }), old = addBrowser({ stepUpAt: clock - DOOR_FRESH_MS - 1 }), viaSite = addBrowser({ proof: "factor" });
    expect((await call(port, "POST", "/api/webhooks", young.cookie, {})).status).toBe(200);
    expect((await call(port, "POST", "/api/webhooks", old.cookie, {})).status).toBe(403);
    expect((await call(port, "POST", "/api/webhooks", viaSite.cookie, {})).status).toBe(403);
  });
  it("the proof binds the query string: the same body on another query needs its own proof", async () => {
    const port = await start(ownerAct()), r = addBrowser(), body = { fullAccess: true };
    const proof = `proof-for-${routeActDigest("PATCH", "/api/bots/b1", body)}`;
    expect((await call(port, "PATCH", "/api/bots/b1?other=1", { ...r.cookie, "x-murage-owner-proof": proof }, body)).status).toBe(403);
  });
});

describe("doorFreshAt", () => {
  it("counts an emailed proof only, at the 30 minute boundary, on a live row", async () => {
    await start();
    expect(DOOR_FRESH_MS).toBe(30 * 60 * 1000);
    const at = clock - 1000, emailed = addBrowser({ stepUpAt: at, proof: "email" });
    expect(sessions.doorFreshAt(emailed.id)).toBe(at);
    expect(sessions.doorFresh(emailed.id)).toBe(true);
    const edge = addBrowser({ stepUpAt: clock - DOOR_FRESH_MS });
    expect(sessions.doorFresh(edge.id)).toBe(true);
    const past = addBrowser({ stepUpAt: clock - DOOR_FRESH_MS - 1 });
    expect(sessions.doorFreshAt(past.id)).toBe(clock - DOOR_FRESH_MS - 1);
    expect(sessions.doorFresh(past.id)).toBe(false);
    const viaFactor = addBrowser({ stepUpAt: clock - 1000, proof: "factor" });
    expect(sessions.doorFreshAt(viaFactor.id)).toBeUndefined();
    expect(sessions.doorFresh(viaFactor.id)).toBe(false);
    expect(sessions.doorFreshAt(randomUUID())).toBeUndefined();
    const noFactor = addBrowser({ factor: false });
    expect(sessions.doorFreshAt(noFactor.id)).toBeUndefined();
    const revoked = addBrowser({ revoked: true });
    expect(sessions.doorFreshAt(revoked.id)).toBeUndefined();
    const fresh = addBrowser();
    sessions.revokeOwnerFactor(fresh.id);
    expect(sessions.doorFreshAt(fresh.id)).toBeUndefined();
  });
  it("a row that has expired is not a door proof", async () => {
    await start();
    const r = addBrowser(); clock += 31 * DAY;
    expect(sessions.doorFreshAt(r.id)).toBeUndefined();
  });
});

describe("Make this browser chat-only while a request body is still arriving", () => {
  it("answers as a chat-only browser would, not as the owner it was when the request began", async () => {
    const port = await start(), r = addBrowser();
    const first = JSON.stringify({ profile: { name: "A" }, language: "fr" });
    const result = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method: "PUT", path: "/api/config", agent: false, headers: { host: "home.example", origin, "content-type": "application/json", "content-length": String(Buffer.byteLength(first)), ...r.cookie } }, res => {
        const chunks: Buffer[] = []; res.on("data", c => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString() || "null") }));
      });
      req.on("error", reject);
      req.write(first.slice(0, 10));
      setTimeout(() => { sessions.revokeOwnerFactor(r.id); req.end(first.slice(10)); }, 150);
    });
    expect(result.status).toBe(403);
    expect(result.body.error).toBe(cloudHomeCopy.pairedDeviceRequired); // chat-only, not "sign in again"
    expect(sessions.device(r.id)).toMatchObject({ factor: false });
    // the same request, nothing in between, was the owner's
    const again = addBrowser();
    expect((await call(port, "PUT", "/api/config", again.cookie, { profile: { name: "A" }, language: "fr" })).status).toBe(200);
  });
});

describe("a bot's shell on loopback (service scope) is refused on every route the browser gained", () => {
  it("answers 403 over real HTTP and by decision on the whole matrix", async () => {
    const port = await start();
    for (const [method, path, body] of [["PUT", "/api/config", { profile: { name: "A" } }], ["POST", "/api/flux-connection", { key: "k" }], ["POST", "/api/setup/answer", {}], ["POST", "/api/webhooks", {}],
      ["PATCH", "/api/bots/b1", { name: "x" }], ["POST", "/api/starter-profiles", { profileId: "starter-solo-business" }], ["DELETE", "/api/bots/b1", {}], ["POST", "/api/telegram/pair", {}], ["PUT", "/api/bots/b1/general-notes", { text: "x" }]] as const)
      expect((await call(port, method, path, {}, body, true)).status, `${method} ${path}`).toBe(403);
    for (const { method, sample, entry } of requests()) {
      if (cloudRouteDecision(method, sample, "remembered-owner", {}) === "deny") continue;
      const service = cloudRouteDecision(method, sample, "service", {});
      if (service === "allow") expect(["health", "internal", "media", "extension"], `service ${method} ${sample}`).toContain(entry.class);
      else expect(service, `service ${method} ${sample}`).toBe("deny");
    }
  });
});

describe("recovery cancel", () => {
  it("is refused to a browser of any factor", async () => {
    const port = await start(), owner = addBrowser(), chat = addBrowser({ factor: false });
    expect((await call(port, "POST", "/api/cloud/recovery/cancel", owner.cookie, { recoveryId: "r" })).status).toBe(403);
    expect((await call(port, "POST", "/api/cloud/recovery/cancel", chat.cookie, { recoveryId: "r" })).status).toBe(403);
  });
});

// ── the surface rules ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("an owner browser reads as the owner's phone, never as the computer", () => {
  const as = (scope: string, extra: Record<string, unknown> = {}) => { const headers = {}; setCloudIdentity(headers, { id: "d1", account: "owner", scope, revoked: false, ...extra } as any); return headers; };
  const P256 = pem(p256());
  const owner = () => as("browser", { factor: "remembered-owner", publicKey: P256, assertionKey: P256 });
  const legacyPasskey = () => as("browser", { factor: "passkey", publicKey: P256, assertionKey: P256 });

  it("acts, with either factor kind, and maps both to remembered-owner", () => {
    for (const headers of [owner(), legacyPasskey()]) { expect(ownerBrowserActs(cloudIdentity(headers))).toBe(true); expect(ownerBrowserScope(cloudIdentity(headers))).toBe("remembered-owner"); }
    expect(isOwnerBrowser({ scope: "browser", factor: false, publicKey: P256, assertionKey: P256, revoked: false } as any)).toBe(false);
  });
  it("requestSurface says desktop (so approvals, mayApprove and SSE scoping apply) while the computer predicates stay false", () => {
    for (const headers of [owner(), legacyPasskey()]) {
      expect(requestSurface(headers), "surface").toBe("desktop");
      expect(isDesktopApp(headers), "isDesktopApp").toBe(false);
      expect(skipsFreshAuth(headers), "skipsFreshAuth").toBe(false);
      expect(requestFromComputer(headers), "requestFromComputer").toBe(false);
      expect(ownerSurface(headers), "ownerSurface").toBe("phone");
      expect(companionAuthorized(headers)).toBe(true);
    }
  });
  it("a chat-only browser is never the desktop app, even on a settings read", () => {
    const chat = as("browser", { factor: false, settingsRead: true });
    expect(requestSurface(chat)).toBe("desktop");
    expect(isDesktopApp(chat)).toBe(false);
    expect(skipsFreshAuth(chat)).toBe(false);
    expect(requestSurface(as("browser", { factor: false }))).toBe("remote");
  });
  it("owner-desktop, owner-phone and the service listener are unchanged", () => {
    expect([isDesktopApp(as("owner-desktop")), skipsFreshAuth(as("owner-desktop")), requestFromComputer(as("owner-desktop")), ownerSurface(as("owner-desktop"))]).toEqual([true, true, true, "desktop"]);
    expect([isDesktopApp(as("owner-phone")), skipsFreshAuth(as("owner-phone")), requestFromComputer(as("owner-phone")), ownerSurface(as("owner-phone"))]).toEqual([false, false, false, "phone"]);
    expect(isDesktopApp(as("service"))).toBe(false);
  });
  it("off a Cloud home nothing changes: the identity is ignored and the surface is the launch proof alone", () => {
    vi.stubEnv("MURAGE_CLOUD_ROLE", "");
    for (const headers of [owner(), as("owner-desktop"), as("owner-phone")]) {
      expect(isDesktopApp(headers)).toBe(requestSurface(headers) === "desktop");
      expect(isDesktopApp(headers)).toBe(false);
    }
  });
});
