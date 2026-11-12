// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Cloud bot email keystore (CLOUD-EMAIL-KEYSTORE-1019 r2). The supervisor keeps ONE sealed record `botEmailSecrets` in credentials.enc:
// {v:1, storeId, gen, ownerRev, owner?, doc:{bots, prev, retired}}. The server writes only `doc`; only the supervisor writes `owner`.
// Every write is fsync, rename, a directory sync that really ran, then an authenticated reread; an ack carries key ids from that reread.
// The record is never in the credentials the server is sent, never writable by the generic credential path, and reaches the server only as the
// boot-envelope field `emailSecrets`. Dark unless the flag is on.
import { queueOwnerRevoke } from "./email-owner-revokes.ts";
import { randomBytes } from "node:crypto";
import { sanitizeEmailSecrets, type EmailSecretsDoc } from "../email/email-secrets.ts";
import type { FluxCredential } from "../email/flux-email-client.ts";
import { cloudHomeCopy } from "./copy.ts";
import { BOT_EMAIL_SECRETS_KEY, serverCredentialProjection } from "./credential-projection.ts";
import type { SealedSecretStore } from "./secrets.ts";

/** The `cloudBotEmail` flag: default OFF. Read by the supervisor only; the server learns it from the boot envelope (`emailStore: 1`). */
export const CLOUD_BOT_EMAIL_ENV = "MURAGE_CLOUD_BOT_EMAIL";
export function cloudBotEmailEnabled(env: NodeJS.ProcessEnv): boolean { return env[CLOUD_BOT_EMAIL_ENV] === "1"; }

/** The boot pipe refuses over 1 MiB (the whole home would stop); an email write that would push the envelope past this is refused. */
export const EMAIL_ENVELOPE_LIMIT = 768 * 1024;
const MAX_DOC_BYTES = 262_144;

/** The server-owned slots: bots plus whatever else the sanitizer keeps (r4: prev, retired). Never `owner`. */
export type EmailDoc = Omit<EmailSecretsDoc, "owner"> & Record<string, unknown>;
export interface EmailRecord { v: 1; storeId: string; gen: number; ownerRev: number; owner?: FluxCredential; doc: EmailDoc }
export type EmailSecretsSanitizer = (raw: unknown) => EmailSecretsDoc;
export type KeyStore = Pick<SealedSecretStore, "getAll" | "patchDurable" | "readBack">;

const STORE_ID = /^[0-9a-f]{32}$/;
const isInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function stripOwner(doc: EmailSecretsDoc | Record<string, unknown>): EmailDoc {
  const { owner: _owner, ...rest } = doc as Record<string, unknown>;
  return rest as EmailDoc;
}
export function emptyDoc(sanitize: EmailSecretsSanitizer = sanitizeEmailSecrets): EmailDoc { return stripOwner(sanitize({})); }
export function newRecord(sanitize?: EmailSecretsSanitizer): EmailRecord { return { v: 1, storeId: randomBytes(16).toString("hex"), gen: 0, ownerRev: 0, doc: emptyDoc(sanitize) }; }

/** Every key id in the doc slots: bots, and any `keyId` string inside `prev` and `retired`. Sorted, unique. */
export function docKeyIds(doc: EmailDoc, slots: readonly string[] = ["bots", "prev", "retired"]): string[] {
  const out = new Set<string>();
  const walk = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || depth > 4) return;
    for (const [name, child] of Object.entries(value)) {
      if (name === "keyId" && typeof child === "string") out.add(child); else walk(child, depth + 1);
    }
  };
  for (const slot of slots) walk((doc as Record<string, unknown>)[slot], 0);
  return [...out].sort();
}

