import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { deriveManagedComposioCredentials, MANAGED_COMPOSIO_UPDATE_OPTIONS } from "./managed-composio.mjs";
import { createSecureCredentialState } from "./secure-credential-state.mjs";
import { trackedCredentialUpdate } from "./secure-credentials.mjs";

describe("serialized secure credential state", () => {
  // A launch that could not READ credentials.bin starts from {}. Writing a
  // document derived from {} would not "add a key" — it would replace every
  // secret in the file with nothing, and orphan the connected-apps identity
  // the user already authorized. So such a state does not write at all.
  it("refuses to persist when it was built from an unreadable store", async () => {
    const persist = vi.fn();
    const state = createSecureCredentialState({}, persist, { writable: false });

    await expect(state.update((credentials) => ({ ...credentials, xaiApiKey: "new" }))).rejects.toThrow(
      /credential store/i,
    );
    expect(persist).not.toHaveBeenCalled();
  });

  it("still answers reads when it cannot write, so callers see an empty view rather than a crash", async () => {
    const state = createSecureCredentialState({}, vi.fn(), { writable: false });
    expect(state.read()).toEqual({});
  });

  it("writes normally when the store was readable", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const state = createSecureCredentialState({ boxToken: "old" }, persist, { writable: true });

    await state.update((credentials) => ({ ...credentials, boxToken: "new" }));
    expect(persist).toHaveBeenCalledWith({ boxToken: "new" });
  });

  it("writes normally when no options are passed at all", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const state = createSecureCredentialState({}, persist);
    await state.update(() => ({ boxToken: "x" }));
    expect(persist).toHaveBeenCalled();
  });

  it("derives concurrent changes from the latest committed copy", async () => {
    const writes = [];
    let releaseFirst;
    const firstPersisted = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const persist = vi.fn(async (value) => {
      writes.push(value);
      if (writes.length === 1) await firstPersisted;
    });
    const state = createSecureCredentialState({ existing: "kept" }, persist);

    const first = state.update((draft) => ({ ...draft, account: "signed" }));
    const second = state.update((draft) => ({ ...draft, apiKey: "saved" }));
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    releaseFirst();
    await Promise.all([first, second]);

    expect(state.read()).toEqual({ existing: "kept", account: "signed", apiKey: "saved" });
    expect(writes.at(-1)).toEqual({ existing: "kept", account: "signed", apiKey: "saved" });
  });

  it("returns copies that cannot mutate committed state", () => {
    const state = createSecureCredentialState({ nested: { value: "safe" } }, vi.fn());
    const snapshot = state.read();
    snapshot.nested.value = "changed";
    expect(state.read()).toEqual({ nested: { value: "safe" } });
  });

  it("accepts a cross-realm plain record and normalizes it to a local copy", () => {
    const foreign = runInNewContext("({ nested: { value: 'safe' } })");
    const state = createSecureCredentialState(foreign, vi.fn());

    expect(state.read()).toEqual({ nested: { value: "safe" } });
    expect(Object.getPrototypeOf(state.read())).toBe(Object.prototype);
  });

  it("rejects non-record documents and enumerable symbol keys", () => {
    class CredentialBag {}
    const symbolKeyed = { value: "safe" };
    symbolKeyed[Symbol("secret")] = "not-a-string-key";

    for (const invalid of [null, [], new Date(), new CredentialBag(), symbolKeyed]) {
      expect(() => createSecureCredentialState(invalid, vi.fn())).toThrow(TypeError);
    }
  });

  it("restores the encrypted document when the second phase fails", async () => {
    const writes = [];
    const state = createSecureCredentialState({ apiKey: "old" }, async (value) => writes.push(value));

    await expect(state.update(
      (draft) => ({ ...draft, apiKey: "new" }),
      async () => {
        throw new Error("local server rejected it");
      },
    )).rejects.toThrow("local server rejected it");

    expect(state.read()).toEqual({ apiKey: "old" });
    expect(writes).toEqual([{ apiKey: "new" }, { apiKey: "old" }]);
  });

  it("does not publish state when encrypted persistence fails", async () => {
    const state = createSecureCredentialState({ value: "old" }, async () => {
      throw new Error("keychain unavailable");
    });
    await expect(state.update((draft) => ({ ...draft, value: "new" }))).rejects.toThrow(
      "keychain unavailable",
    );
    expect(state.read()).toEqual({ value: "old" });
  });
});

