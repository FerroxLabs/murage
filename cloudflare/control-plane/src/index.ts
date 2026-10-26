import { z } from "zod";
import { FLUX_LEDGER_ROUTE, fluxCapStepUpExempt, fluxOffStubRoute, fluxRoute, sweepFlux, type FluxDependencies } from "./b4-flux";
import { fluxRoutesEnabled, isFluxPath } from "./b4-flux-config";
import { cloudMachineRoute, sweepCloudRetention } from "./cloud-machines";
import { b3Route, isHeartbeatRequest, reconcileB3, type B3Dependencies } from "./b3-control";
import { b3Enabled } from "./b3-config";
import { billingRoute, stripeWebhook, stubFluxHooks, sweepBilling, sweepCustomerWaiting, type BillingDependencies } from "./b5-billing";
import { legalRoute, topupStepUpExempt } from "./legal-routes";
import { cp0ControlRoute } from "./cp0-control";
import { machineEndpointRoute } from "./machine-endpoints";
import { edgeGate } from "./edge-limits";
import { pairingRoute, type PairingDependencies } from "./pairing";
import { homesRoute } from "./homes";
import { devicesRoute } from "./devices";
import { DOOR_HANDING_OUT, doorRoute, handOutDoorTicket, sweepDoorNotices } from "./door";
import { trustedFactorRoute } from "./trusted-factors";
import { sweepMonitoring } from "./ops-monitor";
import { rolloutRoute, sweepRollout } from "./rollout";
import { accountTwoFactorRoute } from "./account-2fa";
import { admin } from "./b3-control";
import { boundCustomer, carryBinding, createIdentity, DOOR_ROUTE, doorRecentProofAt, isFluxCapChange, isFluxOwnerPath, isTopupChange, needsStepUp, stepUpProofValid, type Identity, type IdentityDependencies } from "./customer-identity";
import { completeStepUpRefusal, CONSUMED_HEADER, prepareStepUp, recordOutcome, stepUpEmailRoute, stepUpRefusal, sweepStepUpEmail, type Prepared } from "./step-up-email";
import { membersRoute, sweepPlanResizes } from "./members-api";
import { isPurchaseRoute, purchaseBootstrap, stepUpRefused } from "./purchase-bootstrap";
import { exportDownload, selfServiceMachineRoute, selfServiceRoute, sweepSelfService, type SelfServiceDependencies } from "./self-service";
import { newLinkFailure, publicRoute } from "./public-routes";
import { cancellationAccountRoute, cancellationAdminRoute, registerCancellation, sweepCancellations } from "./public-cancellation";
import { sweepPublicTokens } from "./public-tokens";
import { clarifyAccountRoute, registerClarify } from "./clarify";
import { noticeAccountRoute, registerWithdrawalNotices, sweepWithdrawalNotices, withdrawalAdminRoute } from "./withdrawal-notices";

import { subscribeToAnnouncements, type SendlaneFetch } from "./announcements";
import { accountSession, createAuth } from "./auth";
import { readConfig, type ControlPlaneConfig } from "./config";
import { errorResponse, HTTPError, json, preflight, secureResponse, withBoundedRequestBody, type JSONValue } from "./http";
import { reserveOTPRecipient, requireJSONAuthBody } from "./otp-rate-limit";
import type { CloudflareFetch } from "./cloudflare-api";
import { BOOKMARK_HEADER, sessionFor } from "./d1-session";
import { serverTiming, timeD1 } from "./d1-timing";
import { sweepMailSink } from "./email";
import {
  cleanupEndpointForInstallation,
  deleteManagedEndpoint,
  getManagedEndpoint,
  provisionManagedEndpoint,
  sweepManagedEndpointCleanup,
} from "./endpoints";
import {
  createInstallation,
  installationSelf,
  listInstallations,
  revokeInstallation,
  rotateInstallationCredential,
} from "./installations";

const ROTATE_ROUTE = /^\/v1\/installations\/([^/]+)\/credentials\/rotate$/;
const INSTALLATION_ROUTE = /^\/v1\/installations\/([^/]+)$/;

const BETTER_AUTH_ERROR_CODES = new Map([
  ["INVALID_EMAIL", "invalid_email"],
  ["INVALID_OTP", "invalid_otp"],
  ["OTP_EXPIRED", "otp_expired"],
  ["TOO_MANY_ATTEMPTS", "rate_limited"],
  ["USER_NOT_FOUND", "invalid_otp"],
  ["VALIDATION_ERROR", "invalid_request"],
]);
const betterAuthErrorSchema = z.object({ code: z.string() }).loose();

function authStatusErrorCode(status: number): string {
  if (status === 400 || status === 422) return "invalid_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 405) return "method_not_allowed";
  if (status === 409) return "conflict";
  if (status === 413) return "request_too_large";
  if (status === 415) return "unsupported_media_type";
  if (status === 429) return "rate_limited";
  return "request_failed";
}

