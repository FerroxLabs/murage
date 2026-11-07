// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A real daily-active-installs number (upstream 09f39e5e3, #3337): one `app_active` a day while the app is in use.
// Sent when the page starts, comes into view or is focused, or when a check every ten minutes finds a new day while
// the page is in view and focused. At most once per local day per app page, never while the page is hidden, and only
// while analytics is on (the same switch as every other event). Loaded with the analytics library, never in the first paint.

export const ACTIVE_DAY_KEY = "murage-analytics-active-day";
export const ACTIVE_CHECK_MS = 10 * 60_000;

/** The local calendar day, "YYYY-MM-DD" (the computer's own date). */
export function localDay(now: Date = new Date()): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** How many recent claimed days are remembered, so a clock or time zone moved back to a day already sent sends nothing. */
export const ACTIVE_DAYS_KEPT = 14;

let claimed: string[] = [];

function readStoredDays(): string[] | undefined {
  try {
    const raw = localStorage.getItem(ACTIVE_DAY_KEY);
    return raw ? raw.split(",").filter(Boolean) : [];
  } catch { return undefined; /* no storage: this page's memory still holds the days */ }
}

/** True once per day: the first caller of a day claims it; storage remembers the recent days across restarts when it can. */
export function claimActiveDay(day: string): boolean {
  if (claimed.includes(day)) return false;
  const stored = readStoredDays();
  const known = stored ? [...new Set([...stored, ...claimed])] : claimed;
  if (known.includes(day)) { claimed = known; return false; }
  claimed = [...known, day].slice(-ACTIVE_DAYS_KEPT);
  try { localStorage.setItem(ACTIVE_DAY_KEY, claimed.join(",")); } catch { /* as above */ }
  return true;
}

let watching = false;

/** Start the daily check once per page. `canSend` is the analytics switch (and a running client); `send` captures the event. */
export function watchActiveDays(opts: { canSend: () => boolean; send: () => void; now?: () => Date }): void {
  if (watching || !globalThis.document) return;
  watching = true;
  const check = () => {
    if (!opts.canSend() || globalThis.document?.visibilityState !== "visible") return;
    if (claimActiveDay(localDay(opts.now?.() ?? new Date()))) opts.send();
  };
  check();
  document.addEventListener("visibilitychange", check);
  window.addEventListener("focus", check);
  setInterval(() => { if (document.hasFocus()) check(); }, ACTIVE_CHECK_MS);
}

/** Tests only: forget the claimed day and the started watch. */
export function resetActiveDaysForTest(): void {
  claimed = [];
  watching = false;
}
