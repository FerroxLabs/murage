// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The bots a refused backup restart is waiting on, as the server named them
 * (POST /api/backup-restart, 409 `waitingOnYou`). Only well-formed entries
 * cross into the Backups page; see shared/backup-waiting.ts for the words. */
export function waitingOnYouFrom(value) {
  const text = (input, max) => typeof input === "string" && input.trim() && input.length <= max && !/[\u0000-\u001f\u007f]/.test(input) ? input : null;
  if (!Array.isArray(value)) return [];
  const bots = [];
  for (const entry of value.slice(0, 20)) {
    if (!entry || typeof entry !== "object") continue;
    const botId = text(entry.botId, 200), name = text(entry.name, 120), threadId = text(entry.threadId, 200), messageId = text(entry.messageId, 200);
    if (botId && name && threadId) bots.push({ botId, name, threadId, ...(messageId ? { messageId } : {}) });
  }
  return bots;
}

/** The error a refused restart becomes: BACKUP_WAITING_ON_YOU, carrying who,
 * when a person's answer is what the backup waits for; the old
 * BACKUP_WORK_ACTIVE otherwise. */
export function backupRefusal(body) {
  const waitingOnYou = waitingOnYouFrom(body?.waitingOnYou);
  return waitingOnYou.length ? Object.assign(new Error("BACKUP_WAITING_ON_YOU"), { waitingOnYou }) : new Error("BACKUP_WORK_ACTIVE");
}
