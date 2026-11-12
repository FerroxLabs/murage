// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The home's signed call to the control plane (WIRE: home <-> control plane).
// POST ${MURAGE_CLOUD_ADMIN_URL}/v1/homes/${MURAGE_CLOUD_MACHINE_ID}/home/<op>, the body signed with the bootstrap secret:
// x-murage-home-signature = HMAC-SHA256(secret, "murage-home-to-cp-v1\n" + exact body bytes), hex. Any failure is "unavailable":
// a caller never treats a missing answer as a yes. The secret never leaves this file except as the signature.
import { createHmac, randomBytes } from "node:crypto";

export const CP_SIGNATURE_DOMAIN = "murage-home-to-cp-v1\n";
export const CP_USER_AGENT = "murage-home/1 (cp-client)";
const MAX_ANSWER_BYTES = 64 * 1024;

export interface CpCallOptions {
  /** Default 8000 ms. */
  timeoutMs?: number;
  /** Injected in tests. */
  fetch?: typeof fetch;
  adminUrl?: string;
  homeId?: string;
  /** The bootstrap secret, from the same accessor the server hands options.bootstrapSecret. */
  secret?: () => string | undefined;
  /** The pinned generation, or null when the home has none. */
  generation?: () => number | null | undefined;
  now?: () => number;
  nonce?: () => string;
}

/** ok: the control plane answered 2xx. Otherwise `status` is its HTTP status, or 0 for a network error, timeout or bad setup. */
export type CpResult = { ok: true; status: number; body: unknown } | { ok: false; status: number; body?: unknown };

let defaults: Pick<CpCallOptions, "secret" | "generation"> = {};
/** The server sets these once at boot (the secret and the pinned generation); a call's own options win. */
export function setCpCallDefaults(next: Pick<CpCallOptions, "secret" | "generation">): void { defaults = { ...next }; }

export function cpSignature(secret: string, body: string): string {
  return createHmac("sha256", secret).update(CP_SIGNATURE_DOMAIN + body).digest("hex");
}

export async function cpCall(op: string, fields: Record<string, unknown> = {}, opts: CpCallOptions = {}): Promise<CpResult> {
  const unavailable: CpResult = { ok: false, status: 0 };
  try {
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(op)) return unavailable;
    const adminUrl = (opts.adminUrl ?? process.env.MURAGE_CLOUD_ADMIN_URL ?? "").replace(/\/+$/, "");
    const homeId = opts.homeId ?? process.env.MURAGE_CLOUD_MACHINE_ID ?? "";
    const secret = (opts.secret ?? defaults.secret)?.();
    if (!adminUrl.startsWith("https://") || !/^[A-Za-z0-9_-]{1,128}$/.test(homeId) || !secret) return unavailable;
    const generation = (opts.generation ?? defaults.generation)?.() ?? null;
    const body = JSON.stringify({
      ...fields,
      operation: op,
      timestamp: Math.floor((opts.now?.() ?? Date.now()) / 1000),
      nonce: opts.nonce?.() ?? randomBytes(18).toString("base64url"),
      generation,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
    try {
      const response = await (opts.fetch ?? fetch)(`${adminUrl}/v1/homes/${encodeURIComponent(homeId)}/home/${op}`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": CP_USER_AGENT, "x-murage-home-signature": cpSignature(secret, body) },
        body,
        redirect: "error",
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed: unknown;
      if (text.length <= MAX_ANSWER_BYTES) { try { parsed = JSON.parse(text); } catch { parsed = undefined; } }
      return response.ok ? { ok: true, status: response.status, body: parsed } : { ok: false, status: response.status, body: parsed };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return unavailable;
  }
}
