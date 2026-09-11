import { mutateProviderBank, providerBankRevision } from "./provider-connections.mjs";

const REPLACE_ROUTE = "/api/provider-connections/replace";
export const PROVIDER_BANK_UNCERTAIN_MESSAGE =
  "Model connections could not be reconciled after a failed save. Restart Murage before changing model connections or starting new work.";

/** In-memory reconciliation fence for the generic provider bank (B4, U-14).
 *
 * A replace whose acknowledgement is lost may still have committed in the
 * harness. From that moment until a trusted revision readback proves what the
 * live harness holds, provider writes and new dispatch stay fenced
 * (`publish(true)` tells the harness). Settling never overwrites an unknown
 * successor: it releases only when the harness already matches the encrypted
 * document, or after a revision-bound rollback of the exact candidate is
 * confirmed by a second readback. It holds a revision, never a key. */
export function createProviderBankReconciliation({ readRevision, publish = () => {} }) {
  let candidateRevision = null;
  let settling = null;

  const reconcile = async (diskBank, post) => {
    try {
      const diskRevision = providerBankRevision(diskBank);
      let runtimeRevision = await readRevision();
      if (runtimeRevision !== diskRevision && runtimeRevision === candidateRevision) {
        await post(REPLACE_ROUTE, { bank: diskBank, expectedRevision: candidateRevision });
        runtimeRevision = await readRevision();
      }
      if (runtimeRevision !== diskRevision) {
        throw new Error("The running model connections do not match the saved ones");
      }
      candidateRevision = null;
      publish(false);
    } catch (cause) {
      throw new Error(PROVIDER_BANK_UNCERTAIN_MESSAGE, { cause });
    }
  };

  return {
    get uncertain() {
      return candidateRevision !== null;
    },
    /** Fence before the failed operation lets the credential queue move on. */
    hold(revision) {
      candidateRevision = revision;
      publish(true);
    },
    /** Resolves only with a confirmed disposition; concurrent callers share one readback. */
    settle({ diskBank, post }) {
      if (candidateRevision === null) return Promise.resolve();
      settling ??= reconcile(diskBank, post).finally(() => {
        settling = null;
      });
      return settling;
    },
  };
}

/** Another writer of the provider bank (Flux) must not derive from, or reserve,
 * an uncertain harness bank. Settles under the same serialized queue. */
export function fenceProviderDocumentUpdate(updateDocument, { reconciliation, post }) {
  return (derive, afterPersist, options) =>
    updateDocument(
      async (credentials) => {
        await reconciliation.settle({ diskBank: credentials.modelProviderConnections ?? "[]", post });
        return derive(credentials);
      },
      afterPersist,
      options,
    );
}

/** Reuses the desktop's serialized encrypted document and rollback boundary. */
export async function mutateProviderCredentials(input, { packaged, updateDocument, post, createId, reconciliation }) {
  if (!packaged) return post("/api/provider-connections/mutate", input);
  let previous = "[]", next = "[]";
  return updateDocument(async credentials => {
    previous = credentials.modelProviderConnections ?? "[]";
    next = JSON.stringify(mutateProviderBank(previous, input, createId));
    if (!reconciliation) throw new TypeError("Model connection saves require a reconciliation fence");
    // Derivation runs under the credential queue, so a save queued behind an
    // uncertain one is fenced here before it can post a stale revision.
    await reconciliation.settle({ diskBank: previous, post });
    credentials.modelProviderConnections = next;
    return credentials;
  }, async () => {
    try { return await post(REPLACE_ROUTE, { bank: next, expectedRevision: providerBankRevision(previous) }); }
    catch (error) {
      // A lost HTTP acknowledgement may follow a committed harness write.
      // Fence first, then read the live revision back: release only on a
      // confirmed match (rolling back that exact candidate if it still owns
      // the revision). An unconfirmed disposition keeps the fence and rejects.
      reconciliation.hold(providerBankRevision(next));
      await reconciliation.settle({ diskBank: previous, post });
      throw error;
    }
  });
}
