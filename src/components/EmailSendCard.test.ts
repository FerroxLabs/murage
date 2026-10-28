// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { emailAnswerBody, emailTrustAnswerBody } from "./EmailSendCard";
import { pendingApprovals } from "./PendingApproval";
import type { Message } from "@/state/store";

describe("EmailSendCard answers (4.1, 4.2)", () => {
  it("Send and Retry are an allow, Don't send a deny, Edit an answer with the edited words; each names the shown revision", () => {
    expect(emailAnswerBody("email-s1", 3, "send")).toEqual({ requestId: "email-s1", behavior: "allow", emailAction: "send", emailRevision: 3 });
    expect(emailAnswerBody("email-s1", 3, "retry").behavior).toBe("allow");
    expect(emailAnswerBody("email-s1", 3, "dont_send").behavior).toBe("deny");
    expect(emailAnswerBody("email-s1", 3, "edit", { text: "new" })).toEqual({ requestId: "email-s1", behavior: "answer", emailAction: "edit", emailRevision: 3, emailDraft: { text: "new" } });
  });

  it("the email card is never a composer approval (its own buttons answer it)", () => {
    const message = { id: "m1", role: "bot", kind: "options", text: "", at: 0, card: { kind: "email-send", tool: "email_send", requestId: "email-s1", title: "t", subtitle: "s", options: ["Send"], emailSend: { sendId: "s1" } } } as unknown as Message;
    expect(pendingApprovals([message])).toEqual([]);
  });

  it("the trust proposal answers Add as an allow and Not now as a deny, and is never a composer approval (3.5)", () => {
    expect(emailTrustAnswerBody("email-trust-ab", true)).toEqual({ requestId: "email-trust-ab", behavior: "allow", emailTrust: "add" });
    expect(emailTrustAnswerBody("email-trust-ab", false)).toEqual({ requestId: "email-trust-ab", behavior: "deny", emailTrust: "not_now" });
    const message = { id: "m2", role: "bot", kind: "options", text: "", at: 0, card: { kind: "email-trust-offer", tool: "email_trust_offer", requestId: "email-trust-ab", title: "t", subtitle: "s", options: ["Add a@b.test", "Not now"], emailTrustOffer: { botId: "b1", address: "a@b.test", offeredAt: 1, phase: "open" } } } as unknown as Message;
    expect(pendingApprovals([message])).toEqual([]);
  });
});
