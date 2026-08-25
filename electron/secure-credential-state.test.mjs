import { describe, expect, it, vi } from "vitest";

import { createSecureCredentialState } from "./secure-credential-state.mjs";

describe("serialized secure credential state", () => {
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
