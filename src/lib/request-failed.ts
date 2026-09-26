// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

/** What a failed request says when the harness gave no sentence of its own:
 * never a bare "502 Bad Gateway" (0.1.60 audit C3). */
export function requestFailedSentence(status: number): string {
  if (status === 404) return "That isn't available here.";
  if (status === 408 || status === 504) return "That took too long. Try again.";
  if (status === 429) return "Too many requests right now. Wait a moment, then try again.";
  if (status >= 500) return "Murage couldn't finish that. Try again in a moment.";
  return "Murage couldn't do that. Try again.";
}
