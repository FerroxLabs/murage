// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// GH18-RULING-1019 C1-C3. Browser-safe shared wire contract; no authority or mutation here.
import { z } from "zod";

export const GH18_POLICY_VERSION = "gh18-fresh-start-v2";
export const GH18_FRESH_START_BASE_PATH = "/api/memory/bots/:botId/fresh-start";
export const GH18_PREVIEW_TTL_MS = 120_000;
export const GH18_MAX_BODY_BYTES = 2_048;
export const GH18_MAX_CANDIDATES = 5_000;
export const GH18_RETAINED_SCAN_LIMIT = 5_001;

export const GH18_BLOCKED_REASONS = [
  "deletion-pending", "bot-busy", "lineage-unready", "limit-exceeded", "unsupported-schema", "policy-unavailable",
] as const;
export const GH18_REASONS = ["no-change", "cursor-save-pending", ...GH18_BLOCKED_REASONS] as const;
export type GH18Reason = (typeof GH18_REASONS)[number];

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const candidateCount = count.max(GH18_MAX_CANDIDATES);
const id = z.string().min(1);
const previewToken = z.string().min(1).refine(value => new TextEncoder().encode(value).byteLength <= 512, "token exceeds 512 bytes");

/** POST /preview. Body byte limits and HTTP owner/step-up gates are enforced by S2. */
export const freshStartPreviewRequestSchema = z.strictObject({});
/** POST /confirm. Tokens are opaque; validating their shape does not authorize their use. */
export const freshStartConfirmRequestSchema = z.strictObject({
  previewToken,
  confirm: z.literal(true),
  idempotencyKey: z.string().min(16).max(128).regex(/^[\x00-\x7f]+$/),
});

const common = {
  policyVersion: z.literal(GH18_POLICY_VERSION),
  botId: id,
  // LIMIT 5001 is a sentinel, not an exact count of arbitrarily large retained sets.
  retainedBlocks: count.max(GH18_RETAINED_SCAN_LIMIT),
  retainedCapped: z.boolean(),
};
const previewFields = {
  ...common,
  botName: z.string(),
  staleBlocks: candidateCount,
  freshSessions: count,
  previewToken,
  /** Unix epoch milliseconds. TTL/binding checks belong to the authenticated handler. */
  expiresAt: count,
};
const outcomeFields = {
  ...common,
  operationId: id,
  clearedBlocks: candidateCount,
  freshSessions: count,
  visibilityChanged: z.literal(false),
};
const retainedConsistent = (value: { retainedBlocks: number; retainedCapped: boolean }) =>
  value.retainedCapped === (value.retainedBlocks > GH18_MAX_CANDIDATES);

/** Reason is null for ready/done; no-change is reserved for a complete nothing-to-do check. */
export const freshStartPreviewSchema = z.discriminatedUnion("state", [
  z.strictObject({ ...previewFields, state: z.literal("ready"), reason: z.null() }),
  z.strictObject({ ...previewFields, state: z.literal("nothing-to-do"), reason: z.literal("no-change"), staleBlocks: z.literal(0), freshSessions: z.literal(0) }),
  z.strictObject({ ...previewFields, state: z.literal("blocked"), reason: z.enum(GH18_BLOCKED_REASONS) }),
]).refine(retainedConsistent, "retained count/cap mismatch")
  .refine(value => value.state !== "ready" || value.staleBlocks > 0 || value.freshSessions > 0, "ready requires work");

/** POST /confirm and GET /operations/:id share this exact durable outcome. No content/row/cursor payloads. */
export const freshStartOutcomeSchema = z.discriminatedUnion("state", [
  z.strictObject({ ...outcomeFields, state: z.literal("done"), reason: z.null() }),
  z.strictObject({ ...outcomeFields, state: z.literal("applying"), reason: z.literal("cursor-save-pending") }),
  z.strictObject({ ...outcomeFields, state: z.literal("nothing-to-do"), reason: z.literal("no-change"), clearedBlocks: z.literal(0), freshSessions: z.literal(0) }),
  z.strictObject({ ...outcomeFields, state: z.literal("blocked"), reason: z.enum(GH18_BLOCKED_REASONS), clearedBlocks: z.literal(0), freshSessions: z.literal(0) }),
]).refine(retainedConsistent, "retained count/cap mismatch")
  .refine(value => (value.state !== "done" && value.state !== "applying") || value.clearedBlocks > 0 || value.freshSessions > 0, "done requires a change");

export type FreshStartPreviewRequest = z.infer<typeof freshStartPreviewRequestSchema>;
export type FreshStartConfirmRequest = z.infer<typeof freshStartConfirmRequestSchema>;
export type FreshStartPreview = z.infer<typeof freshStartPreviewSchema>;
export type FreshStartOutcome = z.infer<typeof freshStartOutcomeSchema>;

/** C3 identity/copy only: S3 owns registration, navigation, rendering and locale integration. */
export const GH18_SETTINGS = {
  id: "bot.memory.clear-revoked-marks",
  anchor: "bot-setting-clear-revoked-marks",
  dataSetting: "bot.memory.clear-revoked-marks",
  address: "murage://settings/bot/<encodedBotId>/memory/clear-revoked-marks",
  kind: "action", persistent: false, advanced: true, surface: "desktop",
  label: "Start fresh for this bot",
  technicalHelp: "clear revoked marks for this bot",
  confirmTitle: "Start fresh for {botName}?",
  consequence: "New conversations start clean. Deleted and withdrawn information stays hidden.",
  done: "{botName} starts fresh in {freshSessions} chats. Cleared {clearedBlocks} old blocks. Deleted and withdrawn information stays hidden.",
  nothingToDo: "{botName} already starts fresh.",
} as const;