async function canonicalAuthResponse(response: Response): Promise<Response> {
  if (response.status >= 500) return errorResponse(500, "internal_error");
  if (response.status < 400 || response.status > 499) return response;

  // Better Auth error bodies are dependency-owned and may contain prose or
  // change shape between releases (its rate limiter currently returns only a
  // `message`). Publish only Murage's stable, lowercase error contract.
  const payload: unknown = await response.json().catch(() => null);
  const parsed = betterAuthErrorSchema.safeParse(payload);
  const dependencyCode = parsed.success ? parsed.data.code : "";
  const code = BETTER_AUTH_ERROR_CODES.get(dependencyCode) ?? authStatusErrorCode(response.status);
  return errorResponse(response.status, code);
}

async function route(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  config: ControlPlaneConfig,
  requestId: string,
  cloudflareFetch: CloudflareFetch,
  sendlaneFetch: SendlaneFetch,
  b3Dependencies: B3Dependencies,
  pairingDependencies: PairingDependencies,
  billingDependencies: BillingDependencies,
  identity: Identity,
  selfServiceDependencies: SelfServiceDependencies,
  fluxDependencies: FluxDependencies,
) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return preflight(request, config);

  // Per-IP edge limit on the unauthenticated machine, pairing and signup
  // routes, spent before any D1 access (ADV-6).
  const limited = await edgeGate(request, env);
  if (limited) return limited;

  // Emailed single-use links (WP7): no login, the token is the credential. Before authentication and outside the Cloud scope.
  const publicResponse = await publicRoute(request, env, {}, ctx);
  if (publicResponse) return publicResponse;
  // Operator side of the 312k cancellation (WP8): reason check, attribution, found-valid. Admin token only.
  const cancellationAdmin = await cancellationAdminRoute(request, env);
  if (cancellationAdmin) return cancellationAdmin;
  // Operator side of the emailed withdrawal notices (WP9): intake, queue, Execute, classify, link, alert acknowledgement. Admin token only.
  const noticeAdmin = await withdrawalAdminRoute(request, env);
  if (noticeAdmin) return noticeAdmin;

  if (url.pathname.startsWith("/api/auth/")) {
    await requireJSONAuthBody(request);
    const reservation = await reserveOTPRecipient(request, env);
    if (reservation.limited) return reservation.limited;
    let response: Response;
    try {
      response = await createAuth(env, ctx, config, requestId).handler(request);
    } catch (error) {
      await reservation.refund();
      throw error;
    }
    // Better Auth rejected (bad type/email, its own IP limit): no email went
    // out, so the recipient's budget is not spent.
    if (response.status >= 400) await reservation.refund();
    return canonicalAuthResponse(response);
  }

  // Unauthenticated on purpose: the caller is somebody's first run, before any
  // account exists. Answered before `createAuth`, which a signup needs nothing
  // from.
  if (request.method === "POST" && url.pathname === "/v1/announcements/subscribe") {
    return subscribeToAnnouncements(request, env, sendlaneFetch, requestId);
  }

  // Home side of self-service (commands, logs, export), and the export archive download (its token is the credential).
  const selfServiceMachine = await selfServiceMachineRoute(request, env, { b3: b3Dependencies, billing: billingDependencies, waitUntil: (work) => ctx.waitUntil(work), ...selfServiceDependencies });
  if (selfServiceMachine) return selfServiceMachine;
  const exportToken = /^\/v1\/export-download\/([^/]+)$/.exec(url.pathname);
  if (exportToken && request.method === "GET") {
    return exportDownload(request, env, { b3: b3Dependencies, billing: billingDependencies, waitUntil: (work) => ctx.waitUntil(work), ...selfServiceDependencies }, exportToken[1]);
  }

  const machineEndpoint = await machineEndpointRoute(request, env, config, cloudflareFetch, requestId);
  if (machineEndpoint) return machineEndpoint;
  const cp0Control = await cp0ControlRoute(request, env);
  if (cp0Control) return cp0Control;
  // Home-update rollout controller: operator routes only (the CLOUD_ADMIN_TOKEN bearer); no customer route exists.
  const rollout = await rolloutRoute(request, env);
  if (rollout) return rollout;
  const b3Response = await b3Route(request, env, b3Dependencies);
  if (b3Response) return b3Response;
  const machineResponse = await cloudMachineRoute(request, env);
  if (machineResponse) return machineResponse;

  const auth = createAuth(env, ctx, config, requestId);
  // Cloud routes were bound and authenticated in fetch(), before the body cap and the edge limiter (authenticateCloud).
  if (boundCustomer(request) && needsStepUp(request.method, url.pathname) && !await isOperator(request, env)) {
    // Journey A3: a top-up change that only switches it off or lowers it needs sign-in only (customer-identity.ts TOPUP_ROUTE). Journey A8: the
    // same for a home's monthly Flux spend limit that is not raised, and, while Flux is off, for both spending-Off routes (cap and stop: they
    // only answer that Flux is unavailable; Astra JOURNEY-A-11 #1). Each handler enforces the rule again at the moment it writes.
    const exempt = (isTopupChange(request.method, url.pathname) && await topupStepUpExempt(request, env, billingDependencies, auth))
      || ((isFluxCapChange(request.method, url.pathname) || (!fluxRoutesEnabled(env) && fluxOffStubRoute(request.method, url.pathname)))
        && await fluxCapStepUpExempt(request, env, auth, fluxDependencies))
      // Door v2 (CLOUD-DOOR-V2-DESIGN.md 3.4): the emailed sign-in, or an emailed code granted in THIS Supabase session, within 900 s. The
      // exemption names DOOR_ROUTE and nothing else (device revoke, money routes, desktop-code and the pair hold keep the ordinary rule);
      // the identity is the request's memoized one, and door.ts checks the proof again.
      || (DOOR_ROUTE.test(url.pathname) && await doorProofFresh(request, env, identity));
    if (!exempt && !await (billingDependencies.stepUp ?? (async () => false))(env, request, auth)) {
      const user = await (billingDependencies.accountUser ?? (async (r, a) => (await accountSession(r, a))?.user ?? null))(request, auth);
      if (!user) throw new HTTPError(401, "unauthorized");
      // What the members area needs to re-verify (CONTRACT.md section 3): the shared serializer (step-up-email.ts stepUpRefusal, applied
      // in handle()) fills reason, methods in offer order, window, last proof and the emailed-code alternative for this exact request.
      // The three purchase routes also say the first-purchase bootstrap does not apply (step_up.bootstrap: false).
      if (isPurchaseRoute(request.method, url.pathname)) throw stepUpRefused();
      throw new HTTPError(403, "step_up_required");
    }
  }
  // B4 Flux routes (wiring step 3), after the Cloud authentication and the step-up gate, next to the billing routes. Still OFF by
  // default: handle() answers 404 for every Flux path (CLOUD_FLUX_ROUTES_ENABLED, b4-flux-config.ts) before authenticateCloud,
  // the edge limiter or any D1 read. Switched on, the owner routes (/v1/flux/link*, /v1/homes/:id/flux*) are Cloud scope
  // (isCloudScopePath): only the bound Supabase member authenticates, as the mapped Cloud account id (a Better Auth companion
  // bearer is 401), and link start/complete, subkey, cap and stop passed the fresh trusted second factor above (needsStepUp).
  // The machine and operator Flux routes keep their own credentials.
  // The Flux handlers ask the same trusted second factor the gate asked (journey A8: setCap re-checks a raise of the spend limit).
  const fluxStepUp = billingDependencies.trustedStepUp ?? billingDependencies.stepUp ?? (async () => false);
  const fluxResponse = await fluxRoute(request, env, auth, { stepUp: async (r) => !!boundCustomer(r) && await fluxStepUp(env, r, auth), ...fluxDependencies });
  if (fluxResponse) return fluxResponse;
  const members = await membersRoute(request, env, billingDependencies, auth);
  if (members) return members;
  const selfService = await selfServiceRoute(request, env, identity, { b3: b3Dependencies, billing: billingDependencies, waitUntil: (work) => ctx.waitUntil(work), ...selfServiceDependencies });
  if (selfService) return selfService;
  const billing = await billingRoute(request, env, billingDependencies, auth);
  if (billing) return billing;
  const legal = await legalRoute(request, env, billingDependencies, auth);
  if (legal) return legal;
  const noticeAccount = await noticeAccountRoute(request, env, billingDependencies, auth);
  if (noticeAccount) return noticeAccount;
  const clarifyAccount = await clarifyAccountRoute(request, env, billingDependencies, auth);
  if (clarifyAccount) return clarifyAccount;
  // "Keep my plan" (WP8): signed in, own plan, step-up (gated above through STEP_UP_PATTERNS).
  const keep = await cancellationAccountRoute(request, env, billingDependencies, auth);
  if (keep) return keep;
  // Step-up by an emailed 6-digit code (step-up-email.ts): send and verify, Cloud scope, never step-up gated themselves.
  const stepUpEmail = await stepUpEmailRoute(request, env, identity, { emailSender: pairingDependencies.emailSender });
  if (stepUpEmail) return stepUpEmail;
  const trusted = await trustedFactorRoute(request, env, identity, { emailSender: pairingDependencies.emailSender });
  if (trusted) return trusted;
  // The door (door.ts): the owner's 60-second ticket into their home, after the step-up gate above (STEP_UP_PATTERNS, 300 s).
  const door = await doorRoute(request, env, identity, requestId, { emailSender: pairingDependencies.emailSender, waitUntil: (work) => ctx.waitUntil(work),
    homeFetch: pairingDependencies.homeFetch, keyWrapper: pairingDependencies.keyWrapper });
  if (door) return door;
  // Device management on My Cloud (devices.ts): the list (sign-in) and the revoke (step-up gated above, never the door's reuse).
  const devices = await devicesRoute(request, env, identity, requestId, pairingDependencies);
  if (devices) return devices;
  const pairing = await pairingRoute(request, env, auth, pairingDependencies);
  if (pairing) return pairing;
  const homes = await homesRoute(request, env, auth);
  if (homes) return homes;
  const twoFactor = accountTwoFactorRoute(request);
  if (twoFactor) return twoFactor;
  if (request.method === "GET" && url.pathname === "/v1/me") {
    const session = await accountSession(request, auth);
    if (!session) throw new HTTPError(401, "unauthorized");
    return json({
      user: {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        emailVerified: session.user.emailVerified,
      },
    });
  }
  if (request.method === "GET" && url.pathname === "/v1/installations") {
    return listInstallations(request, env, auth);
  }
  if (request.method === "POST" && url.pathname === "/v1/installations") {
    return createInstallation(request, env, auth);
  }
  if (request.method === "GET" && url.pathname === "/v1/installations/self") {
    return installationSelf(request, env);
  }
  if (url.pathname === "/v1/installations/self/endpoint") {
    if (request.method === "GET") return getManagedEndpoint(request, env);
    if (request.method === "POST") {
      return provisionManagedEndpoint(request, env, config, cloudflareFetch, requestId);
    }
    if (request.method === "DELETE") {
      return deleteManagedEndpoint(request, env, config, cloudflareFetch, requestId);
    }
  }

  const rotate = url.pathname.match(ROTATE_ROUTE);
  if (request.method === "POST" && rotate) {
    return rotateInstallationCredential(request, rotate[1], env, auth);
  }
  const installation = url.pathname.match(INSTALLATION_ROUTE);
  if (request.method === "DELETE" && installation) {
    const response = await revokeInstallation(request, installation[1], env, auth);
    ctx.waitUntil(cleanupEndpointForInstallation(
      env,
      config,
      installation[1],
      cloudflareFetch,
      requestId,
    ).catch(() => {
      console.error(JSON.stringify({
        message: "revoked installation endpoint cleanup scheduling failed",
        requestId,
        errorCode: "endpoint_internal",
      }));
    }));
    return response;
  }
  return errorResponse(404, "not_found");
}

