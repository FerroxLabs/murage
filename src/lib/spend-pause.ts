// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SpendHold, SpendPauseStatus } from "../../shared/spend-pause";
import { formatDollars } from "./spend-meter";
import { opensPurchasePages } from "./native-shell";
import { t } from "./i18n";

/** A response from a retired key can never put its holds on the current one. */
export function matchedPause(answer: unknown, fingerprint: string | null | undefined): SpendPauseStatus | null {
  if (!fingerprint || !answer || typeof answer !== "object") return null;
  const body = answer as { fingerprint?: unknown; pauseFingerprint?: unknown; pause?: SpendPauseStatus };
  if ((body.pauseFingerprint ?? body.fingerprint) !== fingerprint) return null;
  const p = body.pause;
  if (!p || !["on", "off"].includes(p.capability) || !Array.isArray(p.held)) return null;
  if (p.limitUsd !== null && !(typeof p.limitUsd === "number" && Number.isFinite(p.limitUsd) && p.limitUsd > 0)) return null;
  if (!p.held.every(row => row && typeof row === "object" && typeof row.credentialId === "string" && Array.isArray(row.holds) && row.holds.every(h =>
    h && (["limit", "unknown"].includes(h.kind) || (h.kind === "flux" && ["monthly_spend", "bot_monthly_spend", "monthly_tokens"].includes(h.limit)))))) return null;
  return p;
}

export function pauseLines(holds: SpendHold[], limitUsd: number | null, botName?: string, emailOnly?: boolean): string[] {
  const has = (kind: SpendHold["kind"]) => holds.find(h => h.kind === kind);
  const limit = has("limit"), unknown = has("unknown"), flux = has("flux");
  const lines: string[] = [];
  if (limit) lines.push(t("ux.l2c.pause.limit", { limit: limitUsd === null ? "" : formatDollars(limitUsd) }));
  if (unknown?.kind === "unknown") lines.push(t(unknown.noAccount ? "ux.l2c.pause.noAccount.line" : unknown.otherAccount ? "ux.l2c.pause.otherAccount" : "ux.l2c.pause.unknown"));
  if (flux?.kind === "flux") lines.push(t(limit || unknown ? "ux.l2c.pause.fluxAlso" : flux.limit === "monthly_tokens" ? "ux.l2c.pause.fluxTokens" : flux.limit === "bot_monthly_spend" ? "ux.l2c.pause.fluxBot" : "ux.l2c.pause.fluxKey"));
  if (botName) lines.push(t(emailOnly ? "ux.l2c.pause.emailOnly" : "ux.l2c.pause.botWaits", { bot: botName }));
  return lines;
}
export function pauseActions(holds: SpendHold[]): Array<"raise" | "check" | "openFlux"> {
  const actions: Array<"raise" | "check" | "openFlux"> = [];
  if (holds.length === 1 && holds[0]?.kind === "limit") actions.push("raise");
  if (holds.length) actions.push("check");
  if (holds.some(h => h.kind === "flux" || (h.kind === "unknown" && (h.otherAccount || h.noAccount))) && opensPurchasePages()) actions.push("openFlux");
  return actions;
}
