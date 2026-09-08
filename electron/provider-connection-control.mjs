import { mutateProviderBank, providerBankRevision } from "./provider-connections.mjs";
/** Reuses the desktop's serialized encrypted document and rollback boundary. */
export async function mutateProviderCredentials(input, { packaged, updateDocument, post, createId }) {
  if (!packaged) return post("/api/provider-connections/mutate", input);
  let previous = "[]", next = "[]";
  return updateDocument(credentials => {
    previous = credentials.modelProviderConnections ?? "[]";
    next = JSON.stringify(mutateProviderBank(previous, input, createId));
    credentials.modelProviderConnections = next;
    return credentials;
  }, async () => {
    try { return await post("/api/provider-connections/replace", { bank: next, expectedRevision: providerBankRevision(previous) }); }
    catch (error) {
      // A lost HTTP acknowledgement may follow a committed harness write.
      // Roll back only if that exact candidate still owns the revision.
      await post("/api/provider-connections/replace", { bank: previous, expectedRevision: providerBankRevision(next) }).catch(() => {});
      throw error;
    }
  });
}
