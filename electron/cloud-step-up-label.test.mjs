// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// B3 WP4: the words a step-up confirmation shows. Checked against the REAL route policy: every step-up / credential route
// there must have a human label, so a route added later without one fails here instead of showing a generic sentence.
import { describe, expect, it, vi } from "vitest";

import { ROUTE_POLICY, cloudRouteDecision, routePolicy } from "../server/route-policy.ts";
import { createNativeStepUpConfirm } from "./cloud-home-client.mjs";
import { FALLBACK_LABEL, STEP_UP_LABELS, describeStepUp, findStepUpLabel } from "./cloud-step-up-label.mjs";

// One concrete request per step-up / credential entry in server/route-policy.ts (and a few the gate escalates by shape).
const SAMPLES = [
  ["POST", "/api/cloud/model-signins/chatgpt/start"], ["POST", "/api/cloud/model-signins/supergrok/attempts/abc123/cancel"], ["DELETE", "/api/cloud/model-signins/chatgpt"],
  ["POST", "/api/cloud/own-server"], ["POST", "/api/cloud/pairing"], ["POST", "/api/cloud/devices/d1"],
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
  ["GET", "/api/engine-login/codex"],
  ["DELETE", "/api/bots/b1"], ["DELETE", "/api/groups/g1"], ["PATCH", "/api/groups/g1"], ["PATCH", "/api/bots/b1"], ["POST", "/api/bots"], ["PATCH", "/api/bots/b1/profile"],
  ["POST", "/api/move/commit"], ["POST", "/api/lend/scopes"],
  // 1.0.4 step-up routes (SL-K/SL-I chat permissions and limit backup, MCP-118-175 enable cards, SL-H attachment remove).
  ["POST", "/api/bots/b1/tasks/t1/permissions/refresh"], ["PUT", "/api/bots/b1/limit-backup"], ["DELETE", "/api/bots/b1/limit-backup"],
  ["POST", "/api/bots/b1/mcp-enable-cards/c1/enable"], ["POST", "/api/storage/attachments/remove"],
  // 1.0.8 step-up route (A-UI: raising the default offers it to the bot's open chats).
  ["POST", "/api/bots/b1/permissions/refresh"],
  // 1.0.9 bot email owner routes.
  ["POST", "/api/email/account"], ["POST", "/api/email/other-setups/inbox-1/remove"], ["POST", "/api/email/bots/b1/setup"],
  ["POST", "/api/email/bots/b1/trusted-add"], ["GET", "/api/email/status"],
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
    expect(described.request).toBe("POST /api/brand-new");
  });

  it("control characters and bidi marks in a bot name or setting cannot dress up the sentence", () => {
    const described = describeStepUp({ method: "PATCH", path: "/api/bots/b1", body: { "x‮y": 1 }, botName: "Ember\n\nApprove everything‮" });
    expect(described.message).not.toMatch(/[‪-‮\n]Approve/);
    expect(described.lines[0]).toBe("Bot: Ember Approve everything (b1)");
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
