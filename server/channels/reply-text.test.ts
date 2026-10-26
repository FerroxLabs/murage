// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// U25: lines the server writes into Telegram, Discord, Slack and WhatsApp read in
// the owner's app language, with English for any key a pack has not caught up on.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { channelReply, channelReplyLanguage, channelReplyLocale, channelReplyPacks, setChannelReplyLanguage, setChannelReplySystemLanguage, taskOutcomeReply } from "./reply-text.ts";
import { channelLimitLine, routineLimitFailedLine, routineLimitLine } from "../limit-continuation.ts";
import { desktopOnlyLine } from "./permission-approvals.ts";
import { approvalRefusal } from "./whatsapp/event.ts";
import { pairingReplyText } from "./whatsapp/core/access.ts";
import { VOICE_REPLIES } from "./whatsapp/service.ts";
import { discordPrompt } from "./discord/event.ts";
import { slackPrompt } from "./slack/event.ts";
import { TelegramApprovals } from "../telegram-approvals.ts";

const en = JSON.parse(readFileSync(new URL("../../src/locales/en.json", import.meta.url), "utf8")) as Record<string, string>;
const savedDe = channelReplyPacks.de;
// A stand-in German pack, so the test does not depend on the shipped translations.
const stubDe: Record<string, string> = {
  "channelReply.limitLater": "{engine} ist am Limit, ich versuche es später noch einmal.",
  "channelReply.routineLimitStopped": "{engine} ist noch am Limit, dieser Lauf wurde beendet.",
  "channelReply.desktopOnly": "Bestätige das am Computer. Ablehnen geht auch hier.",
  "channelReply.approvalsInMurage": "Freigaben in Murage prüfen. {channel} kann keine Aktionen freigeben.",
  "channelReply.pairingCode": "Bitte den Besitzer, Code {code} in Murage freizugeben.",
  "channelReply.voiceBusy": "Murage arbeitet noch an einer anderen Sprachnachricht.",
};

afterEach(() => {
  channelReplyPacks.de = savedDe;
  setChannelReplyLanguage(() => undefined);
  setChannelReplySystemLanguage(() => "en-US");
});