/** The stored record, or null when absent or unreadable (fail closed). */
export function readRecord(records: Record<string, string>, sanitize: EmailSecretsSanitizer = sanitizeEmailSecrets): EmailRecord | null {
  const raw = records[BOT_EMAIL_SECRETS_KEY];
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.v !== 1 || typeof value.storeId !== "string" || !STORE_ID.test(value.storeId) || !isInt(value.gen) || !isInt(value.ownerRev)) return null;
    if (!value.doc || typeof value.doc !== "object" || Array.isArray(value.doc)) return null;
    const owner = sanitize({ owner: value.owner }).owner;
    return { v: 1, storeId: value.storeId, gen: value.gen, ownerRev: value.ownerRev, ...(owner ? { owner } : {}), doc: stripOwner(sanitize(value.doc)) };
  } catch { return null; }
}
const encode = (record: EmailRecord) => JSON.stringify(record);

/** The new boot-envelope fields. Flag OFF: none, so the envelope is byte-for-byte today's. Flag ON: a record is made on first use; if it
 * cannot be made durable, or an existing record is unreadable, no email fields are sent (the server answers "none"). */
export function emailBootFields(store: Pick<SealedSecretStore, "getAll" | "patchDurable">, enabled: boolean, sanitize?: EmailSecretsSanitizer): { emailStore?: 1; emailSecrets?: EmailRecord } {
  if (!enabled) return {};
  let record = readRecord(store.getAll(), sanitize);
  if (!record) {
    if (store.getAll()[BOT_EMAIL_SECRETS_KEY]) return {};
    record = newRecord(sanitize);
    try { if (!store.patchDurable({ [BOT_EMAIL_SECRETS_KEY]: encode(record) }).durable) return {}; } catch { return {}; }
  }
  return { emailStore: 1, emailSecrets: record };
}

export interface EmailSecretsSave { rev: number; epoch: number; gen: number; doc: EmailDoc }
export interface EmailSecretsAck { rev: number; epoch: number; gen: number; keyIds: string[] }
export type SaveRefusal = "malformed" | "owner_field" | "no_store" | "stale_generation" | "stale_revision" | "would_drop_acked" | "email_store_full" | "not_durable" | "write_failed";

/** Validates a `murage:email-secrets-save` message. The doc carries no owner slot: one writer per slot. */
export function parseEmailSecretsSave(message: Record<string, unknown>, sanitize: EmailSecretsSanitizer = sanitizeEmailSecrets): { ok: true; save: EmailSecretsSave } | { ok: false; reason: SaveRefusal } {
  if (Object.keys(message).some(key => !["type", "rev", "epoch", "gen", "doc"].includes(key))) return { ok: false, reason: "malformed" };
  const { rev, epoch, gen, doc } = message;
  if (!isInt(rev) || !isInt(epoch) || !isInt(gen) || !doc || typeof doc !== "object" || Array.isArray(doc)) return { ok: false, reason: "malformed" };
  if (Object.hasOwn(doc, "owner")) return { ok: false, reason: "owner_field" };
  try { if (JSON.stringify(doc).length > MAX_DOC_BYTES) return { ok: false, reason: "malformed" }; } catch { return { ok: false, reason: "malformed" }; }
  return { ok: true, save: { rev, epoch, gen, doc: stripOwner(sanitize(doc)) } };
}

