/** Reserve the idle runtime before touching the serialized encrypted document. */
export async function mutateFluxCredentials(input, { packaged, updateDocument, post }) {
  if (!packaged) return post("/api/flux-connection/mutate", input);
  let lease;
  let reconcileRequired = false;
  try {
    return await updateDocument(async credentials => {
      const reserved = await post("/api/flux-connection/replace", { phase: "begin", input });
      lease = reserved.lease;
      credentials.fluxApiKey = reserved.next.workspaceKey;
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
  } finally {
    if (lease && !reconcileRequired) await post("/api/flux-connection/replace", { phase: "finish", lease });
  }
}