/**
 * Cloud routes (account, billing, legal, homes): the members-area Supabase identity only, never a Better Auth session.
 * Authenticate and scope the caller BEFORE anything else answers (Astra MAKERKIT7 #1, MAKERKIT8 P3): on every Cloud route
 * a caller that is not the operator and not a verified Supabase member is 401, before the body cap (413), the per-IP
 * edge limiter (429), configuration, content type and body shape. Reads only headers. The retired portal 2FA routes answer
 * 410 to everyone. Off Cloud routes this binds nothing and checks nothing.
 */
async function authenticateCloud(request: Request, env: Env, ctx: ExecutionContext, config: ControlPlaneConfig, requestId: string,
  billingDependencies: BillingDependencies, identity: Identity) {
  if (request.method === "OPTIONS") return;
  identity.bind(request, env);
  if (!boundCustomer(request) || new URL(request.url).pathname.startsWith("/v1/account/2fa") || await isOperator(request, env)) return;
  // On a Cloud route the account is the bound Supabase member (accountSession never consults Better Auth there), so no
  // Better Auth instance is built just to say 401. A caller-supplied accountUser (tests) gets one.
  const user = billingDependencies.accountUser
    ? await billingDependencies.accountUser(request, createAuth(env, ctx, config, requestId))
    : (await boundCustomer(request)!.resolve())?.user ?? null;
  if (!user) throw new HTTPError(401, "unauthorized");
}

