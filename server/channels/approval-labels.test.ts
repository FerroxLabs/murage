// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// U25 review (Grok, High): the word on a channel approval button always names what the
// button does. A language pack cannot relabel Approve as Deny, or a denial as an approval.
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { channelReplyPacks, setChannelReplyLanguage } from "./reply-text.ts";
import { APPROVAL_LABELS, approvalButtonLabel, approvalResultLabel } from "./approval-labels.ts";
import { TelegramApprovals } from "../telegram-approvals.ts";

const savedDe = channelReplyPacks.de;
// What a wrong or tampered pack would carry.
const swapped = {
  "channelReply.buttonApproveOnce": "Ablehnen",
  "channelReply.buttonDeny": "Einmalig freigeben",
  "channelReply.denied": "Einmalig freigegeben.",
  "channelReply.approvedOnce": "Abgelehnt.",
} as never;

afterEach(() => { channelReplyPacks.de = savedDe; setChannelReplyLanguage(() => undefined); });

describe("channel approval labels", () => {
  it("labels each Telegram button by the action it carries, whatever the pack says", async () => {
    channelReplyPacks.de = { ...savedDe, ...(swapped as object) };
    setChannelReplyLanguage(() => "de");
    const sendMessage = vi.fn(async () => ({ messageId: 7 }));
    const approvals = new TelegramApprovals(
      { pending: () => [{ id: "a1", fingerprint: "f1", summary: "Run a command" }], resolve: async () => true },
      { sendMessage, answerCallbackQuery: vi.fn(async () => undefined) } as never,
    );
    await approvals.publish({ senderId: "1", chatId: "1" }, () => true, new AbortController().signal);
    const sent = (sendMessage.mock.calls[0] as unknown as [{ buttons: Array<{ text: string; data: string }> }])[0];
    const byAction = Object.fromEntries(sent.buttons.map((button) => [button.data.slice(button.data.lastIndexOf(":") + 1), button.text]));
    expect(byAction.a).toBe("Einmalig freigeben");
    expect(byAction.d).toBe("Ablehnen");
  });

  it("writes the result line from the action, not the pack", () => {
    channelReplyPacks.de = { ...savedDe, ...(swapped as object) };
    setChannelReplyLanguage(() => "de");
    expect(approvalResultLabel("deny")).toBe("Abgelehnt.");
    expect(approvalResultLabel("approvedOnce")).toBe("Einmalig freigegeben.");
    expect(approvalButtonLabel("deny")).toBe("Ablehnen");
  });

  it("has a label for every language Murage ships, with Approve and Deny always different", () => {
    for (const code of Object.keys(channelReplyPacks)) {
      const key = code === "pt" ? "pt-br" : code;
      expect(APPROVAL_LABELS[key], code).toBeDefined();
      expect(approvalButtonLabel("approveOnce", code)).not.toBe(approvalButtonLabel("deny", code));
      expect(approvalResultLabel("approveOnce", code)).not.toBe(approvalResultLabel("deny", code));
    }
    expect(approvalButtonLabel("deny", "pt")).toBe("Negar");
    expect(approvalButtonLabel("deny", "tlh")).toBe("Deny");
  });

  it("keeps these words out of the language packs", () => {
    const dir = new URL("../../src/locales/", import.meta.url);
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".json") && name !== "source-hashes.json")) {
      const pack = readFileSync(new URL(file, dir), "utf8");
      for (const key of ["buttonApproveOnce", "buttonAllowTask", "buttonDeny", "approvedOnce", "allowedOnce", "allowedTask", "denied"]) {
        expect(pack, `${file} ${key}`).not.toContain(`"channelReply.${key}"`);
      }
    }
  });
});
