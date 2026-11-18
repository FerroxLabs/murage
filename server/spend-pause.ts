// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SpendGate } from "./spend-gate.ts";
import type { SpendPauseStatus } from "../shared/spend-pause.ts";

/** This projection is served only to the owner's desktop. */
export function ownerSpendPause(gate: SpendGate, botName: (id: string) => string | undefined): SpendPauseStatus {
  const status = gate.status();
  const emailOnly = status.held.every(row => row.credentialId.startsWith("bot:"));
  return { ...status, held: status.held.map(row => row.credentialId.startsWith("bot:")
    ? { ...row, botName: botName(row.credentialId.slice(4)) ?? "This bot", emailOnly }
    : row) };
}

/** The account figure orders the meter too. A key's smaller total must never
 * make the percentage disagree with the account-level admission decision. */
export function pauseMeterTotal(status: SpendPauseStatus): { state: "ok"; spentUsd: number; asOf: string; resetsAt: string } | { state: "pending" } | undefined {
  if (status.capability === "off") return undefined;
  if (!status.figure) return { state: "pending" };
  const [year, month] = status.figure.month.split("-").map(Number);
  return { state: "ok", spentUsd: status.figure.spentUsd, asOf: status.figure.asOf, resetsAt: new Date(Date.UTC(year!, month!, 1)).toISOString() };
}
