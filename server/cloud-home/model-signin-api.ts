// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { cloudIdentity, isOwnerBrowser } from "../cloud-request-identity.ts";
import { cloudHomeCopy } from "./copy.ts";
import { HomeSignInError, type HomeSignInProvider, type HomeSignInRequest } from "./model-signin.ts";

/** B2: a cloud home signs engines in through each vendor's own CLI (engine-login.ts),
 * so these routes are not mounted there. The code stays for the desktop-side clients
 * and tests; flip this only with an Opus-gated decision. */
export const cloudModelSignInMounted = (): boolean => false;

type Options = {
  environmentId: string;
  activeDevice(id: string): boolean;
  invoke(request: HomeSignInRequest): Promise<unknown>;
  invalidateOwner(deviceId: string): void;
  removeConnection?(provider: HomeSignInProvider): Promise<void>;
  readBody(req: IncomingMessage, max: number): Promise<unknown>;
};
const providerSchema = z.enum(["chatgpt", "supergrok"]);
const boundedText = (max: number) => z.string().min(1).max(max).regex(/^[^\x00-\x1f\x7f]+$/);
const attemptIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const errorSchema = z.enum(["cancelled", "timeout", "disabled", "storage", "unauthorized", "offline", "unavailable"]);
const emptyBody = z.object({}).strict();
const accountFields = { email: boundedText(320).optional(), plan: boundedText(40).optional() };
const statusSchema = z.object({ providers: z.array(z.object({
  provider: providerSchema, enabled: z.boolean(), state: z.enum(["waiting", "connected", "needs-sign-in", "signed-out"]),
  acceptsCode: z.boolean(), ...accountFields,
}).strict()).length(2).refine(rows => new Set(rows.map(row => row.provider)).size === 2) }).strict();
const attemptFields = { attemptId: attemptIdSchema, provider: providerSchema };
const challengeSchema = z.object({ ...attemptFields, state: z.literal("waiting"), verificationUrl: boundedText(4096), userCode: boundedText(128), expiresAt: z.number().finite().positive(), }).strict().refine(value => {
  try {
    const url = new URL(value.verificationUrl);
    return value.provider === "chatgpt" ? value.verificationUrl === "https://auth.openai.com/codex/device"
      : url.protocol === "https:" && ["auth.x.ai", "accounts.x.ai"].includes(url.hostname) && !url.port && !url.username && !url.password && !url.hash;
  } catch { return false; }
});
const attemptSchema = z.union([challengeSchema,
  z.object({ ...attemptFields, state: z.literal("waiting") }).strict(),
  z.object({ ...attemptFields, state: z.enum(["connected", "failed", "cancelled"]), ...accountFields, errorCode: errorSchema.optional() }).strict(),
]);
const errorStatuses: Record<string, number> = { "invalid-request": 400, unauthorized: 403, "not-found": 404, cancelled: 409, "rate-limited": 429, busy: 429, timeout: 504, disabled: 503, storage: 503, offline: 503, unavailable: 503 };
function reply(res: ServerResponse, status: number, body?: unknown) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "cache-control": "no-store", ...(body === undefined ? {} : { "content-type": "application/json" }) });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}
/** Called after createCloudRequestAuth has verified the real body-bound factor. */
export function createCloudModelSignInApi(options: Options) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const base = "/api/cloud/model-signins", path = url.pathname, method = req.method ?? "GET";
    if (!(path === base || path.startsWith(`${base}/`))) return false;
    const identity = cloudIdentity(req.headers);
    const current = () => identity && !identity.revoked && (["owner-desktop", "owner-phone"].includes(identity.scope) || isOwnerBrowser(identity)) && options.activeDevice(identity.id);
    if (!current()) { reply(res, 403, { code: "unauthorized", error: cloudHomeCopy.pairedDeviceRequired }); return true; }
    let match: RegExpExecArray | null = null;
    let operation: HomeSignInRequest["operation"] | undefined, attemptId: string | undefined;
    if (method === "GET" && path === "/api/cloud/model-signins") operation = "status";
    else if (method === "POST" && (match = /^\/api\/cloud\/model-signins\/(chatgpt|supergrok)\/start$/.exec(path))) operation = "start";
    else if (method === "POST" && (match = /^\/api\/cloud\/model-signins\/(chatgpt|supergrok)\/sign-out$/.exec(path))) operation = "signOut";
    else if (method === "GET" && (match = /^\/api\/cloud\/model-signins\/(chatgpt|supergrok)\/attempts\/([A-Za-z0-9_-]{1,200})$/.exec(path))) { operation = "attempt"; attemptId = match[2]; }
    else if (method === "POST" && (match = /^\/api\/cloud\/model-signins\/(chatgpt|supergrok)\/attempts\/([A-Za-z0-9_-]{1,200})\/cancel$/.exec(path))) { operation = "cancel"; attemptId = match[2]; }
    else if (method === "DELETE" && (match = /^\/api\/cloud\/model-signins\/(chatgpt|supergrok)$/.exec(path))) operation = "remove";
    const provider = match?.[1] as HomeSignInProvider | undefined;
    if (!operation || url.search) { reply(res, 400, { code: "invalid-request", error: cloudHomeCopy.signInRequestRefused }); return true; }
    const deviceId = identity!.id;
    let invalidated = false;
    const invalidate = () => { if (!invalidated) { invalidated = true; options.invalidateOwner(deviceId); } };
    const finish = () => { res.off("close", close); };
    const close = () => { res.off("finish", finish); if (!res.writableFinished) invalidate(); };
    res.once("close", close);
    res.once("finish", finish);
    try {
      if (!["status", "attempt"].includes(operation) && !emptyBody.safeParse(await options.readBody(req, 1024)).success) throw new HomeSignInError("invalid-request");
      if (!current() || res.destroyed) { invalidate(); throw new HomeSignInError("unauthorized"); }
      const result = await options.invoke({ operation, ...(provider ? { provider } : {}), ...(attemptId ? { attemptId } : {}), actor: { environmentId: options.environmentId, deviceId } });
      if (!current() || res.destroyed) { invalidate(); throw new HomeSignInError("unauthorized"); }
      const schema = operation === "status" ? statusSchema : operation === "start" ? challengeSchema : operation === "attempt" ? attemptSchema : z.null();
      const parsed = schema.safeParse(result);
      if (!parsed.success) throw new HomeSignInError("unavailable");
      if ((operation === "start" || operation === "attempt") && (!parsed.data || !("provider" in parsed.data) || parsed.data.provider !== provider || (operation === "attempt" && (!("attemptId" in parsed.data) || parsed.data.attemptId !== attemptId)))) throw new HomeSignInError("unavailable");
      if (operation === "remove") await options.removeConnection?.(provider!);
      if (!current() || res.destroyed) { invalidate(); throw new HomeSignInError("unauthorized"); }
      reply(res, operation === "start" ? 202 : ["status", "attempt"].includes(operation) ? 200 : 204, ["status", "start", "attempt"].includes(operation) ? parsed.data : undefined);
    } catch (error) {
      const code = error instanceof HomeSignInError && Object.hasOwn(errorStatuses, error.code) ? error.code : "unavailable";
      reply(res, errorStatuses[code]!, { code, error: cloudHomeCopy.signInRequestRefused });
    }
    return true;
  };
}
