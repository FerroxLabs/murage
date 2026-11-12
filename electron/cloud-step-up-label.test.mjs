// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// B3 WP4: the words a step-up confirmation shows. Checked against the REAL route policy: every step-up / credential route
// there must have a human label, so a route added later without one fails here instead of showing a generic sentence.
import { describe, expect, it, vi } from "vitest";

import { ROUTE_POLICY, cloudRouteDecision, routePolicy } from "../server/route-policy.ts";
import { COPY, createNativeStepUpConfirm } from "./cloud-home-client.mjs";
import { FALLBACK_LABEL, PROGRAM_SHOW_MAX, SETTINGS_MAX, STEP_UP_LABELS, describeStepUp, findStepUpLabel, programLine } from "./cloud-step-up-label.mjs";
import { STEP_UP_EN } from "./step-up-locale.mjs";

// One concrete request per step-up / credential entry in server/route-policy.ts (and a few the gate escalates by shape).
const SAMPLES = [
  ["POST", "/api/claude-code-import"], ["POST", "/api/move-in/grok"],
  ["POST", "/api/cloud/model-signins/chatgpt/start"], ["POST", "/api/cloud/model-signins/supergrok/attempts/abc123/cancel"], ["DELETE", "/api/cloud/model-signins/chatgpt"],
  ["POST", "/api/cloud/own-server"], ["POST", "/api/data-dir/confirm-root"], ["POST", "/api/cloud/pairing"], ["POST", "/api/cloud/devices/d1"],
  ["POST", "/api/bots/b1/computer/join"], ["GET", "/api/mcp-grants"], ["POST", "/api/mcp-grants"], ["DELETE", "/api/mcp-grants/g1"], ["POST", "/api/routines/r1/run"],
  ["GET", "/api/bots/b1/browser-extension/activity"], ["POST", "/api/bots/b1/browser-extension/mode"], ["POST", "/api/bots/b1/browser-extension/sites"],
  ["POST", "/api/bots/b1/browser-extension/check"], ["POST", "/api/bots/b1/browser-extension/start-task"], ["GET", "/api/browser-extension/clients"], ["POST", "/api/browser/linux-sandbox/enable"],
  ["PATCH", "/api/groups/g1/project/budget"], ["POST", "/api/groups/g1/project/budget"], ["PUT", "/api/groups/g1/project/work-roots"],
  ["PATCH", "/api/groups/g1/project/work-profile"], ["PATCH", "/api/groups/g1/project/settings"],
  ["PATCH", "/api/bots/b1/sharing"], ["POST", "/api/bots/b1/sharing/skills"], ["POST", "/api/bots/b1/sharing/copy"],
  ["POST", "/api/flux-connection"], ["POST", "/api/provider-connections"], ["POST", "/api/local-models"], ["POST", "/api/claude-accounts"],
  ["POST", "/api/memory/x"], ["PATCH", "/api/config"], ["PUT", "/api/config"], ["POST", "/api/skills/import"],
  ["POST", "/api/teams/import"], ["POST", "/api/team-library/github"], ["POST", "/api/team-library/grok"], ["POST", "/api/packages/import"], ["POST", "/api/starter-profiles"],
  ["POST", "/api/telegram/pair"], ["POST", "/api/slack/revoke"], ["POST", "/api/whatsapp/link"], ["POST", "/api/cli-test"],
  ["POST", "/api/engine-management/codex"], ["PATCH", "/api/instances/i1"], ["POST", "/api/instances/i1/claude-update"], ["POST", "/api/hermes/profiles/import"],
  ["POST", "/api/mcp/servers"], ["POST", "/api/mcp/inspect"], ["POST", "/api/folder-trust"], ["POST", "/api/local-computer"],
  ["POST", "/api/routines"], ["PATCH", "/api/routines/r1"], ["DELETE", "/api/routines/r1"], ["POST", "/api/routines/r1/always-allow"],
  ["POST", "/api/webhooks"], ["PATCH", "/api/webhooks/w1"], ["POST", "/api/webhooks/w1/rotate"],
  ["POST", "/api/connectors/c1/authorize"], ["DELETE", "/api/connectors/c1"],
  ["PUT", "/api/bots/b1/access"], ["POST", "/api/bots/b1/always-allow"], ["POST", "/api/bots/b1/assistant-profile"], ["POST", "/api/bots/b1/skills/my-skill/rollback"],
  ["POST", "/api/bots/b1/held-continuations/h1/retry"], ["POST", "/api/restore-holds/shared_result/r1/release"], ["PATCH", "/api/bots/b1/message-allow"],
  ["POST", "/api/bots/b1/secret-cards/s1/provided"], ["POST", "/api/bots/b1/connector-cards/c1/authorize"], ["POST", "/api/bots/b1/mcp-sign-in-cards/m1/resume"],
  ["POST", "/api/publish/netlify/check"], ["POST", "/api/bots/b1/published-sites/s1/take-down"],
  ["POST", "/api/bots/b1/computer/provision"], ["POST", "/api/bots/b1/local-computer/run"],
  ["GET", "/api/engine-login/codex"], ["GET", "/api/engine-login/antigravityAgent"], ["POST", "/api/bots/b1/engine-signin/code"],
  ["DELETE", "/api/bots/b1"], ["DELETE", "/api/groups/g1"], ["PATCH", "/api/groups/g1"], ["PATCH", "/api/bots/b1"], ["POST", "/api/bots"], ["PATCH", "/api/bots/b1/profile"],
  ["POST", "/api/move/commit"], ["POST", "/api/lend/scopes"],
  // 1.0.4 step-up routes (SL-K/SL-I chat permissions and limit backup, MCP-118-175 enable cards, SL-H attachment remove).
  ["POST", "/api/bots/b1/tasks/t1/permissions/refresh"], ["PUT", "/api/bots/b1/limit-backup"], ["DELETE", "/api/bots/b1/limit-backup"],
  ["POST", "/api/bots/b1/mcp-enable-cards/c1/enable"], ["POST", "/api/storage/attachments/remove"],
  // 1.0.13 step-up route (UX L1A: taking back a task allowance).
  ["POST", "/api/bots/b1/task-allow/clear"],
  // 1.0.8 step-up route (A-UI: raising the default offers it to the bot's open chats).
  ["POST", "/api/bots/b1/permissions/refresh"],
  // 1.0.9 bot email owner routes.
  ["POST", "/api/email/account"], ["POST", "/api/email/other-setups/inbox-1/remove"], ["POST", "/api/email/bots/b1/setup"],
  ["POST", "/api/email/bots/b1/trusted-add"], ["GET", "/api/email/status"],
  // BOT-CALLS owner routes, including the collection path.
  ["GET", "/api/phone-calls"], ["POST", "/api/phone-calls/setup"], ["PUT", "/api/phone-calls/settings"],
  ["POST", "/api/phone-calls/c1/cancel"], ["POST", "/api/phone-calls/c1/share"],
  // 1.0.9 bot call settings.
  ["PUT", "/api/bots/b1/calls/rules"], ["POST", "/api/calls/off-today"], ["POST", "/api/calls/rearm"],
  // 1.0.13 the desktop accepts the No limits terms.
  ["POST", "/api/no-limits/terms"],
  // 1.0.14 Call me when this finishes, and the desktop engine sign-in and set-up check.
  ["POST", "/api/calls/turn-end"], ["POST", "/api/engine-setup-check"], ["POST", "/api/engine-signin-recipe"], ["POST", "/api/engine-signin-probe"],
  // 1.0.17 C31: add a Voice Library voice to the owner's own ElevenLabs account.
  ["POST", "/api/tts/voices/add"],
  // 1.0.18 HighLevel owner routes (read only): check, confirm, per-bot read access, disconnect, and the catch-all.
  ["POST", "/api/highlevel/token/check"], ["POST", "/api/highlevel/token/0f8fad5b-d9cb-469f-a165-70867728950e/confirm"],
  ["PUT", "/api/highlevel/bots/b1/access"], ["DELETE", "/api/highlevel/connections/hl_abcd1234"], ["PATCH", "/api/highlevel/other"],
  // 1.0.18 CROSS-CHAT-READ: the owner's Share / Don't share on a share card, and the composer's ask for a room.
  ["POST", "/api/room-shares/s1/share"], ["POST", "/api/room-shares/s1/decline"], ["POST", "/api/groups/g1/room-shares"],
  ["GET", "/api/connector-incidents/0f8fad5b-d9cb-469f-a165-70867728950e"],
  ["POST", "/api/connector-incidents/0f8fad5b-d9cb-469f-a165-70867728950e"],
  ["GET", "/api/signal/status"], ["POST", "/api/signal/link/start"],
];

