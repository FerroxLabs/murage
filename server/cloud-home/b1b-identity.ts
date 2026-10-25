// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { cloudHomeCopy, cloudHomeInternal } from "./copy.ts";
import { doorRefusal, type DoorOutcome } from "./door-log.ts";
import { createPublicKey, verify } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
export interface SignedHomeKey { algorithm: "ES256"; payload: string; signature: string }
export interface ControlPlanePublicJwk { kty?: string; crv?: string; x?: string; y?: string; d?: string }
/** Signed identity and verifier key are public, immutable root-owned metadata. */
export function readHomePublicMetadata(file: string): string {
  const fd=openProtectedRootFile(file);
  try {
    const stat=fstatSync(fd);
    if(!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) || stat.size > 16_384)throw new Error(cloudHomeCopy.homeIdentityRefused);
    const buffer=Buffer.alloc(16_385);let size=0;
    while(size<buffer.length){const count=readSync(fd,buffer,size,buffer.length-size,null);if(!count)break;size+=count;}
    if(size>16_384)throw new Error(cloudHomeCopy.homeIdentityRefused);
    return buffer.subarray(0,size).toString("utf8");
  } finally {closeSync(fd);}
}
/** Descriptor-relative traversal keeps every root-owned parent pinned while opening its child. */
export function openProtectedRootFile(file: string): number {
  if(!file.startsWith("/") || resolve(file)!==file)throw new Error(cloudHomeCopy.homeIdentityRefused);
  const parts=file.slice(1).split("/");let parent=openSync("/",constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try {
    for(let i=0;i<parts.length;i++){
      const stat=fstatSync(parent);
      if(!stat.isDirectory() || stat.uid!==0 || (stat.mode&0o022))throw new Error(cloudHomeCopy.homeIdentityRefused);
      const child=openSync(`/proc/self/fd/${parent}/${parts[i]}`,constants.O_RDONLY|constants.O_NOFOLLOW|(i<parts.length-1?constants.O_DIRECTORY:0));
      closeSync(parent);parent=child;
    }
    const stat=fstatSync(parent);
    if(!stat.isFile() || stat.uid!==0 || (stat.mode&0o022))throw new Error(cloudHomeCopy.homeIdentityRefused);
    const result=parent;parent=-1;return result;
  } finally {if(parent>=0)closeSync(parent);}
}
function verifiedPayload(input: SignedHomeKey, publicJwk: ControlPlanePublicJwk): Record<string,unknown> {
  if (!input || input.algorithm !== "ES256" || typeof input.payload !== "string" || input.payload.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(input.payload) || typeof input.signature !== "string" || !/^[A-Za-z0-9_-]+$/.test(input.signature) || Buffer.from(input.signature,"base64url").length !== 64
    || publicJwk.d !== undefined || publicJwk.kty !== "EC" || publicJwk.crv !== "P-256") throw new Error(cloudHomeCopy.homeIdentityRefused);
  const key=createPublicKey({key:publicJwk,format:"jwk"});
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1" || !verify("sha256",Buffer.from(input.payload),{key,dsaEncoding:"ieee-p1363"},Buffer.from(input.signature,"base64url"))) throw new Error(cloudHomeCopy.homeIdentityRefused);
  const claims=JSON.parse(Buffer.from(input.payload,"base64url").toString("utf8"));
  if(!claims || typeof claims !== "object" || Array.isArray(claims))throw new Error(cloudHomeCopy.homeIdentityRefused);
  return claims;
}
function boundClaims(claims: Record<string,unknown>, homeId: string, generation: number, now: number, ttl: number): boolean {
  return !!homeId && Number.isSafeInteger(generation) && generation>0 && claims.homeId === homeId && claims.generation === generation && typeof claims.issuedAt === "number" && Number.isSafeInteger(claims.issuedAt) && claims.issuedAt <= now && typeof claims.expiresAt === "number" && Number.isSafeInteger(claims.expiresAt) && claims.expiresAt > now && claims.expiresAt <= claims.issuedAt+ttl;
}
/** Same ES256 envelope as CP b3-signatures.ts; local generation is independently pinned. */
export function verifiedHomeIdentity(input: SignedHomeKey, publicJwk: ControlPlanePublicJwk, homeId: string, generation: number, publicOrigin: string, now = Date.now()): { homeKey: SignedHomeKey } {
  const claims=verifiedPayload(input,publicJwk),fields=["type","homeId","generation","homeKey","publicOrigin","issuedAt","expiresAt"];
  if(Object.keys(claims).some(k=>!fields.includes(k)) || claims.type !== "murage-home-key-v1" || !boundClaims(claims,homeId,generation,now,3_600_000) || claims.publicOrigin !== publicOrigin || typeof claims.homeKey !== "string" || !claims.homeKey || claims.homeKey.length > 4096)throw new Error(cloudHomeCopy.homeIdentityRefused);
  return {homeKey:{algorithm:input.algorithm,payload:input.payload,signature:input.signature}};
}
/** A verified hold is evidence of elapsed hold, never evidence of cleanup or key rotation. */
export function verifiedRecoveryHold(input: SignedHomeKey, publicJwk: ControlPlanePublicJwk, homeId: string, generation: number, now = Date.now()): {holdId:string;deviceKeyDigest?:string} {
  const claims=verifiedPayload(input,publicJwk),fields=["type","homeId","generation","holdId","action","holdStartedAt","holdCompletedAt","cancelState","deviceKeyDigest","issuedAt","expiresAt"];
  if(Object.keys(claims).some(k=>!fields.includes(k)) || claims.type !== "murage-recovery-v1" || !boundClaims(claims,homeId,generation,now,300_000) || claims.action !== "pair" || claims.cancelState !== "not_canceled" || typeof claims.holdId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(claims.holdId) || typeof claims.holdStartedAt !== "number" || !Number.isSafeInteger(claims.holdStartedAt) || typeof claims.holdCompletedAt !== "number" || !Number.isSafeInteger(claims.holdCompletedAt) || claims.holdCompletedAt < claims.holdStartedAt+72*3_600_000 || claims.holdCompletedAt > (claims.issuedAt as number) || (claims.deviceKeyDigest !== undefined && (typeof claims.deviceKeyDigest !== "string" || !/^[0-9a-f]{64}$/.test(claims.deviceKeyDigest))))throw new Error(cloudHomeCopy.recoveryHoldRefused);
  // deviceKeyDigest: the one device the control plane spent this pair hold on (its scope and keys); see pairDeviceDigest.
  return claims.deviceKeyDigest === undefined ? {holdId:claims.holdId} : {holdId:claims.holdId,deviceKeyDigest:claims.deviceKeyDigest as string};
}

const doorTicketSchema = z.object({
  type: z.literal("murage-door-v2"), homeId: z.string().min(1).max(128), generation: z.number().int().positive(),
  publicOrigin: z.string().min(1).max(256), account: z.string().min(1).max(256), nonce: z.string().regex(/^[A-Za-z0-9_-]{22,43}$/),
  stepUpAt: z.number().int(), issuedAt: z.number().int(), expiresAt: z.number().int(),
  /** sha256 hex of the SPKI DER of the session public key this ticket was minted for. */
  bind: z.string().regex(/^[0-9a-f]{64}$/), kind: z.enum(["browser","desktop"]),
  /** Only a desktop ticket for a home that has (or had) a full-scope device: the completed pair hold the CP reserved. */
  pairHold: z.string().regex(/^[\w-]{16,128}$/).optional(),
  /** CP-signed proof this ticket's sign-in carried an emailed code (`email`) or a trusted authenticator (`factor`): the
   *  remembered-owner factor is issued only for a browser ticket that carries it (§4.1, §4.4). Absent = a chat-level browser. */
  proof: z.enum(["email","factor"]).optional(),
}).strict();
export type DoorTicketClaims = z.infer<typeof doorTicketSchema>;
/** The URL fragment value `<payload>.<signature>` (split on the first dot) as the same ES256 envelope the home-key verifier takes. */
export function doorTicketEnvelope(ticket: unknown): SignedHomeKey {
  if (typeof ticket !== "string" || ticket.length > 8300) throw doorRefusal("ticket_malformed", cloudHomeCopy.doorTicketRefused);
  const dot = ticket.indexOf(".");
  if (dot < 1) throw doorRefusal("ticket_malformed", cloudHomeCopy.doorTicketRefused);
  return { algorithm: "ES256", payload: ticket.slice(0, dot), signature: ticket.slice(dot + 1) };
}
/** Which bound check a refused ticket failed, in the order a reader would look: wrong home, then lifetime, then step-up. */
function ticketRefusal(claims: DoorTicketClaims, homeId: string, generation: number, publicOrigin: string, now: number): DoorOutcome {
  if (!homeId || !Number.isSafeInteger(generation) || generation <= 0 || claims.homeId !== homeId || claims.generation !== generation || claims.publicOrigin !== publicOrigin) return "ticket_wrong_home";
  if (claims.expiresAt <= now) return "ticket_expired";
  if (claims.issuedAt > now || claims.expiresAt > claims.issuedAt + 60_000) return "ticket_bad_times";
  return "ticket_stale_step_up";
}
/** A 60-second, single-use door ticket. Signature, type, home, generation, origin and lifetime are checked here;
 *  the account, suspension and nonce are checked by the home's session store when it spends the ticket. */
export function verifiedDoorTicket(input: SignedHomeKey, publicJwk: ControlPlanePublicJwk, homeId: string, generation: number, publicOrigin: string, now = Date.now()): DoorTicketClaims {
  // Every refusal is the same error to the caller; the outcome it carries only names which check refused, for the door log.
  const refuse = (outcome: DoorOutcome) => doorRefusal(outcome, cloudHomeCopy.doorTicketRefused);
  let payload: Record<string,unknown>, claims: DoorTicketClaims;
  try { payload = verifiedPayload(input, publicJwk); } catch { throw refuse(cloudHomeInternal.ticketBadSignature); }
  // A ticket of any other type (the first door version) is named as such, before the full parse would call it malformed.
  if (payload.type !== "murage-door-v2") throw refuse(cloudHomeInternal.ticketWrongType);
  try { claims = doorTicketSchema.parse(payload); } catch { throw refuse(cloudHomeInternal.ticketMalformed); }
  if (!boundClaims(claims, homeId, generation, now, 60_000) || claims.publicOrigin !== publicOrigin
    || claims.stepUpAt > claims.issuedAt || claims.stepUpAt < claims.issuedAt - 900_000) throw refuse(ticketRefusal(claims, homeId, generation, publicOrigin, now));
  return claims;
}
