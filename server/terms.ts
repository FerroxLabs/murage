// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Terms acceptance: which version of the Terms of Service and Privacy Policy
// this install's owner accepted, when, and in which app version.
//
// The record lives in DATA_DIR/terms-acceptance.json (owner-only, written
// through writeFileAtomic), never only in the browser, so it survives a
// reinstall of the app, a cleared browser and a second device. The renderer
// shows the acceptance screen until the current TERMS_VERSION (shared/terms.ts)
// is on record, and the server only records it; this file does not stop
// background work (routines, channels) for an install that has not accepted
// yet, so an update never silently halts someone's automations.
//
// HEADLESS AND CLOUD SETUPS. There is no screen to tick, so an operator who
// has accepted the terms for that install on the owner's behalf (or an
// automated test) sets MURAGE_TERMS_ACCEPTED=<TERMS_VERSION> in the server's
// environment. The status then reads accepted with source "environment" and
// nothing is written. It is deliberately not exposed in the app's UI, and it
// only counts when it names the exact current version.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PRIVACY_URL, TERMS_URL, TERMS_VERSION, type TermsStatus } from "../shared/terms.ts";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { verifiedTermsProof, type ControlPlanePublicJwk, type TermsProofClaims } from "./cloud-home/b1b-identity.ts";
import type { CpCallOptions, CpResult } from "./cloud-home/cp-client.ts";

const FILE = "terms-acceptance.json";
const KEEP = 20;
const APP_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.]{1,16})?$/;
const TERMS_VERSION_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** The control plane's signed envelope, kept verbatim in the row it seeded (base64url payload and signature). */
export interface TermsProofEnvelope { payload: string; signature: string }

export interface TermsRecord {
  version: string;
  acceptedAt: string;
  appVersion?: string;
  /** Only on a Cloud home's row seeded from the checkout acceptance; the proof is what makes it count there. */
  source?: "checkout" | "reaccept";
  proof?: TermsProofEnvelope;
}

const B64URL = /^[A-Za-z0-9_-]+$/;
function proofOf(value: unknown): TermsProofEnvelope | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { payload, signature } = value as Record<string, unknown>;
  return typeof payload === "string" && payload.length <= 8192 && B64URL.test(payload) && typeof signature === "string" && signature.length <= 200 && B64URL.test(signature)
    ? { payload, signature } : undefined;
}

function isRecordShape(value: unknown): value is TermsRecord {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.version === "string" && TERMS_VERSION_SHAPE.test(raw.version)
    && typeof raw.acceptedAt === "string" && !Number.isNaN(Date.parse(raw.acceptedAt));
}

/** Every acceptance on record, oldest first. A missing or damaged file reads
 * as none, which asks the owner again, the right way round for a legal record. */
export function readTermsRecords(dir: string = DATA_DIR): TermsRecord[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, FILE), "utf8"));
    const list = parsed && typeof parsed === "object" && Array.isArray((parsed as { accepted?: unknown }).accepted)
      ? (parsed as { accepted: unknown[] }).accepted : [];
    return list.filter(isRecordShape).map((entry) => {
      const proof = proofOf((entry as { proof?: unknown }).proof);
      const source = (entry as { source?: unknown }).source;
      return {
        version: entry.version,
        acceptedAt: entry.acceptedAt,
        ...(typeof entry.appVersion === "string" && APP_VERSION.test(entry.appVersion) ? { appVersion: entry.appVersion } : {}),
        ...(source === "checkout" || source === "reaccept" ? { source } : {}),
        ...(proof ? { proof } : {}),
      };
    });
  } catch {
    return [];
  }
}

/** What a Cloud home needs to read the terms record: the pinned control-plane binding, the owner and a way to ask the control plane. */
export interface TermsHomeDeps {
  binding(): { homeId: string; generation: number; publicJwk: ControlPlanePublicJwk };
  owner(): string | undefined;
  call(op: string, fields: Record<string, unknown>, opts: CpCallOptions): Promise<CpResult>;
  now?: () => number;
}
export type TermsPull = "recorded" | "grace" | "none" | "unavailable";
export interface TermsHome {
  /** A row counts on a home only when its proof verifies for this home, generation, owner and version. */
  rowCounts(row: TermsRecord): boolean;
  /** A notice-period proof held in memory (never in the file), live until its graceUntil. */
  grace(): { acceptedAt: string } | undefined;
  /** Ask the control plane for a proof when none counts. Single flight; "none" is remembered for 30 s unless `fresh`. */
  pull(dir: string, fresh?: boolean): Promise<TermsPull>;
}
export const TERMS_NEGATIVE_CACHE_MS = 30_000;
const TERMS_PROOF_TIMEOUT_MS = 3000;
/** A "check again" skips the 30 s cache but not a "none" answered in the last few seconds. */
const TERMS_FRESH_MIN_GAP_MS = 5000;

