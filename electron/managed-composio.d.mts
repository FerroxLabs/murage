// SPDX-License-Identifier: AGPL-3.0-or-later
export function fluxComposioBrokerUrl(
  env?: Record<string, string | undefined>,
  options?: { packaged?: boolean; releaseUrl?: string },
): string;
export function fluxComposioAccess(
  fluxBrokerUrl: string,
  credentials: Record<string, string | undefined>,
): { url: string; token: string } | null;

export function withComposioCredentialChange<T extends Record<string, string | undefined>>(current: T, next: T, brokerUrl: string): T;
export function readComposioCustody(value: unknown): import("./composio-lifecycle.mjs").PendingRevocation[];
export function applyComposioCustodyDelta(current: unknown, entries: import("./composio-lifecycle.mjs").PendingRevocation[], delta?: import("./composio-lifecycle.mjs").CustodyDelta[]): import("./composio-lifecycle.mjs").PendingRevocation[];
export function applyComposioCredentialResult(current: Record<string, unknown>, snapshot: Record<string, unknown>, next: Record<string, unknown>): { credentials: Record<string, unknown>; applied: boolean };
