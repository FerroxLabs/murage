import { z } from "zod";

import { botAvatarCropSchema, botAvatarUrlSchema } from "../shared/bot-avatar.ts";
import { BOT_PROFILE_LIMITS } from "../shared/bot-profile.ts";

import type { BotRecord } from "./store.ts";

export const BOT_PROFILE_PATCH_FIELDS = [
  "name",
  "title",
  "description",
  "persona",
  "notifications",
  "avatarUrl",
  "avatarCrop",
  "voice",
  "speakReplies",
] as const;

const profilePatchSchema = z.object({
  name: z
    .string({ error: "name must be a string" })
    .max(BOT_PROFILE_LIMITS.name, { error: "name must be at most 100 characters" })
    .refine((value) => Boolean(value.trim()), { error: "name must not be empty" })
    .optional(),
  title: z
    .string({ error: "title must be a string" })
    .max(BOT_PROFILE_LIMITS.title, { error: "title must be at most 200 characters" })
    .optional(),
  description: z
    .string({ error: "description must be a string" })
    .max(BOT_PROFILE_LIMITS.description, { error: "description must be at most 4000 characters" })
    .optional(),
  // The voice note. Deliberately the SHORTEST profile field: it is appended
  // to the persona string on every turn and read by nothing that routes,
  // draws or publishes this bot, so a brief written here would never be seen
  // by the Chief deciding who does the work.
  persona: z
    .string({ error: "persona must be a string" })
    .max(BOT_PROFILE_LIMITS.persona, { error: "persona must be at most 280 characters" })
    .optional(),
  notifications: z.boolean({ error: "notifications must be true or false" }).optional(),
  avatarUrl: z
    .union([botAvatarUrlSchema, z.literal(""), z.null()], {
      error: "avatarUrl must be a stored PNG, JPEG, GIF, or WebP attachment",
    })
    .optional(),
  avatarCrop: botAvatarCropSchema.optional(),
  voice: z
    .string({ error: "voice must be a string" })
    .max(BOT_PROFILE_LIMITS.voice, { error: "voice must be at most 200 characters" })
    .optional(),
  speakReplies: z.boolean({ error: "speakReplies must be true or false" }).optional(),
});

export type BotProfilePatchInput = z.input<typeof profilePatchSchema>;

export type BotProfilePatch = Partial<
  Pick<
    BotRecord,
    | "name"
    | "title"
    | "description"
    | "persona"
    | "notifications"
    | "avatarUrl"
    | "avatarCrop"
    | "voice"
    | "speakReplies"
  >
>;

export type BotProfilePatchResult =
  | { ok: true; patch: BotProfilePatch }
  | { ok: false; error: string };

/**
 * The shared validation boundary for profile fields. The desktop's broad bot
 * PATCH passes strict=false; paired clients use strict=true so a future bot
 * field cannot silently become remotely writable.
 *
 * avatarUrl deliberately uses `undefined` as the normalized clear value.
 * Store persistence already omits undefined fields, while wireBot sends null
 * back to clients so Codable and object-spread clients both clear stale data.
 */
export function parseBotProfilePatch(input: BotProfilePatchInput, strict = false): BotProfilePatchResult {
  const parsed = (strict ? profilePatchSchema.strict() : profilePatchSchema).safeParse(input);
  if (!parsed.success) {
    const unsupported = parsed.error.issues.find((issue) => issue.code === "unrecognized_keys");
    if (unsupported?.code === "unrecognized_keys") {
      return { ok: false, error: `unsupported profile field: ${unsupported.keys[0] ?? "unknown"}` };
    }
    const issue = parsed.error.issues[0];
    if (issue?.path[0] === "avatarCrop") {
      return { ok: false, error: "avatarCrop must be mascot, circle, rounded, or square" };
    }
    return { ok: false, error: issue?.message ?? "invalid profile patch" };
  }

  const { avatarUrl, persona, ...fields } = parsed.data;
  const patch: BotProfilePatch = fields;
  if (avatarUrl !== undefined) patch.avatarUrl = avatarUrl || undefined;
  // Same clear-value rule as avatarUrl: absent, never an empty string. A
  // cleared voice note must leave no `Personality:` line on the next turn.
  if (persona !== undefined) patch.persona = persona.trim() || undefined;
  return { ok: true, patch };
}
