import { z } from "zod";

const credentialsSchema = z.record(z.string(), z.unknown());
const copy = (credentials) => structuredClone(credentialsSchema.parse(credentials));

/** A serialized, copy-on-write view over credentials.bin.
 *
 * Every caller derives its next complete document from the latest committed
 * document while holding the same queue. This prevents an account sign-in,
 * API-key edit, and optional service registration from each persisting an old
 * snapshot over the other two. `afterPersist` supports changes that must also
 * be accepted by the local server: if that second phase fails, the encrypted
 * file is restored before another mutation may begin. */
export function createSecureCredentialState(initialCredentials, persist) {
  let current = copy(initialCredentials);
  let transition = Promise.resolve();

  const serialize = (work) => {
    const next = transition.then(work, work);
    transition = next.then(
      () => {},
      () => {},
    );
    return next;
  };

  return {
    read() {
      return copy(current);
    },

    update(derive, afterPersist) {
      return serialize(async () => {
        const previous = copy(current);
        const next = copy(await derive(copy(previous)));
        await persist(copy(next));
        try {
          const result = await afterPersist?.(copy(next));
          current = next;
          return result ?? copy(next);
        } catch (error) {
          // Keep both the in-memory view and the encrypted file consistent
          // with the failed operation the caller observed.
          await persist(copy(previous));
          current = previous;
          throw error;
        }
      });
    },
  };
}
