// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomBytes } from "node:crypto";
import type { ConsumingTurnBinding } from "./consuming-turn-response.ts";
import { assertConsumingBinding, refuseConsumingTurn } from "./consuming-turn-response.ts";
import { ownerTurnBinding } from "./consuming-turn-ingress.ts";

// Connection credentials remain valid for catalog probes only. Inference credentials
// are issued at admission and never resolve a replacement by thread id.
const credentials = new Map<string, { connectionId: string; binding: ConsumingTurnBinding }>();
export function issueGatewayTurnCredential(connectionId: string, binding: ConsumingTurnBinding): string {
  assertConsumingBinding(binding);
  // cause22 caps: a full table refuses every turn but the owner's own, as before; the owner's turn is issued its credential
  // regardless (no count stops it; its credentials leave the table when its generation is revoked, like any other).
  if (credentials.size >= 4096 && !ownerTurnBinding(binding)) refuseConsumingTurn(binding, { state: "checking", reason: "retained-budget" });
  const key = randomBytes(32).toString("base64url");
  credentials.set(key, { connectionId, binding });
  return key;
}
export function gatewayTurnBinding(connectionId: string, authorization: string | undefined): ConsumingTurnBinding | undefined {
  const key = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const entry = credentials.get(key);
  if (entry?.connectionId !== connectionId) return undefined;
  try { assertConsumingBinding(entry.binding); return entry.binding; }
  catch { credentials.delete(key); return undefined; }
}
export function revokeGatewayTurnCredentials(generation: string): void {
  for (const [key, entry] of credentials) if (entry.binding.identity.dispatchGeneration === generation) credentials.delete(key);
}