// R2-T5: the optional managed Composio writer runs inside the same queue as
// every user credential write. Event order below is established with deferred
// promises only; nothing waits on wall-clock time.
describe("optional unchanged credential writes", () => {
  const TOKEN = "a".repeat(64);
  const brokerUrl = "https://broker.example";
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const abortable = (signal) =>
    new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  // Settles only what is already runnable; it cannot release a held deferred.
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const registration = (fetchImpl, shutdown) =>
    deriveManagedComposioCredentials({
      brokerUrl,
      fetchImpl,
      timeoutSignal: () => shutdown.signal,
    });

  it("skips the native write when an aborted pending registration derives the same document", async () => {
    const persist = vi.fn(async () => {});
    const state = createSecureCredentialState({ xaiApiKey: "kept" }, persist);
    const shutdown = new AbortController();
    const requested = deferred();
    const fetchImpl = vi.fn((_url, init) => {
      requested.resolve();
      return abortable(init.signal);
    });

    const optional = state.update(registration(fetchImpl, shutdown), undefined, MANAGED_COMPOSIO_UPDATE_OPTIONS);
    await requested.promise;
    shutdown.abort();

    await expect(optional).resolves.toEqual({ xaiApiKey: "kept" });
    expect(persist).not.toHaveBeenCalled();

    await state.update((draft) => ({ ...draft, boxToken: "user" }));
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith({ xaiApiKey: "kept", boxToken: "user" });
  });

  it("keeps a valid identity through a transient outage without writing, while ordinary equal writes still persist", async () => {
    const identity = { composioBrokerToken: TOKEN, composioInstallationId: "installation-test" };
    for (const outage of [
      async () => {
        throw new Error("offline");
      },
      async () => ({ ok: false, status: 503 }),
    ]) {
      const persist = vi.fn(async () => {});
      const state = createSecureCredentialState(identity, persist);

      await expect(
        state.update(registration(vi.fn(outage), new AbortController()), undefined, MANAGED_COMPOSIO_UPDATE_OPTIONS),
      ).resolves.toEqual(identity);
      expect(persist).not.toHaveBeenCalled();

      await state.update((draft) => draft);
      expect(persist).toHaveBeenCalledTimes(1);
      expect(persist).toHaveBeenCalledWith(identity);
    }
  });

  it("persists a definitive 401 invalidation even when the replacement registration is aborted", async () => {
    const persist = vi.fn(async () => {});
    const state = createSecureCredentialState(
      { xaiApiKey: "kept", composioBrokerToken: TOKEN, composioInstallationId: "installation-revoked" },
      persist,
    );
    const shutdown = new AbortController();
    const replacementRequested = deferred();
    const fetchImpl = vi.fn((url, init) => {
      if (url.endsWith("/v1/me")) return Promise.resolve({ ok: false, status: 401 });
      replacementRequested.resolve();
      return abortable(init.signal);
    });

    const optional = state.update(registration(fetchImpl, shutdown), undefined, MANAGED_COMPOSIO_UPDATE_OPTIONS);
    await replacementRequested.promise;
    shutdown.abort();

    await expect(optional).resolves.toEqual({ xaiApiKey: "kept" });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith({ xaiApiKey: "kept" });
    expect(state.read()).toEqual({ xaiApiKey: "kept" });
  });

  it("keeps a completed registration durable across abort while a queued user write waits behind it", async () => {
    const writes = new Set();
    const persistStarted = deferred();
    const releasePersist = deferred();
    const persist = vi.fn(async () => {
      if (persist.mock.calls.length !== 1) return;
      persistStarted.resolve();
      await releasePersist.promise;
    });
    const state = createSecureCredentialState({ xaiApiKey: "kept" }, persist);
    const shutdown = new AbortController();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ token: TOKEN, installationId: "installation-test" }),
    }));
    const settled = [];

    const optional = trackedCredentialUpdate(
      state,
      writes,
      registration(fetchImpl, shutdown),
      undefined,
      MANAGED_COMPOSIO_UPDATE_OPTIONS,
    );
    void optional.then(() => settled.push("registration"));
    await persistStarted.promise;
    shutdown.abort();

    const userDerive = vi.fn((draft) => ({ ...draft, boxToken: "user" }));
    const user = trackedCredentialUpdate(state, writes, userDerive);
    void user.then(() => settled.push("user"));
    const drained = Promise.allSettled([...writes]).then(() => settled.push("drain"));
    await flush();

    expect(writes.size).toBe(2);
    expect(settled).toEqual([]);
    expect(userDerive).not.toHaveBeenCalled();

    releasePersist.resolve();
    await Promise.all([drained, optional, user]);

    const registered = { xaiApiKey: "kept", composioBrokerToken: TOKEN, composioInstallationId: "installation-test" };
    expect([...settled].sort()).toEqual(["drain", "registration", "user"]);
    expect(userDerive).toHaveBeenCalledWith(registered);
    expect(persist.mock.calls.map(([document]) => document)).toEqual([registered, { ...registered, boxToken: "user" }]);
    expect(state.read()).toEqual({ ...registered, boxToken: "user" });
    expect(writes.size).toBe(0);
  });

  it("after a native persist rejection keeps the previous view, derives later writes from it, and does not skip an unchanged write", async () => {
    const persist = vi.fn().mockRejectedValueOnce(new Error("keychain unavailable")).mockResolvedValue(undefined);
    const state = createSecureCredentialState({ value: "old" }, persist);

    await expect(state.update((draft) => ({ ...draft, value: "new" }))).rejects.toThrow("keychain unavailable");
    expect(state.read()).toEqual({ value: "old" });

    // The rejected write may or may not have replaced the file, so an unchanged
    // optional write is not provably a no-op and must persist.
    await state.update((draft) => draft, undefined, { skipUnchanged: true });
    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenLastCalledWith({ value: "old" });

    await state.update((draft) => ({ ...draft, other: "later" }));
    expect(persist).toHaveBeenLastCalledWith({ value: "old", other: "later" });
  });

  it("restores the previous document before a queued mutation derives after a second-phase failure", async () => {
    const writes = [];
    const state = createSecureCredentialState({ apiKey: "old" }, async (value) => writes.push(value));
    const failed = state.update(
      (draft) => ({ ...draft, apiKey: "new" }),
      async () => {
        throw new Error("local server rejected it");
      },
    );
    const queuedDerive = vi.fn((draft) => ({ ...draft, other: "queued" }));
    const queued = state.update(queuedDerive);

    await expect(failed).rejects.toThrow("local server rejected it");
    await queued;
    expect(queuedDerive).toHaveBeenCalledWith({ apiKey: "old" });
    expect(writes).toEqual([{ apiKey: "new" }, { apiKey: "old" }, { apiKey: "old", other: "queued" }]);
  });

  it("reports a failed restoration as a durability limitation instead of claiming the rollback", async () => {
    const persist = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(undefined);
    const state = createSecureCredentialState({ apiKey: "old" }, persist);

    const error = await state
      .update(
        (draft) => ({ ...draft, apiKey: "new" }),
        async () => {
          throw new Error("local server rejected it");
        },
      )
      .catch((failure) => failure);

    expect(error.code).toBe("CREDENTIAL_RESTORE_FAILED");
    expect(error.message).toMatch(/could not be restored/);
    expect(error.cause.message).toBe("local server rejected it");
    expect(error.restoreError.message).toBe("disk full");
    expect(state.read()).toEqual({ apiKey: "old" });

    // The file may still hold the rejected document: an unchanged optional
    // write repairs it rather than skipping, and only then may later ones skip.
    await state.update((draft) => draft, undefined, { skipUnchanged: true });
    expect(persist).toHaveBeenCalledTimes(3);
    expect(persist).toHaveBeenLastCalledWith({ apiKey: "old" });
    await state.update((draft) => draft, undefined, { skipUnchanged: true });
    expect(persist).toHaveBeenCalledTimes(3);
  });

  it("refuses an unchanged optional write from an unreadable store before deriving or persisting", async () => {
    const persist = vi.fn();
    const derive = vi.fn((draft) => draft);
    const state = createSecureCredentialState({}, persist, { writable: false });

    await expect(state.update(derive, undefined, { skipUnchanged: true })).rejects.toThrow(/credential store/i);
    expect(derive).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("keeps full execution when a second phase is supplied with skipUnchanged", async () => {
    const persist = vi.fn(async () => {});
    const afterPersist = vi.fn(async () => "accepted");
    const state = createSecureCredentialState({ value: "same" }, persist);

    await expect(state.update((draft) => draft, afterPersist, { skipUnchanged: true })).resolves.toBe("accepted");
    expect(persist).toHaveBeenCalledWith({ value: "same" });
    expect(afterPersist).toHaveBeenCalledWith({ value: "same" });
  });

  it("compares validated structure rather than references or key order", async () => {
    const persist = vi.fn(async () => {});
    const state = createSecureCredentialState({ a: "1", nested: { x: 1, y: 2 } }, persist);

    await state.update(() => ({ nested: { y: 2, x: 1 }, a: "1" }), undefined, { skipUnchanged: true });
    expect(persist).not.toHaveBeenCalled();

    await state.update((draft) => ({ ...draft, nested: { x: 1, y: 3 } }), undefined, { skipUnchanged: true });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith({ a: "1", nested: { x: 1, y: 3 } });
  });
});
