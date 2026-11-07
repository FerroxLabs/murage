// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// BOT-CALLS-1020 3a boot and push wiring: the env marks a desktop run and is deleted; the shell push sets or clears the key;
// the server boot reads the env beside the MCP secrets and before any child is spawned.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  _heldPhoneKeyForSend, _resetPhoneSecretsForTest, applyPhoneShellMessage, isPhoneShellMessage, loadPhoneSecretsFromEnv,
  PHONE_KEY_MESSAGE, PHONE_KEY_ORIGIN, PHONE_SECRETS_ENV, phoneCallsSupported, phoneKeyPresent,
} from "./phone-secrets.ts";

const KEY = "vapi-private-key-fixture-0002";
afterEach(() => _resetPhoneSecretsForTest());

describe("phone key boot and shell push", () => {
  it("an empty '{}' env still marks a desktop run with no key, and the env is deleted", () => {
    const env: NodeJS.ProcessEnv = { [PHONE_SECRETS_ENV]: "{}" };
    expect(loadPhoneSecretsFromEnv(env)).toEqual({ desktop: true, loaded: false });
    expect(PHONE_SECRETS_ENV in env).toBe(false);
    expect(phoneCallsSupported()).toBe(true);
    expect(phoneKeyPresent()).toBe(false);
  });

  it("no env means no desktop shell: no phone calls even when a push-shaped doc is absent", () => {
    expect(loadPhoneSecretsFromEnv({})).toEqual({ desktop: false, loaded: false });
    expect(phoneCallsSupported()).toBe(false);
  });

  it("the shell push sets the key for api.vapi.ai only, and a null doc clears it", () => {
    loadPhoneSecretsFromEnv({ [PHONE_SECRETS_ENV]: "{}" });
    const push = { type: PHONE_KEY_MESSAGE, doc: { key: KEY, origin: PHONE_KEY_ORIGIN } };
    expect(isPhoneShellMessage(push)).toBe(true);
    expect(isPhoneShellMessage({ type: "murage:email-owner" })).toBe(false);
    expect(applyPhoneShellMessage(push)).toBe(true);
    expect(_heldPhoneKeyForSend(PHONE_KEY_ORIGIN)).toBe(KEY);
    expect(_heldPhoneKeyForSend("https://evil.example")).toBeNull();
    expect(applyPhoneShellMessage({ doc: null })).toBe(false);
    expect(phoneKeyPresent()).toBe(false);
  });

  it("the server boot reads the phone env beside the MCP secrets and handles the shell push", () => {
    const index = fs.readFileSync(path.join(import.meta.dirname, "..", "index.ts"), "utf8");
    const mcp = index.indexOf("\nloadMcpSecretsFromEnv();");
    const phone = index.indexOf("\nloadPhoneSecretsFromEnv();");
    expect(mcp).toBeGreaterThan(0);
    expect(phone).toBeGreaterThan(mcp);
    expect(phone - mcp).toBeLessThan(400);
    expect(index).toContain("if (isPhoneShellMessage(message)) { applyPhoneShellMessage(message); return; }");
  });
});
