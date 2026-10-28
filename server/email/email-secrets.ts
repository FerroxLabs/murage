// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Where the email keys (one email:bot key per bot, label bot-email:<bot id>) and the email:owner desktop token live (design 2.3, 2.4).
// The same arrangement as the link-server secrets (mcp-secrets.ts): the harness holds them in memory only. In the packaged app they arrive
// from the desktop shell once at boot in MURAGE_EMAIL_SECRETS (read and deleted here, listed in WORKSPACE_CREDENTIAL_ENV so no child
// inherits it), and every change the server makes (a key minted, revoked or rotated) is handed back to the shell through the injected
// `persist` hook, which keeps them in the OS secret storage. They are never in config.flux, never returned by fluxKey(), never in any
// spawn env, tool result or response body.
import { createHash } from "node:crypto";
import type { EmailCredentialProvider, FluxCredential } from "./flux-email-client.ts";

export const EMAIL_SECRETS_ENV = "MURAGE_EMAIL_SECRETS";

export interface EmailSecretsDoc { owner?: FluxCredential; bots: Record<string, FluxCredential & { label: string }> }

const KEY_ID = /^[\w.:-]{1,200}$/;
function credential(raw: unknown): FluxCredential | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { token, keyId } = raw as Record<string, unknown>;
  if (typeof token !== "string" || !token || token.length > 4096 || /[\s]/.test(token)) return null;
  if (typeof keyId !== "string" || !KEY_ID.test(keyId)) return null;
  return { token, keyId };
}

export function sanitizeEmailSecrets(raw: unknown): EmailSecretsDoc {
  const out: EmailSecretsDoc = { bots: Object.create(null) as EmailSecretsDoc["bots"] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const record = raw as Record<string, unknown>;
  const owner = credential(record.owner);
  if (owner) out.owner = owner;
  const bots = record.bots;
  if (bots && typeof bots === "object" && !Array.isArray(bots)) {
    for (const [botId, value] of Object.entries(bots as Record<string, unknown>)) {
      const cred = credential(value);
      if (!cred || botId === "__proto__" || !/^[\w-]{1,160}$/.test(botId)) continue;
      out.bots[botId] = { ...cred, label: `bot-email:${botId}` };
    }
  }
  return out;
}

/** A fingerprint for comparisons in tests and logs (never the value). */
export function credentialFingerprint(token: string): string { return createHash("sha256").update(token).digest("hex").slice(0, 16); }

export class EmailSecretStore {
  private doc: EmailSecretsDoc = { bots: Object.create(null) as EmailSecretsDoc["bots"] };
  private readonly persist: (doc: EmailSecretsDoc) => void;
  constructor(persist: (doc: EmailSecretsDoc) => void = () => {}) { this.persist = persist; }

  /** Reads MURAGE_EMAIL_SECRETS once and deletes it from the environment. */
  loadFromEnv(env: NodeJS.ProcessEnv = process.env): { loaded: number } {
    const raw = env[EMAIL_SECRETS_ENV];
    delete env[EMAIL_SECRETS_ENV];
    if (!raw) return { loaded: 0 };
    try { this.doc = sanitizeEmailSecrets(JSON.parse(raw)); } catch { return { loaded: 0 }; }
    return { loaded: Object.keys(this.doc.bots).length + (this.doc.owner ? 1 : 0) };
  }
  /** A full push from the shell. */
  replaceAll(raw: unknown): void { this.doc = sanitizeEmailSecrets(raw); }

  owner(): FluxCredential | null { return this.doc.owner ? { ...this.doc.owner } : null; }
  setOwner(cred: FluxCredential | null): void { if (cred) this.doc.owner = { ...cred }; else delete this.doc.owner; this.save(); }
  botKey(botId: string): (FluxCredential & { label: string }) | null { const cred = this.doc.bots[botId]; return cred ? { ...cred } : null; }
  setBotKey(botId: string, cred: FluxCredential): void { this.doc.bots[botId] = { ...cred, label: `bot-email:${botId}` }; this.save(); }
  clearBotKey(botId: string): void { if (botId in this.doc.bots) { delete this.doc.bots[botId]; this.save(); } }
  botIds(): string[] { return Object.keys(this.doc.bots); }
  /** Every key id held (fingerprint-free): used by the env-leak checks and by rotation to tell which key is current. */
  keyIds(): string[] { return [...Object.values(this.doc.bots).map(cred => cred.keyId), ...(this.doc.owner ? [this.doc.owner.keyId] : [])]; }
  /** Every token held, for the spawn-env leak check (compared by fingerprint only). */
  fingerprints(): string[] { return [...Object.values(this.doc.bots).map(cred => credentialFingerprint(cred.token)), ...(this.doc.owner ? [credentialFingerprint(this.doc.owner.token)] : [])]; }

  private save(): void { try { this.persist(sanitizeEmailSecrets(JSON.parse(JSON.stringify(this.doc)))); } catch { /* the shell keeps the last copy it got; a failed hand-off is retried by the next change */ } }
}

/** Main -> server (electron/email-secrets.mjs): the email:owner token the owner just obtained with the desktop PKCE sign-in (2.4). */
export const EMAIL_OWNER_MESSAGE = "murage:email-owner";
/** Server -> main: the whole sanitized doc after every change, for the shell's encrypted store. */
export const EMAIL_SECRETS_SAVE = "murage:email-secrets-save";

export function isEmailShellMessage(message: unknown): message is { type: typeof EMAIL_OWNER_MESSAGE; owner?: unknown } {
  return !!message && typeof message === "object" && (message as { type?: unknown }).type === EMAIL_OWNER_MESSAGE;
}

/** Applies a shell message to the store; true when it was one (a malformed owner is dropped, never stored). */
export function applyEmailShellMessage(store: EmailSecretStore, message: unknown): boolean {
  if (!isEmailShellMessage(message)) return false;
  const owner = credential(message.owner);
  if (owner) store.setOwner(owner);
  return true;
}

/** The provider the client reads. `account` is the saved Flux account's key, handed in by the wiring (only #31 uses it). */
export function emailCredentialProvider(store: EmailSecretStore, account: () => FluxCredential | null): EmailCredentialProvider {
  return { account, owner: () => store.owner(), bot: botId => { const cred = store.botKey(botId); return cred ? { token: cred.token, keyId: cred.keyId } : null; } };
}
