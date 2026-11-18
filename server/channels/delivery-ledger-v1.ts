// The 1.0.18 receipt file format ("v1": a root file plus immutable overflow pages).
// 1.0.19 keeps it only to migrate old files into delivery-ledger.db, to re-import after a
// downgrade, and to write the export a prepared downgrade leaves for the older build.
import { lstatSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const id = z.string().min(1).max(400).regex(/^[^\x00-\x1f\x7f]+$/);
/** The message a reply quotes (WhatsApp keeps the triggering key; other adapters leave it unset). */
export const quoteSchema = z.object({ id, remoteJid: id.optional(), participant: id.optional(), fromMe: z.boolean().optional(), text: z.string().max(600).optional() }).strict();
/** A stored attachment reference; the file lives in the adapter's media directory. */
export const mediaSchema = z.object({ path: z.string().min(1).max(600), mime: z.string().max(120), bytes: z.number().int().nonnegative() }).strict();
export type DeliveryQuote = z.infer<typeof quoteSchema>;
export type DeliveryMedia = z.infer<typeof mediaSchema>;
/** The schemas of ONE record and ONE tombstone (the v1 element shapes); the store parses each row body with them. */
const buildElementSchemas = (maxResponse: number) => ({
  record: z.object({ deliveryId: id, dedupeId: id.optional(), sourceDeliveryId: id.optional(), expiresAt: z.number().finite().optional(), expiryKnown: z.literal(true).optional(), prompt: z.string().max(6000), occurredAt: z.number().finite(),
    runId: id.optional(), state: z.enum(["accepted", "queued", "sending", "sent", "uncertain", "rejected", "cancelled", "needs-review"]),
    response: z.string().max(maxResponse).optional(), attempts: z.number().int().min(0).max(3).default(0),
    retryAt: z.number().finite().optional(), resendAfter: z.number().finite().optional(), messageId: id.optional(), error: z.string().max(60).optional(),
    quote: quoteSchema.optional(), media: z.array(mediaSchema).max(8).optional(), noticeSent: z.boolean().optional(),
  }).strict(),
  tombstone: z.object({ deliveryId: id, dedupeId: id.optional(), sourceDeliveryId: id.optional(), expiresAt: z.number().finite().optional(), expiryKnown: z.literal(true).optional(), occurredAt: z.number().finite() }).strict(),
});
const buildSchema = (maxResponse: number, bounded = true) => {
  const { record, tombstone } = buildElementSchemas(maxResponse);
  return z.object({ version: z.literal(1), bindingKey: id, recipient: id,
    records: z.array(record).max(bounded ? 200 : Infinity), tombstones: z.array(tombstone).max(bounded ? 10000 : Infinity),
    overflow: z.array(z.uuid()).optional(),
  }).strict();
};
export type State = z.infer<ReturnType<typeof buildSchema>>;
export type Schema = ReturnType<typeof buildSchema>;
export { buildSchema, buildElementSchemas };
export const fileMax = 4 * 1024 * 1024;
export function checkFile(file: string) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > fileMax) throw new Error("Invalid channel receipt file");
}
export const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export function readPage(file: string, schema: Schema): State & { bytes: Buffer } {
  checkFile(file);
  const bytes = readFileSync(file);
  return Object.assign(schema.parse(JSON.parse(bytes.toString("utf8"))), { bytes });
}
/** The v1 ledger at `file` (root and overflow pages) and the sha256 of the root bytes. */
export function readLedger(file: string, schema: Schema): { state: State; rootSha: string } {
  const root = readPage(file, schema);
  const { bytes, ...state } = root;
  for (const part of state.overflow ?? []) {
    // Referenced pages must exist; ENOENT must not make a partial ledger look new.
    let page: State;
    try { page = readPage(`${file}.${part}`, schema); } catch { throw new Error("Invalid channel receipt overflow"); }
    if (page.overflow || page.bindingKey !== state.bindingKey || page.recipient !== state.recipient) throw new Error("Channel receipt binding mismatch");
    state.records.push(...page.records); state.tombstones.push(...page.tombstones);
  }
  delete state.overflow;
  return { state, rootSha: sha256(bytes) };
}
/** The v1 serialisation of a whole state: page 0 is the root. Page names are fresh uuids. */
export function planV1(state: State, schema: Schema): { rootBytes: string; pages: Array<{ name: string; bytes: string }> } {
  const empty = (): State => ({ version: 1, bindingKey: state.bindingKey, recipient: state.recipient, records: [], tombstones: [] });
  const pages = [empty()];
  let size = 0;
  for (const field of ["records", "tombstones"] as const) for (const row of state[field]) {
    const bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
    let page = pages.at(-1)!;
    // Leave room in the root for the page references as well as its own rows.
    if (page[field].length >= (field === "records" ? 200 : 10000) || size + bytes > fileMax / 2) {
      page = empty(); pages.push(page); size = 0;
    }
    if (field === "records") page.records.push(row as State["records"][number]);
    else page.tombstones.push(row);
    size += bytes;
  }
  const root = pages[0];
  if (pages.length > 1) root.overflow = pages.slice(1).map(() => randomUUID());
  const serialized = pages.map(page => JSON.stringify(schema.parse(page)));
  if (serialized.some(bytes => Buffer.byteLength(bytes) > fileMax)) throw new Error("Channel receipt size limit");
  return { rootBytes: serialized[0], pages: pages.slice(1).map((_, i) => ({ name: root.overflow![i], bytes: serialized[i + 1] })) };
}
