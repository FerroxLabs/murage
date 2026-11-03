// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// LINUX-NOKEYRING-ENV-KEY: the reason code the desktop hands its server child. Never a key.
import { describe, expect, it } from "vitest";
import { secretSaveRefusedReason } from "./secret-storage-policy.mjs";

const store = (backend, available = true) => ({ getSelectedStorageBackend: () => backend, isAsyncEncryptionAvailable: async () => available });

describe("the desktop's save-refused reason", () => {
  it("is keyring only for a Linux store it could read that refuses writes", async () => {
    expect(await secretSaveRefusedReason({ safeStorage: store("basic_text"), storeUnavailable: false, platform: "linux", env: {} })).toBe("keyring");
    expect(await secretSaveRefusedReason({ safeStorage: store("unknown"), storeUnavailable: false, platform: "linux", env: {} })).toBe("keyring");
  });
  it("is empty for a writable store, the plaintext opt-in, an unreadable store, and another OS", async () => {
    expect(await secretSaveRefusedReason({ safeStorage: store("gnome_libsecret"), storeUnavailable: false, platform: "linux", env: {} })).toBe("");
    expect(await secretSaveRefusedReason({ safeStorage: store("basic_text"), storeUnavailable: false, platform: "linux", env: { MURAGE_ALLOW_PLAINTEXT_SECRETS: "1" } })).toBe("");
    expect(await secretSaveRefusedReason({ safeStorage: store("basic_text"), storeUnavailable: true, platform: "linux", env: {} })).toBe("");
    expect(await secretSaveRefusedReason({ safeStorage: store("unknown", false), storeUnavailable: false, platform: "darwin", env: {} })).toBe("");
  });
});
