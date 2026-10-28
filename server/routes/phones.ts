// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The phone job routes (S14, design 4.2 and 4.4): registration, the long poll, targeted reads, lease, decline, result, foreground,
// switch-off, and the companion's revoke and minted calls. The module owns no state: every dependency is injected, and the caller
// (server/index.ts) has already proved the phone's envelope (phoneCaller) and passes only the device id it yielded. A device id is
// never read from a body or a query.
//
// Revocation barrier (Astra AS2): after the caller is proved and before anything else, every /api/phones/self* handler of a barred
// device answers 403 { error: "revoked" }. DELETE /api/phones/self is the one exception (idempotent). Only POST /api/phones/minted ends it.
import { z } from "zod";
import { PHONE_ACTIONS, PHONE_TOOL_NAMES, RESULT_MAX_BYTES, type PhoneToolName } from "../../shared/phone-jobs-contract.ts";
import { locationPrecision, phoneTools, type PhoneApps } from "../../shared/phone-apps.ts";
import { PHONE_COPY } from "../../shared/phone-copy.ts";
import type { PhoneAuthorities } from "../phones/authority.ts";
import type { PhoneJobs } from "../phones/jobs.ts";
import type { PhoneRegistry, PhoneRevocations } from "../phones/registry.ts";
import type { AskRevocations } from "../phones/ask-revocations.ts";

export interface PhoneRouteDeps {
  registry: PhoneRegistry;
  revocations: PhoneRevocations;
  jobs: PhoneJobs;
  authorities: PhoneAuthorities;
  grant(botId: string): PhoneApps;
  /** Posts one activity row to the thread. The text names the action and the phone, never contents. */
  activity(threadId: string, text: string): void;
  /** Whether share and ask is offered right now (its own flag): an ask mint report is answered only then. */
  askOffered(): boolean;
}

export interface PhoneRouteRequest {
  method: string;
  /** url.pathname: the query string is not in it. */
  path: string;
  query: URLSearchParams;
  /** The device id phoneCaller proved from the door's phone envelope, or null when the caller is not the phone's own runner. */
  deviceId: string | null;
  /** The caller holds the companion's launch proof. */
  companion: boolean;
  /** The caller is the owner's desktop. */
  desktop: boolean;
  readBody(): Promise<unknown>;
  /** Aborted when the phone's connection closes. */
  signal: AbortSignal;
}

export interface PhoneRouteAnswer { status: number; body: unknown }

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const JOB = new RegExp(`^/api/phones/self/jobs/(${UUID})(?:/(lease|decline|result))?$`);
const EVENT_REF = /^[a-f0-9]{64}$/;
const DEVICE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const OFFER_ID = new RegExp(`^${UUID}$`);

const leaseBody = z.strictObject({ offerId: z.string().regex(OFFER_ID) });
const foregroundBody = z.strictObject({ active: z.boolean() });
const revokeBody = z.strictObject({ deviceId: z.string().regex(DEVICE_ID), reason: z.enum(["removed", "switch-off"]) });
const mintedBody = z.strictObject({ deviceId: z.string().regex(DEVICE_ID), scope: z.enum(["jobs", "ask"]).optional() });

const askRevokeBody = z.strictObject({ deviceId: z.string().regex(DEVICE_ID), through: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) });

const answer = (status: number, body: unknown): PhoneRouteAnswer => ({ status, body });
const REVOKED = answer(403, { error: "revoked" });
const NOT_RUNNER = answer(403, { error: "This route is for the phone's own runner." });

/** What the thread's activity row says per action, past tense (PHONE_COPY.did). The phone is named by kind; nothing the phone returned is in it. */

export function activityText(action: string, platform: "ios" | "android" | undefined): string {
  const phone = platform === "ios" ? PHONE_COPY.activity.iphone : platform === "android" ? PHONE_COPY.activity.android : PHONE_COPY.activity.other;
  return `${(PHONE_COPY.did as Record<string, string>)[action] ?? PHONE_COPY.activity.fallback}${PHONE_COPY.activity.on}${phone}`;
}

function toolOf(action: string): PhoneToolName | undefined {
  return PHONE_TOOL_NAMES.find((tool) => PHONE_ACTIONS[tool].action === action);
}

type Parsed<T> = { ok: true; value: T } | { ok: false; res: PhoneRouteAnswer };
async function bodyOf<T>(req: PhoneRouteRequest, schema: z.ZodType<T>): Promise<Parsed<T>> {
  let raw: unknown;
  try { raw = await req.readBody(); } catch (cause) {
    const status = (cause as { status?: unknown } | null)?.status;
    return { ok: false, res: answer(status === 413 ? 413 : 400, { error: status === 413 ? "That body is too large." : "That body could not be read." }) };
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, res: answer(400, { error: "That request could not be read." }) };
}

