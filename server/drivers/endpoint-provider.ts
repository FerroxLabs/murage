// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Which named provider's API an engine endpoint is, so an engine can refuse
// to send a key whose own prefix names a different provider.
import { PROVIDER_PRESETS } from "../../electron/provider-connections.mjs";
import type { ProviderPreset } from "../../shared/provider-connections.ts";

/** The named provider whose API this endpoint is (its host or a subdomain of
 * it, case and a trailing dot ignored), or undefined for any other server. */
export function endpointProvider(url: string): ProviderPreset | undefined {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return undefined;
  }
  return (Object.keys(PROVIDER_PRESETS) as (keyof typeof PROVIDER_PRESETS)[]).find((preset) => {
    const presetHost = new URL(PROVIDER_PRESETS[preset].baseUrl).hostname;
    return host === presetHost || host.endsWith(`.${presetHost}`);
  });
}
