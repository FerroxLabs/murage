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
}).strict();
export type B3Config = z.infer<typeof configSchema>;

export function b3Enabled(env: Env): boolean { return env.CLOUD_B3_MODE === "fake" || env.CLOUD_B3_MODE === "live"; }
export function b3Config(env: Env): B3Config {
  if (!b3Enabled(env)) throw new Error("b3_disabled");
  const config = configSchema.parse(JSON.parse(env.CLOUD_B3_CONFIG ?? "null"));
  if (new Set(config.capacity.map((slot) => slot.id)).size !== config.capacity.length) {
    throw new Error("b3_duplicate_capacity");
  }
  return config;
}
