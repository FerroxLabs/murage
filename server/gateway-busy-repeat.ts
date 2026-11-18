// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { GatewayBusyReason, LimitTurn } from "./limit-continuation.ts";
import { redactSecretsForSink } from "./redact.ts";

type Selection = Pick<LimitTurn, "driverKind" | "selection">;
const keyOf = ({ driverKind, selection: s }: Selection) => JSON.stringify([driverKind, s.instanceId, s.connectionId ?? "", s.model, s.effort ?? ""]);
/** Process-local streaks, shared across chats using the same engine and selection. No retries or engine changes. */
export class GatewayBusyStreaks {
  private readonly entries = new Map<string, { count: number; lastAt: number; reason: GatewayBusyReason }>();
  succeeded(turn: Selection): void { this.entries.delete(keyOf(turn)); }
  refused(turn: Selection, reason: GatewayBusyReason, now: number, firstJob: boolean): { count: number; repeated: boolean } {
    const key = keyOf(turn), previous = this.entries.get(key);
    if (reason !== "busy" && reason !== "unknownLimit") { this.entries.delete(key); return { count: 0, repeated: false }; }
    const count = previous?.reason === reason && now - previous.lastAt <= 600_000 ? previous.count + 1 : 1;
    const repeated = (reason === "busy" || reason === "unknownLimit") && (count >= 3 || (firstJob && count >= 2 && now >= previous!.lastAt && now - previous!.lastAt <= 600_000));
    this.entries.set(key, { count, lastAt: now, reason });
    return { count, repeated };
  }
}
/** Mask before bounding so a truncated credential cannot evade the existing sink masker. JSON escaping prevents log injection. */
export function gatewayBusyLogLine(turn: Pick<LimitTurn, "engineName" | "httpStatus" | "gatewayCode" | "errorText">, reason: GatewayBusyReason, count: number): string {
  return `gateway busy engine=${JSON.stringify(redactSecretsForSink(turn.engineName).slice(0, 80))} http=${turn.httpStatus ?? "-"} gatewayCode=${turn.gatewayCode ?? "-"} reason=${reason} consecutive=${count} refusal=${JSON.stringify(redactSecretsForSink(turn.errorText ?? "").slice(0, 2000))}`;
}
/** Only a short human-readable explanation belongs on the card. Raw bodies and codes remain in Diagnostics. */
export function gatewayBusyShortReason(text: string): string | undefined {
  const clean = redactSecretsForSink(text).replace(/^API error \(status \d{3}[^)]*\):?\s*/i, "").replace(/^HTTP \d{3}:?\s*/i, "").replace(/\s+/g, " ").trim();
  if (!clean || /[{}\[\]]|\b(?:error|exception|traceback|rate_limited)\b|https?:\/\//i.test(clean)) return undefined;
  return clean.slice(0, 180);
}
