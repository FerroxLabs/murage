// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner-only pause status. Never carries credentials, credential fingerprints,
// refusal records or Flux management URLs supplied by a remote response.
export type SpendHold =
  | { kind: "limit" }
  | { kind: "unknown"; otherAccount?: boolean; noAccount?: boolean }
  | { kind: "flux"; limit: "monthly_spend" | "bot_monthly_spend" | "monthly_tokens" };
export interface SpendPauseStatus {
  capability: "on" | "off";
  limitUsd: number | null;
  figure: { month: string; asOf: string; spentUsd: number } | null;
  headsUpOnlyNotice: boolean;
  held: Array<{ credentialId: string; holds: SpendHold[]; botName?: string; emailOnly?: boolean }>;
}
