// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Where the email keys (one email:bot key per bot, label bot-email:<bot id>) and the email:owner desktop token live (design 2.3, 2.4).
// The same arrangement as the link-server secrets (mcp-secrets.ts): the harness holds them in memory only. In the packaged app they arrive
// from the desktop shell once at boot in MURAGE_EMAIL_SECRETS (read and deleted here, listed in WORKSPACE_CREDENTIAL_ENV so no child
// inherits it), and every change the server makes (a key minted, revoked or rotated) is handed back to the shell through the injected
// `persist` hook, which keeps them in the OS secret storage. They are never in config.flux, never returned by fluxKey(), never in any
// spawn env, tool result or response body.
import { createHash, randomUUID } from "node:crypto";
import type { EmailCredentialProvider, FluxCredential } from "./flux-email-client.ts";

export const EMAIL_SECRETS_ENV = "MURAGE_EMAIL_SECRETS";

/** EMAIL-ACCOUNT-CHANGE r3: `retired` holds, per inbox id, the bot key of an inbox the binding moved away from (the old Flux account's),
 *  kept only while sends on that inbox are still open, so their reconcile reads the old inbox with the key that can read it. */
type RetiredSlots = Record<string, FluxCredential & { botId: string }>;
export interface EmailSecretsDoc { owner?: FluxCredential; bots: Record<string, FluxCredential & { label: string }>; retired?: RetiredSlots | FluxCredential[]; legacyRetired?: FluxCredential[];
  /** EMAIL-ACCOUNT-CHANGE r4 section 2: during a rotation the old key stays on disk here until the new key is acked and the ref names it. */
  prev?: Record<string, FluxCredential> }

export const KEY_ID = /^[\w.:-]{1,200}$/;
const BOT_ID = /^[\w-]{1,160}$/;
const INBOX_ID = /^[\w.:-]{1,200}$/;
export function credential(raw: unknown): FluxCredential | null {
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
      if (!cred || botId === "__proto__" || !BOT_ID.test(botId)) continue;
      out.bots[botId] = { ...cred, label: `bot-email:${botId}` };
    }
  }
  for (const field of ["retired", "legacyRetired"] as const) {
    if (Array.isArray(record[field])) {
      const kept = record[field].map(credential).filter((c): c is FluxCredential => c !== null);
      if (kept.length) out[field] = kept;
    }
  }
  const retired = record.retired;
  if (retired && typeof retired === "object" && !Array.isArray(retired)) {
    for (const [inboxId, value] of Object.entries(retired as Record<string, unknown>)) {
      const cred = credential(value);
      const botId = value && typeof value === "object" ? (value as Record<string, unknown>).botId : undefined;
      if (!cred || inboxId === "__proto__" || !INBOX_ID.test(inboxId) || typeof botId !== "string" || !BOT_ID.test(botId)) continue;
      if (!out.retired) out.retired = Object.create(null) as RetiredSlots;
      (out.retired as RetiredSlots)[inboxId] = { ...cred, botId };
    }
  }
  const prev = record.prev;
  if (prev && typeof prev === "object" && !Array.isArray(prev)) {
    for (const [botId, value] of Object.entries(prev as Record<string, unknown>)) {
      const cred = credential(value);
      if (!cred || botId === "__proto__" || !BOT_ID.test(botId)) continue;
      (out.prev ??= Object.create(null) as NonNullable<EmailSecretsDoc["prev"]>)[botId] = cred;
    }
  }
  return out;
}

/** A fingerprint for comparisons in tests and logs (never the value). */
export function credentialFingerprint(token: string): string { return createHash("sha256").update(token).digest("hex").slice(0, 16); }

/** EMAIL-ACCOUNT-CHANGE r3: each save's revision, for the shell's ack. `epoch` is this server process's, so an ack meant for a server that has
 *  since restarted is never taken as this one's. */
export interface EmailSecretsSaveMeta { rev: number; epoch: string }
/** r4 section 1: the shell's ack lists the key ids it READ BACK from disk after the durable write. */
export interface EmailSecretsAck { rev?: unknown; epoch?: unknown; keyIds?: unknown }
/** The persist hook: true when a shell will answer `murage:email-secrets-saved {rev, epoch}` once the doc is on disk; anything else (no
 *  shell: tests, headless) counts the save as done at once, since nothing more durable exists. */
export type EmailSecretsPersist = (doc: EmailSecretsDoc, meta: EmailSecretsSaveMeta) => boolean | void;