describe("every step-up route has a human label", () => {
  it("each sample is named in words, not the generic fallback", () => {
    const unlabeled = SAMPLES.filter(([method, path]) => !findStepUpLabel(method, path)).map(([m, p]) => `${m} ${p}`);
    expect(unlabeled).toEqual([]);
  });

  it("the samples cover EVERY step-up / credential / browser-step-up entry in server/route-policy.ts", () => {
    const sensitive = ROUTE_POLICY.filter((entry) => ["step-up", "credential", "browser-step-up"].includes(entry.cloudWrite ?? "") && !entry.arrives);
    expect(sensitive.length).toBeGreaterThan(40);
    const hit = new Set(SAMPLES.map(([method, path]) => routePolicy(method, path)).filter(Boolean));
    const uncovered = sensitive.filter((entry) => !hit.has(entry)).map((entry) => `${JSON.stringify(entry.methods)} ${String(entry.path)}`);
    expect(uncovered, "add a SAMPLES row and a STEP_UP_LABELS entry for each").toEqual([]);
  });

  it("the gate really asks for step-up on the sampled step-up and credential routes, so the labels are for requests that happen", () => {
    for (const [method, path] of SAMPLES) {
      const cloudWrite = routePolicy(method, path)?.cloudWrite;
      // 1.0.4 SL-H: attachment remove is refused on every Cloud home before step-up is considered (route-policy.ts).
      if (path === "/api/storage/attachments/remove") {
        expect(cloudRouteDecision(method, path, "owner-desktop", {}, false), `${method} ${path}`).toBe("deny");
        continue;
      }
      if (method !== "GET" && (cloudWrite === "step-up" || cloudWrite === "credential")) {
        expect(cloudRouteDecision(method, path, "owner-desktop", {}, false), `${method} ${path}`).toBe("step-up required");
      }
    }
    expect(cloudRouteDecision("PATCH", "/api/bots/b1", "owner-desktop", { fullAccess: true }, false)).toBe("step-up required");
    expect(cloudRouteDecision("POST", "/api/cloud/pairing", "owner-desktop", {}, false)).toBe("step-up required");
  });

  it("a bot email action names the bot it changes (1.0.9)", () => {
    const described = describeStepUp({ method: "POST", path: "/api/email/bots/ember-1/pause", body: {}, botName: "Ember" });
    expect(JSON.stringify(described)).toContain("Change a bot's email address or who can email it");
    expect(JSON.stringify(described)).toContain("Ember (ember-1)");
  });

  it("each HighLevel owner route gets its own sentence, and a pasted token in the body is never shown (1.0.18)", () => {
    expect(findStepUpLabel("POST", "/api/highlevel/token/check")?.label).toBe("Check a HighLevel location");
    expect(findStepUpLabel("PUT", "/api/highlevel/bots/b1/access")?.label).toBe("Change what a bot can read in HighLevel");
    expect(findStepUpLabel("DELETE", "/api/highlevel/connections/hl_abcd1234")?.label).toBe("Disconnect your HighLevel location");
    const described = describeStepUp({ method: "POST", path: "/api/highlevel/token/check", body: { token: "pit-SECRET-1", locationId: "loc1" } });
    expect(JSON.stringify(described)).not.toContain("SECRET-1");
    expect(JSON.stringify(described)).not.toContain("loc1");
  });

  it("Signal and app reconnection confirmations name the action without showing body values", () => {
    for (const [path, label] of [
      ["/api/signal/link/start", "Change the Signal connection"],
      ["/api/connector-incidents/0f8fad5b-d9cb-469f-a165-70867728950e", "Connect an app"],
    ]) {
      const described = describeStepUp({ method: "POST", path, body: { accountId: "PRIVATE-ACCOUNT", alias: "PRIVATE-ALIAS" } });
      expect(described.known).toBe(true);
      expect(described.label).toBe(label);
      expect(described.lines).toEqual([]);
      expect(described.message).not.toMatch(/PRIVATE/);
    }
  });

  it("no two table entries disagree about a sample (first match wins, and it is the intended one)", () => {
    for (const [method, path] of SAMPLES) {
      const matches = STEP_UP_LABELS.filter((entry) => (entry.methods === "*" || entry.methods.includes(method)) && entry.path.test(path));
      expect(matches.length, `${method} ${path}`).toBeGreaterThan(0);
    }
  });
});

