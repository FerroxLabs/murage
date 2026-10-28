// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The commit section of a phone share or ask (S33, design 5.3 (e)). ONE synchronous send-store transaction: the receipt is re-read,
// the target is re-checked, and the queue row and the receipt flip land together. Nothing here may suspend, so a revocation or a
// hidden bot applied elsewhere cannot slip between the check and the write. The caller runs drainQueuedSends() afterwards.
import { sendFingerprint } from "../send-idempotency.ts";
import type { SendRow, SendStore } from "../send-store.ts";
import { phoneSendId, type PhoneReceipts, type Receipt } from "./receipts.ts";
import type { phoneTarget, TargetRefusal } from "./target.ts";

/** The same phone send id already holds a row for other words: both come from one receipt, so this is a programming error (409). */
export class PhoneCommitConflict extends Error {
  constructor() { super("a phone send id met a different line"); this.name = "PhoneCommitConflict"; }
}

export function commitPhoneLine(
  c: { receipt: Receipt; botId: string; threadId: string; text: string; via: "share" | "ask-intent"; files: SendRow["attachments"] },
  d: { target(): ReturnType<typeof phoneTarget>; sendStore: SendStore; receipts: PhoneReceipts; deleteFiles(files: SendRow["attachments"]): void; now(): number },
): { ok: true; result: { threadId: string; queueId: string } } | { ok: false; code: TargetRefusal } {
  const { deviceId, kind, id } = c.receipt;
  return d.sendStore.within(() => {
    const fresh = d.receipts.get(deviceId, kind, id);
    if (fresh?.state === "committed" && fresh.result) return { ok: true as const, result: fresh.result };
    if (fresh?.state === "refused" && fresh.code) return { ok: false as const, code: fresh.code };
    const t = d.target();
    if (!t.ok) {
      d.receipts.flip(deviceId, kind, id, { state: "refused", code: t.code });
      d.deleteFiles(c.files);
      return { ok: false as const, code: t.code };
    }
    const accepted = d.sendStore.accept({
      kind: "bot", status: "queued", ownerId: c.botId, threadId: c.threadId, text: c.text, origin: "unproven", via: c.via, queueOnly: true, viaDevice: deviceId,
      sendId: phoneSendId(kind, deviceId, id), fingerprint: sendFingerprint(c.text, undefined), attachments: c.files, now: d.now(),
    });
    if (accepted.kind === "conflict") throw new PhoneCommitConflict();
    const result = { threadId: accepted.row.threadId, queueId: accepted.row.queueId };
    d.receipts.flip(deviceId, kind, id, { state: "committed", result });
    return { ok: true as const, result };
  });
}