export class EmailSecretStore {
  private doc: EmailSecretsDoc = { bots: Object.create(null) as EmailSecretsDoc["bots"] };
  /** CLOUD-EMAIL-KEYSTORE-1019 r2: set once the supervisor's boot record is loaded (Cloud only). Null on the desktop. */
  private cloud: { storeId: string; gen: number; ownerRev: number } | null = null;
  /** Recovery fence (r2 section 3): once set, nothing is saved, held or answered until the process restarts. No unfence. */
  private fenced = false;
  private confirmed: () => Promise<boolean>;
  setConfirmation(confirmed?: () => Promise<boolean>): void { if (confirmed) this.confirmed = confirmed; }
  async durable(): Promise<boolean> { try { return await this.confirmed(); } catch { return false; } }
  private readonly persist: EmailSecretsPersist;
  private readonly epoch = randomUUID();
  private rev = 0;
  private acked = 0;
  /** Keys this process added that no ack has listed yet (by key id): a key is used only once an ack's read-back list names it. */
  private readonly pending = new Set<string>();
  private readonly waiters = new Set<() => void>();
  /** EMAIL-ACCOUNT-CHANGE r4 section 1: why bot email is off this run, or null. "cloud": a Cloud home has no durable email key store yet
   *  (CLOUD-EMAIL-KEYSTORE-1019). "store": no shell can keep the keys (plain Node, or the shell's key store could not be read this launch).
   *  Off means: no enable or Reconnect (no Flux call), every bot key answers no credential, tools stay unmounted, bindings are not changed. */
  readonly unavailable: "cloud" | "store" | null;
  constructor(persist?: EmailSecretsPersist, options: { unavailable?: "cloud" | "store" | null } | (() => Promise<boolean>) = {}) { this.persist = persist ?? (() => false); this.unavailable = typeof options === "function" ? null : options.unavailable ?? (persist ? null : "store"); this.confirmed = typeof options === "function" ? options : async () => true; }
  /** False when the persist backend answers "none". */
  get available(): boolean { return this.unavailable === null; }

