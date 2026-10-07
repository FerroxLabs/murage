// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The key path end to end on the server side: a fake private parent port stands in for Electron main, which answers
// `murage:whatsapp-auth-key-request` (its half is electron/whatsapp-auth-key.node-test.mjs).
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AUTH_KEY_REPLY, AUTH_KEY_REQUEST, AuthKeyUnavailable, checkedProvider } from "./auth-key.ts";
import { fileAuthKey, whatsappAuthKeySource } from "./auth-key-source.ts";

const KEY = "0a".repeat(32);
let data: string;
beforeEach(() => { data = mkdtempSync(join(tmpdir(), "murage-wa-key-")); });
afterEach(() => { rmSync(data, { recursive: true, force: true }); });

function fakePort(answer: (request: { type: string }) => unknown | undefined) {
  const listeners: Array<(event: { data?: unknown }) => void> = [];
  const requests: unknown[] = [];
  return {
    requests,
    on: (_event: "message", listener: (event: { data?: unknown }) => void) => { listeners.push(listener); },
    postMessage(message: object) {
      requests.push(message);
      const reply = answer(message as { type: string });
      if (reply !== undefined) queueMicrotask(() => listeners.forEach(l => l({ data: reply })));
    },
  };
}

it("desktop: asks main over the parent port and hands back the key it answers with", async () => {
  const port = fakePort(() => ({ type: AUTH_KEY_REPLY, key: KEY }));
  const provider = whatsappAuthKeySource({ dataDir: data, parentPort: port });
  expect(await provider.get()).toBe(KEY);
  expect(port.requests).toEqual([{ type: AUTH_KEY_REQUEST }]);
  // Every spawn asks again; no copy is cached on the server.
  expect(await provider.get()).toBe(KEY);
  expect(port.requests).toHaveLength(2);
});

it("desktop: a null answer (store unavailable) fails closed as credential-store and nothing lands on disk", async () => {
  const port = fakePort(() => ({ type: AUTH_KEY_REPLY, key: null }));
  const provider = checkedProvider(whatsappAuthKeySource({ dataDir: data, parentPort: port }));
  await expect(provider()).rejects.toMatchObject({ reason: "credential-store" });
  expect(() => statSync(join(data, "whatsapp"))).toThrow();
});

it("desktop: a malformed key and a missing answer both fail closed", async () => {
  await expect(whatsappAuthKeySource({ dataDir: data, parentPort: fakePort(() => ({ type: AUTH_KEY_REPLY, key: "short" })) }).get()).rejects.toBeInstanceOf(AuthKeyUnavailable);
  await expect(whatsappAuthKeySource({ dataDir: data, parentPort: fakePort(() => undefined), timeoutMs: 20 }).get()).rejects.toMatchObject({ reason: "credential-store" });
});

it("headless: the exported variable wins and a malformed one is refused", async () => {
  expect(await whatsappAuthKeySource({ dataDir: data, env: { MURAGE_WHATSAPP_AUTH_KEY: KEY } }).get()).toBe(KEY);
  await expect(whatsappAuthKeySource({ dataDir: data, env: { MURAGE_WHATSAPP_AUTH_KEY: "nope" } }).get()).rejects.toBeInstanceOf(AuthKeyUnavailable);
});

it("headless: creates a 0600 key file once and never regenerates it", async () => {
  const first = await whatsappAuthKeySource({ dataDir: data, env: {} }).get();
  expect(first).toMatch(/^[0-9a-f]{64}$/);
  const file = join(data, "whatsapp", "auth-key");
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readFileSync(file, "utf8")).toBe(first + "\n");
  expect(await whatsappAuthKeySource({ dataDir: data, env: {} }).get()).toBe(first);
});

it("headless: a corrupt, loose or linked key file is refused, not repaired", () => {
  const dir = join(data, "whatsapp"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth-key"), "garbage\n", { mode: 0o600 });
  expect(() => fileAuthKey(data)).toThrow(AuthKeyUnavailable);
  expect(readFileSync(join(dir, "auth-key"), "utf8")).toBe("garbage\n");
  if (process.platform !== "win32") {
    writeFileSync(join(dir, "auth-key"), KEY + "\n", { mode: 0o600 }); chmodSync(join(dir, "auth-key"), 0o644);
    expect(() => fileAuthKey(data)).toThrow(AuthKeyUnavailable);
    rmSync(join(dir, "auth-key"));
    writeFileSync(join(data, "elsewhere"), KEY + "\n", { mode: 0o600 });
    symlinkSync(join(data, "elsewhere"), join(dir, "auth-key"));
    expect(() => fileAuthKey(data)).toThrow(AuthKeyUnavailable);
  }
});

it("an auth dir with no key source is key-missing and no second key is minted beside it", () => {
  mkdirSync(join(data, "whatsapp", "auth"), { recursive: true });
  expect(() => fileAuthKey(data)).toThrow(expect.objectContaining({ reason: "key-missing" }));
  expect(() => statSync(join(data, "whatsapp", "auth-key"))).toThrow();
});