/** Answers a /api/phones request, or null when the path is not a phone route. The caller has already applied the offered gate. */
export async function phoneRoute(req: PhoneRouteRequest, deps: PhoneRouteDeps): Promise<PhoneRouteAnswer | null> {
  const { method, path } = req;

  if (path === "/api/phones") {
    if (method !== "GET") return answer(405, { error: "method not allowed" });
    if (!req.desktop) return answer(403, { error: "That belongs to the Murage app on this computer." });
    return answer(200, { phones: deps.registry.list() });
  }

  if (path === "/api/phones/revoke" || path === "/api/phones/minted") {
    if (method !== "POST") return answer(405, { error: "method not allowed" });
    if (!req.companion) return answer(403, { error: "That belongs to the Murage app on this computer." });
    if (path === "/api/phones/minted") {
      const body = await bodyOf(req, mintedBody);
      if (!body.ok) return body.res;
      // An ask mint belongs to the share and ask family: with that flag off it is not offered, however phoneTools is set.
      if (body.value.scope === "ask" && !deps.askOffered()) return answer(404, { error: "no such route" });
      // Only a jobs mint clears the jobs barrier. An ask mint has no barrier to clear: its refusal is the generation the door sends,
      // which only grows, so the new token (a higher generation) is accepted and every older one stays refused.
      if (body.value.scope !== "ask") deps.revocations.clear(body.value.deviceId);
      return answer(200, { ok: true });
    }
    const body = await bodyOf(req, revokeBody);
    if (!body.ok) return body.res;
    // Synchronously, before the answer: the jobs first (the bot hears it), then the registration and the bar in one transaction.
    const revoked = deps.jobs.revokeFor({ deviceId: body.value.deviceId });
    deps.registry.revoke(body.value.deviceId, body.value.reason);
    return answer(200, { revoked });
  }

  if (path !== "/api/phones/self" && !path.startsWith("/api/phones/self/")) return null;
  // Every /api/phones/self* route is the phone's own runner only.
  if (req.deviceId === null) return NOT_RUNNER;
  const deviceId = req.deviceId;

  if (path === "/api/phones/self" && method === "DELETE") {
    // The one route a barred device may call: switch-off is idempotent.
    deps.jobs.revokeFor({ deviceId });
    deps.registry.revoke(deviceId, "switch-off");
    return answer(200, { ok: true });
  }
  if (deps.revocations.barred(deviceId)) return REVOKED;

  if (path === "/api/phones/self") {
    if (method !== "PUT") return answer(405, { error: "method not allowed" });
    let raw: unknown;
    try { raw = await req.readBody(); } catch { return answer(400, { error: "That body could not be read." }); }
    const put = deps.registry.put(deviceId, raw);
    if (!put.ok) return answer(put.status, { error: put.error });
    // F7: capabilities the phone no longer reports end its open jobs for them.
    if (put.dropped.length > 0) deps.jobs.revokeFor({ deviceId, capabilities: put.dropped });
    return answer(200, { ok: true });
  }

  if (path === "/api/phones/self/jobs") {
    if (method !== "GET") return answer(405, { error: "method not allowed" });
    const eventRef = req.query.get("eventRef");
    if (eventRef !== null) {
      if (!EVENT_REF.test(eventRef)) return answer(400, { error: "That event reference could not be read." });
      return answer(200, deps.jobs.byEventRef(deviceId, eventRef));
    }
    const jobs = await deps.jobs.poll(deviceId, req.signal);
    // The device may have been revoked while it waited: the revoke answers the poll with nothing, and so does this.
    return answer(200, { jobs: deps.revocations.barred(deviceId) ? [] : jobs });
  }

  if (path === "/api/phones/self/foreground") {
    if (method !== "POST") return answer(405, { error: "method not allowed" });
    const body = await bodyOf(req, foregroundBody);
    if (!body.ok) return body.res;
    if (!body.value.active) deps.jobs.requeue(deviceId);
    return answer(200, { ok: true });
  }

  const job = JOB.exec(path);
  if (job) {
    const operationId = job[1]!;
    const verb = job[2];
    if (verb === undefined) {
      if (method !== "GET") return answer(405, { error: "method not allowed" });
      return answer(200, deps.jobs.byOperation(deviceId, operationId));
    }
    if (method !== "POST") return answer(405, { error: "method not allowed" });
    if (verb === "lease") {
      const body = await bodyOf(req, leaseBody);
      if (!body.ok) return body.res;
      return answer(200, deps.jobs.lease(deviceId, operationId, body.value.offerId, () => leaseHolds(deps, deviceId, operationId)));
    }
    if (verb === "decline") {
      const body = await bodyOf(req, leaseBody);
      if (!body.ok) return body.res;
      return deps.jobs.decline(deviceId, operationId, body.value.offerId) ? answer(200, { ok: true }) : answer(409, { error: "That job is not waiting for an answer." });
    }
    // result
    let raw: unknown;
    try { raw = await req.readBody(); } catch (cause) {
      return answer((cause as { status?: unknown } | null)?.status === 413 ? 413 : 400, { error: "That result could not be read." });
    }
    const before = deps.jobs.detail(deviceId, operationId);
    const status = deps.jobs.result(deviceId, operationId, raw);
    if (status !== 200) return answer(status, { error: status === 409 ? "That job is not waiting for a result." : status === 413 ? `That result is over ${RESULT_MAX_BYTES} bytes.` : "That result could not be read." });
    // A result that landed as DONE posts one activity row. A phone that answered with a refusal ends the job FAILED and posts nothing.
    const after = deps.jobs.byOperation(deviceId, operationId);
    if (before && "handled" in after && after.reason === "done") {
      try { deps.activity(before.authority.threadId, activityText(before.action, deps.registry.get(deviceId)?.platform)); } catch { /* the row is a courtesy; the bot has its result */ }
    }
    return answer(200, { ok: true });
  }

  return answer(404, { error: "no such route" });
}

