// SPDX-License-Identifier: AGPL-3.0-or-later
// NOLIM-1019 N3 (ported from NL-UNREAD S6 44c2f70cc, same text): Approve all is on screen whenever two approval cards
// wait, whether or not any of them can go in bulk. Visibility counts every waiting approval; eligibility (the server's
// `bulk: "ok"` stamp, which excludes the N2 wipe cards) only decides the count and whether the press is enabled.
export function approveAllCounts(shown: ReadonlyArray<{ kind?: string; bulk?: string; segment?: string }>) {
  const rows = shown.filter(row => row.kind === "request" && (row.segment === undefined || row.segment === "approval"));
  const ok = rows.filter(row => row.bulk === "ok").length;
  return { visible: rows.length >= 2, disabled: ok === 0, ok, rest: rows.length - ok };
}

export function approveAllLabel(counts: ReturnType<typeof approveAllCounts>, copy: { approve: (ok: number) => string; look: (rest: number) => string }): string {
  if (!counts.ok) return copy.look(counts.rest);
  return copy.approve(counts.ok) + (counts.rest ? ` · ${copy.look(counts.rest)}` : "");
}
