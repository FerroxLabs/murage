// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Raising a bot to Full access or No limits the way the confirm card does
// (UX-TRUST-L1B-1013 section 1): preview, the default PATCH with the preview's
// previewId and ifRev, then the conversation apply with the revision the PATCH
// returned. `call` must be a desktop caller; `body` carries the level flags and
// whatever else the PATCH sets. The answer is the PATCH's, or the apply's when
// the apply refused.

type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;

export async function raiseLevel(call: Call, botId: string, body: Record<string, unknown>, options: { conversations?: boolean } = {}) {
  const targetLevel = body.noLimits === true ? "no-limits" : "full";
  const refresh = `/api/bots/${botId}/permissions/refresh`;
  const preview = await call("POST", refresh, { scope: "open", targetLevel });
  if (preview.status !== 200) return preview;
  const raised = await call("PATCH", `/api/bots/${botId}`, { settingsScope: "defaults", previewId: preview.body.previewId, ifRev: preview.body.botRev, ...body });
  if (raised.status !== 200 || options.conversations === false || !preview.body.eligible.length) return raised;
  const applied = await call("POST", refresh, { scope: "open", targetLevel, rosterId: preview.body.rosterId, afterRev: raised.body.permissionRev });
  return applied.status === 200 ? raised : applied;
}
