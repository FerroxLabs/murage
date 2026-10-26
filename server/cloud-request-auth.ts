import { homeRememberedGrantWrite, secureHomeHtml } from "./cloud-home/b1b-policy.ts";
import { cloudHomeCopy } from "./cloud-home/copy.ts";
import { preReadBodies } from "./read-body.ts";
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CloudSessions, type PairingInput } from "./cloud-sessions.ts";
import { isOwnerBrowser, ownerBrowserScope, setCloudIdentity } from "./cloud-request-identity.ts";
import { cloudRouteDecision, cloudRouteNeedsBody, cloudSettingsRead } from "./route-policy.ts";
import { trustedCloudSocket } from "./cloud-home/proxy-socket.ts";
import { CloudResponseSessions, type CloudResponseBinding } from "./cloud-home/response-sessions.ts";
import { doorTicketEnvelope, type DoorTicketClaims } from "./cloud-home/b1b-identity.ts";
import { doorOutcomeOf, doorPageReport, doorRefusal, logDoorOutcome, logDoorPage, type DoorOutcome, type DoorRoute } from "./cloud-home/door-log.ts";
import { MEDIA_ASSET_ID_PATTERN, verifyMediaCapability } from "./media-assets.ts";
import { MEDIA_CAPABILITY_QUERY_PARAM, MEDIA_ROUTES } from "../shared/media-assets.ts";

/** The device a pair hold was spent on, as the control plane computes it (cloudflare/control-plane/src/pairing.ts pairDeviceDigest). */
export function pairDeviceDigest(device:{scope:string;publicKey:string;assertionKey:string}): string {
  return createHash("sha256").update(`murage-pair-device-v1\n${device.scope}\n${device.publicKey}\n${device.assertionKey}`).digest("hex");
}

// One map with readBody (read-body.ts), so every route reads the body this gate verified.
export const cloudBodies = preReadBodies;
export interface CloudAuthOptions { sessions: CloudSessions; publicOrigin: string; trustedProxy?: string; bootstrapSecret: () => string | undefined; homeIdentity?: () => { homeKey: unknown };
  executionOpen?: () => boolean;
  lifecycle?: (action: "stop" | "drain" | "revoke-sessions" | "resume") => Promise<void>;
  recoveryProof?: (proof: unknown) => {holdId:string;deviceKeyDigest?:string};
  /** The home's own control-plane generation, pinned independently of any request (the CP binding); undefined only when unbound, throws when unreadable. */
  homeGeneration?: () => number | undefined;
  /** Verifies a door ticket against the pinned control-plane key and this home's own id, generation and origin; throws to refuse. */
  doorTicket?: (ticket: import("./cloud-home/b1b-identity.ts").SignedHomeKey) => DoorTicketClaims;
  recoveryNotice?: (id: string, availableAt: number) => Promise<void>;
  recoveryCleanup?: (id: string, account: string) => Promise<void>;
  beforeAccountRevoke?: (device: import("./cloud-sessions.ts").CloudDevice) => Promise<void> }