function onHome(env: NodeJS.ProcessEnv, home?: TermsHome): boolean {
  return env.MURAGE_CLOUD_ROLE === "home" || home !== undefined;
}

export function createTermsHome(deps: TermsHomeDeps): TermsHome {
  const now = () => deps.now?.() ?? Date.now();
  const verified = new Map<string, boolean>();
  let held: { claims: TermsProofClaims; until: number } | undefined;
  let flight: Promise<TermsPull> | undefined;
  let noneAt = -Infinity;

  /** The claims of a proof that checks out for this home right now, else undefined. Nothing here reads the row's own labels. */
  const claimsFor = (proof: TermsProofEnvelope, version: string): TermsProofClaims | undefined => {
    try {
      const binding = deps.binding();
      const owner = deps.owner();
      if (!owner) return undefined;
      const claims = verifiedTermsProof(proof, binding.publicJwk, binding.homeId, binding.generation);
      if (claims.account !== owner || claims.homeTermsVersion !== version || claims.ageConfirmed !== true || claims.acceptedAt > claims.issuedAt) return undefined;
      return claims;
    } catch {
      return undefined;
    }
  };
  const cacheKey = (row: TermsRecord): string | undefined => {
    if (!row.proof) return undefined;
    try {
      const binding = deps.binding();
      return createHash("sha256").update(`${row.proof.payload}.${row.proof.signature}|${binding.homeId}|${binding.generation}|${deps.owner() ?? ""}|${row.version}|${row.acceptedAt}`).digest("hex");
    } catch {
      return undefined;
    }
  };
  const rowCounts = (row: TermsRecord): boolean => {
    const key = cacheKey(row);
    if (!key || !row.proof) return false;
    const known = verified.get(key);
    if (known !== undefined) return known;
    const claims = claimsFor(row.proof, row.version);
    // A stored row is a checkout or site acceptance, never a notice-period grace; its time is the signed time.
    const ok = !!claims && claims.source !== "notice-period" && row.acceptedAt === new Date(claims.acceptedAt).toISOString();
    if (verified.size > 64) verified.clear();
    verified.set(key, ok);
    return ok;
  };
  const grace = () => {
    if (held && held.until > now()) return { acceptedAt: new Date(held.claims.acceptedAt).toISOString() };
    held = undefined;
    return undefined;
  };
  const run = async (dir: string): Promise<TermsPull> => {
    let result: CpResult;
    try {
      result = await deps.call("terms-proof", { homeTermsVersion: TERMS_VERSION }, { timeoutMs: TERMS_PROOF_TIMEOUT_MS, generation: () => { try { return deps.binding().generation; } catch { return null; } } });
    } catch {
      return "unavailable";
    }
    if (!result.ok) return "unavailable";
    const body = result.body as { status?: unknown; proof?: unknown } | undefined;
    if (body?.status === "none") { noneAt = now(); return "none"; }
    const proof = body?.status === "proof" ? proofOf(body.proof) : undefined;
    if (!proof) return "unavailable";
    const claims = claimsFor(proof, TERMS_VERSION);
    if (!claims) return "unavailable";
    if (claims.source === "notice-period") {
      if (typeof claims.graceUntil !== "number" || claims.graceUntil <= now()) { noneAt = now(); return "none"; }
      held = { claims, until: claims.graceUntil };
      return "grace";
    }
    recordCheckoutAcceptance(claims, proof, dir);
    return "recorded";
  };
  const pull = (dir: string, fresh = false): Promise<TermsPull> => {
    if (flight) return flight;
    const t = now();
    if (t - noneAt < (fresh ? TERMS_FRESH_MIN_GAP_MS : TERMS_NEGATIVE_CACHE_MS)) return Promise.resolve("none");
    flight = run(dir).finally(() => { flight = undefined; });
    return flight;
  };
  return { rowCounts, grace, pull };
}

export function termsStatus(dir: string = DATA_DIR, env: NodeJS.ProcessEnv = process.env, home?: TermsHome): TermsStatus {
  const cloud = onHome(env, home);
  // A declared acceptance has no signature: it never counts on a Cloud home.
  if (!cloud && env.MURAGE_TERMS_ACCEPTED === TERMS_VERSION) return { version: TERMS_VERSION, accepted: true, source: "environment" };
  const all = readTermsRecords(dir);
  // On a home a row counts only with a proof that verifies, whatever its source label says.
  const records = cloud ? all.filter((row) => home?.rowCounts(row) === true) : all;
  const current = records.find((entry) => entry.version === TERMS_VERSION);
  if (current) return { version: TERMS_VERSION, accepted: true, acceptedVersion: current.version, acceptedAt: current.acceptedAt, source: "record" };
  const held = cloud ? home?.grace() : undefined;
  if (held) return { version: TERMS_VERSION, accepted: true, acceptedVersion: TERMS_VERSION, acceptedAt: held.acceptedAt, source: "record" };
  const last = records.at(-1);
  return { version: TERMS_VERSION, accepted: false, ...(last ? { acceptedVersion: last.version, acceptedAt: last.acceptedAt } : {}) };
}

