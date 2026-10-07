// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { GENERIC_STORE_UNAVAILABLE, LINUX_KEYRING_REQUIRED, secretWriteRefusal } from "./secret-storage-policy.mjs";

const store = (backend, available = true) => ({
  isAsyncEncryptionAvailable: async () => available,
  getSelectedStorageBackend: () => backend,
});

test("Linux basic_text is refused even though safeStorage says it is available", async () => {
  assert.equal(await secretWriteRefusal({ safeStorage: store("basic_text"), platform: "linux", env: {} }), LINUX_KEYRING_REQUIRED);
});

test("Linux with an unknown or unreadable backend is refused", async () => {
  assert.equal(await secretWriteRefusal({ safeStorage: store("unknown"), platform: "linux", env: {} }), LINUX_KEYRING_REQUIRED);
  assert.equal(await secretWriteRefusal({ safeStorage: { isAsyncEncryptionAvailable: async () => true }, platform: "linux", env: {} }), LINUX_KEYRING_REQUIRED);
  assert.equal(await secretWriteRefusal({ safeStorage: { isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend() { throw new Error("not ready"); } }, platform: "linux", env: {} }), LINUX_KEYRING_REQUIRED);
});

test("Linux with a real keyring is allowed, and without any encryption is refused with the keyring sentence", async () => {
  for (const backend of ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"]) {
    assert.equal(await secretWriteRefusal({ safeStorage: store(backend), platform: "linux", env: {} }), null, backend);
  }
  assert.equal(await secretWriteRefusal({ safeStorage: store("gnome_libsecret", false), platform: "linux", env: {} }), LINUX_KEYRING_REQUIRED);
});

test("the explicit opt-in lets Linux write as plain text; only the exact value counts", async () => {
  assert.equal(await secretWriteRefusal({ safeStorage: store("basic_text"), platform: "linux", env: { MURAGE_ALLOW_PLAINTEXT_SECRETS: "1" } }), null);
  assert.equal(await secretWriteRefusal({ safeStorage: store("basic_text"), platform: "linux", env: { MURAGE_ALLOW_PLAINTEXT_SECRETS: "yes" } }), LINUX_KEYRING_REQUIRED);
});

test("macOS and Windows keep the old behaviour and never ask for a Linux backend", async () => {
  const guarded = { isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend() { throw new Error("linux only"); } };
  for (const platform of ["darwin", "win32"]) {
    assert.equal(await secretWriteRefusal({ safeStorage: guarded, platform, env: {} }), null);
    assert.equal(await secretWriteRefusal({ safeStorage: { isAsyncEncryptionAvailable: async () => false }, platform, env: {} }), GENERIC_STORE_UNAVAILABLE);
  }
});

test("the message names the fix and follows the copy rules", () => {
  assert.match(LINUX_KEYRING_REQUIRED, /gnome-keyring/);
  assert.match(LINUX_KEYRING_REQUIRED, /KWallet/);
  assert.doesNotMatch(LINUX_KEYRING_REQUIRED, /—|–|safe|Composio|\$|price/i);
});

test("every desktop secret write goes through the policy, not safeStorage directly", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const writers = main.split("\n").filter(line => /safeStorage\.isAsyncEncryptionAvailable\(\)/.test(line) && !/isAvailable:/.test(line));
  assert.deepEqual(writers, []);
  assert.match(main, /secretWriteRefusal/);
});