  /** The shell's ack: the doc of save `rev` (and every earlier one) is on disk. */
  ack(meta: EmailSecretsAck): void {
    if (meta.epoch !== this.epoch || typeof meta.rev !== "number" || !Number.isInteger(meta.rev) || meta.rev > this.rev) return;
    // r4 section 1: an ack with no key id list is not an ack (the shell always sends what it read back); only listed keys become durable
    if (!Array.isArray(meta.keyIds) || meta.keyIds.some(id => typeof id !== "string")) return;
    for (const id of meta.keyIds as string[]) this.pending.delete(id);
    if (meta.rev > this.acked) this.acked = meta.rev;
    for (const wake of [...this.waiters]) wake();
  }
  /** Whether a key this process added is on disk, by key id (a key loaded at boot always is). */
  isDurable(keyId: string): boolean { return !this.pending.has(keyId); }
  /** Resolves true once the key is on disk, false after `ms`. */
  whenDurable(keyId: string, ms: number): Promise<boolean> {
    if (this.isDurable(keyId)) return Promise.resolve(true);
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const wake = () => { if (!this.isDurable(keyId)) return; this.waiters.delete(wake); if (timer) clearTimeout(timer); resolve(true); };
      this.waiters.add(wake);
      timer = setTimeout(() => { this.waiters.delete(wake); resolve(this.isDurable(keyId)); }, ms);
      (timer as { unref?: () => void }).unref?.();
    });
  }
  /** The tick: a save the shell has not answered is pushed again (the doc is whole, so the latest push covers every earlier one). */
  resaveIfUnacked(): boolean { if (this.acked >= this.rev && this.pending.size === 0) return false; this.save(); return true; }
  private added(keyId: string): void { this.pending.add(keyId); }

  /** Reads MURAGE_EMAIL_SECRETS once and deletes it from the environment. */
  loadFromEnv(env: NodeJS.ProcessEnv = process.env): { loaded: number } {
    const raw = env[EMAIL_SECRETS_ENV];
    delete env[EMAIL_SECRETS_ENV];
    if (!raw || this.fenced) return { loaded: 0 };
    try { this.doc = sanitizeEmailSecrets(JSON.parse(raw)); this.pending.clear(); } catch { return { loaded: 0 }; }
    return { loaded: Object.keys(this.doc.bots).length + (this.doc.owner ? 1 : 0) };
  }
  /** A full push from the shell. */
  replaceAll(raw: unknown): void { if (this.fenced) return; this.doc = sanitizeEmailSecrets(raw); this.pending.clear(); }
  /** Cloud boot: the supervisor's record (owner and doc together) and its generation counters. */
  attachCloud(boot: { storeId: string; gen: number; ownerRev: number; owner?: unknown; doc: unknown }): void {
    if (this.fenced) return;
    this.cloud = { storeId: boot.storeId, gen: boot.gen, ownerRev: boot.ownerRev };
    this.doc = sanitizeEmailSecrets({ ...(boot.doc as object), ...(boot.owner ? { owner: boot.owner } : {}) });
  }
  storeId(): string | null { return this.cloud?.storeId ?? null; }
  cloudGen(): number | null { return this.cloud?.gen ?? null; }
  /** Recovery: clears the memory copy and stops every later change from being saved, held or answered. */
  fence(): void { this.fenced = true; this.doc = { bots: Object.create(null) as EmailSecretsDoc["bots"] }; }
  isFenced(): boolean { return this.fenced; }
  /** The Cloud owner message (supervisor only writer of the owner slot): applied when gen matches and ownerRev is newer; null clears. */
  applyCloudOwner(message: unknown): boolean {
    if (!isCloudEmailOwnerMessage(message)) return false;
    const m = message as { gen?: unknown; ownerRev?: unknown; owner?: unknown };
    if (this.fenced || !this.cloud || m.gen !== this.cloud.gen || typeof m.ownerRev !== "number" || !Number.isSafeInteger(m.ownerRev) || m.ownerRev <= this.cloud.ownerRev) return true;
    if (m.owner === null) delete this.doc.owner;
    else { const owner = credential(m.owner); if (!owner) return true; this.doc.owner = owner; }
    this.cloud.ownerRev = m.ownerRev;
    return true;
  }

  owner(): FluxCredential | null { return this.doc.owner ? { ...this.doc.owner } : null; }
  setOwner(cred: FluxCredential | null): void { if (this.fenced) return; if (cred) this.doc.owner = { ...cred }; else delete this.doc.owner; this.save(); }
  botKey(botId: string): (FluxCredential & { label: string }) | null { const cred = this.doc.bots[botId]; return cred ? { ...cred } : null; }
  setBotKey(botId: string, cred: FluxCredential): void { if (this.fenced) return; if (this.doc.bots[botId]?.keyId !== cred.keyId) this.added(cred.keyId); this.doc.bots[botId] = { ...cred, label: `bot-email:${botId}` }; this.save(); }
  clearBotKey(botId: string): void { if (!this.fenced && botId in this.doc.bots) { delete this.doc.bots[botId]; this.save(); } }
  botIds(): string[] { return Object.keys(this.doc.bots); }

  // ---- EMAIL-ACCOUNT-CHANGE r3: retired keys (the database decides which key id is expected; these only hold them) ----

  private retiredSlots(create: boolean): RetiredSlots | undefined {
    if (Array.isArray(this.doc.retired)) {
      if (!create) return undefined;
      this.doc.legacyRetired = [...(this.doc.legacyRetired ?? []), ...this.doc.retired];
      delete this.doc.retired;
    }
    if (create && !this.doc.retired) this.doc.retired = Object.create(null) as RetiredSlots;
    return this.doc.retired;
  }
  /** The retired key held for an inbox, if any. */
  retiredKey(inboxId: string): (FluxCredential & { botId: string }) | null { const cred = this.retiredSlots(false)?.[inboxId]; return cred ? { ...cred } : null; }
  retiredInboxes(): string[] { return Object.keys(this.retiredSlots(false) ?? {}); }
  /** The key with id `keyId` for this bot, from the bot slot or the inbox's retired slot (a half-applied save never decides which). */
  findBotKey(botId: string, keyId: string, inboxId: string | null, durableOnly = false): FluxCredential | null {
    if (durableOnly && !this.isDurable(keyId)) return null;
    const current = this.doc.bots[botId];
    if (current && current.keyId === keyId) return { token: current.token, keyId: current.keyId };
    const prev = this.doc.prev?.[botId];
    if (prev && prev.keyId === keyId) return { token: prev.token, keyId: prev.keyId };
    const retired = inboxId ? this.retiredSlots(false)?.[inboxId] : undefined;
    if (retired && retired.botId === botId && retired.keyId === keyId) return { token: retired.token, keyId: retired.keyId };
    return null;
  }
  /** One save: the bot slot's key moves to `retireTo` first when its id is the one named (so it is never dropped), then the bot slot takes
   *  `cred` (null empties it). */
  replaceBotKey(botId: string, cred: FluxCredential | null, retireTo: { inboxId: string; keyId: string }[] = []): void {
    if (this.fenced) return;
    const current = this.doc.bots[botId];
    const target = current ? retireTo.find(item => item.keyId === current.keyId && INBOX_ID.test(item.inboxId)) : undefined;
    if (current && target) this.retiredSlots(true)![target.inboxId] = { token: current.token, keyId: current.keyId, botId };
    if (cred) { this.setBotKey(botId, cred); return; }
    delete this.doc.bots[botId];
    this.save();
  }
  // ---- EMAIL-ACCOUNT-CHANGE r4 section 2: the prev slot (rotation handover) ----

  /** The old key held through a rotation handover, if any. */
  prevKey(botId: string): FluxCredential | null { const cred = this.doc.prev?.[botId]; return cred ? { ...cred } : null; }
  prevBotIds(): string[] { return Object.keys(this.doc.prev ?? {}); }
  /** One save: the new key takes the bot slot and the old key moves to the prev slot, so the key the database still names is on disk. A key
   *  the outgoing slots hold that a retired ref names goes to its retired slot in the same save, never dropped. */
  rotateInto(botId: string, next: FluxCredential, old: FluxCredential | null, retireTo: { inboxId: string; keyId: string }[] = []): void {
    if (this.fenced) return;
    this.retireNamed(botId, this.doc.prev?.[botId], retireTo);
    this.retireNamed(botId, this.doc.bots[botId], retireTo);
    if (old && old.keyId !== next.keyId) (this.doc.prev ??= Object.create(null) as NonNullable<EmailSecretsDoc["prev"]>)[botId] = { token: old.token, keyId: old.keyId };
    // The single persistence boundary includes all three slots. Keep the
    // established key-write boundary observable to crash and durability hooks.
    this.setBotKey(botId, next);
  }
  /** Empties the prev slot (only the key with `keyId`, when given). A key a retired ref names moves to its retired slot instead of being dropped. */
  dropPrev(botId: string, keyId?: string, retireTo: { inboxId: string; keyId: string }[] = []): void {
    if (this.fenced) return;
    const cred = this.doc.prev?.[botId];
    if (!cred || (keyId !== undefined && cred.keyId !== keyId)) return;
    this.retireNamed(botId, cred, retireTo);
    delete this.doc.prev![botId];
    if (!Object.keys(this.doc.prev!).length) delete this.doc.prev;
    this.save();
  }
  private retireNamed(botId: string, cred: FluxCredential | undefined, retireTo: { inboxId: string; keyId: string }[]): void {
    const target = cred ? retireTo.find(item => item.keyId === cred.keyId && INBOX_ID.test(item.inboxId)) : undefined;
    if (cred && target) this.retiredSlots(true)![target.inboxId] = { token: cred.token, keyId: cred.keyId, botId };
  }
  /** Drops an inbox's retired key (only when it is still the one with `keyId`, when given). */
  dropRetired(inboxId: string, keyId?: string): void {
    if (this.fenced) return;
    const cred = this.retiredSlots(false)?.[inboxId];
    if (!cred || (keyId !== undefined && cred.keyId !== keyId)) return;
    delete this.retiredSlots(false)![inboxId];
    if (!Object.keys(this.doc.retired!).length) delete this.doc.retired;
    this.save();
  }

  /** Every key id held (fingerprint-free): used by the env-leak checks and by rotation to tell which key is current. */
  keyIds(): string[] { return [...Object.values(this.doc.bots).map(cred => cred.keyId), ...Object.values(this.doc.prev ?? {}).map(cred => cred.keyId), ...Object.values(this.doc.retired ?? {}).map(cred => cred.keyId), ...(this.doc.legacyRetired ?? []).map(cred => cred.keyId), ...(this.doc.owner ? [this.doc.owner.keyId] : [])]; }
  /** Every token held, for the spawn-env leak check (compared by fingerprint only). */
  fingerprints(): string[] { return [...Object.values(this.doc.bots).map(cred => credentialFingerprint(cred.token)), ...Object.values(this.doc.prev ?? {}).map(cred => credentialFingerprint(cred.token)), ...Object.values(this.doc.retired ?? {}).map(cred => credentialFingerprint(cred.token)), ...(this.doc.legacyRetired ?? []).map(cred => credentialFingerprint(cred.token)), ...(this.doc.owner ? [credentialFingerprint(this.doc.owner.token)] : [])]; }

  private save(): void {
    if (this.fenced || !this.available) return;
    const rev = ++this.rev;
    const held = new Set(this.keyIds());
    for (const id of [...this.pending]) if (!held.has(id)) this.pending.delete(id);
    let willAck = false;
    try { willAck = this.persist(sanitizeEmailSecrets(JSON.parse(JSON.stringify(this.doc))), { rev, epoch: this.epoch }) === true; } catch { /* not on disk: the tick pushes it again (resaveIfUnacked) */ return; }
    // Only an explicit backend acknowledgement can make a newly saved key durable.
    void willAck;
  }
}