/** Write, make durable, reread, and only then return the ack. Key ids come from the reread of credentials.enc, never from memory. */
export function saveEmailSecrets(store: KeyStore, save: EmailSecretsSave, context: { lastRevs: Map<number, number>; sanitize?: EmailSecretsSanitizer; /** r5 A: the owner delta still pending on the owner lane; every chain write carries it, so a doc save never writes the old owner back. */ pendingOwner?: OwnerDelta | null }): { ok: true; ack: EmailSecretsAck; settledOwner: boolean } | { ok: false; reason: SaveRefusal } {
  const sanitize = context.sanitize ?? sanitizeEmailSecrets;
  const records = store.getAll();
  const current = readRecord(records, sanitize);
  if (!current) return { ok: false, reason: "no_store" };
  if (save.gen !== current.gen) return { ok: false, reason: "stale_generation" };
  const last = context.lastRevs.get(save.epoch);
  if (last !== undefined && save.rev <= last) return { ok: false, reason: "stale_revision" };
  const saved = new Set(docKeyIds(save.doc));
  if (docKeyIds(current.doc, ["prev", "retired"]).some(id => !saved.has(id))) return { ok: false, reason: "would_drop_acked" };
  const next: EmailRecord = { ...current, doc: save.doc };
  const pending = context.pendingOwner && context.pendingOwner.gen === current.gen ? context.pendingOwner : null;
  if (pending) applyOwnerSlot(next, pending);
  const text = encode(next);
  if (Buffer.byteLength(JSON.stringify({ credentials: serverCredentialProjection(records), emailSecrets: next })) + 1024 > EMAIL_ENVELOPE_LIMIT) return { ok: false, reason: "email_store_full" };
  try {
    // r2 section 4 / M9: the fence tracks the last WRITTEN revision. From here a rename may have happened, so an older rev must never replace it,
    // whether or not this write is later confirmed (the server resaves under a newer rev).
    context.lastRevs.set(save.epoch, save.rev);
    if (!store.patchDurable({ [BOT_EMAIL_SECRETS_KEY]: text, ...queueOwnerRevoke(records, next.owner && current.owner?.keyId !== next.owner.keyId ? current.owner?.token : undefined) }).durable) return { ok: false, reason: "not_durable" };
    const again = readRecord(store.readBack(), sanitize);
    if (!again || again.storeId !== current.storeId || again.gen !== current.gen) return { ok: false, reason: "write_failed" };
    const onDisk = new Set(docKeyIds(again.doc));
    if (![...saved].every(id => onDisk.has(id))) return { ok: false, reason: "write_failed" };
    if (pending && !ownerLanded(again, pending)) return { ok: false, reason: "write_failed" };
    return { ok: true, ack: { rev: save.rev, epoch: save.epoch, gen: again.gen, keyIds: docKeyIds(again.doc) }, settledOwner: pending !== null };
  } catch { return { ok: false, reason: "write_failed" }; }
}

/** r5 B: the owner lane keeps only this delta, never a whole record. `owner: null` clears the slot. */
export interface OwnerDelta { gen: number; ownerRev: number; owner: FluxCredential | null }
function applyOwnerSlot(record: EmailRecord, delta: OwnerDelta): void {
  record.ownerRev = delta.ownerRev;
  if (delta.owner) record.owner = delta.owner; else delete record.owner;
}
/** The reread shows this delta: right owner key id (or none) at the delta's `ownerRev`. */
function ownerLanded(again: EmailRecord, delta: OwnerDelta): boolean { return again.ownerRev === delta.ownerRev && again.owner?.keyId === delta.owner?.keyId; }

/** One owner transaction on the store chain (r5 B): read the latest record C, require `C.gen === delta.gen`, set only the owner slot, keep C's `doc`
 * as it is, durable, reread. `dropped`: nothing was written (no record or another generation). Throws when the commit is uncertain (a write was
 * attempted and the reread or sync did not confirm it): the caller keeps the delta and retries it. */
export function applyOwnerDelta(store: KeyStore, delta: OwnerDelta, sanitize: EmailSecretsSanitizer = sanitizeEmailSecrets): { kind: "ok"; gen: number; ownerRev: number } | { kind: "dropped" } {
  const current = readRecord(store.getAll(), sanitize);
  if (!current || current.gen !== delta.gen) return { kind: "dropped" };
  const next: EmailRecord = { ...current };
  applyOwnerSlot(next, delta);
  if (!store.patchDurable({ [BOT_EMAIL_SECRETS_KEY]: encode(next), ...queueOwnerRevoke(store.getAll(), next.owner && current.owner?.keyId !== next.owner.keyId ? current.owner?.token : undefined) }).durable) throw new Error(cloudHomeCopy.cloudCredentialWriteFailed);
  const again = readRecord(store.readBack(), sanitize);
  const kept = again ? new Set(docKeyIds(again.doc)) : new Set<string>();
  if (!again || again.storeId !== current.storeId || again.gen !== delta.gen || !ownerLanded(again, delta) || !docKeyIds(current.doc).every(id => kept.has(id))) throw new Error(cloudHomeCopy.cloudCredentialWriteFailed);
  return { kind: "ok", gen: again.gen, ownerRev: again.ownerRev };
}

