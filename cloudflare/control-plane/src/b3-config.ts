// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

declare global {
  interface Env {
    CLOUD_B3_MODE?: string;
    CLOUD_B3_CONFIG?: string;
    CLOUD_B3_SIGNING_JWK?: string;
  }
  namespace Cloudflare {
    interface Env {
      CLOUD_B3_MODE?: string;
      CLOUD_B3_CONFIG?: string;
      CLOUD_B3_SIGNING_JWK?: string;
    }
  }
}

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
/** The most slots one capacity block may stand for: the seeding CTE recurses once per slot, kept within SQLite's 1000-level limit. */
export const MAX_BLOCK_SLOTS = 1000;
const gates = z.object({
  claudeAgent: z.boolean(), codex: z.boolean(), grokAgent: z.boolean(),
  kimiAgent: z.boolean(), opencodeGo: z.boolean(),
}).strict();
const configSchema = z.object({
  reservationMs: z.number().int().min(60_000).max(30 * 60_000),
  graceMs: z.number().int().min(0).max(90 * 86_400_000),
  retentionMs: z.number().int().min(0).max(365 * 86_400_000),
  imageDigest: digest,
  engineSubscriptionGates: gates,
  quarantineRelayIP: z.ipv4(),
  capacity: z.array(z.object({
    id: z.string().regex(/^[\w-]{1,128}$/), projectId: z.string().regex(/^[\w-]{1,128}$/),
    location: z.enum(["fsn1", "nbg1", "hel1"]), serverType: z.string().regex(/^[\w-]{1,64}$/),
    outcome: z.enum(["available", "412", "503", "failed_allocation"]),
  }).strict()).max(100),
  // Admission slots in bulk: block {prefix, count} stands for the slots <prefix>-1 .. <prefix>-<count>, each with the block's fields. A
  // Worker text var holds at most ~5 kB, so a launch-size fleet (hundreds of slots) cannot be listed row by row.
  capacityBlocks: z.array(z.object({
    prefix: z.string().regex(/^[a-z][a-z0-9]{0,15}$/), count: z.number().int().min(1).max(MAX_BLOCK_SLOTS),
    projectId: z.string().regex(/^[\w-]{1,128}$/), location: z.enum(["fsn1", "nbg1", "hel1"]), serverType: z.string().regex(/^[\w-]{1,64}$/),
    outcome: z.enum(["available", "412", "503", "failed_allocation"]),
  }).strict()).max(10).optional(),
}).strict();
export type B3Config = z.infer<typeof configSchema>;

export function b3Enabled(env: Env): boolean { return env.CLOUD_B3_MODE === "fake" || env.CLOUD_B3_MODE === "live"; }
export function b3Config(env: Env): B3Config {
  if (!b3Enabled(env)) throw new Error("b3_disabled");
  const config = configSchema.parse(JSON.parse(env.CLOUD_B3_CONFIG ?? "null"));
  const ids = capacitySlotIds(config);
  if (new Set(ids).size !== ids.length) throw new Error("b3_duplicate_capacity");
  return config;
}
/** Every admission slot id the config defines: the listed rows, then each block's <prefix>-1 .. <prefix>-<count>. */
export function capacitySlotIds(config: Pick<B3Config, "capacity" | "capacityBlocks">): string[] {
  const ids = config.capacity.map((slot) => slot.id);
  for (const b of config.capacityBlocks ?? []) for (let i = 1; i <= b.count; i += 1) ids.push(`${b.prefix}-${i}`);
  return ids;
}
