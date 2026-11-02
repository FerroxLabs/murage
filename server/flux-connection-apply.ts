// The server half of a Flux key save (the `apply` hook of
// FluxConnectionTransaction). Every copy the server holds is rewritten here,
// synchronously, before the commit answer: config.json (a "" tombstone when
// the desktop store holds the key), the process env the server and its
// readers prefer over the file, and the in-memory config. The desktop store
// is written by Electron before commit (electron/flux-connection-control.mjs).
//
// Engine children already running keep the key they were spawned with, so a
// key change that replaces or removes a key usable before the save asks for a
// restart (`restartRequired`). A first connect with no usable Flux key before
// does not: no child holds an old key.
import { saveConfig, syncCredentialEnv, type AppConfig } from "./config.ts";
import type { FluxCredentialState } from "../electron/flux-credential-policy.mjs";
import { isFluxKeyShape, parseProviderBank } from "../electron/provider-connections.mjs";

export interface FluxConnectionApplyDeps {
  config: () => AppConfig;
  cloudHome: boolean;
  persistCloudCredentialPatch: (patch: { modelProviders: { bank: string }; flux: { apiKey: string } }) => Promise<void>;
  dropFluxBrokerToken: () => void;
  providerConnectionsChanged: (previous: string | undefined, next: string) => Promise<void>;
}

/** Every Flux credential a turn could have used before this save: the
 * workspace key and each enabled flux bank row (Astra r1 Medium 1). */
function usableFluxKeys(workspaceKey: string, bank: string | undefined): Set<string> {
  const keys = new Set<string>();
  if (isFluxKeyShape(workspaceKey.trim())) keys.add(workspaceKey.trim());
  try { for (const row of parseProviderBank(bank)) if (row.preset === "flux" && row.enabled && isFluxKeyShape(row.key.trim())) keys.add(row.key.trim()); }
  catch { /* an unreadable bank holds nothing usable */ }
  return keys;
}

export function createFluxConnectionApply(deps: FluxConnectionApplyDeps) {
  let keyChangedSinceBoot = false;
  // The flag as it was before the last non-restore apply, so a restore of
  // that same lease puts it back.
  let beforeLastApply = false;
  const apply = async (state: FluxCredentialState, external: boolean, restore: boolean): Promise<void> => {
    const cfg = deps.config();
    const previous = cfg.modelProviders?.bank, previousKey = cfg.flux?.apiKey ?? "";
    const bank = state.bank ?? "[]", apiKey = state.workspaceKey ?? "", connectionAliases = state.aliases ?? [];
    const before = usableFluxKeys(previousKey, previous);
    if (!restore) beforeLastApply = keyChangedSinceBoot;
    if (previousKey !== apiKey) deps.dropFluxBrokerToken();
    if (deps.cloudHome) await deps.persistCloudCredentialPatch({ modelProviders: { bank }, flux: { apiKey } });
    saveConfig({ modelProviders: { bank: deps.cloudHome || external ? "" : bank }, flux: { apiKey: deps.cloudHome ? "" : restore ? state.fileWorkspaceKey ?? "" : external ? "" : apiKey, connectionAliases } });
    syncCredentialEnv({ modelProviders: { bank }, flux: { apiKey } });
    process.env.MURAGE_FLUX_CONNECTION_ALIASES = JSON.stringify(connectionAliases);
    if (restore && state.ambientWorkspaceKey) process.env.MURAGE_FLUX_AMBIENT_KEY = state.ambientWorkspaceKey; else delete process.env.MURAGE_FLUX_AMBIENT_KEY;
    cfg.modelProviders = { bank }; cfg.flux = { apiKey, connectionAliases };
    if (restore) keyChangedSinceBoot = beforeLastApply;
    else if ([...before].some(key => key !== apiKey.trim())) keyChangedSinceBoot = true;
    await deps.providerConnectionsChanged(previous, bank);
  };
  return { apply, restartRequired: () => keyChangedSinceBoot };
}
