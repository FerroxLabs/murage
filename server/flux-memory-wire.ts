// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The fixed Flux Memory wire names and the three codex provider tables. Pure
// constants with NO imports: flux-routing.ts is bundled into the browser (the
// model picker reads it), so nothing it imports may reach a node: module.
// The decision logic lives in flux-memory-headers.ts.

export const FLUX_MEMORY_APP_HEADER = "x-flux-memory-app";
export const FLUX_MEMORY_CAPTURE_HEADER = "x-flux-memory-capture";
export const FLUX_MEMORY_INJECT_HEADER = "x-flux-memory-inject";
export const FLUX_MEMORY_SPACE_HEADER = "x-flux-memory-space";
export const FLUX_MEMORY_READ_HEADER = "x-flux-memory-read";
export const FLUX_MEMORY_APP = "murage";


/** Codex provider ids. The app-server is shared by every thread, so the headers
 *  cannot ride its process: three provider tables are declared once, in argv,
 *  and each thread picks one at thread/start (and thread/resume). */
export const FLUX_CODEX_PROVIDER_BASE = "flux";
export const FLUX_CODEX_PROVIDER_OFF = "flux-off";
export const FLUX_CODEX_PROVIDER_NOINJECT = "flux-noinject";

/** The fixed headers of each codex table. Never depend on settings: a settings change picks another table. */
export const FLUX_CODEX_TABLE_HEADERS: Readonly<Record<string, Record<string, string>>> = {
  [FLUX_CODEX_PROVIDER_BASE]: { [FLUX_MEMORY_APP_HEADER]: FLUX_MEMORY_APP },
  [FLUX_CODEX_PROVIDER_OFF]: { [FLUX_MEMORY_APP_HEADER]: FLUX_MEMORY_APP, [FLUX_MEMORY_CAPTURE_HEADER]: "off", [FLUX_MEMORY_INJECT_HEADER]: "off" },
  [FLUX_CODEX_PROVIDER_NOINJECT]: { [FLUX_MEMORY_APP_HEADER]: FLUX_MEMORY_APP, [FLUX_MEMORY_INJECT_HEADER]: "off" },
};

/** `-c` argv declaring `http_headers` on one codex provider table. */
export function codexHttpHeaderArgs(provider: string, headers: Record<string, string>): string[] {
  const inline = `{ ${Object.entries(headers).map(([name, value]) => `${JSON.stringify(name)} = ${JSON.stringify(value)}`).join(", ")} }`;
  return ["-c", `model_providers.${provider}.http_headers=${inline}`];
}

