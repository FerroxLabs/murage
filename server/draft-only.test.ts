// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A draft-only bot has no route that sends (server/draft-only.ts, DRAFT-ONLY-ALLOWLIST-104). These are the pure decisions every
// route reads: the one allow-list gate, and the sweep: a draft-only bot stored at any access level reaches no send path.
import { describe, expect, it } from "vitest";
import {
  CHANNEL_HELD_LINE, channelReplyText, DRAFT_ONLY_BROWSER_REFUSAL, DRAFT_ONLY_CHANNEL_LINE, DRAFT_ONLY_COMMAND_REFUSAL, DRAFT_ONLY_ENGINE_LINE,
  DRAFT_ONLY_HANDOFF_REFUSAL, DRAFT_ONLY_NOTE, DRAFT_ONLY_PROMPT, DRAFT_ONLY_ROUTINE_REFUSAL, DRAFT_ONLY_SETTINGS_REFUSAL, draftOnlyClamp,
  draftOnlyMentionAllowed, draftOnlyQualifies, draftOnlySettingsLift,
} from "./draft-only.ts";
import { applyRoutinePermissionMode, botPermissionMode, effectiveRoutinePermissionMode, turnPermissionEnforcement, ROUTINE_PERMISSION_MODES } from "./routine-permissions.ts";
import { MCP_REMOTE_DRAFT_ONLY_BOT, mcpRemoteBotRefusal, ownServersAllowedFor } from "./mcp-relay.ts";
import { createBotPackageExport } from "./package-export.ts";
import { parseBotPackage, renderBotPackageMarkdown } from "./bot-package.ts";
import { MurageStatus, status } from "./murage-status.ts";
import type { BotRecord } from "./store.ts";

// DRAFT-ONLY-ALLOWLIST-104 section 6: the owner line, verbatim.
const OWNER_LINE = "This bot writes drafts for you to review and send, and it drafts on Claude or a connected chat model. Choose one of those in this bot's settings and it picks up from here.";
/** Every engine whose turn runs a tool, hook or fetch of its own (section 1), and one Murage does not know yet. */
const REFUSED_DRIVERS = ["fuigoAgent", "grokAgent", "grok", "geminiAgent", "kimiAgent", "droidAgent", "cursorAgent", "opencodeGo", "qwenAgent",
  "hermesAgent", "openclawAgent", "clineAgent", "customAcp", "pi", "piAgent", "codex", "antigravity", "antigravityAgent", "boxAgent", "someNewEngine", ""];

describe("draft-only: the one gate (an allow-list)", () => {
  it.each(REFUSED_DRIVERS)("refuses a draft-only turn on %s with the owner line", (driverKind) => {
    expect(draftOnlyQualifies({ driverKind })).toEqual({ ok: false, line: OWNER_LINE });
  });
  it("runs Claude toolless, locally, with no managed hooks, managed MCP policy or helpers", () => {
    expect(draftOnlyQualifies({ driverKind: "claudeAgent" })).toEqual({ ok: true, surface: "claude-toolless" });
    for (const fact of ["managedHooks", "managedMcp", "claudeHelpers", "cloudHome"] as const) {
      expect(draftOnlyQualifies({ driverKind: "claudeAgent", [fact]: true }), fact).toEqual({ ok: false, line: OWNER_LINE });
    }
    expect(draftOnlyQualifies({ driverKind: "claudeAgent", runOn: "cloud" })).toEqual({ ok: false, line: OWNER_LINE });
  });
  it("runs the chat-completions drivers, and not on the Cloud computer", () => {
    for (const driverKind of ["openai-compat", "minimax"]) {
      expect(draftOnlyQualifies({ driverKind }), driverKind).toEqual({ ok: true, surface: "chat-completions" });
      expect(draftOnlyQualifies({ driverKind, runOn: "cloud" }), driverKind).toEqual({ ok: false, line: OWNER_LINE });
    }
  });
  it("the owner line is the agreed one", () => {
    expect(DRAFT_ONLY_ENGINE_LINE).toBe(OWNER_LINE);
    expect(DRAFT_ONLY_NOTE).toBe("I write drafts for you to review and send.");
  });
});