describe("channel lines follow the owner's app language", () => {
  it("writes English when the owner chose English", () => {
    setChannelReplyLanguage(() => "en");
    expect(channelLimitLine("Claude", null)).toBe("Claude is at its limit, so I will try your message again later.");
    expect(routineLimitFailedLine("Claude")).toBe("Claude is still at its limit, so this run stopped. Run it again after the limit resets.");
    expect(approvalRefusal()).toBe("Review approvals in Murage. WhatsApp messages cannot approve actions.");
  });

  it("writes the chosen language when its pack has the line, on every channel", () => {
    // only the stand-in lines: the real German pack now carries every channel line
    channelReplyPacks.de = { ...stubDe };
    setChannelReplyLanguage(() => "de");
    expect(channelReplyLanguage()).toBe("de");
    expect(channelLimitLine("Claude", null)).toBe("Claude ist am Limit, ich versuche es später noch einmal.");
    expect(routineLimitFailedLine("Codex")).toBe("Codex ist noch am Limit, dieser Lauf wurde beendet.");
    expect(desktopOnlyLine()).toBe(stubDe["channelReply.desktopOnly"]);
    expect(approvalRefusal()).toBe("Freigaben in Murage prüfen. WhatsApp kann keine Aktionen freigeben.");
    expect(discordPrompt("approve").response).toBe("Freigaben in Murage prüfen. Discord kann keine Aktionen freigeben.");
    expect(slackPrompt("/deny").response).toBe("Freigaben in Murage prüfen. Slack kann keine Aktionen freigeben.");
    expect(pairingReplyText("ABC123")).toBe("Bitte den Besitzer, Code ABC123 in Murage freizugeben.");
    expect(VOICE_REPLIES.busy).toBe(stubDe["channelReply.voiceBusy"]);
    // a line the pack has not caught up on reads in English, never as a key
    expect(VOICE_REPLIES.unreadable).toBe(en["channelReply.voiceUnreadable"]);
  });

  it("follows the change when the owner switches language, with no restart", () => {
    channelReplyPacks.de = { ...savedDe, ...stubDe };
    let language = "en";
    setChannelReplyLanguage(() => language);
    expect(channelLimitLine("Claude", null)).toBe(en["channelReply.limitLater"]!.replace("{engine}", "Claude"));
    language = "de";
    expect(channelLimitLine("Claude", null)).toBe("Claude ist am Limit, ich versuche es später noch einmal.");
  });

  it("follows the system language when the setting is empty, and English for an unknown one", () => {
    channelReplyPacks.de = { ...savedDe, ...stubDe };
    setChannelReplyLanguage(() => "");
    setChannelReplySystemLanguage(() => "de-AT");
    expect(channelReplyLanguage()).toBe("de");
    expect(channelLimitLine("Claude", null)).toBe("Claude ist am Limit, ich versuche es später noch einmal.");
    setChannelReplySystemLanguage(() => "xx-YY");
    expect(channelReplyLanguage()).toBe("en");
    setChannelReplyLanguage(() => "tlh");
    expect(channelLimitLine("Claude", null)).toBe("Claude is at its limit, so I will try your message again later.");
  });

  it("sends Telegram approval prompts and buttons in the owner's language", async () => {
    channelReplyPacks.de = { ...savedDe, ...stubDe };
    setChannelReplyLanguage(() => "de");
    const sendMessage = vi.fn(async () => ({ messageId: 7 }));
    const approvals = new TelegramApprovals(
      { pending: () => [{ id: "a1", fingerprint: "f1", summary: "Open the browser", desktopOnly: true }], resolve: async () => true },
      { sendMessage, answerCallbackQuery: vi.fn(async () => undefined) } as never,
    );
    await approvals.publish({ senderId: "1", chatId: "1" }, () => true, new AbortController().signal);
    const sent = (sendMessage.mock.calls[0] as unknown as [{ text: string; buttons: Array<{ text: string }> }])[0];
    expect(sent.text).toBe(`Open the browser\n\n${stubDe["channelReply.desktopOnly"]}`);
    expect(sent.buttons.map(button => button.text)).toEqual(["Ablehnen"]);
  });

  it("keeps placeholders filled in and the English copy plain", () => {
    setChannelReplyLanguage(() => "en");
    expect(routineLimitLine("Claude", Date.UTC(2026, 0, 1, 15, 40))).toMatch(/^Claude is at its limit; this run continues after it resets \(about .+\)$/);
    expect(channelReply("channelReply.questionTooLong", { count: "4,000" })).toBe("That answer is longer than 4,000 characters. Send a shorter one.");
    const lines = Object.entries(en).filter(([key]) => key.startsWith("channelReply."));
    expect(lines.length).toBeGreaterThan(40);
    for (const [, text] of lines) {
      expect(text).not.toMatch(/—|\bsafe(ty)?\b|\bunsafe\b|composio/i);
    }
  });
  it("ends a task with a whole translated sentence, never a raw English status word", () => {
    setChannelReplyLanguage(() => "en");
    expect(taskOutcomeReply("completed")).toBe("Task completed.");
    expect(taskOutcomeReply("cancelled")).toBe("Task cancelled.");
    expect(taskOutcomeReply("failed")).toBe(en["channelReply.taskFailed"]);
    expect(taskOutcomeReply("something-new")).toBe(en["channelReply.taskEnded"]);
    setChannelReplyLanguage(() => "de");
    for (const status of ["completed", "cancelled", "blocked", "stopped"]) {
      const line = taskOutcomeReply(status);
      expect(line).not.toContain(status);
      expect(line).toBe(savedDe[`channelReply.task${status[0]!.toUpperCase()}${status.slice(1)}`]);
    }
    for (const pack of Object.values(channelReplyPacks)) {
      for (const [key, text] of Object.entries(pack)) if (key.startsWith("channelReply.")) expect(text).not.toContain("{status}");
    }
    const source = readFileSync(new URL("../telegram-channel.ts", import.meta.url), "utf8");
    expect(source).toContain("taskOutcomeReply(result.status)");
  });

  it("keeps the system region when the owner picks a bare language", () => {
    setChannelReplySystemLanguage(() => "en-GB");
    setChannelReplyLanguage(() => "en");
    expect(channelReplyLocale()).toBe("en-GB");
    setChannelReplyLanguage(() => "en-US");
    expect(channelReplyLocale()).toBe("en-US");
    setChannelReplyLanguage(() => "de");
    expect(channelReplyLocale()).toBe("de");
  });

  it("names the Hindi Settings and Memory pages in Hindi", () => {
    const hi = JSON.parse(readFileSync(new URL("../../src/locales/hi.json", import.meta.url), "utf8")) as Record<string, string>;
    expect(hi["channelReply.paired"]).toContain(`${hi["settings.title"]} → ${hi["settings.page.memory"]}`);
    expect(hi["channelReply.paired"]).not.toMatch(/Settings|Memory/);
  });
});