/** H2 / r4 revoke rule 2: rewrite the record as it now is in memory, durable, then reread. True only when the sync really ran, the reread is the same
 * store and generation and its stored owner key id is not `notKeyId`. Used to prove a wipe (or any gen change) is on disk before a key is revoked. */
export function confirmDurableWithoutOwner(store: KeyStore, notKeyId: string | undefined, sanitize: EmailSecretsSanitizer = sanitizeEmailSecrets): boolean {
  try {
    const current = readRecord(store.getAll(), sanitize);
    if (!current) return false;
    if (!store.patchDurable({ [BOT_EMAIL_SECRETS_KEY]: encode(current) }).durable) return false;
    const again = readRecord(store.readBack(), sanitize);
    return !!again && again.storeId === current.storeId && again.gen === current.gen && again.ownerRev === current.ownerRev && again.owner?.keyId === current.owner?.keyId && (notKeyId === undefined || again.owner?.keyId !== notKeyId);
  } catch { return false; }
}

/** The supervisor's owner write (S): compare-and-set on `gen`, `ownerRev + 1`, durable, reread. Throws on any failure. `null` clears. */
export function writeOwner(store: KeyStore, owner: FluxCredential | null, expectGen: number, sanitize: EmailSecretsSanitizer = sanitizeEmailSecrets): { gen: number; ownerRev: number } {
  const current = readRecord(store.getAll(), sanitize);
  if (!current || current.gen !== expectGen) throw new Error(cloudHomeCopy.cloudCredentialWriteFailed);
  const next: EmailRecord = { ...current, ownerRev: current.ownerRev + 1 };
  if (owner) next.owner = owner; else delete next.owner;
  if (!store.patchDurable({ [BOT_EMAIL_SECRETS_KEY]: encode(next), ...queueOwnerRevoke(store.getAll(), current?.owner?.keyId !== next.owner?.keyId ? current?.owner?.token : undefined) }).durable) throw new Error(cloudHomeCopy.cloudCredentialWriteFailed);
  const again = readRecord(store.readBack(), sanitize);
  if (!again || again.gen !== next.gen || again.ownerRev !== next.ownerRev || again.owner?.keyId !== owner?.keyId) throw new Error(cloudHomeCopy.cloudCredentialWriteFailed);
  return { gen: again.gen, ownerRev: again.ownerRev };
}

/** Recovery wipe (H2): gen+1, ownerRev+1, no owner, empty doc, same storeId; durable and verified by reread before it reports. Throws on failure.
 * A home that never held a record and has the flag OFF is left untouched; the wipe is otherwise not gated by the flag. */
export function wipeEmailRecord(store: KeyStore, enabled: boolean, sanitize: EmailSecretsSanitizer = sanitizeEmailSecrets): void {
  const records = store.getAll();
  const current = readRecord(records, sanitize);
  if (!current && !enabled && !records[BOT_EMAIL_SECRETS_KEY]) return;
  const base = current ?? newRecord(sanitize);
  const next: EmailRecord = { v: 1, storeId: base.storeId, gen: base.gen + 1, ownerRev: base.ownerRev + 1, doc: emptyDoc(sanitize) };
  if (!store.patchDurable({ [BOT_EMAIL_SECRETS_KEY]: encode(next), ...queueOwnerRevoke(store.getAll(), current?.owner?.keyId !== next.owner?.keyId ? current?.owner?.token : undefined) }).durable) throw new Error(cloudHomeCopy.cloudCredentialWriteFailed);
  const again = readRecord(store.readBack(), sanitize);
  if (!again || again.gen !== next.gen || again.owner || docKeyIds(again.doc).length) throw new Error(cloudHomeCopy.cloudCredentialWriteFailed);
}