async function isOperator(request: Request, env: Env): Promise<boolean> {
  try { await admin(request, env); return true; } catch { return false; }
}

/** The hard wall of a scheduled invocation (a Cron Trigger runs at most 15 minutes): the billing sweep's bounded loops (stored-event and
 *  notice retries) start no attempt that could run past it. Only an upper bound, never a reason to skip them (Astra MAILRETRY-6 P1). */
export const SCHEDULED_SWEEP_DEADLINE_MS = 15 * 60_000;

/** A door refusal after the request's step-up intent was spent (its ticket could not be handed out: 403 proof expired, 503 door_unavailable,
 *  404/409 home changed, any failure): its real status and code, with retry "step_up" and a fresh step-up (THE refusal's step_up body,
 *  bound to a new intent for this same request), so the members area steps up again and mints again. Without one: retry only. Answered
 *  as built, never re-serialized as a plain step-up refusal; it carries the consumed header (the spent intent stays spent). */
async function doorRetry(env: Env, identity: Identity, prepared: Prepared, requestId: string, status: number, code: string,
  fields: { [key: string]: JSONValue } = {}): Promise<Response> {
  let extra: { [key: string]: JSONValue } = { ...fields, retry: "step_up" };
  if (prepared.frozen) {
    try {
      const fresh = await stepUpRefusal(env, identity, prepared.request, prepared.frozen, new HTTPError(403, "step_up_required"));
      if (completeStepUpRefusal(fresh)) extra = { ...extra, step_up: fresh.extra!.step_up };
    } catch { console.error(JSON.stringify({ message: "door retry step-up could not be built", requestId })); }
  }
  const res = errorResponse(status, code, extra);
  res.headers.set(CONSUMED_HEADER, "1");
  return res;
}

/** The replay of a door intent, answered from ONE read of its record made after every other await of the replay (Astra DOORMINT-6: the
 *  replay prepareStepUp built from an earlier read is used only for the operation id, never for the answer, because the original request
 *  can record its hand-out's outcome in between). By that row alone:
 *    - still HANDING OUT (door.ts DOOR_HANDING_OUT: the refusal could not be recorded, or the worker stopped before its hand-out was
 *      confirmed): 503 door_unavailable with retry "step_up" and a fresh intent (doorRetry);
 *    - a recorded refusal (any error status): that refusal, with the same retry fields;
 *    - delivered (the hand-out was confirmed): 409 already_completed with the same retry fields and the operation, never a second
 *      ticket from the old intent: the browser may never have seen the first one (its response lost), so it recovers with one more
 *      step-up, without clearing cookies (Astra DOORMINT-7). Never 410 on the door path: any other replay prepareStepUp built as 410 is
 *      answered the same way.
 *  null: not a door intent, or not done (any other replay, e.g. 409 action_in_progress, is answered as prepareStepUp built it). */
