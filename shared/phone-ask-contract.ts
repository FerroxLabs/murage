// Share-and-ask contract shared by the harness (server) and tested against the fixtures in
// apps/mobile/contract/phone-ask.json and share-types.json, which Swift and Java read too.
// The companion door cannot import shared/ (TS6059 under build:companion), so it keeps a
// byte-for-byte twin of the tag, token pattern and message builder (plan B8:
// companion/src/phone-ask-shape.ts). No imports beyond zod and no Node builtins: web code may load this module.
import { z } from "zod";

export const PHONE_ASK_TAG = "murage-phone-ask/1";
export const PHONE_ASK_TTL_MS = 60000;
export const PHONE_ASK_TOKEN = /^murage_pa_[A-Za-z0-9_-]{43}$/;

export interface PhoneAskMessageFields { origin: string; keyId: string; nonce: string; expiresAt: number }

/** UTF-8 of tag, origin, keyId, nonce and decimal expiresAt joined by LF, no trailing newline. */
export function phoneAskMessage(f: PhoneAskMessageFields): string {
  return [PHONE_ASK_TAG, f.origin, f.keyId, f.nonce, String(f.expiresAt)].join("\n");
}

export const SHARE_LIMITS = {
  maxItems: 10,
  maxShareBytes: 62914560,
  doorMaxBytes: 67108864,
  imageMaxBytes: 10485760,
  fileMaxBytes: 26214400,
  noteMaxChars: 2000,
} as const;

/** Keys of IMAGE_MIMES and FILE_MIMES in server/attachments.ts, in order. shared/phone-ask-contract.test.ts pins both lists to SHARE_IMAGE_MIMES and SHARE_FILE_MIMES there. */
export const SHARE_IMAGE_MIME_LIST = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const SHARE_FILE_MIME_LIST = [
  "text/plain", "text/markdown", "text/csv", "text/tab-separated-values", "application/json", "application/pdf",
  "application/rtf", "text/rtf", "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text", "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
] as const;
const SHARE_MIMES: ReadonlySet<string> = new Set<string>([...SHARE_IMAGE_MIME_LIST, ...SHARE_FILE_MIME_LIST]);

const text = (max: number) => z.string().min(1).max(max);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Same shape as a send id (server/send-idempotency.ts). */
const ID_16_80 = /^[A-Za-z0-9_-]{16,80}$/;
const KEY_ID = /^[A-Za-z0-9_-]{43}$/;
// The door's DEVICE_ID and FreshAuthGate's nonce/signature shapes.
const DEVICE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** 1 MB of text in UTF-8 bytes, the server's message ceiling (shared/message-limits.ts); characters bound it from above here. */
const TEXT_MAX_CHARS = 1024 * 1024;

