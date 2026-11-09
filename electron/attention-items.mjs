// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

const list = value => Array.isArray(value) ? value : [];
const text = value => typeof value === "string" ? value : "";
const hasTarget = row => row && typeof row.threadId === "string" && row.threadId && typeof row.messageId === "string" && row.messageId;
export function attentionDisplay(value) {
  if (!value || ![value.botName, value.title, value.willRun].every(part => typeof part === "string" && part.trim())) return null;
  return { botName: value.botName, title: value.title, willRun: value.willRun };
}

/** Main-only adapter. Pass the JSON bodies of /api/desktop/attention and
 * /api/desktop/tray from the SAME captured home, plus its explicit previews
 * preference and this launch's privacy-filtered receipts. No network or cache.
 * Tray-only rows (including questions) can open, but never inherit authority.
 * Held rows are routing data, not a second list of cards to display. */
export function itemsFromAttention(readResults) {
  const { attention, tray, home, previews, receipts } = readResults ?? {};
  const show = previews === true;
  const rows = new Map();
  const key = row => JSON.stringify([row.threadId, row.messageId]);
  for (const row of list(attention?.open).filter(hasTarget)) rows.set(key(row), { row, authority: true });
  for (const row of list(tray?.items).filter(hasTarget)) if (!rows.has(key(row))) rows.set(key(row), { row, authority: false });
  const chief = list(tray?.bots).find(bot => bot?.chief === true);
  return {
    previews: show,
    items: [...rows.values()].map(({ row, authority }) => ({
      home: text(home), epoch: text(attention?.epoch), threadId: row.threadId, messageId: row.messageId,
      ...(typeof row.botId === "string" ? { botId: row.botId } : {}),
      ...(authority && typeof row.requestId === "string" ? { requestId: row.requestId } : {}),
      display: show ? attentionDisplay(row.display) : null,
      // The current reads have no level; keep it absent rather than inventing one.
      level: show ? text(row.level) : "",
      outsideOk: show && authority && row.outsideOk && typeof row.outsideOk === "object" ? { ...row.outsideOk } : {},
      ...(show && authority && typeof row.digest === "string" ? { digest: row.digest } : {}),
    })),
    running: show ? list(tray?.working).filter(Boolean).map(row => ({ botName: text(row.botName), doing: text(row.doing) })) : [],
    receipts: show ? list(receipts).filter(row => row && typeof row.text === "string").slice(-3).map(row => ({ text: row.text })) : [],
    chief: chief ? { name: show ? text(chief.name) : "" } : null,
  };
}
