// SPDX-License-Identifier: AGPL-3.0-or-later
export function fluxComposioBrokerUrl(
  env?: Record<string, string | undefined>,
  options?: { packaged?: boolean; releaseUrl?: string },
): string;
export function fluxComposioAccess(
  fluxBrokerUrl: string,
  credentials: Record<string, string | undefined>,
): { url: string; token: string } | null;