/** The lease recheck: the cutoff reads the world once more. Every check must hold or the lease is refused and the bot hears it did not run. */
function leaseHolds(deps: PhoneRouteDeps, deviceId: string, operationId: string): boolean {
  if (deps.revocations.barred(deviceId)) return false;
  const job = deps.jobs.detail(deviceId, operationId);
  if (!job) return false;
  if (deps.authorities.live(job.authority.generation) === null) return false;
  const reg = deps.registry.get(deviceId);
  if (!reg) return false;
  const tool = toolOf(job.action);
  if (tool === undefined) return false;
  const grant = deps.grant(job.authority.botId);
  if (!phoneTools(grant, reg.capabilities).includes(tool)) return false;
  // a location job keeps the precision it was asked for only while the grant and the phone's current report still allow it
  if (tool === "phone_location_get") {
    const allowed = locationPrecision(grant, reg.capabilities);
    const asked = (job.args as { precision?: unknown } | null)?.precision;
    if (allowed === null || (asked !== "approximate" && asked !== "precise") || (asked === "precise" && allowed !== "precise")) return false;
  }
  return true;
}

/**
 * POST /api/phones/ask-revoke (S32): the companion door tells the harness the highest ask generation it refuses for a device.
 * Companion only. The door removes its queued entry only on a 200 carrying `ok: true`, so that is the one success answer; any
 * failure to read or to persist is a non-200 and the door keeps retrying. Applying is synchronous (it keeps the maximum), so it
 * cannot interleave with a commit section.
 */
export async function askRevokeRoute(req: { method: string; companion: boolean; readBody(): Promise<unknown> }, revocations: AskRevocations): Promise<PhoneRouteAnswer> {
  if (req.method !== "POST") return answer(405, { error: "method not allowed" });
  if (!req.companion) return answer(403, { error: "That belongs to the Murage app on this computer." });
  let raw: unknown;
  try { raw = await req.readBody(); } catch (cause) {
    const status = (cause as { status?: unknown } | null)?.status;
    return answer(status === 413 ? 413 : 400, { error: status === 413 ? "That body is too large." : "That body could not be read." });
  }
  const parsed = askRevokeBody.safeParse(raw);
  if (!parsed.success) return answer(400, { error: "That request could not be read." });
  try { revocations.apply(parsed.data.deviceId, parsed.data.through); } catch { return answer(500, { error: "That could not be saved." }); }
  return answer(200, { ok: true });
}

/**
 * POST /api/phones/minted when the jobs side is not offered (phoneTools off) but share and ask is: the door's report that it minted a
 * token. Only an ask mint is the ask family's to answer (it has no barrier to clear, so the answer is the whole job); a jobs mint, or one
 * naming no scope, belongs to the jobs side and is absent here. Without this the door reads a 404 as "not offered" and drops the new token.
 */
export async function askMintedRoute(req: { method: string; companion: boolean; readBody(): Promise<unknown> }): Promise<PhoneRouteAnswer> {
  if (req.method !== "POST") return answer(405, { error: "method not allowed" });
  if (!req.companion) return answer(403, { error: "That belongs to the Murage app on this computer." });
  let raw: unknown;
  try { raw = await req.readBody(); } catch (cause) {
    const status = (cause as { status?: unknown } | null)?.status;
    return answer(status === 413 ? 413 : 400, { error: status === 413 ? "That body is too large." : "That body could not be read." });
  }
  const parsed = mintedBody.safeParse(raw);
  if (!parsed.success) return answer(400, { error: "That request could not be read." });
  if (parsed.data.scope !== "ask") return answer(404, { error: "no such route" });
  return answer(200, { ok: true });
}