/** Main -> server (electron/email-secrets.mjs): the email:owner token the owner just obtained with the desktop PKCE sign-in (2.4). */
export const EMAIL_OWNER_MESSAGE = "murage:email-owner";
/** Server -> main: the whole sanitized doc after every change, for the shell's encrypted store. */
export const EMAIL_SECRETS_SAVE = "murage:email-secrets-save";

/** Supervisor -> server, Cloud only (CLOUD-EMAIL-KEYSTORE-1019 r2 section 4): the owner slot with its generation and revision. */
export const CLOUD_EMAIL_OWNER_MESSAGE = "murage:cloud-email-owner";
export function isCloudEmailOwnerMessage(message: unknown): boolean {
  return !!message && typeof message === "object" && (message as { type?: unknown }).type === CLOUD_EMAIL_OWNER_MESSAGE;
}

/** Main -> server (EMAIL-ACCOUNT-CHANGE r3): the doc of save {rev, epoch} is in the encrypted store (or no store exists to hold it). */
export const EMAIL_SECRETS_SAVED = "murage:email-secrets-saved";

export function isEmailShellMessage(message: unknown): message is { type: typeof EMAIL_OWNER_MESSAGE | typeof EMAIL_SECRETS_SAVED; owner?: unknown; rev?: unknown; epoch?: unknown; keyIds?: unknown } {
  const type = !!message && typeof message === "object" ? (message as { type?: unknown }).type : undefined;
  return type === EMAIL_OWNER_MESSAGE || type === EMAIL_SECRETS_SAVED;
}

