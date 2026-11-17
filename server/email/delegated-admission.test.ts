// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeEmailCall, emailMounts, EMAIL_UNAVAILABLE, type EmailCallLive, type EmailMountInput } from "./admission.ts";
import { forgetAllEmailTurns, forgetEmailTurn, recordEmailTurn, type EmailTurnRecord } from "./email-turns.ts";
import { emailToolsFor } from "../drivers/email-tool-schemas.ts";

const bot = { id: "ember", threadId: "ember-chat", tasks: [
  { threadId: "ember-task" }, { threadId: "project-desk", channelProjectDesk: {} }, { threadId: "shared-task", sharedWork: {} },
] };
const handoff = { id: "handoff-1", origin: "owner" as const, ownerRooted: true, attended: true };
const mount: EmailMountInput = {
  enabled: true, binding: "active", driverKind: "codex", agentsMcp: true,
  surfacesForOwner: true, directOwnerAudience: true, automationThread: false,
  handoffTurn: true, handoff, commsDepth: 1, chainRootThreadId: "sable-chat", bot, threadId: bot.threadId,
};
const claim = { botId: bot.id, threadId: bot.threadId, generation: "generation-1" };
const delegated: EmailTurnRecord = {
  botId: bot.id, threadId: bot.threadId, mode: "delegated", kind: "delegated",
  handoffId: handoff.id, rootThreadId: "sable-chat", attended: true,
};
const permitted = ["email_list", "email_read", "email_send", "email_reply"] as const;
const unavailable = { ok: false, line: EMAIL_UNAVAILABLE };
function live(patch: Partial<EmailCallLive> = {}): EmailCallLive {
  return {
    enabled: () => true, binding: () => "active", bot: () => bot,
    ownerSurface: () => true, notOwnerAudience: () => false,
    ownerThread: threadId => threadId === bot.threadId, boundRequest: () => false,
    handoffLive: (generation, id) => generation === claim.generation && id === handoff.id,
    ownerRooted: id => id === handoff.id, ...patch,
  };
}
function mountedRecord(): EmailTurnRecord {
  const verdict = emailMounts(mount);
  expect(verdict).toMatchObject({ mounted: true, mode: "delegated" });
  if (!verdict.mounted) throw new Error("Expected the owner-rooted fixture to mount");
  const record = { botId: bot.id, threadId: bot.threadId, mode: verdict.mode, ...verdict.turn };
  recordEmailTurn(claim.generation, record);
  return record;
}
afterEach(() => forgetAllEmailTurns());

describe("T-DE-MOUNT", () => {
  it("records the depth-one owner hand-off and lists its four tools", () => {
    expect(mountedRecord()).toEqual(delegated);
    expect(emailToolsFor("delegated").map(tool => tool.name)).toEqual(permitted);
  });

  const guards: Array<[string, Partial<EmailMountInput>]> = [
    ["room origin", { handoff: { ...handoff, origin: "room" } }],
    ["shared origin", { handoff: { ...handoff, origin: "shared" } }],
    ["legacy origin", { handoff: { ...handoff, origin: "legacy" } }],
    ["depth two", { commsDepth: 2 }],
    ["depth zero", { commsDepth: 0 }],
    ["missing depth", { commsDepth: undefined }],
    ["owner_rooted zero", { handoff: { ...handoff, ownerRooted: false } }],
    ["missing hand-off", { handoff: undefined }],
    ["not a hand-off turn", { handoffTurn: false }],
    ["missing root thread", { chainRootThreadId: undefined }],
    ["empty root thread", { chainRootThreadId: "" }],
    ["non-owner chain", { chainNotOwner: true }],
    ["non-owner audience", { notOwnerAudience: true }],
    ["no owner surface", { surfacesForOwner: false }],
    ["no direct owner audience", { directOwnerAudience: false }],
    ["asker wake", { askerWake: true }],
    ["card continuation", { cardContinuation: true }],
    ["project card run", { projectCardRun: {} }],
    ["shared work run", { sharedWorkRun: {} }],
    ["schedule source", { automationSource: "schedule" }],
    ["manual source", { automationSource: "manual" }],
    ["channel source", { automationSource: "channel" }],
    ["webhook source", { automationSource: "webhook" }],
    ["empty automation source", { automationSource: "" }],
    ["automation thread", { automationThread: true }],
    ["project desk", { threadId: "project-desk" }],
    ["shared task", { threadId: "shared-task" }],
    ["another bot's thread", { threadId: "other-chat" }],
    ["draft-only bot", { bot: { ...bot, draftOnly: true } }],
    ["missing binding", { binding: null }],
    ["removed binding", { binding: "removing" }],
    ["disabled email", { enabled: false }],
    ["no agents mount", { agentsMcp: false }],
  ];
  it.each(guards)("refuses only after flipping %s", (_name, patch) => {
    expect(emailMounts(mount)).toMatchObject({ mounted: true, mode: "delegated" });
    expect(emailMounts({ ...mount, ...patch })).toMatchObject({ mounted: false });
  });
  it("leaves the primer silent for an unrooted hand-off", () => {
    expect(emailMounts(mount)).toMatchObject({ mounted: true });
    expect(emailMounts({ ...mount, handoff: { ...handoff, ownerRooted: false } })).toEqual({ mounted: false, line: null });
  });
  it("gives a read-only engine reads and refuses both send calls", () => {
    expect(emailMounts(mount)).toMatchObject({ mounted: true, mode: "delegated" });
    const verdict = emailMounts({ ...mount, driverKind: "geminiAgent" });
    expect(verdict).toMatchObject({ mounted: true, mode: "read", turn: { kind: "delegated" } });
    if (!verdict.mounted) throw new Error("Expected read mount");
    expect(emailToolsFor(verdict.mode).map(tool => tool.name)).toEqual(["email_list", "email_read"]);
    recordEmailTurn(claim.generation, delegated);
    for (const tool of permitted) expect(authorizeEmailCall(claim, tool, live()).ok).toBe(true);
    recordEmailTurn(claim.generation, { ...delegated, mode: verdict.mode });
    for (const tool of permitted) expect(authorizeEmailCall(claim, tool, live()).ok).toBe(tool === "email_list" || tool === "email_read");
  });
  it("allows the target's own task and retains effective attendance", () => {
    expect(emailMounts({ ...mount, threadId: "ember-task" })).toMatchObject({ mounted: true, turn: { attended: true } });
    for (const attended of [false, undefined]) {
      expect(emailMounts({ ...mount, handoff: { ...handoff, attended: attended as boolean } })).toMatchObject({
        mounted: true, turn: { kind: "delegated", attended: false },
      });
    }
  });
  it("preserves direct and routine mounts without delegated dependencies", () => {
    const owner = { ...mount, handoff: undefined, handoffTurn: false, commsDepth: 0, chainRootThreadId: undefined, origin: "desktop" };
    for (const input of [owner, { ...owner, origin: undefined, automationSource: "schedule", automationThread: true }]) {
      const verdict = emailMounts(input);
      expect(verdict).toMatchObject({ mounted: true, mode: "send" });
      if (!verdict.mounted) throw new Error("Expected owner mount");
      recordEmailTurn(claim.generation, { botId: bot.id, threadId: bot.threadId, mode: verdict.mode, ...verdict.turn });
      expect(authorizeEmailCall(claim, "email_trust_offer", live({ handoffLive: undefined, ownerRooted: undefined })).ok).toBe(true);
    }
  });
});

