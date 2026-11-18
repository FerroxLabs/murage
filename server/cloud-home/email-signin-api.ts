// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";
import { cloudHomeCopy } from "./copy.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { cloudIdentity, isOwnerBrowser } from "../cloud-request-identity.ts";

const BASE = "/api/email/owner-signin";
type Actor = { environmentId: string; deviceId: string };
export type CloudEmailSigninWireRequest = { type: "murage:email-owner-signin-start"; requestId: string; actor: Actor; gen: number }
  | { type: "murage:email-owner-unlink"; requestId: string }
  | { type: "murage:email-owner-session-end"; deviceId?: string };
type Result = { requestId: string; state: string; userCode?: string; verificationUrl?: string };
/** Public state contains a code only. Tokens travel through the sealed owner channel. */
export function createCloudEmailSignin(options: {
  available(): boolean; connected?(): boolean; ttlMs(): number; gen(): number; environmentId: string; activeDevice(id: string): boolean;
  send(message: CloudEmailSigninWireRequest): boolean; readBody(req: IncomingMessage, max: number): Promise<unknown>;
  now?: () => number;
}) {
  const now = options.now ?? (() => performance.now());
  let attempt: { actor: Actor; expires: number; result: Result } | undefined;
  const invalidate = (deviceId?: string) => {
    if (deviceId && attempt?.actor.deviceId !== deviceId) return;
    attempt = undefined;
    options.send({ type: "murage:email-owner-session-end", ...(deviceId ? { deviceId } : {}) });
  };
  const reply = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "cache-control": "no-store", "content-type": "application/json" }); res.end(JSON.stringify(body));
  };
  return {
    invalidate,
    receive(message: unknown): boolean {
      if (!message || typeof message !== "object" || !["murage:email-owner-signin-result", "murage:email-owner-unlink-result"].includes(String((message as { type?: unknown }).type))) return false;
      const value = message as Record<string, unknown>;
      if (!attempt || value.requestId !== attempt.result.requestId || now() >= attempt.expires) return true;
      if (!["code", "done", "saving", "denied", "expired", "unavailable", "owner_busy", "disconnecting", "unlinked", "none", "replaced"].includes(String(value.state))) return true;
      if (value.state === "code") {
        if (typeof value.userCode !== "string" || !value.userCode || value.userCode.length > 64 || typeof value.verificationUrl !== "string") return true;
        try { const url = new URL(value.verificationUrl); if (url.protocol !== "https:" || url.username || url.password) return true; } catch { return true; }
        attempt.result = { requestId: attempt.result.requestId, state: "code", userCode: value.userCode, verificationUrl: value.verificationUrl };
      } else attempt.result = { requestId: attempt.result.requestId, state: String(value.state) };
      return true;
    },
    async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
      if (!(url.pathname === BASE || url.pathname.startsWith(`${BASE}/`))) return false;
      const device = cloudIdentity(req.headers);
      const current = () => device && !device.revoked && (["owner-desktop", "owner-phone"].includes(device.scope) || isOwnerBrowser(device)) && options.activeDevice(device.id);
      if (!current()) { reply(res, 403, { error: cloudHomeCopy.emailSigninOwnerRequired }); return true; }
      if (url.search) { reply(res, 400, { error: cloudHomeCopy.emailSigninRequestRefused }); return true; }
      if (req.method === "GET" && url.pathname === BASE) {
        const ttlMs = options.available() ? options.ttlMs() : 0;
        reply(res, 200, { available: ttlMs > 0, ttlMs, ...(options.connected ? { connected: options.connected() } : {}) }); return true;
      }
      if (req.method === "GET" && url.pathname.startsWith(`${BASE}/attempts/`)) {
        const id = url.pathname.slice(`${BASE}/attempts/`.length);
        if (!attempt || attempt.actor.deviceId !== device!.id || attempt.result.requestId !== id || now() >= attempt.expires) reply(res, 404, { error: cloudHomeCopy.emailSigninExpired });
        else reply(res, 200, attempt.result);
        return true;
      }
      if (req.method !== "POST" || ![`${BASE}/start`, `${BASE}/sign-out`].includes(url.pathname)) { reply(res, 404, { error: cloudHomeCopy.emailSigninNotFound }); return true; }
      const body = await options.readBody(req, 1024);
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) { reply(res, 400, { error: cloudHomeCopy.emailSigninRequestRefused }); return true; }
      const unlink = url.pathname === `${BASE}/sign-out`;
      if (!current()) { reply(res, 403, { error: cloudHomeCopy.emailSigninOwnerRequired }); return true; }
      if (attempt && now() < attempt.expires && ["waiting", "code", "saving", "disconnecting"].includes(attempt.result.state)) { reply(res, 409, { error: cloudHomeCopy.emailRequestInProgress }); return true; }
      if (unlink ? !options.connected?.() : !options.available()) {
        reply(res, unlink ? 409 : 404, { error: unlink ? cloudHomeCopy.emailNotConnected : cloudHomeCopy.emailSigninUnavailable }); return true;
      }
      const actor = { environmentId: options.environmentId, deviceId: device!.id }, requestId = randomUUID();
      attempt = { actor, expires: now() + 600_000, result: { requestId, state: unlink ? "disconnecting" : "waiting" } };
      if (!options.send(unlink ? { type: "murage:email-owner-unlink", requestId } : { type: "murage:email-owner-signin-start", requestId, actor, gen: options.gen() })) { attempt = undefined; reply(res, 503, { error: cloudHomeCopy.emailSigninUnavailable }); return true; }
      reply(res, 202, attempt.result); return true;
    },
  };
}