async function doorReplay(env: Env, identity: Identity, prepared: Prepared, requestId: string): Promise<Response | null> {
  const replay = prepared.replay!;
  if (!prepared.frozen || !DOOR_ROUTE.test(prepared.frozen.path)) return null;
  const body = await replay.clone().json().catch(() => null) as { operation?: { id?: unknown } } | null;
  const id = body?.operation?.id;
  if (typeof id !== "string") return replay.status === 410 ? doorRetry(env, identity, prepared, requestId, 409, "already_completed") : null;
  // THE read: nothing is awaited between it and the classification below.
  const row = await env.DB.prepare("SELECT phase, response_status, response_code, response_ref FROM cloud_stepup_intents WHERE id=? AND state='done'")
    .bind(id).first<{ phase: string | null; response_status: number | null; response_code: string | null; response_ref: string | null }>();
  const completed = () => doorRetry(env, identity, prepared, requestId, 409, "already_completed",
    { operation: { id, ...(row?.response_ref ? { ref: row.response_ref } : {}) } });
  if (row?.phase !== "delivered" || row.response_status === null) return replay.status === 410 ? completed() : null;
  if (row.response_status === 200 && row.response_code === DOOR_HANDING_OUT) return doorRetry(env, identity, prepared, requestId, 503, "door_unavailable");
  if (row.response_status >= 400) return doorRetry(env, identity, prepared, requestId, row.response_status, row.response_code ?? "action_failed");
  return completed();
}

/** The door's 15-minute reuse holds for this request's bound member (customer-identity.ts doorRecentProofAt). */
async function doorProofFresh(request: Request, env: Env, identity: Identity): Promise<boolean> {
  const s = await identity.customer(request);
  return Boolean(s) && (await doorRecentProofAt(env, s!, identity.now())) !== null;
}

