// Test-only compatibility adapters: every old helper scenario still executes
// the real facade and private dispatcher. No alternate admission implementation.
import { createComposioLifecycle } from "../composio-lifecycle.mjs";

async function run(operation, options) {
  let credentials = { ...options.credentials, ...(options.fluxKey === undefined ? {} : { fluxApiKey: options.fluxKey }) };
  const authority = createComposioLifecycle({
    getConfiguration: () => ({ ...options, prepareLegacy: operation === "prepare" || operation === "claim" }),
    getCredentials: () => ({ ...credentials, ...(options.fluxKey === undefined ? {} : { fluxApiKey: options.fluxKey }) }),
    saveCredentials: async next => {
      // Existing token helpers return only their credential fields.
      if (!Object.hasOwn(options.credentials ?? {}, "fluxApiKey")) delete next.fluxApiKey;
      credentials = next;
      if (operation === "register") {
        const registered = next.composioBrokerToken && next.composioBrokerToken !== options.credentials.composioBrokerToken;
        for (const field of Object.keys(options.credentials)) if (!(field in next)) delete options.credentials[field];
        Object.assign(options.credentials, next);
        if (registered) await options.saveCredentials?.(options.credentials);
      }
      return true;
    },
    transport: options.fetchImpl,
    now: options.now === undefined ? undefined : () => options.now,
    monotonic: options.now === undefined ? undefined : () => options.now,
    onRateLimited: options.onRateLimited,
    onTransientFailure: options.onTransientFailure,
    log: options.log,
  });
  try {
    const result = await authority.request({ operation, force: options.force, rejectedTokenFingerprint: options.rejectedTokenFingerprint, token: options.token });
    const document = { ...result.credentials };
    if (!Object.hasOwn(options.credentials ?? {}, "fluxApiKey")) delete document.fluxApiKey;
    return operation === "revoke" ? result.revoked : operation === "register" ? options.credentials : document;
  } finally { authority.dispose(); }
}
export const ensureFluxComposioBrokerToken = options => run("refresh", options);
export const revokeFluxComposioBrokerToken = options => run("revoke", options);
export const claimLegacyComposioInstall = options => run("claim", options);
export const prepareLegacyComposioClaim = options => run("prepare", options);
export const ensureManagedComposioCredentials = options => run("register", { ...options, legacyBrokerUrl: options.brokerUrl });
export const deriveManagedComposioCredentials = options => async credentials => { await ensureManagedComposioCredentials({ ...options, credentials }); return credentials; };
