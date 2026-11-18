// SPDX-License-Identifier: AGPL-3.0-or-later
// Confirmed desktop receipts and bounded attempts, scoped to home and incident.
import fs from "node:fs";
import path from "node:path";
const MAX_ATTEMPTS = 3;
const RETRY_MS = 60_000;
export function createConnectorNoticeReceipts(file) {
  let seen = new Set(), attempts = new Map();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    // v1 was written after show(), which did not confirm delivery. Do not trust it.
    if (parsed.v === 2) {
      seen = new Set(parsed.ids.filter(id => typeof id === "string" && id.length < 512).slice(-4096));
      attempts = new Map(parsed.attempts.filter(([key, value]) => typeof key === "string" && Number.isFinite(value.at) && Number.isInteger(value.count)).slice(-4096));
    }
  } catch { /* A first launch has no receipts. */ }
  const key = (home, id) => JSON.stringify([home, id]);
  const save = () => {
    while (seen.size > 4096) seen.delete(seen.values().next().value);
    while (attempts.size > 4096) attempts.delete(attempts.keys().next().value);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ v: 2, ids: [...seen], attempts: [...attempts] }), { mode: 0o600 });
    fs.renameSync(temporary, file);
  };
  const canAttempt = (home, id, now = Date.now()) => {
    const held = attempts.get(key(home, id));
    return !seen.has(key(home, id)) && (!held || (held.count < MAX_ATTEMPTS && now - held.at >= RETRY_MS));
  };
  return {
    has(home, id) { return typeof id === "string" && seen.has(key(home, id)); },
    canAttempt,
    attempt(home, id, now = Date.now()) {
      if (!canAttempt(home, id, now)) return false;
      const k = key(home, id); attempts.set(k, { at: now, count: (attempts.get(k)?.count ?? 0) + 1 }); save(); return true;
    },
    failed(home, id) { if (seen.delete(key(home, id))) save(); },
    delivered(home, id) {
      if (typeof id !== "string" || id.length > 256) return;
      seen.add(key(home, id)); save();
    },
  };
}