describe("draft-only: levels, engines, mounts and channels", () => {
  it("no routine, ceiling or stored flag lifts a draft-only bot past Ask", () => {
    const stored = { draftOnly: true as const, autoApprove: true, fullAccess: true, noLimits: true, alwaysAllow: ["Bash"] };
    expect(botPermissionMode(stored)).toBe("ask");
    for (const mode of ROUTINE_PERMISSION_MODES) {
      const judged = applyRoutinePermissionMode(stored, mode);
      expect(botPermissionMode(judged), mode).toBe("ask");
      expect(judged.autoApprove, mode).toBe(false);
      expect(effectiveRoutinePermissionMode({ permissionMode: mode }, stored), mode).toBe("ask");
    }
    expect(turnPermissionEnforcement(stored)).toEqual({ routeAsks: true, askLevel: true });
  });
  it("the turn copy is at Ask with no computer or browser", () => {
    const turn = draftOnlyClamp({ autoApprove: true, fullAccess: true, noLimits: true, alwaysAllow: ["Bash"], computer: "local" as unknown, browser: true, useMyChrome: true });
    expect(turn).toEqual({ autoApprove: false, fullAccess: false, noLimits: false, alwaysAllow: [], computer: "off", browser: false, useMyChrome: false });
  });
  it("names the settings that would lift it", () => {
    for (const body of [{ autoApprove: true }, { fullAccess: true }, { noLimits: true }, { alwaysAllow: ["x"] }, { browser: true }, { useMyChrome: true }, { computer: "local" }, { computer: null }, { fullAccessChannelMessages: true }]) {
      expect(draftOnlySettingsLift(body), JSON.stringify(body)).toBe(true);
    }
    for (const body of [{ autoApprove: false }, { composio: true }, { name: "x" }, { alwaysAllow: [] }, { computer: "off" }, { modelSelection: {} }]) {
      expect(draftOnlySettingsLift(body), JSON.stringify(body)).toBe(false);
    }
  });
  it("mounts none of the owner's MCP servers, whatever its access", () => {
    expect(mcpRemoteBotRefusal({ draftOnly: true }, "unrestricted")).toBe(MCP_REMOTE_DRAFT_ONLY_BOT);
    expect(ownServersAllowedFor({ draftOnly: true } as unknown as Parameters<typeof ownServersAllowedFor>[0])).toBe(false);
    expect(mcpRemoteBotRefusal({}, "unrestricted")).toBeNull();
  });
  it("keeps its words in Murage: a channel gets Murage's line, never the draft", () => {
    expect(channelReplyText({ draftOnly: true }, "Hi Dana, your refund is on its way.", (text) => text)).toBe(DRAFT_ONLY_CHANNEL_LINE);
    expect(channelReplyText({ draftOnly: true }, undefined, (text) => text)).toBeUndefined();
    expect(channelReplyText({}, "sent", (text) => text.toUpperCase())).toBe("SENT");
    // a bot that cannot be read any more: the reply is held in Murage (r2/r4 Medium)
    expect(channelReplyText(undefined, "sent", (text) => text)).toBe(CHANNEL_HELD_LINE);
    expect(channelReplyText(null, "Hi Dana", (text) => text)).toBe(CHANNEL_HELD_LINE);
  });
  it("tells a teammate why the hand-off did not start", () => {
    expect(MurageStatus.words(status("draft_only_handoff"))).toBe(DRAFT_ONLY_HANDOFF_REFUSAL);
  });
});

describe("draft-only: export and import", () => {
  const bot = { id: "b1", name: "Sorrel", title: "Ticket triage", description: "Drafts helpdesk replies.", color: "teal", draftOnly: true, section: undefined } as unknown as BotRecord;
  it("exports the agent as draft-only, and both the package and its Markdown read it back", () => {
    const document = createBotPackageExport({ name: "Support", bots: [bot], groups: [], routines: [] });
    expect(document.package.agents[0]!.outbound).toBe("draft-only");
    const markdown = renderBotPackageMarkdown(document);
    expect(parseBotPackage(markdown).package.agents[0]!.outbound).toBe("draft-only");
    expect(parseBotPackage(JSON.parse(JSON.stringify(document))).package.agents[0]!.outbound).toBe("draft-only");
  });
  it("leaves an ordinary bot without the mark", () => {
    const document = createBotPackageExport({ name: "Support", bots: [{ ...bot, draftOnly: undefined } as BotRecord], groups: [], routines: [] });
    expect(document.package.agents[0]!.outbound).toBeUndefined();
  });
});

