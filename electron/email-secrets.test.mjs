// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot email custody in the desktop shell (BOT-EMAIL-MURAGE-109 2.3, 2.4): the encrypted document field, the server-only env, the
// server's save message and the email:owner token response.
import { describe, expect, it } from "vitest";
import {
  EMAIL_SECRETS_KEY, emailOwnerFromTokenResponse, emailOwnerScopeGranted, emailSecretsEnv, isEmailSecretsSave, sanitizeEmailSecretsDoc, withEmailOwner, withEmailSecrets,
} from "./email-secrets.mjs";
import { workspaceCredentialEnv } from "./workspace-credentials.mjs";

const DOC = { owner: { token: "owner-token-fixture", keyId: "key_owner" }, bots: { b1: { token: "bot-key-fixture", keyId: "key_b1", label: "bot-email:b1" } } };

describe("email secrets custody", () => {
  it("keeps only well-formed credentials and plain bot ids", () => {
    expect(sanitizeEmailSecretsDoc({ ...DOC, bots: { ...DOC.bots, "../x": { token: "t", keyId: "k" }, b2: { token: "with space", keyId: "k" }, b3: { token: "t", keyId: "bad id" } }, extra: 1 }))
      .toEqual({ owner: DOC.owner, bots: { b1: { token: "bot-key-fixture", keyId: "key_b1" } } });
    expect(sanitizeEmailSecretsDoc("not json")).toEqual({ bots: {} });
    expect(sanitizeEmailSecretsDoc(JSON.stringify(DOC)).bots.b1.keyId).toBe("key_b1");
  });

  it("the server's save replaces the stored doc and an empty doc removes the field; other credentials stay", () => {
    const stored = withEmailSecrets({ fluxApiKey: "sk-flux-x" }, DOC);
    expect(stored.fluxApiKey).toBe("sk-flux-x");
    expect(stored[EMAIL_SECRETS_KEY].bots.b1.token).toBe("bot-key-fixture");
    expect(EMAIL_SECRETS_KEY in withEmailSecrets(stored, { bots: {} })).toBe(false);
    expect(isEmailSecretsSave({ type: "murage:email-secrets-save", doc: DOC })).toBe(true);
    expect(isEmailSecretsSave({ type: "murage:mcp-secrets-stale" })).toBe(false);
  });

  it("a new owner token keeps the bot keys", () => {
    const stored = withEmailOwner(withEmailSecrets({}, DOC), { token: "owner-token-2", keyId: "key_owner_2" });
    expect(stored[EMAIL_SECRETS_KEY]).toEqual({ owner: { token: "owner-token-2", keyId: "key_owner_2" }, bots: { b1: { token: "bot-key-fixture", keyId: "key_b1" } } });
    expect(() => withEmailOwner({}, { token: "", keyId: "k" })).toThrow();
  });

  it("the spawned server gets MURAGE_EMAIL_SECRETS only when something is stored", () => {
    expect(workspaceCredentialEnv({}).MURAGE_EMAIL_SECRETS).toBeUndefined();
    const env = workspaceCredentialEnv(withEmailSecrets({}, DOC));
    expect(JSON.parse(env.MURAGE_EMAIL_SECRETS)).toEqual(sanitizeEmailSecretsDoc(DOC));
    expect(emailSecretsEnv({ [EMAIL_SECRETS_KEY]: { bots: {} } })).toBeUndefined();
  });

  it("reads the email:owner token response (contract r2.5): key_id and scopes required, scopes without email:owner stays dark", () => {
    expect(emailOwnerFromTokenResponse({ api_key: "owner-token", key_prefix: "sk-flux-o", name: "Murage Desktop", key_id: "key_o", scopes: ["email:owner"] })).toEqual({ token: "owner-token", keyId: "key_o" });
    expect(emailOwnerScopeGranted({ api_key: "owner-token", key_id: "key_o", scopes: ["email:owner"] })).toBe(true);
    for (const scopes of [[], ["email:bot"], undefined, "email:owner"]) {
      const body = { api_key: "owner-token", key_id: "key_o", ...(scopes === undefined ? {} : { scopes }) };
      expect(emailOwnerScopeGranted(body)).toBe(false);
      expect(emailOwnerFromTokenResponse(body)).toBeNull();
    }
    expect(emailOwnerFromTokenResponse({ api_key: "owner-token", scopes: ["email:owner"] })).toBeNull();
    expect(emailOwnerFromTokenResponse({ api_key: "owner-token", key_id: "bad id", scopes: ["email:owner"] })).toBeNull();
    expect(emailOwnerFromTokenResponse({ api_key: "", key_id: "key_o", scopes: ["email:owner"] })).toBeNull();
    expect(emailOwnerFromTokenResponse(null)).toBeNull();
  });
});
