// The Flux Router credential, resolved for the SERVER process only.
//
// This is deliberately the one and only reader of the key. `FLUX_API_KEY` is
// listed in WORKSPACE_CREDENTIAL_ENV (config.ts), so `stripWorkspaceCredentialEnv`
// deletes it from every child-process env before a CLI is spawned. Anything
// that needs to route a spawned engine at Flux must therefore call `fluxKey()`
// — which reads config/`process.env`, not the env object it is mutating — and
// re-inject a copy under a harness-owned name AFTER the strip has run. Reading
// the key back off a child env is guaranteed to find nothing.
import { loadConfig } from "./config.ts";
import { isFluxKeyShape } from "../electron/provider-connections.mjs";
import { fluxKeyRefused } from "./flux-key-health.ts";

/** The saved value, whatever it is. Never leaves this file. */
function savedFluxValue(env: NodeJS.ProcessEnv): string {
  let cfg: { flux?: { apiKey?: string } } = {};
  try {
    cfg = loadConfig() as typeof cfg;
  } catch {
    // a malformed config must not make every Flux lookup throw
  }
  return (cfg.flux?.apiKey ?? env.FLUX_API_KEY ?? "").trim();
}

/** Config first, then env, so a packaged build can be pointed at a different
 *  key without a rebuild — the same order `announcementsBaseUrl()` uses.
 *  Returns null rather than throwing: no key simply means Flux routing is
 *  unavailable, and a malformed config.json must not take the server down.
 *
 *  Only a value shaped like a Flux key (`sk-flux-…`) is returned. A base URL,
 *  a short value or another provider's key in the Flux slot is never a Flux
 *  key, so it is never sent to Flux (2026-10-01 ingress evidence). */
export function fluxKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = savedFluxValue(env);
  return isFluxKeyShape(key) ? key : null;
}

/** Listed in Settings → Models when the Flux slot holds something that is not
 *  a Flux key. Returned as the row's `legacyError`, which disables the row, so
 *  nothing with that value as a bearer ever reaches api.fluxrouter.ai (start,
 *  Test or images). `foreignIssuer` is the more specific message when the value
 *  is another provider's key. */
export const NOT_FLUX_SAVED = "This saved value is not a Flux Router key. Paste your sk-flux- key.";
export function legacyFluxError(value: string | null | undefined, foreignIssuer?: string): string | undefined {
  if (!value?.trim() || isFluxKeyShape(value)) return undefined;
  return foreignIssuer ?? NOT_FLUX_SAVED;
}

/** Whether a Flux key is present, for the config route's boolean. Never
 *  return `fluxKey()` itself to the renderer — an Electron renderer bundle is
 *  readable by anyone who installs the app. */
export function fluxConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return fluxKey(env) !== null;
}

/** What the owner should be told about the Flux slot, without the key:
 *  `missing` (nothing saved), `not-flux` (something saved that is not a Flux
 *  key, so nothing is sent), `refused` (Flux said 401 or 403 to this exact key on Murage's own catalog call),
 *  `ok` otherwise. */
export type FluxKeyState = "ok" | "missing" | "not-flux" | "refused";
export function fluxKeyState(env: NodeJS.ProcessEnv = process.env): FluxKeyState {
  const saved = savedFluxValue(env);
  if (!saved) return "missing";
  if (!isFluxKeyShape(saved)) return "not-flux";
  return fluxKeyRefused(saved) ? "refused" : "ok";
}