export function createWorker(
  cloudflareFetch: CloudflareFetch = fetch,
  sendlaneFetch: SendlaneFetch = fetch,
  b3Dependencies: B3Dependencies = {},
  pairingDependencies: PairingDependencies = {},
  billingInput: BillingDependencies = {},
  identityDependencies: IdentityDependencies = {},
  selfServiceDependencies: SelfServiceDependencies = {},
  fluxDependencies: FluxDependencies = {},
) {
  // Astra INTEGRATED-1 #7: B4 dispatches under the SAME launch gate as billing (b4-flux.ts b4RouterClient): the hooks billing runs with.
  fluxDependencies = { billingFlux: billingInput.flux ?? stubFluxHooks, ...fluxDependencies };
  const identity = createIdentity(identityDependencies);
  // Money actions require a fresh second factor: the members-area token's aal2 + amr. Every money route is a Cloud route
  // (always bound); anything else fails closed. A caller may override.
  // A caller's stepUp override is the TRUSTED check (tests); the first-purchase bootstrap is added to it on the three purchase routes only,
  // so the worker gate below and every handler consult the same purchaseBootstrap (purchase-bootstrap.ts), which only reads.
  // An emailed-code approval claimed for this very request (step-up-email.ts) counts as the trusted check everywhere it is consulted, as
  // long as its frozen target still re-validates in D1 (Astra STEPUP-EMAIL-2 #3: repeated checks re-validate the target, not the proof).
  const trustedBase: NonNullable<BillingDependencies["stepUp"]> = billingInput.stepUp ?? (async (env, request) =>
    boundCustomer(request) ? identity.stepUp(request, env) : false);
  const trustedStepUp: NonNullable<BillingDependencies["stepUp"]> = async (env, request, auth) =>
    (await stepUpProofValid(request)) || trustedBase(env, request, auth);
  const bootstrapCheck: NonNullable<BillingDependencies["purchaseBootstrap"]> = billingInput.purchaseBootstrap ?? ((env, request, accountId, homeId) =>
    purchaseBootstrap(env, request, accountId, homeId, (billingInput.now ?? Date.now)()));
  const stepUp: NonNullable<BillingDependencies["stepUp"]> = async (env, request, auth) =>
    (await trustedStepUp(env, request, auth)) || (await bootstrapCheck(env, request, null, null)) !== null;
  const billingDependencies: BillingDependencies = { ...billingInput, stepUp, trustedStepUp, purchaseBootstrap: bootstrapCheck };
  registerCancellation(billingDependencies);
  registerWithdrawalNotices(billingDependencies);
  registerClarify();
  const handle = async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
      const requestId = crypto.randomUUID();
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/healthz") {
        try {
          readConfig(env);
        } catch {
          return secureResponse(errorResponse(503, "misconfigured"), request, null, requestId);
        }
        return secureResponse(json({ ok: true, service: "murage-control-plane" }), request, null, requestId);
      }

      // B4 Flux routes are off unless CLOUD_FLUX_ROUTES_ENABLED is exactly "1": 404 before configuration, origin,
      // authentication (no Supabase or Better Auth session is resolved), the body cap, the edge limiter and any D1 read.
      // The one exception (Astra JOURNEY-A-10 #4): the owner's spending Off is authenticated as usual and answered "Flux is unavailable".
      // Astra INTEGRATED-11 (ledger R9): the operator's evidenced ledger recovery makes no router call and works while Flux is off (admin
      // credential, checked by the route itself).
      if (isFluxPath(url.pathname) && !fluxRoutesEnabled(env) && !fluxOffStubRoute(request.method, url.pathname) && !FLUX_LEDGER_ROUTE.test(url.pathname)) {
        return secureResponse(errorResponse(404, "not_found"), request, null, requestId);
      }

      let config: ControlPlaneConfig | null = null;
      let stepped: Prepared | null = null;
      // Set the moment an approval is claimed (step-up-email.ts claim), before anything else can fail (Astra STEPUP-EMAIL-3 #5).
      const claimSink: { consumed?: boolean } = {};
      // Consumed: what the prepared request says (a confirmed release sets it false), else whatever the claim or the recognition of an
      // exact duplicate recorded before anything could fail (a 401/503 of the live identity check, a 500 while reconciling).
      const consumedNow = () => (stepped?.consumed ?? claimSink.consumed) === true;
      try {
        config = readConfig(env);
        const origin = request.headers.get("origin");
        if (origin && !config.allowedOrigins.has(origin)) {
          return secureResponse(errorResponse(403, "origin_not_allowed"), request, config, requestId);
        }
        // Stripe events can exceed the 16 KB API body cap and are authenticated by signature, not origin.
        if (request.method === "POST" && url.pathname === "/v1/billing/webhook") {
          return secureResponse(await stripeWebhook(request, env, billingDependencies), request, config, requestId);
        }
        await authenticateCloud(request, env, ctx, config, requestId, billingDependencies, identity);
        // The machine heartbeat bounds its own body, AFTER authenticating the machine from its headers (Astra AUTOCANARY-11 P1-2): an
        // oversized report from a valid credential must reach the route, which invalidates the home's evidence before answering 413.
        const boundedRequest = isHeartbeatRequest(request.method, url.pathname) ? request : await withBoundedRequestBody(request);
        carryBinding(request, boundedRequest);
        // stepUpIntentId (emailed-code step-up) is validated and removed here, before any route's strict body validation; a named,
        // approved intent matching exactly this request is claimed here, once (step-up-email.ts prepareStepUp).
        const cfg = config;
        // `stepped` is the TRUSTED-factor check only: the first-purchase bootstrap stays its own purchase authority, checked by the purchase
        // handlers under its own constraints, and is never promoted into a step-up approval (Astra STEPUP-EMAIL-3 #1).
        const prepared = await prepareStepUp(boundedRequest, env, identity, {
          operator: () => isOperator(boundedRequest, env),
          stepped: async (r) => trustedStepUp(env, r, createAuth(env, ctx, cfg, requestId)),
        }, claimSink);
        stepped = prepared;
        if (prepared.replay) {
          // A door operation: its replay is classified from its record as it stands NOW (doorReplay): a refusal, or a hand-out not
          // confirmed, says how to recover; a confirmed hand-out never yields a second ticket.
          const doorAnswer = await doorReplay(env, identity, prepared, requestId);
          if (doorAnswer) return secureResponse(doorAnswer, request, config, requestId);
          // The replay of an operation its refusal voided is that refusal again, built whole by the serializer below (a fresh intent),
          // never a bare stored code (Astra STEPUP-EMAIL-7 #4).
          if (prepared.replay.status === 403 && prepared.frozen
            && (await prepared.replay.clone().json().catch(() => null) as { error?: unknown } | null)?.error === "step_up_required") {
            throw new HTTPError(403, "step_up_required");
          }
          return secureResponse(prepared.replay, request, config, requestId);
        }
        // A claimed operation runs on the journaled binding recordOutcome hands it (its writes fenced and counted on the intent).
        const run = (e: Env) => route(prepared.request, e, ctx, cfg, requestId, cloudflareFetch, sendlaneFetch, b3Dependencies, pairingDependencies, billingDependencies, identity, selfServiceDependencies, fluxDependencies);
        // A door ticket's 55 s are checked once more AFTER the intent's finalization, immediately before the answer is handed out (door.ts).
        const outcome = prepared.claimed ? await recordOutcome(env, prepared, identity.now, run) : await run(env);
        let answered: Response;
        try { answered = await handOutDoorTicket(prepared.request, outcome, prepared.claimed?.id); }
        catch (e) {
          // Refused after the intent was finalized HANDING OUT (EVERY refusal: proof expired, signer down, too slow, home changed, any
          // throw): the consumed intent stays consumed (never claimable again), its record says what the member actually got (its real
          // status and code), and the answer carries a fresh step-up to mint again (Astra DOORMINT-3, DOORMINT-4). If that record cannot be
          // written the intent stays handing out, which replays as a recorded refusal too (doorReplay; Astra DOORMINT-5).
          if (!prepared.claimed) throw e;
          const refusal = e instanceof HTTPError ? e : new HTTPError(500, "internal_error");
          if (!(e instanceof HTTPError)) console.error(JSON.stringify({ message: "door handout failed", requestId }));
          await env.DB.prepare(`UPDATE cloud_stepup_intents SET response_status=?, response_code=?
            WHERE id=? AND state='done' AND response_status=200 AND response_code=?`).bind(refusal.status, refusal.code, prepared.claimed.id, DOOR_HANDING_OUT).run()
            .catch(() => console.error(JSON.stringify({ message: "door handout failure not recorded", requestId })));
          return secureResponse(await doorRetry(env, identity, prepared, requestId, refusal.status, refusal.code), request, config, requestId);
        }
        // An exact duplicate of an executing or completed operation was recognised (prepareStepUp): its approval is consumed, and this
        // answer says so too, whatever route answered it (Astra STEPUP-EMAIL-5 #5).
        if (!prepared.claimed && prepared.consumed && !answered.headers.has(CONSUMED_HEADER)) {
          const marked = new Response(answered.body, answered);
          marked.headers.set(CONSUMED_HEADER, "1");
          return secureResponse(marked, request, config, requestId);
        }
        return secureResponse(answered, request, config, requestId);
      } catch (error) {
        // /new-link answers 202 {} even when the request failed before reaching it (an oversized body, for one).
        const quiet = newLinkFailure(request, error);
        if (quiet) return secureResponse(quiet, request, config, requestId);
        if (error instanceof HTTPError) {
          let e = error;
          // THE step-up refusal, for the gate and every handler alike (Astra STEPUP-EMAIL-1 #2).
          // A refusal that cannot be built whole (the serializer or its storage failed, or nothing could be frozen) is a 5xx, never a
          // 403 step_up_required without its step_up.email_code: that code is only ever sent actionable (Astra STEPUP-EMAIL-7 #4).
          if (e.status === 403 && e.code === "step_up_required" && stepped?.frozen) {
            const plain = e;
            try { e = await stepUpRefusal(env, identity, stepped.request, stepped.frozen, e); }
            catch { console.error(JSON.stringify({ message: "step-up refusal could not be built", requestId })); e = new HTTPError(503, "step_up_unavailable"); }
            // (Returned unchanged only for a request with no bound Supabase session, where nothing can be frozen: the refusing code's own.)
            if (e !== plain && e.code === "step_up_required" && !completeStepUpRefusal(e)) {
              console.error(JSON.stringify({ message: "step-up refusal incomplete", requestId }));
              e = new HTTPError(503, "step_up_unavailable");
            }
          }
          const res = errorResponse(e.status, e.code, e.extra);
          // A consumed approval says so on every answer, a refusal or an exception after the claim included (Astra STEPUP-EMAIL-2 #5).
          if (consumedNow()) res.headers.set(CONSUMED_HEADER, "1");
          return secureResponse(res, request, config, requestId);
        }
        // Staging only (LOG_INTERNAL_ERRORS=1): the error's name, message and top frames, so a 500 can be diagnosed without
        // exposing request data; production logs the request id alone.
        const detail = (env as { LOG_INTERNAL_ERRORS?: string }).LOG_INTERNAL_ERRORS === "1" && error instanceof Error
          ? { error: `${error.name}: ${error.message}`.slice(0, 300), stack: (error.stack ?? "").split("\n").slice(1, 4).map((l) => l.trim().slice(0, 160)) }
          : {};
        console.error(JSON.stringify({ message: "request failed", requestId, ...detail }));
        const failed = errorResponse(500, "internal_error");
        if (consumedNow()) failed.headers.set(CONSUMED_HEADER, "1");
        return secureResponse(failed, request, config, requestId);
      }
      };
  return {
    async fetch(request: Request, rawEnv: Env, ctx: ExecutionContext): Promise<Response> {
      // Server-Timing: D1 round trips and time for this request (see d1-timing.ts).
      const started = Date.now();
      const sessioned = sessionFor(rawEnv.DB, request);
      const { db, stats } = timeD1(sessioned.db);
      const response = await handle(request, { ...rawEnv, DB: db }, ctx);
      // The public no-login routes carry no telemetry and no session bookmark: a count or a duration there could tell a matched account from an
      // unmatched one (Astra WP8-1 #1, WP8 review). Their slow work runs after the answer (ctx.waitUntil, and the sweep).
      // A denied Flux home answer (/v1/homes/<id>/flux*: an unknown home and somebody else's are the same 404) carries none either: its
      // duration or round trips could tell an existing home from an unknown one (Astra FLUX-STEP3 #3).
      const pathname = new URL(request.url).pathname;
      if (pathname.startsWith("/v1/public/") || (response.status === 404 && isFluxOwnerPath(pathname))) {
        for (const h of [BOOKMARK_HEADER, "server-timing", "x-d1-bookmark"]) response.headers.delete(h);
        return response;
      }
      const bookmark = sessioned.bookmark();
      if (bookmark) response.headers.set(BOOKMARK_HEADER, bookmark);
      response.headers.set("server-timing", serverTiming(stats, Date.now() - started));
      return response;
    },
    scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
      const requestId = crypto.randomUUID();
      // The invocation's hard wall, taken once at its start (lane C design 3 A2): the customer-waiting loops (stored events, then notices)
      // start no attempt that could run past it, and wait for each at most EVENT_MAX_MS. They run FIRST in the invocation, before B3
      // reconcile and the self-service sweep, each on its own budget, so no other stage can use up their time (Astra MAILRETRY-6/7 P1). The
      // other stages are not bounded yet (lane C2). Accepted for C1 (Astra MAILRETRY-7 P2): the notice loop can delay every later stage's
      // money work by up to its 120 s budget; lane C2 covers it. B3's overdue give-ups (refund obligations) do not wait behind B3's per-home
      // work order: reconcileB3 runs them first (giveUpOverdue, Astra MAILRETRY-8 P1), within about 4 minutes of the invocation's start.
      const deadline = Date.now() + SCHEDULED_SWEEP_DEADLINE_MS;
      ctx.waitUntil((async () => {
        try {
          // Every attempt cut at its cap goes on as a continuation registered with this invocation (Astra MAILRETRY-4 P2).
          await sweepCustomerWaiting(env, { ...billingDependencies, sweepDeadline: deadline, waitUntil: (work) => ctx.waitUntil(work) });
        } catch {
          console.error(JSON.stringify({ message: "customer-waiting sweep failed", requestId, errorCode: "billing_waiting_internal" }));
        }
        // Each sweep is isolated: B3 being on must never silence the tunnel
        // and DNS cleanup sweep, and a failing one must not stop the other.
        if (b3Enabled(env)) {
          try {
            await reconcileB3(env, b3Dependencies);
          } catch {
            console.error(JSON.stringify({ message: "b3 reconcile failed", requestId, errorCode: "b3_internal" }));
          }
        }
        try {
          await sweepSelfService(env, { b3: b3Dependencies, billing: billingDependencies, waitUntil: (work) => ctx.waitUntil(work), ...selfServiceDependencies });
        } catch {
          console.error(JSON.stringify({ message: "self-service sweep failed", requestId, errorCode: "selfservice_internal" }));
        }
        try {
          // The customer-waiting loops already ran first in this invocation: the billing sweep does not run them again.
          await sweepBilling(env, { ...billingDependencies, customerWaitingDone: true, sweepDeadline: deadline, waitUntil: (work) => ctx.waitUntil(work) });
        } catch {
          console.error(JSON.stringify({ message: "billing sweep failed", requestId, errorCode: "billing_internal" }));
        }
        try {
          await sweepPlanResizes(env, billingDependencies);
        } catch {
          console.error(JSON.stringify({ message: "plan resize sweep failed", requestId, errorCode: "resize_internal" }));
        }
        try {
          await sweepFlux(env, fluxDependencies);
        } catch {
          console.error(JSON.stringify({ message: "flux sweep failed", requestId, errorCode: "flux_internal" }));
        }
        try {
          await sweepCloudRetention(env);
        } catch {
          console.error(JSON.stringify({ message: "retention sweep failed", requestId, errorCode: "retention_internal" }));
        }
        try {
          await sweepCancellations(env, billingDependencies);
        } catch {
          console.error(JSON.stringify({ message: "cancellation sweep failed", requestId, errorCode: "cancellation_internal" }));
        }
        try {
          await sweepWithdrawalNotices(env, billingDependencies);
        } catch {
          console.error(JSON.stringify({ message: "withdrawal notice sweep failed", requestId, errorCode: "withdrawal_notices_internal" }));
        }
        try {
          // Staging mail sink retention (TRUST-FIRST-FACTOR.md part C, Astra TRUST-2 F4): rows older than 24 h go. No binding: no-op.
          await sweepMailSink(env);
        } catch {
          console.error(JSON.stringify({ message: "mail sink sweep failed", requestId, errorCode: "mail_sink_internal" }));
        }
        try {
          await sweepStepUpEmail(env, Date.now());
        } catch {
          console.error(JSON.stringify({ message: "step-up email sweep failed", requestId, errorCode: "stepup_email_internal" }));
        }
        try {
          // The door's owed first-open notices (door.ts): a failed or interrupted first attempt is retried with backoff.
          await sweepDoorNotices(env, Date.now(), { emailSender: pairingDependencies.emailSender });
        } catch {
          console.error(JSON.stringify({ message: "door notice sweep failed", requestId, errorCode: "door_notices_internal" }));
        }
        try {
          await sweepPublicTokens(env, Date.now());
        } catch {
          console.error(JSON.stringify({ message: "public token sweep failed", requestId, errorCode: "public_tokens_internal" }));
        }
        try {
          await sweepMonitoring(env);
        } catch {
          console.error(JSON.stringify({ message: "monitoring sweep failed", requestId, errorCode: "monitoring_internal" }));
        }
        try {
          // After monitoring, so the heartbeat and render alerts it raised this run are what the soak gate reads.
          await sweepRollout(env);
        } catch {
          console.error(JSON.stringify({ message: "rollout sweep failed", requestId, errorCode: "rollout_internal" }));
        }
        try {
          await sweepManagedEndpointCleanup(env, readConfig(env), cloudflareFetch, requestId);
        } catch {
          console.error(JSON.stringify({
            message: "managed endpoint cleanup sweep failed",
            requestId,
            errorCode: "endpoint_internal",
          }));
        }
      })());
    },
  } satisfies ExportedHandler<Env>;
}

export default createWorker();