describe("T-DE-TRUST", () => {
  it("the exported listing drops only trust_offer when send becomes delegated", () => {
    const names = (mode: string) => emailToolsFor(mode).map(tool => tool.name);
    expect(names("send")).toEqual([...permitted, "email_trust_offer"]);
    expect(names("delegated")).toEqual(permitted);
    expect(emailToolsFor(undefined)).toEqual([]);
    expect(emailToolsFor("unknown")).toEqual([]);
  });
  it.each(["delegated", "send"] as const)("refuses a direct trust_offer call with a delegated record in %s mode", mode => {
    recordEmailTurn(claim.generation, { ...delegated, mode });
    expect(authorizeEmailCall(claim, "email_send", live()).ok).toBe(true);
    expect(authorizeEmailCall(claim, "email_trust_offer", live())).toEqual(unavailable);
  });
});

describe("T-DE-RECHECK unit", () => {
  it("passes the recorded generation and hand-off id to both live checks, and checks audience without an origin", () => {
    const record = mountedRecord();
    const state = live({ handoffLive: vi.fn(() => true), ownerRooted: vi.fn(() => true), ownerThread: vi.fn(() => true) });
    expect(authorizeEmailCall(claim, "email_reply", state)).toEqual({ ok: true, record });
    expect(state.handoffLive).toHaveBeenCalledWith(claim.generation, handoff.id);
    expect(state.ownerRooted).toHaveBeenCalledWith(handoff.id);
    expect(state.ownerThread).toHaveBeenCalledWith(bot.threadId);
  });
  const changes: Array<[string, Partial<EmailCallLive>]> = [
    ["cancelled hand-off", { handoffLive: () => false }],
    ["owner_rooted zero or missing row", { ownerRooted: () => false }],
    ["person-bound destination", { ownerThread: () => false }],
    ["bound request", { boundRequest: () => true }],
    ["non-owner audience", { notOwnerAudience: () => true }],
    ["disabled email", { enabled: () => false }],
    ["removed binding", { binding: () => null }],
    ["draft-only bot", { bot: () => ({ ...bot, draftOnly: true }) }],
    ["missing bot", { bot: () => undefined }],
    ["foreign thread", { bot: () => ({ ...bot, threadId: "another-chat" }) }],
    ["missing liveness dependency", { handoffLive: undefined }],
    ["missing rooted dependency", { ownerRooted: undefined }],
    ["throwing liveness read", { handoffLive: () => { throw new Error("unavailable"); } }],
    ["throwing rooted read", { ownerRooted: () => { throw new Error("unavailable"); } }],
  ];
  it.each(changes)("refuses every next call after %s", (_name, patch) => {
    mountedRecord();
    const state = live();
    for (const tool of permitted) expect(authorizeEmailCall(claim, tool, state).ok).toBe(true);
    Object.assign(state, patch);
    for (const tool of permitted) expect(authorizeEmailCall(claim, tool, state)).toEqual(unavailable);
  });
  it.each(["Stop", "replacement generation", "mismatched hand-off id"])("refuses after %s", change => {
    const record = mountedRecord();
    for (const tool of permitted) expect(authorizeEmailCall(claim, tool, live()).ok).toBe(true);
    if (change === "Stop") forgetEmailTurn(claim.generation);
    else if (change === "replacement generation") recordEmailTurn("generation-2", record);
    else recordEmailTurn(claim.generation, { ...delegated, handoffId: "different-hand-off" });
    for (const tool of permitted) expect(authorizeEmailCall(claim, tool, live())).toEqual(unavailable);
  });
  it.each(["botId", "threadId", "generation"] as const)("binds calls to the recorded %s", key => {
    mountedRecord();
    expect(authorizeEmailCall(claim, "email_read", live()).ok).toBe(true);
    expect(authorizeEmailCall({ ...claim, [key]: "different" }, "email_read", live())).toEqual(unavailable);
  });
});
