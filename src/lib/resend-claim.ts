// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { api } from "@/state/store";

/** L1: the server claims a resend row's Send again once. True only when THIS press won the claim; a refusal or a lost answer is false (nothing is sent). */
export function claimResendFor(threadId: string, messageId: string): () => Promise<boolean> {
  return async () => {
    try {
      const answer = await api(`/api/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/resend-used`, { method: "POST", body: "{}" });
      return answer?.claimed === true;
    } catch { return false; }
  };
}
