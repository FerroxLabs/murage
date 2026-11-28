// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Connect with no usable system keyring: the real store, the real client and the real cloud-home:connect-start handler.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCloudHomeClient } from "./cloud-home-client.mjs";
import { KEYRING_NEEDED, registerCloudHomeIpc } from "./cloud-home-ipc.mjs";
import { createCloudHomeStore } from "./cloud-home-store.mjs";

const PLAIN = "Murage needs your system keyring to connect. Set one up and try again.";
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "connect-keyring-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function connectStart({ platform, backend, available, store: storeOver }) {
  const safeStorage = {
    getSelectedStorageBackend: () => backend, isAsyncEncryptionAvailable: async () => available,
    encryptString: (text) => Buffer.from(`sealed:${text}`), decryptString: (bytes) => bytes.toString().slice(7),
  };
  const store = storeOver ?? createCloudHomeStore({ safeStorage, directory: join(dir, "store"), platform });
  const opened = [];
  const client = createCloudHomeClient({
    store, fetch: async () => { throw new Error("no network in this test"); }, appVersion: "1.0.0", confirmStepUp: async () => true, cpEnvironment: "staging",
    cp: { staging: { baseUrl: "https://cp.test", siteOrigin: "https://site.test", jwk: { kty: "EC", crv: "P-256", x: "x", y: "y" } }, prod: { baseUrl: "https://p.test", siteOrigin: "https://site.test", jwk: null } },
    openExternal: async (url) => { opened.push(url); },
  });
  const handlers = new Map();
  registerCloudHomeIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, { cloudHome: { client }, getCpToken: () => "token", cpEnvironment: "staging" });
  return { call: () => handlers.get("cloud-home:connect-start")({ sender: "e" }), opened };
}
const messageOf = async (promise) => (await promise.then(() => null, (error) => error))?.message;

describe("Connect with no system keyring", () => {
  it("Linux with only the plain-text backend: plain words, no browser, nothing written", async () => {
    const t = connectStart({ platform: "linux", backend: "basic_text", available: true });
    expect(await messageOf(t.call())).toBe(PLAIN);
    expect(KEYRING_NEEDED).toBe(PLAIN);
    expect(t.opened).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("safeStorage unavailable (not Linux): the same plain words", async () => {
    const t = connectStart({ platform: "darwin", backend: undefined, available: false });
    expect(await messageOf(t.call())).toBe(PLAIN);
  });

  it("the words carry no key material", async () => {
    const t = connectStart({ platform: "linux", backend: "unknown", available: false });
    const message = await messageOf(t.call());
    expect(message).toBe(PLAIN);
    expect(message).not.toMatch(/PRIVATE|BEGIN|[A-Za-z0-9_-]{40,}/);
  });

  it("other errors stay as they were: a working keyring that fails elsewhere still says Something went wrong", async () => {
    const t = connectStart({ platform: "darwin", backend: undefined, available: true });
    const failing = connectStart({ platform: "darwin", backend: undefined, available: true, store: { assertWritable: async () => { throw new Error("EACCES /secret/path"); }, loadPending: async () => null, savePending: vi.fn(), loadRevocations: async () => [], list: async () => [] } });
    expect(await messageOf(failing.call())).toBe("Something went wrong. Try again.");
    expect(await messageOf(t.call())).not.toBe(PLAIN);
  });
});