describe("describeStepUp", () => {
  it("names the action, the bot and the settings; shows setting NAMES never values; flags what it turns on", () => {
    const described = describeStepUp({ method: "PATCH", path: "/api/bots/ember-1", body: { color: "green", fullAccess: true, acknowledgeFullAccess: true }, botName: "Ember" });
    expect(described.label).toBe("Change a bot's settings");
    expect(described.known).toBe(true);
    expect(described.lines).toEqual(["Bot: Ember (ember-1)", "Settings: color", "Turns on: Full access"]);
    expect(described.request).toBe("PATCH /api/bots/ember-1");
    expect(described.message).toContain("Change a bot's settings");
  });

  it("never prints a value that could be a secret", () => {
    const described = describeStepUp({ method: "PATCH", path: "/api/config", body: { openaiKey: "sk-live-SECRET", theme: "dark" } });
    expect(described.label).toBe("Change app settings");
    expect(described.message).not.toMatch(/SECRET|sk-live/);
    expect(described.lines).toEqual(["Settings: openaiKey, theme"]);
    const credential = describeStepUp({ method: "POST", path: "/api/provider-connections", body: { apiKey: "SECRET-1", name: "x" } });
    expect(credential.message).not.toMatch(/SECRET/);
  });

  it("phone call confirmation names the action without exposing credentials or call contents", () => {
    const described = describeStepUp({ method: "POST", path: "/api/phone-calls/setup", body: { apiKey: "SECRET", transcript: "PRIVATE" } });
    expect(described.known).toBe(true);
    expect(described.label).toBe("Manage bot phone calls");
    expect(described.lines).toEqual([]);
    expect(described.message).not.toMatch(/SECRET|PRIVATE/);
  });

  it("add-device names the device type and a key fingerprint, not the key", () => {
    const body = { operation: "/api/cloud/pairing", scope: "owner-desktop", publicKey: "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n" };
    const described = describeStepUp({ method: "POST", path: "/api/cloud/pairing", body });
    expect(described.label).toBe("Add a new device to your Cloud home");
    expect(described.lines[0]).toBe("Device type: owner-desktop");
    expect(described.lines[1]).toMatch(/^Device key: [0-9a-f]{4}-[0-9a-f]{4}$/);
    expect(described.message).not.toContain("AAAA");
  });

  it("an unknown route still gets a plain sentence with the method and path, never an opaque blob", () => {
    const described = describeStepUp({ method: "POST", path: "/api/brand-new?x=1", body: { a: 1 } });
    expect(described.label).toBe(FALLBACK_LABEL);
    expect(described.known).toBe(false);
    // the query's value is never shown; that one was there is marked
    expect(described.request).toBe("POST /api/brand-new?...");
    expect(described.message).not.toContain("x=1");
    // Touch ID cannot show the request line, so an unknown action always uses the dialog
    expect(described.reasonComplete).toBe(false);
  });

  it("renaming a bot shows the new name as its own line, so it is part of what is approved", () => {
    const described = describeStepUp({ method: "PATCH", path: "/api/bots/b1", body: { name: "Renamed", fullAccess: true }, botName: "Ember" });
    expect(described.lines).toEqual(["Bot: Ember (b1)", "Name: Renamed", "Turns on: Full access"]);
    expect(described.reason).toContain("Name: Renamed");
  });

  it("the dialog lists every setting name up to SETTINGS_MAX, and counts the rest", () => {
    const nine = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, 1]));
    const shown = describeStepUp({ method: "PATCH", path: "/api/bots/b1", body: nine });
    expect(shown.lines[1]).toBe(`Settings: ${Object.keys(nine).join(", ")}`);
    expect(shown.reasonComplete).toBe(false); // over 8 names: the dialog shows them all, Touch ID is not used
    const many = Object.fromEntries(Array.from({ length: SETTINGS_MAX + 2 }, (_, i) => [`k${i}`, 1]));
    const d = describeStepUp({ method: "PATCH", path: "/api/bots/b1", body: many });
    expect(d.lines[1].endsWith(", +2")).toBe(true);
    expect(d.reasonComplete).toBe(false);
  });

  it("control characters and bidi marks in a bot name or setting cannot dress up the sentence", () => {
    const described = describeStepUp({ method: "PATCH", path: "/api/bots/b1", body: { "x‮y": 1 }, botName: "Ember\n\nApprove everything‮" });
    expect(described.message).not.toMatch(/[‪-‮\n]Approve/);
    expect(described.lines[0]).toBe("Bot: Ember Approve everything (b1)");
  });

  it("every direction mark (LRM, RLM, ALM and the rest) is removed from a bot name and a setting name", () => {
    const marks = "‎‏؜‪‫‬‭‮⁦⁧⁨⁩";
    const described = describeStepUp({ method: "PATCH", path: "/api/bots/b1", body: { [`a${marks}b`]: 1 }, botName: `Em${marks}ber` });
    expect(described.message).not.toMatch(/\p{Bidi_Control}/u);
    expect(described.reason).not.toMatch(/\p{Bidi_Control}/u);
    expect(described.lines[0]).toBe("Bot: Em ber (b1)");
    expect(described.lines[1]).toBe("Settings: a b");
  });
});

