// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Phone-call key custody in the desktop shell (BOT-CALLS-1020 3a): own entry kind, one origin, server-only env, never in config.json.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PHONE_KEY_MESSAGE, PHONE_KEY_ORIGIN, PHONE_SECRETS_KEY, phoneKeyMessage, phoneSecretsEnv, sanitizePhoneKey, withPhoneKey } from "./phone-secrets.mjs";
import { workspaceCredentialEnv } from "./workspace-credentials.mjs";

const KEY = "vapi-private-key-fixture-0001";

describe("phone key custody", () => {
  it("binds the key to api.vapi.ai and refuses any other origin or a malformed key", () => {
    expect(sanitizePhoneKey(KEY)).toEqual({ key: KEY, origin: PHONE_KEY_ORIGIN });
    expect(sanitizePhoneKey({ key: KEY, origin: "https://evil.example" })).toBeNull();
    expect(sanitizePhoneKey({ key: "with space", origin: PHONE_KEY_ORIGIN })).toBeNull();
    expect(sanitizePhoneKey({ key: "x".repeat(513), origin: PHONE_KEY_ORIGIN })).toBeNull();
    expect(sanitizePhoneKey(null)).toBeNull();
  });

  it("stores and removes its own field; other credentials stay; it is never an MCP entry", () => {
    const stored = withPhoneKey({ fluxApiKey: "sk-flux-x", mcpServerSecrets: {} }, KEY);
    expect(stored.fluxApiKey).toBe("sk-flux-x");
    expect(stored[PHONE_SECRETS_KEY]).toEqual({ key: KEY, origin: PHONE_KEY_ORIGIN });
    expect(JSON.stringify(stored.mcpServerSecrets)).not.toContain(KEY);
    expect(PHONE_SECRETS_KEY in withPhoneKey(stored, null)).toBe(false);
    expect(() => withPhoneKey({}, "bad key")).toThrow();
  });

  it("the server env is always a string under the shell ('{}' with no key), set only at the server fork, never in the shared credential env", () => {
    expect(phoneSecretsEnv({})).toBe("{}");
    expect(JSON.parse(phoneSecretsEnv(withPhoneKey({}, KEY)))).toEqual({ key: KEY, origin: PHONE_KEY_ORIGIN });
    const shared = workspaceCredentialEnv(withPhoneKey({}, KEY));
    expect(JSON.stringify(shared)).not.toContain(KEY);
    const main = fs.readFileSync(path.join(import.meta.dirname, "main.mjs"), "utf8");
    expect(main).toContain("MURAGE_PHONE_CALL_SECRETS: phoneSecretsEnv(secureCredentials),");
  });

  it("the push to the server names the doc, or null after a removal", () => {
    expect(phoneKeyMessage(withPhoneKey({}, KEY))).toEqual({ type: PHONE_KEY_MESSAGE, doc: { key: KEY, origin: PHONE_KEY_ORIGIN } });
    expect(phoneKeyMessage({})).toEqual({ type: PHONE_KEY_MESSAGE, doc: null });
  });

  it("main wires the key box through the encrypted document and the private port, and the preload never reads the key back", () => {
    const main = fs.readFileSync(path.join(import.meta.dirname, "main.mjs"), "utf8");
    expect(main).toContain('ipcMain.handle("phone-key:save"');
    expect(main).toContain('ipcMain.handle("phone-key:remove"');
    expect(main).toMatch(/withPhoneKey\(current, /);
    expect(main).toContain("serverProc?.postMessage(phoneKeyMessage(");
    const preload = fs.readFileSync(path.join(import.meta.dirname, "preload.cjs"), "utf8");
    expect(preload).not.toMatch(/phone-key:(get|read|load)/);
  });
});