export const shareItemSchema = z.strictObject({
  n: z.number().int().min(1).max(SHARE_LIMITS.maxItems),
  name: text(255),
  mime: z.string().refine((m) => SHARE_MIMES.has(m), { message: "mime not offered" }),
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

/** Item sizes against the per-kind limits are the server's call (413 too_large); the schema checks shape only. */
export const manifestSchema = z
  .strictObject({
    shareId: z.string().regex(ID_16_80),
    botId: text(128),
    threadId: z.union([z.literal("new"), z.string().regex(UUID_V4)]),
    note: z.string().min(1).max(SHARE_LIMITS.noteMaxChars).optional(),
    text: z.string().min(1).max(TEXT_MAX_CHARS).optional(),
    url: z.string().max(2048).regex(/^https?:\/\/\S+$/).optional(),
    items: z.array(shareItemSchema).max(SHARE_LIMITS.maxItems),
  })
  .refine((m) => m.items.every((it, i) => it.n === i + 1), { message: "items must be numbered 1..n in order" })
  .refine((m) => m.note !== undefined || m.text !== undefined || m.url !== undefined || m.items.length > 0, { message: "nothing to share" });

export const askProofSchema = z.strictObject({
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  signature: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
});

export const askSchema = z.strictObject({
  askId: z.string().regex(ID_16_80),
  botId: text(128),
  text: text(TEXT_MAX_CHARS),
  proof: z.union([z.literal("want"), askProofSchema]).optional(),
});

/** Persisted admission evidence, never an authority ticket. Drain checks its bindings and current liveness again. */
export const askProofRecordSchema = z.strictObject({
  v: z.literal(1),
  deviceId: z.string().regex(DEVICE_ID),
  generation: safeInteger,
  keyId: z.string().regex(KEY_ID),
  askId: z.string().regex(ID_16_80),
  digest: z.string().regex(SHA256_HEX),
  rawTextHash: z.string().regex(SHA256_HEX),
  storedTextHash: z.string().regex(SHA256_HEX),
  verifiedAt: safeInteger,
});
export type AskProofRecord = z.infer<typeof askProofRecordSchema>;

export const askProofChallengeSchema = z.strictObject({
  v: z.literal(1),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  digest: z.string().regex(SHA256_HEX),
  decision: z.literal("allow"),
  expiresAt: safeInteger.min(1),
});
export type AskProofChallenge = z.infer<typeof askProofChallengeSchema>;

/** Only the authenticated desktop companion may submit this body; unknown is a local timeout result, never an answer. */
export const askLiveBodySchema = z.strictObject({
  answers: z.array(z.discriminatedUnion("state", [
    z.strictObject({
      qid: z.string().regex(UUID_V4), deviceId: z.string().regex(DEVICE_ID), state: z.literal("live"),
      keyId: z.string().regex(KEY_ID), generation: safeInteger,
    }),
    z.strictObject({ qid: z.string().regex(UUID_V4), deviceId: z.string().regex(DEVICE_ID), state: z.literal("not-live") }),
  ])).min(1).max(64),
});
export type AskLiveBody = z.infer<typeof askLiveBodySchema>;

/** Body of the existing bootstrap token route. scope is optional and a missing scope means "jobs" (Part 1 bodies stay valid). */
export const tokenRequestSchema = z.strictObject({
  keyId: z.string().regex(KEY_ID),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: z.number().int().positive(),
  signature: z.string().regex(/^[A-Za-z0-9_-]{16,200}$/),
  scope: z.enum(["jobs", "ask"]).optional(),
});

export const TARGETS_RECENT_MAX = 8;
/** No message text anywhere in a targets answer. */
export const targetsAnswerSchema = z.strictObject({
  workspace: z.string().max(120),
  bots: z.array(z.strictObject({ id: text(128), name: text(120), avatar: z.string().nullable(), mainThreadId: text(128) })),
  recent: z.array(z.strictObject({ botId: text(128), threadId: text(128), title: z.string().max(200), at: z.number().int().nonnegative() })).max(TARGETS_RECENT_MAX),
});

export type ShareCode = "conflict" | "target_gone" | "too_large" | "unsupported_type" | "invalid" | "revoked";
export type AskCode = Exclude<ShareCode, "too_large" | "unsupported_type">;
export type ShareManifest = z.infer<typeof manifestSchema>;
export type AskRequest = z.infer<typeof askSchema>;
export type TargetsAnswer = z.infer<typeof targetsAnswerSchema>;
export type ShareAnswer = { state: "sent"; threadId: string; messageId?: string; queueId?: string } | { error: string; code: ShareCode };
export const askAnswerSchema = z.union([
  z.strictObject({ state: z.literal("sent"), askId: z.string().regex(ID_16_80), threadId: text(128), id: text(128), notify: z.boolean(), proven: z.boolean() }),
  z.strictObject({ state: z.literal("confirm"), deviceId: z.string().regex(DEVICE_ID), threadId: z.string().regex(DEVICE_ID), challenge: askProofChallengeSchema }),
  z.strictObject({ state: z.literal("plain") }),
  z.strictObject({ state: z.literal("proof_failed") }),
  z.strictObject({ error: z.string(), code: z.enum(["conflict", "target_gone", "invalid", "revoked"]) }),
]);
export type AskAnswer = z.infer<typeof askAnswerSchema>;
