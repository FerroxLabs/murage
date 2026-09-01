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

/** Config first, then env, so a packaged build can be pointed at a different
 *  key without a rebuild — the same order `sendlaneCredentials()` uses.
 *  Returns null rather than throwing: no key simply means Flux routing is
 *  unavailable, and a malformed config.json must not take the server down. */
export function fluxKey(env: NodeJS.ProcessEnv = process.env): string | null {
  let cfg: { flux?: { apiKey?: string } } = {};
  try {
    cfg = loadConfig() as typeof cfg;
  } catch {
    // a malformed config must not make every Flux lookup throw
  }
  const key = (cfg.flux?.apiKey ?? env.FLUX_API_KEY ?? "").trim();
  return key || null;
}

/** Whether a Flux key is present, for the config route's boolean. Never
 *  return `fluxKey()` itself to the renderer — an Electron renderer bundle is
 *  readable by anyone who installs the app. */
export function fluxConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return fluxKey(env) !== null;
}