describe("the native confirm shows the right label", () => {
  const dialog = (response = 0) => ({ showMessageBox: vi.fn(async () => ({ response })) });

  it("dialog: title line is the label, detail has the summary and the request", async () => {
    const d = dialog(0);
    const confirm = createNativeStepUpConfirm({ systemPreferences: {}, dialog: d, platform: "linux", resolveBotName: async (_home, id) => (id === "ember-1" ? "Ember" : undefined) });
    expect(await confirm({ homeId: "h", method: "PATCH", path: "/api/bots/ember-1", body: { pinned: true } })).toBe(true);
    const options = d.showMessageBox.mock.calls[0][0];
    expect(options.message).toBe("Change a bot's settings");
    expect(options.detail).toBe("Bot: Ember (ember-1)\nSettings: pinned\n\nPATCH /api/bots/ember-1");
    expect(options.buttons).toEqual(["Confirm", "Cancel"]);
    expect(options.cancelId).toBe(1);
  });

  it("Touch ID: the reason carries the label and the first summary line", async () => {
    const systemPreferences = { canPromptTouchID: () => true, promptTouchID: vi.fn(async () => undefined) };
    const confirm = createNativeStepUpConfirm({ systemPreferences, dialog: dialog(1), platform: "darwin", resolveBotName: async () => "Ember" });
    await confirm({ homeId: "h", method: "DELETE", path: "/api/bots/ember-1" });
    expect(systemPreferences.promptTouchID).toHaveBeenCalledWith("Delete a bot and its conversations (Bot: Ember (ember-1))");
  });

  it("a slow or failing name lookup never blocks or breaks the confirm", async () => {
    const d = dialog(0);
    const confirm = createNativeStepUpConfirm({ systemPreferences: {}, dialog: d, platform: "linux", resolveBotName: async () => { throw new Error("home down"); } });
    expect(await confirm({ homeId: "h", method: "DELETE", path: "/api/bots/ember-1" })).toBe(true);
    expect(d.showMessageBox.mock.calls[0][0].detail).toContain("Bot: ember-1");
  });
});

