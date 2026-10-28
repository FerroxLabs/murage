// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Where a phone's share or ask may land (S32, design 5.8). Pure and synchronous on purpose: no suspension point may sit between
// this check and the commit section that uses it, so a revocation applied meanwhile cannot slip between them.
import type { AskRevocations } from "./ask-revocations.ts";

export type TargetRefusal = "revoked" | "target_gone";

export interface TargetBot { hidden?: boolean }

export function phoneTarget(
  t: { deviceId: string; generation: number; botId: string; threadId: string | "new" },
  w: { offered(): boolean; revocations: AskRevocations; bot(id: string): TargetBot | null; direct(botId: string, threadId: string): boolean },
): { ok: true } | { ok: false; code: TargetRefusal } {
  if (w.revocations.refuses(t.deviceId, t.generation)) return { ok: false, code: "revoked" };
  if (!w.offered()) return { ok: false, code: "target_gone" };
  const bot = w.bot(t.botId);
  if (!bot || bot.hidden === true) return { ok: false, code: "target_gone" };
  if (t.threadId !== "new" && !w.direct(t.botId, t.threadId)) return { ok: false, code: "target_gone" };
  return { ok: true };
}
