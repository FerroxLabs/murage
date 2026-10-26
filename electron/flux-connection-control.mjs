import { fluxKeyFingerprint, FLUX_COMPOSIO_TOKEN_FIELDS } from "./flux-composio-token.mjs";

/** Reserve the idle runtime before touching the serialized encrypted document. */
export async function mutateFluxCredentials(input, { packaged, updateDocument, post, afterDocument }) {
  if (!packaged) return post("/api/flux-connection/mutate", input);
  let lease;
  let reconcileRequired = false;
  try {
    const status = await updateDocument(async credentials => {
      const reserved = await post("/api/flux-connection/replace", { phase: "begin", input });
      lease = reserved.lease;
      const nextKey = typeof reserved.next.workspaceKey === "string" ? reserved.next.workspaceKey : "";
      // The connected-app token belongs to the account whose key minted it. A
      // different (or removed) key drops it in this same fenced write, so no
      // later failure can leave the previous account's token in use.
      const heldFingerprint = credentials.fluxComposioBrokerTokenKeyFingerprint
        ?? (typeof credentials.fluxApiKey === "string" && credentials.fluxApiKey ? fluxKeyFingerprint(credentials.fluxApiKey) : "");
      if (!nextKey || (heldFingerprint && heldFingerprint !== fluxKeyFingerprint(nextKey))) {
        for (const field of FLUX_COMPOSIO_TOKEN_FIELDS) delete credentials[field];
      }
      credentials.fluxApiKey = nextKey;
      credentials.modelProviderConnections = reserved.next.bank;
      credentials.fluxConnectionAliases = JSON.stringify(reserved.next.aliases);
      // An explicit selection supersedes inherited ambient credentials on later launches.
      credentials.fluxConnectionManaged = "true";
      return credentials;
    }, async () => {
      try { return await post("/api/flux-connection/replace", { phase: "commit", lease }); }
      catch (error) {
        try { await post("/api/flux-connection/replace", { phase: "rollback", lease }); }
        catch { reconcileRequired = true; throw new Error("Flux save could not be reconciled. Restart Murage before changing credentials again."); }
        throw error;
      }
    });
    // The document is written and the in-memory copy refreshed, but the
    // reservation is still held: hand the harness the cleared token now, so a
    // send during the next account's mint cannot carry the previous one.
    if (afterDocument) await afterDocument();
    return status;
  } finally {
    if (lease && !reconcileRequired) await post("/api/flux-connection/replace", { phase: "finish", lease });
  }
}