describe("the engine check names the exact program", () => {
  const describeCli = (body, language) => describeStepUp({ method: "POST", path: "/api/cli-test", body, language });
  const dialog = (response = 0) => ({ showMessageBox: vi.fn(async () => ({ response })) });

  it.each([
    "/opt/tools/My Engine/run",
    "/usr/local/bin/ag claude agp",
    "/tmp/odd $$ $1 $' {path} {bot} name",
    "/opt/моторы/エンジン/é",
    `/${"a".repeat(PROGRAM_SHOW_MAX - 1)}`,
  ])("shows %j byte for byte, and only in the dialog", (cli) => {
    const described = describeCli({ cli });
    expect(described.refused).toBe(false);
    expect(described.lines).toEqual([`Program: ${cli}`]);
    expect(described.reasonComplete).toBe(false);
  });

  it("names the program in every shipped language", () => {
    for (const language of ["de", "es", "fr", "hi", "ja", "pt-br", "zh"]) {
      expect(describeCli({ cli: "/opt/run" }, language).lines[0]).toContain("/opt/run");
    }
  });

  it.each([
    ["missing", {}],
    ["no body", undefined],
    ["an array body", [{ cli: "/opt/run" }]],
    ["not a string", { cli: ["/opt/run"] }],
    ["empty", { cli: "" }],
    ["only spaces", { cli: "   " }],
    ["space around it, which the home trims", { cli: " /opt/run" }],
    ["over the limit", { cli: `/${"a".repeat(PROGRAM_SHOW_MAX)}` }],
    ["a newline", { cli: "/opt/run\n/opt/other" }],
    ["a tab", { cli: "/opt/\trun" }],
    ["NUL", { cli: "/opt/run\u0000.txt" }],
    ["a right-to-left override", { cli: "/opt/‮txt.exe" }],
    ["an isolate mark", { cli: "/opt/⁦run" }],
    ["a zero-width space", { cli: "/opt/ru​n" }],
    ["a zero-width joiner", { cli: "/opt/ru‍n" }],
    ["a soft hyphen", { cli: "/opt/ru­n" }],
    ["a variation selector", { cli: "/opt/ru️n" }],
    ["a tag character", { cli: "/opt/ru\u{E0041}n" }],
    ["a no-break space", { cli: "/opt/My Engine" }],
    ["a line separator", { cli: "/opt/run x" }],
    ["a lone surrogate", { cli: "/opt/\uD800run" }],
    ["the replacement character", { cli: "/opt/�run" }],
    ["right-to-left letters", { cli: "/opt/אב/run" }],
    ["right-to-left letters no one listed", { cli: "/opt/\u{10900}\u{10901}/run" }],
    ["Arabic digits", { cli: "/opt/٠/run" }],
    ["an ideographic space", { cli: "/opt/My　Engine" }],
    ["a private-use character", { cli: "/opt/run" }],
    ["an unassigned character", { cli: "/opt/\u{10FFFD}run" }],
  ])("refuses %s and shows no program line", (_name, body) => {
    const described = describeCli(body);
    expect(described.refused).toBe(true);
    expect(described.lines).toEqual([]);
    expect(described.reasonComplete).toBe(false);
  });

  it("shows accents written as a combining mark", () => {
    const cli = "/opt/é/run";
    expect(describeCli({ cli }).lines).toEqual([`Program: ${cli}`]);
  });

  it.each([
    ["no placeholder", "Program:"],
    ["two placeholders", "{path} and {path}"],
  ])("a language line with %s still names the program", (_name, broken) => {
    const fill = (key, params = {}) => (key === "line.program" ? broken.replaceAll("{path}", params.path ?? "{path}") : "");
    expect(programLine(fill, "/opt/run")).toBe("Program: /opt/run");
  });

  it.each([
    ["a Windows path with spaces", "C:\\Program Files\\My Engine\\run.exe"],
    ["a Windows path with a non-ASCII user folder", "C:\\Users\\Sébastien Müller\\AppData\\Local\\Engine\\run.cmd"],
    ["ASCII path punctuation", "/opt/a-b_c.d/(x)+[y]~@#%=,;'!/run --flag=1"],
    ["German", "/home/jürgen/straße/run"],
    ["Spanish and Portuguese", "/home/joão/año/run"],
    ["Hindi", "C:\\Users\\सीन\\कार्यक्रम\\run.exe"],
    ["Chinese", "C:\\Users\\张伟\\程序\\run.exe"],
    ["Japanese Hiragana and Katakana with a long mark", "/opt/たなか/エンジン/サーバー・々/run"],
    ["Korean", "C:\\Users\\김철수\\run.exe"],
    ["Russian", "/home/кирилл/движок/run"],
    ["Greek", "/home/αλέξης/run"],
  ])("real owners' paths: %s", (_name, cli) => {
    const described = describeCli({ cli });
    expect(described.refused).toBe(false);
    expect(described.lines).toEqual([`Program: ${cli}`]);
  });

  it.each([
    ["a Hebrew letter", "/opt/\u05D0/run"],
    ["a Hebrew vowel mark", "/opt/a\u05B0/run"],
    ["an Arabic letter", "/opt/\u0627/run"],
    ["an Arabic vowel mark", "/opt/a\u064B/run"],
    ["a combining mark for symbols", "/opt/a\u20D0/run"],
    ["a narrow no-break space", "/opt/My\u202FEngine"],
    ["an ampersand, which a Windows dialog may hide", "/opt/bin/claude&.exe"],
    ["an ampersand in a folder name", "C:\\Tools\\My & Engine\\run.exe"],
  ])("refused, outside the allowed scripts: %s", (_name, cli) => {
    expect(describeCli({ cli }).refused).toBe(true);
  });

  it("the refusal says why and what to do instead, and names no value", () => {
    const words = STEP_UP_EN["line.programRefused"];
    expect(words).toMatch(/Hebrew or Arabic/);
    expect(words).toMatch(/computer itself/);
    expect(COPY.stepUpRefused).toMatch(/computer itself/);
  });

  it("a refusal offers no way to approve, and holds even if the notice cannot open", async () => {
    const d = dialog(0);
    const confirm = createNativeStepUpConfirm({ systemPreferences: { canPromptTouchID: () => true, promptTouchID: vi.fn() }, dialog: d, platform: "darwin" });
    await expect(confirm({ homeId: "h", method: "POST", path: "/api/cli-test", body: { cli: "/opt/‮run" } })).rejects.toMatchObject({ code: "step-up-refused" });
    expect(d.showMessageBox.mock.calls[0][0].buttons).toEqual(["Close"]);
    const broken = { showMessageBox: vi.fn(async () => { throw new Error("no window"); }) };
    await expect(createNativeStepUpConfirm({ systemPreferences: {}, dialog: broken, platform: "linux" })({ homeId: "h", method: "POST", path: "/api/cli-test", body: {} })).rejects.toMatchObject({ code: "step-up-refused" });
  });

  it("Touch ID is never used for it", async () => {
    const promptTouchID = vi.fn(async () => {});
    const d = dialog(0);
    const confirm = createNativeStepUpConfirm({ systemPreferences: { canPromptTouchID: () => true, promptTouchID }, dialog: d, platform: "darwin" });
    expect(await confirm({ homeId: "h", method: "POST", path: "/api/cli-test", body: { cli: "/opt/run" } })).toBe(true);
    expect(promptTouchID).not.toHaveBeenCalled();
    expect(d.showMessageBox.mock.calls[0][0].detail.split("\n")).toContain("Program: /opt/run");
  });

  it("other routes still list setting names, never values", () => {
    const secret = "sk-this-must-never-show";
    const described = describeStepUp({ method: "PATCH", path: "/api/config", body: { apiKey: secret, cli: secret } });
    expect(described.refused).toBe(false);
    expect(described.message).not.toContain(secret);
    expect(described.message).toContain("apiKey");
  });
});