const cookieName = "__Host-murage";
const sessionCookie = (value: string, maxAge: number) => `${cookieName}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
/** The coarse reason a refused ticket gives the door page; the fine outcome stays in the home's log. */
function coarseDoorReason(outcome: DoorOutcome): "expired"|"too_many_devices"|"hold_required"|"refused" {
  if (["ticket_expired","ticket_bad_times","ticket_stale_step_up","ticket_reused"].includes(outcome)) return "expired";
  if (outcome === "device_limit") return "too_many_devices";
  if (outcome === "desktop_hold_required" || outcome === "pair_hold_refused") return "hold_required";
  return "refused";
}
const bounded = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
function reply(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status,{"content-type":"application/json","cache-control":"no-store"}); res.end(JSON.stringify(body));
}
function loopback(host: string): boolean {
  try { const u = new URL(`http://${host}`); const h=u.hostname.replace(/^\[|\]$/g,""); return u.host === host && (h === "localhost" || h === "::1" || (isIP(h) === 4 && h.startsWith("127."))); } catch { return false; }
}
export function cloudHostGate(req: IncomingMessage, origin: string, trustedProxy?: string): boolean {
  let publicUrl: URL; try { publicUrl = new URL(origin); } catch { return false; }
  if (publicUrl.protocol !== "https:" || publicUrl.origin !== origin) return false;
  const unix = trustedCloudSocket(req, trustedProxy);
  const forwarded = req.headers["x-forwarded-host"];
  const host = unix && typeof forwarded === "string" ? forwarded : req.headers.host;
  if (!host || (host !== publicUrl.host && !loopback(host))) return false;
  const write = !["GET","HEAD","OPTIONS"].includes(req.method ?? "GET");
  // A bot's turn posts to /api/internal on the loopback listener with its own capability
  // and no Origin (Node fetch sends none). That is not a browser: only a request that
  // arrived over TCP between loopback addresses, named a loopback Host and carries no
  // Origin may write without one. Route policy still limits such a caller to the
  // capability-checked classes.
  const localWrite = write && !unix && !req.headers.origin && loopback(host)
    && [req.socket.localAddress, req.socket.remoteAddress].every(address =>
      address === "::1" || address === "::ffff:127.0.0.1" || (typeof address === "string" && isIP(address) === 4 && address.startsWith("127.")));
  return (!req.headers.origin || req.headers.origin === origin) && (!write || req.headers.origin === origin || localWrite);
}
/** Caddy supplies a validated source only on the configured Unix transport. */
export function cloudClientIp(req: IncomingMessage, trustedProxy?: string): string {
  if (trustedCloudSocket(req, trustedProxy)) {
    const value = req.headers["x-forwarded-for"];
    const address = typeof value === "string" ? value.split(",")[0]?.trim() : undefined;
    if (address && isIP(address)) return address;
  }
  return req.socket.remoteAddress ?? "unknown";
}
async function rawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[]=[]; let size=0;
  for await (const chunk of req.iterator({destroyOnReturn:false})) { const bytes=Buffer.from(chunk); size+=bytes.length; if(size>maxBytes) { req.resume(); throw Object.assign(new Error(cloudHomeCopy.bodyTooLarge),{status:413}); } chunks.push(bytes); }
  return Buffer.concat(chunks);
}
export function stepPurpose(method: string, path: string, body: unknown): string {
  return `step:${method}:${path}:${createHash("sha256").update(JSON.stringify(body ?? {})).digest("hex")}`;
}
export function createCloudRequestAuth(options: CloudAuthOptions) {
  const {sessions}=options;
  const responses = new CloudResponseSessions(sessions);
  return async (req: IncomingMessage,res: ServerResponse,url: URL): Promise<boolean> => {
    secureHomeHtml(res);
    const path=url.pathname,method=req.method ?? "GET";
    // Every door request logs one line, including the ones refused before the door code runs (server/cloud-home/door-log.ts).
    const doorPath: DoorRoute|undefined = method === "GET" && path === "/api/cloud/door-state" ? "state" : method === "POST" && (path === "/api/cloud/enter" || path === "/api/cloud/enter/report") ? "enter" : undefined;
    const early=(outcome: DoorOutcome)=>{ if (doorPath) logDoorOutcome(doorPath,outcome); };
    if (!cloudHostGate(req,options.publicOrigin,options.trustedProxy)) { early("origin_refused"); reply(res,403,{error:cloudHomeCopy.requestOriginRefused}); return true; }
    // Tokens are accepted only in the authorization header or host-only cookie.
    if (url.searchParams.has("token") || url.searchParams.has("access_token") || url.searchParams.has("code")) { early("query_token_refused"); reply(res,400,{error:cloudHomeCopy.useTheSignInRequestBody}); return true; }
    let body: Record<string,unknown>={}; let raw: Buffer=Buffer.alloc(0);
    try {
      if (path === "/.well-known/murage/environment" && method === "GET") { reply(res,200,{environmentId:sessions.environmentId,...options.homeIdentity?.()}); return true; }
      const bearer = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization ?? "")?.[1];
      const cookies=(req.headers.cookie ?? "").split(";").map(v=>v.trim()).filter(v=>v.startsWith(`${cookieName}=`));
      const access=bearer ?? (cookies.length===1 ? cookies[0]!.slice(cookieName.length+1) : "");
      const device=sessions.resolve(access);
      if (device?.scope === "browser" && bearer) { early("bearer_refused"); reply(res,401,{error:cloudHomeCopy.browserSignInRequiresItsCookie}); return true; }
      // Unix is proxy provenance, never service authentication. The dedicated
      // main TCP listener accepts local capabilities only from actual loopback
      // peers; Host and forwarded headers cannot manufacture that transport.
      const localService = !trustedCloudSocket(req, options.trustedProxy)
        && Boolean(req.socket.localAddress && req.socket.remoteAddress)
        && [req.socket.localAddress!, req.socket.remoteAddress!].every(address =>
          address === "::1" || address === "::ffff:127.0.0.1" || (isIP(address) === 4 && address.startsWith("127.")));
      const scope = (device ? ownerBrowserScope(device) : undefined) ?? (localService ? "service" : "anonymous");
      const management = method === "POST" && ["/api/cloud/stop","/api/cloud/drain","/api/cloud/revoke-sessions","/api/cloud/account/resume","/api/cloud/recovery/hold","/api/cloud/devices/list","/api/cloud/devices/revoke"].includes(path);
      const doorRoute = doorPath !== undefined;
      // A paired device lists and forgets itself; anonymous callers reach the handler only to be refused there.
      const deviceSelfRoute = method === "GET" && path === "/api/cloud/devices" || method === "POST" && path === "/api/cloud/devices/forget";
      const bootstrap = management || doorRoute || deviceSelfRoute || method === "POST" && ["/api/cloud/pairing", "/api/cloud/pair", "/api/cloud/challenge", "/api/cloud/refresh"].includes(path);
      // Resolve bearer/cookie and refuse protected anonymous/service requests
      // before attaching a body reader, including when the client never ends it.
      if (!device && !bootstrap && (path === "/api" || path.startsWith("/api/"))
        && cloudRouteDecision(method, path, scope, {}) !== "allow") {
        reply(res,403,{error:cloudHomeCopy.pairedDeviceRequired}); return true;
      }
      if (cloudRouteNeedsBody(method,path)) {
        raw=await rawBody(req,path.startsWith("/api/cloud/") ? 1_048_576 : 12*1024*1024); body=raw.length ? JSON.parse(raw.toString("utf8")) : {};
        cloudBodies.set(req,{body,bytes:raw.length});
        // The device was resolved before the body arrived: it must still be signed in once the body is complete.
        if (device && sessions.resolve(access)?.id !== device.id) { reply(res,403,{error:cloudHomeCopy.signInRequestRefused}); return true; }
      }
      if(options.executionOpen && !options.executionOpen() && !["GET","HEAD","OPTIONS"].includes(method) && /^\/api\/(?:internal|model-gateway)(?:\/|$)/.test(path)) {reply(res,403,{error:cloudHomeCopy.homePaused});return true;}
      if (homeRememberedGrantWrite(method,path,body)) { reply(res,403,{error:cloudHomeCopy.alwaysAllowUnavailable}); return true; }
      const bindings: CloudResponseBinding[] = [];
      if (device) {
        const accessHash = createHash("sha256").update(access).digest("hex");
        setCloudIdentity(req.headers,{...device,accessHash,settingsRead:cloudSettingsRead(method,path)});
        bindings.push({ id: device.id, account: device.account, scope: device.scope, accessHash, owner: isOwnerBrowser(device) });
      }
      if (["GET", "HEAD"].includes(method) && path.startsWith(`${MEDIA_ROUTES.bytes}/`)) {
        const assetId = path.slice(MEDIA_ROUTES.bytes.length + 1), caps = url.searchParams.getAll(MEDIA_CAPABILITY_QUERY_PARAM);
        if (MEDIA_ASSET_ID_PATTERN.test(assetId) && caps.length === 1) {
          const cap = verifyMediaCapability(caps[0], assetId);
          if (cap.ok && cap.claims.cloudSession) {
            const bound = cap.claims.cloudSession, issuer = sessions.resolveHash(bound.accessHash);
            if (!issuer || issuer.id !== bound.deviceId) { reply(res,403,{error:cloudHomeCopy.signInRequestRefused}); return true; }
            bindings.push({ id: issuer.id, account: issuer.account, scope: issuer.scope, accessHash: bound.accessHash, owner: isOwnerBrowser(issuer) });
          }
        }
      }
      const assertion=(id: string,purpose: string) => {
        const value=req.headers["x-murage-step-up"];
        if(typeof value!=="string" || value.length>4096) return false;
        try { const a=JSON.parse(Buffer.from(value,"base64url").toString("utf8")); return sessions.consumeAssertion(id,a.challenge,purpose,a.at,a.webauthn ? JSON.stringify(a.webauthn) : a.signature); } catch { return false; }
      };
      if (management) {
        const input=sessions.verifyBootstrap(raw,String(req.headers["x-murage-signature"] ?? ""),options.bootstrapSecret() ?? "");
        if (input.operation !== path) throw new Error(cloudHomeCopy.homeControlOperationRefused);
        if (path === "/api/cloud/recovery/hold") {
          if (!options.recoveryNotice) throw new Error(cloudHomeCopy.recoveryNoticeUnavailable);
          const id=String(input.recoveryId ?? ""), availableAt=sessions.startRecovery(id,String(input.account ?? ""));
          try { await options.recoveryNotice(id,availableAt); } catch(error) { sessions.cancelRecovery(id); throw error; }
          reply(res,200,{recoveryId:id,availableAt}); return true;
        }
        if (path === "/api/cloud/devices/list") { reply(res,200,{devices:sessions.listDevices(),fullScopeEver:sessions.fullScopeEver(),consumedHoldIds:sessions.consumedHoldIds()}); return true; }
        if (path === "/api/cloud/devices/revoke") {
          const id=input.deviceId;
          if (typeof id !== "string" || !/^[a-f0-9-]{1,64}$/.test(id)) throw new Error(cloudHomeCopy.homeControlOperationRefused);
          // An id this home never had is 404, which the control plane reports as device_not_found.
          if (!sessions.knownDevice(id)) { reply(res,404,{error:cloudHomeCopy.homeControlOperationRefused}); return true; }
          // My Cloud's "Make chat-only" sends factorOnly:true: revoke just the remembered-owner factor, the device stays for chat.
          if (input.factorOnly === true) sessions.revokeOwnerFactor(id); else sessions.revoke(id);
          reply(res,200,{revoked:true}); return true;
        }
        if (!options.lifecycle) throw new Error(cloudHomeCopy.homeLifecycleUnavailable);
        const action=path.endsWith("/resume") ? "resume" : path.slice(path.lastIndexOf("/")+1) as "stop"|"drain"|"revoke-sessions";
        if (action === "revoke-sessions") sessions.revokeAccount();
        await options.lifecycle(action);
        if (action === "resume") sessions.resumeAccount();
        reply(res,200,{accepted:true}); return true;
      }
      if (deviceSelfRoute) {
        if (!device) { reply(res,401,{error:cloudHomeCopy.signInRequired}); return true; }
        if (method === "GET") {
          if (!sessions.devicesReadAllowed(device.id)) { res.setHeader("retry-after","60"); reply(res,429,{error:cloudHomeCopy.doorTooManyAttempts}); return true; }
          reply(res,200,{devices:sessions.listDevices(),self:device.id}); return true;
        }
        sessions.revoke(device.id);
        res.setHeader("set-cookie",sessionCookie("",0));
        reply(res,200,{forgotten:true}); return true;
      }
      if (doorRoute) {
        const source=cloudClientIp(req,options.trustedProxy);
        const route: DoorRoute = doorPath!;
        // Every outcome is logged as one fixed line (server/cloud-home/door-log.ts); no ticket, key, cookie or id is ever in it.
        const tooMany=(outcome: DoorOutcome)=>{ if (path !== "/api/cloud/enter/report") logDoorOutcome(route,outcome); res.setHeader("retry-after","600"); reply(res,429,{error:cloudHomeCopy.doorTooManyAttempts}); return true; };
        // The per-source lockout is checked first, so a locked source consumes nothing shared. A locked source may still enter with a
        // ticket that verifies (a neighbour's failures behind the same NAT or /64 never lock the owner out); every other route stays refused.
        const locked=sessions.doorSourceLocked(source);
        if (locked && path !== "/api/cloud/enter") return tooMany("source_locked");
        if (path === "/api/cloud/enter/report") {
          // What went wrong on the door page, mapped to fixed words and logged; it changes nothing and answers nothing.
          if (!sessions.doorReportAllowed(source)) return tooMany("state_rate_limited");
          logDoorPage(doorPageReport(body)); reply(res,202,{}); return true;
        }
        if (path === "/api/cloud/door-state") {
          if (!sessions.doorStateAllowed(source)) return tooMany("state_rate_limited");
          // Answers one boolean and nothing else: no home id, account, device count or environment id.
          const hasDevices=Boolean(sessions.db.prepare("SELECT 1 FROM cloud_devices LIMIT 1").get());
          logDoorOutcome(route,"state_answered");
          reply(res,200,{hasDevices}); return true;
        }
        // /api/cloud/enter
        const d=body.device as Record<string,unknown>|null|undefined;
        const deviceShaped=Boolean(d && typeof d === "object" && !Array.isArray(d) && bounded(d.publicKey,4096) && bounded(d.assertionKey,4096) && bounded(d.proof,4096)
          && (d.assertionProof === undefined || d.assertionProof === null || bounded(d.assertionProof,4096))
          && (d.deviceId === undefined || d.deviceId === null || (typeof d.deviceId === "string" && d.deviceId.length <= 64)));
        // A locked source: cheap shape checks, then the home-wide cap on locked verifications, before any signature is checked. Every
        // refusal it gets is this same answer, whichever check refused, so being locked reveals nothing about the ticket it sent.
        const lockedRefusal=()=>{ sessions.doorSourceFailure(source,false); return tooMany("source_locked"); };
        if (locked && (!deviceShaped || typeof body.ticket !== "string" || body.ticket.length > 8300 || body.ticket.indexOf(".") < 1 || !options.doorTicket || !sessions.lockedVerifyAllowed("door"))) return lockedRefusal();
        let claims: ReturnType<NonNullable<typeof options.doorTicket>>|undefined, refused: DoorOutcome="door_unconfigured";
        try { claims=options.doorTicket ? options.doorTicket(doorTicketEnvelope(body.ticket)) : undefined; } catch (error) { claims=undefined; refused=doorOutcomeOf(error); }
        if (locked && !claims) return lockedRefusal();
        // The home-wide cap counts failures only: a ticket that verifies is never refused by it.
        if (!claims && !sessions.doorFailureBudgetOpen()) return tooMany("budget_closed");
        try {
          if (!claims) throw doorRefusal(refused,cloudHomeCopy.doorRequestRefused);
          if (!deviceShaped || !d) throw doorRefusal("body_malformed",cloudHomeCopy.doorRequestRefused);
          const result=sessions.enterDoor(claims,body.ticket as string,{deviceId:d.deviceId as string|null|undefined,publicKey:d.publicKey as string,assertionKey:d.assertionKey as string,proof:d.proof as string,assertionProof:d.assertionProof as string|undefined});
          logDoorOutcome(route,result.outcome);
          const {accessToken,outcome:_outcome,...answer}=result;
          if (result.scope === "browser") { res.setHeader("set-cookie",sessionCookie(accessToken,900)); reply(res,200,{state:"signed-in",...answer}); }
          else reply(res,200,{state:"signed-in",...answer,accessToken});
          return true;
        } catch (error) {
          if (locked) return lockedRefusal();
          const outcome=doorOutcomeOf(error);
          logDoorOutcome(route,outcome); sessions.doorSourceFailure(source);
          reply(res,403,{error:cloudHomeCopy.doorTicketRefused,reason:coarseDoorReason(outcome)}); return true;
        }
      }
      if (path === "/api/cloud/recovery/cancel" && method === "POST") {
        if (!device) throw new Error(cloudHomeCopy.pairedDeviceRequiredRefusal);
        sessions.cancelRecovery(String(body.recoveryId ?? "")); reply(res,200,{cancelled:true}); return true;
      }
      if (path === "/api/cloud/pairing" && method === "POST") {
        const input=sessions.verifyBootstrap(raw,String(req.headers["x-murage-signature"] ?? ""),options.bootstrapSecret() ?? "");
        // The signed body names the home generation the control plane disclosed it for (Astra STEPUP-EMAIL-7 #1). It is compared with
        // this home's OWN pin before anything is minted: a body signed for generation N never pairs a home at N+1 (a reset, a restore,
        // a re-provisioning), whatever the control plane later does. A body with no generation is a legacy control plane: accepted only
        // by a home that has no pin of its own; both cases are logged.
        let pinned: number | undefined, pinUnreadable=false;
        try { pinned=options.homeGeneration?.(); } catch { pinUnreadable=true; }
        const carried=input.generation;
        if(pinUnreadable || pinned !== undefined && (!Number.isSafeInteger(pinned) || pinned < 1 || carried !== pinned)) {
          console.warn(`[cloud] pairing refused: signed generation ${carried === undefined ? "absent" : Number.isSafeInteger(carried) ? String(carried) : "invalid"} does not match this home's generation ${pinUnreadable ? "(unreadable)" : String(pinned)}`);
          reply(res,409,{error:cloudHomeCopy.pairingGenerationRefused}); return true;
        }
        if(pinned === undefined) console.warn(`[cloud] pairing on a home with no pinned generation (signed generation ${carried === undefined ? "absent, legacy control plane" : "present, not checkable"})`);
        // The control plane authenticates the first passkey registration. After
        // that, even its HMAC cannot add a device without an existing factor.
        const hasDevices=Boolean(sessions.db.prepare("SELECT 1 FROM cloud_devices LIMIT 1").get());
        if (input.recovery === true) {
          if (!options.recoveryCleanup) throw new Error(cloudHomeCopy.recoveryCleanupUnavailable);
          const recoveryId=String(input.recoveryId ?? ""), account=String(input.account ?? "");
          if(!options.recoveryProof || options.recoveryProof(input.recoveryProof).holdId !== recoveryId) throw new Error(cloudHomeCopy.recoveryProofRefused);
          await sessions.prepareRecovery(recoveryId,account,()=>options.recoveryCleanup!(recoveryId,account));
        }
        if(hasDevices && input.recovery !== true && (!device || cloudRouteDecision(method,path,device.scope,body,true)!=="allow" || !assertion(device.id,stepPurpose(method,path+url.search,body)))) { reply(res,403,{error:cloudHomeCopy.stepUpRequired}); return true; }
        // Adding a device to a home that has (or had) one never skips the 72-hour hold: a CP-signed proof of a completed pair hold,
        // spent here, one device per hold. A paired device's step-up alone (a stolen, unlocked desktop) is not enough.
        // An add-device body (it carries a pair hold) is held to its proof even when this home has no device (yet, or any more): an
        // empty home never mints from an add-device disclosure on the strength of its HMAC alone (Astra STEPUP-EMAIL-7 #1).
        const addDeviceBody=input.pairHoldId !== undefined || input.pairHoldProof !== undefined;
        if((hasDevices || addDeviceBody) && input.recovery !== true) {
          // The control plane spent the hold on exactly one device (its scope and keys, in its own state, which no restore of this home
          // rolls back) and signed that device's digest into the proof: any other device is refused, whatever this database remembers.
          let proof:{holdId:string;deviceKeyDigest?:string}={holdId:""};
          try { proof=options.recoveryProof ? options.recoveryProof(input.pairHoldProof) : proof; } catch { proof={holdId:""}; }
          const device=pairDeviceDigest({scope:String(input.scope ?? ""),publicKey:String(input.publicKey ?? ""),assertionKey:String(input.assertionKey ?? "")});
          if(!proof.holdId || proof.holdId !== input.pairHoldId || proof.deviceKeyDigest !== device || !sessions.consumePairHold(proof.holdId,String(input.account ?? ""))) { reply(res,403,{error:cloudHomeCopy.pairHoldRequired}); return true; }
        }
        const {pairHoldId:_holdId,pairHoldProof:_holdProof,...pairing}=input as Record<string,unknown>;
        // The code records the generation it was minted at (the home's own pin, never the body's); redemption compares it with the pin
        // as it is THEN, and codes from any other generation are dropped the moment the pin appears or changes (Astra STEPUP-EMAIL-8 #1).
        sessions.dropSupersededCodes(pinned);
        const code=sessions.mint({...pairing,homeGeneration:pinned ?? null} as unknown as PairingInput); reply(res,200,{code,expiresIn:input.ttl ?? 600}); return true;
      }
      if (path === "/api/cloud/pair" && method === "POST") {
        const result=sessions.redeem(String(body.code ?? ""),String(body.account ?? ""),String(body.signature ?? ""),body.webauthn ? JSON.stringify(body.webauthn) : String(body.assertionSignature ?? ""),cloudClientIp(req,options.trustedProxy),()=>options.homeGeneration?.());
        if(result.scope === "browser") { res.setHeader("set-cookie",sessionCookie(result.accessToken,900)); const {accessToken: _token,...publicResult}=result; reply(res,200,publicResult); }
        else reply(res,200,result);
        return true;
      }
      if (path === "/api/cloud/challenge" && method === "POST") {
        const id=String(body.deviceId ?? "");
        const purpose=typeof body.purpose === "string" ? body.purpose : "refresh";
        if(purpose!=="refresh" && (!device || device.id!==id)) { reply(res,401,{error:cloudHomeCopy.signInRequired}); return true; }
        if(purpose.length>1024) throw new Error(cloudHomeCopy.invalidChallenge);
        reply(res,200,{challenge:sessions.challenge(id,purpose),environmentId:sessions.environmentId}); return true;
      }
      if (path === "/api/cloud/refresh" && method === "POST") {
        const result=sessions.refresh(String(body.deviceId ?? ""),String(body.challenge ?? ""),Number(body.at),String(body.signature ?? ""));
        if(result.scope === "browser") { res.setHeader("set-cookie",sessionCookie(result.accessToken,900)); const {accessToken:_token,...publicResult}=result; reply(res,200,publicResult); } else reply(res,200,result);
        return true;
      }
      if (path.startsWith("/api/") || path === "/api") {
        let decision=cloudRouteDecision(method,path,scope,body);
        if(decision === "step-up required" && device && assertion(device.id,stepPurpose(method,path+url.search,body))) decision=cloudRouteDecision(method,path,ownerBrowserScope(device) ?? device.scope,body,true);
        if(decision!=="allow") { reply(res,403,{error:decision === "deny" ? device?.scope === "owner-phone" ? cloudHomeCopy.phoneCredential : cloudHomeCopy.pairedDeviceRequired : cloudHomeCopy.stepUpRequired}); return true; }
        if(path === "/api/cloud/account" && method === "DELETE") { if (device) await options.beforeAccountRevoke?.(device); sessions.revokeAccount(); reply(res,200,{revoked:true}); return true; }
        const revoke=/^\/api\/cloud\/devices\/([a-f0-9-]+)$/.exec(path);
        if(revoke && method === "DELETE") { sessions.revoke(revoke[1]!); reply(res,200,{revoked:true}); return true; }
        // "Make this browser chat-only" from a paired owner surface: sensitive (devices/[^/]+), so it passed a step-up above.
        const ownerRevoke=/^\/api\/cloud\/devices\/([a-f0-9-]+)\/owner\/revoke$/.exec(path);
        if(ownerRevoke && method === "POST") { sessions.revokeOwnerFactor(ownerRevoke[1]!); reply(res,200,{revoked:true}); return true; }
      }
      responses.track(res,bindings);
      return false;
    } catch (error) {
      const status=(error as {status?:number}).status;
      early(status === 413 ? "body_too_large" : error instanceof SyntaxError ? "body_malformed" : "internal_error");
      if (status === 503) res.setHeader("retry-after","2");
      // A refused challenge or refresh says whether the device was removed or the account is paused, so a computer forgets its
      // sign-in only when it was really removed. Nothing else carries a reason.
      const reason=(path === "/api/cloud/challenge" || path === "/api/cloud/refresh") && status !== 413 && status !== 503 ? (error as {reason?:unknown}).reason : undefined;
      reply(res,status===413?413:status===503?503:403,{error:status===413?cloudHomeCopy.bodyTooLarge:status===503?cloudHomeCopy.controlPlaneActionUnavailable:cloudHomeCopy.signInRequestRefused, ...(reason === "revoked" || reason === "suspended" ? {reason} : {}), ...(path === "/.well-known/murage/environment" ? {environmentId:sessions.environmentId} : {})}); return true; }
  };
}