function writeRecords(dir: string, records: TermsRecord[]): void {
  writeFileAtomic(join(dir, FILE), JSON.stringify({ accepted: records.slice(-KEEP), termsUrl: TERMS_URL, privacyUrl: PRIVACY_URL }, null, 2) + "\n", { mode: 0o600 });
}

export function recordTermsAcceptance(
  input: { appVersion?: string },
  dir: string = DATA_DIR,
  now: () => Date = () => new Date(),
): TermsStatus {
  const records = readTermsRecords(dir).filter((entry) => entry.version !== TERMS_VERSION);
  const entry: TermsRecord = {
    version: TERMS_VERSION,
    acceptedAt: now().toISOString(),
    ...(input.appVersion && APP_VERSION.test(input.appVersion) ? { appVersion: input.appVersion } : {}),
  };
  writeRecords(dir, [...records, entry]);
  return termsStatus(dir, {});
}

/** Seed the record from the control plane's signed checkout acceptance. The caller has verified the proof for this home;
 *  acceptedAt is the checkout time, never the time of seeding. */
export function recordCheckoutAcceptance(claims: TermsProofClaims, proof: TermsProofEnvelope, dir: string = DATA_DIR): void {
  const records = readTermsRecords(dir).filter((entry) => entry.version !== claims.homeTermsVersion);
  const source = claims.source === "reaccept" ? "reaccept" : "checkout";
  writeRecords(dir, [...records, { version: claims.homeTermsVersion, acceptedAt: new Date(claims.acceptedAt).toISOString(), source, proof: { payload: proof.payload, signature: proof.signature } }]);
}

type ApiAnswer = { status: number; body: unknown };

export async function handleTermsApi(
  request: { method: string; path: string; readBody: () => Promise<unknown>; fresh?: boolean },
  dir: string = DATA_DIR,
  env: NodeJS.ProcessEnv = process.env,
  home?: TermsHome,
  ownerSet: () => boolean = () => false,
): Promise<ApiAnswer | null> {
  const { method, path } = request;
  const cloud = onHome(env, home);
  if (path === "/api/terms" && method === "GET") {
    const status = termsStatus(dir, env, home);
    if (!cloud || status.accepted || !home || !ownerSet()) return { status: 200, body: status };
    // Any session reaching this route pulls: terms need no owner factor, the account fact comes from the signature.
    const pulled = await home.pull(dir, request.fresh === true);
    if (pulled === "unavailable") return { status: 503, body: { error: "Murage could not check your terms agreement just now. Try again in a moment." } };
    return { status: 200, body: termsStatus(dir, env, home) };
  }
  if (path === "/api/terms/accept" && method === "POST") {
    // On a home the customer agrees on the site, where the control plane records it; the home writes nothing.
    if (cloud) return { status: 409, body: { code: "accept_on_site", error: "Agree to the terms on murage.ai." } };
    let body: unknown;
    try {
      body = await request.readBody();
    } catch {
      return { status: 400, body: { error: "The request could not be read. Try again." } };
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, body: { error: "Send { version, ageConfirmed }." } };
    const { version, ageConfirmed, appVersion, ...rest } = body as Record<string, unknown>;
    if (Object.keys(rest).length) return { status: 400, body: { error: `Unknown field: ${Object.keys(rest)[0]}` } };
    if (ageConfirmed !== true) return { status: 400, body: { error: "Confirm that you are 18 or older and agree to the terms." } };
    // An older screen left open across an update must not accept newer terms it never showed.
    if (version !== TERMS_VERSION) return { status: 409, body: { error: "The terms were updated. Reload Murage to read them.", version: TERMS_VERSION } };
    if (appVersion !== undefined && (typeof appVersion !== "string" || !APP_VERSION.test(appVersion))) {
      return { status: 400, body: { error: "appVersion must look like 1.0.2." } };
    }
    return { status: 200, body: recordTermsAcceptance({ appVersion: appVersion as string | undefined }, dir) };
  }
  if (path === "/api/terms" || path === "/api/terms/accept") return { status: 405, body: { error: "method not allowed" } };
  return null;
}
