// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HomeSignInError, type HomeSignInRequest } from "./model-signin.ts";

export type CloudModelSignInWireRequest = ({ type: "murage:cloud-model-signin-request"; requestId: string } & HomeSignInRequest)
  | { type: "murage:cloud-model-signin-cancel-owner"; all: boolean; deviceId?: string }
  | { type: "murage:cloud-model-signin-ready" };
const text = z.string().min(1).max(200).regex(/^[^\x00-\x1f\x7f]+$/);
export const cloudModelRequest = z.object({
  type: z.literal("murage:cloud-model-signin-request"), requestId: z.string().uuid(),
  operation: z.enum(["status", "start", "attempt", "cancel", "signOut", "remove"]),
  provider: z.enum(["chatgpt", "supergrok"]).optional(), attemptId: text.optional(),
  actor: z.object({ environmentId: text, deviceId: text }).strict(),
}).strict().refine(value => value.operation === "status" ? !value.provider && !value.attemptId
  : Boolean(value.provider) && (["attempt", "cancel"].includes(value.operation) ? Boolean(value.attemptId) : !value.attemptId));
export const cloudModelCancel = z.object({ type: z.literal("murage:cloud-model-signin-cancel-owner"), all: z.boolean(), deviceId: text.optional() }).strict()
  .refine(value => value.all || Boolean(value.deviceId));

/** Only correlation is handled here; the HTTP helper validates public results. */
export function createCloudModelSignInClient(send: (message: CloudModelSignInWireRequest) => void) {
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let disposed = false;
  return {
    request(request: HomeSignInRequest): Promise<unknown> {
      if (disposed) return Promise.reject(new HomeSignInError("unavailable"));
      const requestId = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(new HomeSignInError("unavailable")); }, 15_000);
        pending.set(requestId, { resolve, reject, timer });
        try { send({ type: "murage:cloud-model-signin-request", requestId, ...request }); }
        catch { clearTimeout(timer); pending.delete(requestId); reject(new HomeSignInError("unavailable")); }
      });
    },
    receive(message: unknown): boolean {
      if (!message || typeof message !== "object" || (message as {type?:unknown}).type !== "murage:cloud-model-signin-result") return false;
      const value = message as { requestId?: unknown; ok?: unknown; result?: unknown; errorCode?: unknown };
      if (typeof value.requestId !== "string" || typeof value.ok !== "boolean") return true;
      const item = pending.get(value.requestId); if (!item) return true;
      clearTimeout(item.timer); pending.delete(value.requestId);
      if (value.ok) item.resolve(value.result);
      else {
        const code = ["unauthorized", "not-found", "rate-limited", "busy", "invalid-request", "cancelled", "timeout", "disabled", "storage", "offline"].includes(String(value.errorCode)) ? String(value.errorCode) : "unavailable";
        item.reject(new HomeSignInError(code));
      }
      return true;
    },
    invalidate(deviceId?: string) { if (!disposed) { try { send({ type: "murage:cloud-model-signin-cancel-owner", all: !deviceId, ...(deviceId ? { deviceId } : {}) }); } catch { /* Disconnect already cancels that server generation. */ } } },
    dispose() { disposed = true; for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new HomeSignInError("unavailable")); } pending.clear(); },
  };
}