describe("draft-only: the sweep", () => {
  const LEVELS = [
    { name: "Ask", flags: {} },
    { name: "Auto", flags: { autoApprove: true } },
    { name: "Full access", flags: { autoApprove: true, fullAccess: true } },
    { name: "No limits", flags: { autoApprove: true, fullAccess: true, noLimits: true } },
    { name: "every grant", flags: { autoApprove: true, fullAccess: true, noLimits: true, alwaysAllow: ["Bash", "shell", "WebFetch", "mcp__mailer__send"], computer: "local", browser: true, useMyChrome: true } },
  ];
  it.each(LEVELS)("a draft-only bot stored at $name reaches no send path", ({ flags }) => {
    const stored = { draftOnly: true as const, ...flags };
    // the engine runs at Ask, read-only (shell, routines)
    const turn = draftOnlyClamp({ ...stored } as Parameters<typeof draftOnlyClamp>[0]);
    expect(botPermissionMode(turn)).toBe("ask");
    for (const mode of ROUTINE_PERMISSION_MODES) expect(botPermissionMode(applyRoutinePermissionMode(stored, mode))).toBe("ask");
    expect(turn).toMatchObject({ computer: "off", browser: false, useMyChrome: false, alwaysAllow: [] });
    // only a toolless Claude or a chat model runs its turns, whatever its level
    for (const driverKind of REFUSED_DRIVERS) expect(draftOnlyQualifies({ driverKind }).ok, driverKind).toBe(false);
    // the owner's own MCP servers are not mounted
    expect(mcpRemoteBotRefusal(stored, "unrestricted")).not.toBeNull();
    // no channel posts its words
    expect(channelReplyText(stored, "Dear customer, done.", (text) => text)).toBe(DRAFT_ONLY_CHANNEL_LINE);
    // it stays draft-only when shared
    const exported = createBotPackageExport({ name: "Support", bots: [{ id: "b", name: "B", color: "teal", ...stored } as unknown as BotRecord], groups: [], routines: [] });
    expect(exported.package.agents[0]!.outbound).toBe("draft-only");
  });
});

describe("draft-only: owner-facing copy", () => {
  it("says what the bot does, in plain words", () => {
    const lines = [DRAFT_ONLY_SETTINGS_REFUSAL, DRAFT_ONLY_ROUTINE_REFUSAL, DRAFT_ONLY_BROWSER_REFUSAL, DRAFT_ONLY_HANDOFF_REFUSAL, DRAFT_ONLY_COMMAND_REFUSAL,
      DRAFT_ONLY_CHANNEL_LINE, CHANNEL_HELD_LINE, DRAFT_ONLY_NOTE, DRAFT_ONLY_PROMPT, DRAFT_ONLY_ENGINE_LINE, MCP_REMOTE_DRAFT_ONLY_BOT];
    for (const line of lines) expect(line).not.toMatch(/—|\bsafe|unsafe|safety|composio/i);
    expect(DRAFT_ONLY_PROMPT).toContain(DRAFT_ONLY_NOTE);
  });
});

// Grok r2 High: room, phone and mention turns of a draft-only member ran with the full tool set.
describe("draft-only in rooms", () => {
  it("a draft-only speaker's @mention starts no teammate at all", () => {
    const draft = { draftOnly: true as const }, plain = {};
    expect(draftOnlyMentionAllowed([draft, draft])).toBe(false);
    expect(draftOnlyMentionAllowed([draft, undefined])).toBe(false);
    expect(draftOnlyMentionAllowed([plain, draft])).toBe(false);
    expect(draftOnlyMentionAllowed([plain, plain])).toBe(true);
    expect(draftOnlyMentionAllowed([plain, undefined])).toBe(true);
  });
});