/** Applies a shell message to the store; true when it was one (a malformed owner is dropped, never stored). */
export function applyEmailShellMessage(store: EmailSecretStore, message: unknown): boolean {
  if (!isEmailShellMessage(message)) return false;
  if (message.type === EMAIL_SECRETS_SAVED) { store.ack(message); return true; }
  const owner = credential(message.owner);
  if (owner) store.setOwner(owner);
  return true;
}

/** EMAIL-ACCOUNT-CHANGE r6 F1: the owner identity is the email:owner credential itself: its key id, or null with no owner token (then no owner
 *  run starts and every inbox row stays held). Never the Flux account key, never runtime account(). */
export function emailOwnerRef(store: Pick<EmailSecretStore, "owner">): string | null {
  return store.owner()?.keyId ?? null;
}

/** EMAIL-ACCOUNT-CHANGE r3: the key id the database expects for a bot on an inbox (the binding's emailKeyRef for its own inbox, the retired
 *  key ref for an inbox it moved away from), or null when no key may be used. */
export type ExpectedBotKey = (botId: string, inboxId: string | undefined) => { keyId: string; inboxId: string | null } | null;

/** The provider the client reads. `account` is the saved Flux account's key, handed in by the wiring (only #31 uses it). With `expected`
 *  (the runtime always passes it) a bot key is used only when its id is the one the database names: a saved key the database does not name
 *  (an old account's key a lost save brought back, a key a crash never recorded) is never sent on. */
export function emailCredentialProvider(store: EmailSecretStore, account: () => FluxCredential | null, expected?: ExpectedBotKey): EmailCredentialProvider {
  return {
    account, owner: () => store.owner(), ownerRef: () => emailOwnerRef(store),
    bot: (botId, inboxId) => {
      if (!store.available) return null; // r4 section 1: backend "none": no bot key is ever used
      if (!expected) { const cred = store.botKey(botId); return cred ? { token: cred.token, keyId: cred.keyId } : null; }
      const want = expected(botId, inboxId);
      return want ? store.findBotKey(botId, want.keyId, want.inboxId, true) : null;
    },
  };
}
