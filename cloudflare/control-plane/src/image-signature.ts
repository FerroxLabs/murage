// SPDX-License-Identifier: AGPL-3.0-or-later
// Signed-image gate: no home or pool server is created or rebuilt by the Worker from an image that fails verifyImageForUse.
// The payload, field rules and trust lists are shared with scripts/check-deploy.mjs (scripts/image-sig.mjs). Only creation paths call this;
// a running home's restart never does, so an expired signature blocks new boots, rebuilds and pool fills and nothing else.
import { persistAlert } from "./ops-monitor";
import { isStagingEnv, type ProvisionerConfig } from "./b5-config";
import {
  ACCEPTED_CHECK_SHA256, DAY_MS, IMAGE_SIG_ALERT_DAYS, IMAGE_SIG_MAX_AGE_DAYS, RECHECK_TIMEOUT_MS, RECHECK_TTL_MS, REVOKED_IMAGE_IDS,
  TRUSTED_IMAGE_KEY_FPS, b64urlEncode, buildPayload, daysLeft, decodeStoredSig, imageSizeText, parseCreatedMs, parseCustomerEntry, parseVerifiedAtMs,
  validImageId,
} from "../scripts/image-sig.mjs";

declare global {
  // CLOUD_PROVISIONING_OPEN ("false" refuses every creation) and CLOUD_FREEZE ("true" is the FROZEN prerequisite of image readiness) are set by the
  // freeze deploy only; absent means normal operation, so they are typed here and not in wrangler.jsonc vars.
  interface Env { B5_IMAGE_VERIFY_PUBKEY?: string; CLOUD_PROVISIONING_OPEN?: string; CLOUD_FREEZE?: string }
  namespace Cloudflare { interface Env { B5_IMAGE_VERIFY_PUBKEY?: string; CLOUD_PROVISIONING_OPEN?: string; CLOUD_FREEZE?: string } }
}
/** Set by wrangler `define` at deploy time ("production" or "staging"). Absent in tests and local runs: then CLOUD_CP0_STAGING decides. */
declare const __MURAGE_BUILD_ENV__: string | undefined;

/** Bumped by any change to the trusted fingerprints, the revoked ids or the accepted check hashes. */
export const IMAGE_POLICY_EPOCH = 2;

export type BuildEnv = "production" | "staging";
export type SigEnv = "prod" | "staging";
export const sigEnvOf = (b: BuildEnv): SigEnv => (b === "production" ? "prod" : "staging");

export class ImageRefused extends Error {
  /** A refusal thrown before any provider call: the create is "not sent". */
  readonly notSent = true;
  constructor(public readonly code: string) { super(code); }
}

export interface ImageTrust { fps: readonly string[]; checks: readonly string[]; revoked: readonly string[]; epoch: number }
export const DEFAULT_TRUST: ImageTrust = { fps: TRUSTED_IMAGE_KEY_FPS, checks: ACCEPTED_CHECK_SHA256, revoked: REVOKED_IMAGE_IDS, epoch: IMAGE_POLICY_EPOCH };
export interface VerifyDeps { fetch?: (input: string, init?: RequestInit) => Promise<Response>; trust?: ImageTrust; buildEnv?: BuildEnv }

export interface VerifiedImage {
  readonly provider: "hetzner" | "vultr"; readonly image: string; readonly arch: "x86" | "arm";
  readonly env: SigEnv; readonly expiresAt: number; readonly epoch: number;
  /** When this verification stops being true for readiness (KMS design 10.5): min(signature expiry, re-check expiry). expiresAt is the 60 s capability. */
  readonly validUntil: number;
  /** The signing key and check hash the verdict rests on (a revocation of either finds the dispatches that used it, 10.6). */
  readonly keyFp: string; readonly checkSha256: string;
}
/** Every capability remembers the database of the environment that minted it: the dispatch authorization (below) is taken there. */
const issued = new WeakMap<object, D1Database>();
function mint(v: VerifiedImage, db: D1Database): VerifiedImage { const f = Object.freeze({ ...v }); issued.set(f, db); return f; }

/** KMS 9.6 / 10.4 / 10.6 (13.1 H1): the adapters call this right before the POST of every create or rebuild. It records the authorization with ONE
 *  conditional INSERT that only lands while the durable epoch is not above the capability's, so an epoch raised after the capability was minted (a
 *  revocation, a new bundle) refuses the dispatch. Returns the dispatch_id, which the create puts in its labels as murage/dispatch. A rebuild passes the
 *  server it rebuilds (`serverId`), recorded at the INSERT so the sweep never needs a label lookup for it. Nothing has been sent when it throws; a D1
 *  error fails closed. */
export async function authorizeDispatch(v: VerifiedImage, now: number, opts: { serverId?: string } = {}): Promise<string> {
  const db = typeof v === "object" && v !== null ? issued.get(v) : undefined;
  if (!db) throw new ImageRefused("image_unverified_call");
  const id = crypto.randomUUID();
  let changes = 0;
  try {
    changes = (await db.prepare(`INSERT INTO image_dispatch_auth (dispatch_id,epoch,key_fp,check_sha256,image,created_at,state,provider_server_id)
      SELECT ?,?,?,?,?,?,'open',? WHERE (SELECT epoch FROM image_policy WHERE id='current') <= ?`)
      .bind(id, v.epoch, v.keyFp, v.checkSha256, v.image, now, opts.serverId ?? null, v.epoch).run()).meta.changes;
  } catch { throw new ImageRefused("image_recheck_failed"); }
  if (changes !== 1) throw new ImageRefused("image_policy_rolled_back");
  return id;
}

/** What the provider said to the POST of an authorized dispatch. `created` is a parsed answer with the new server's id; `refused` is a parsed provider
 *  refusal (a 4xx body). A timeout, a network error or a 5xx is neither: the dispatch stays `open` (13.1 H4). */
export type DispatchOutcome = { created: string } | { refused: true };
/** Records the provider's answer. Every transition is a conditional UPDATE on the expected prior state (`open`), so a race cannot move a row twice. The
 *  server id is recorded even when the row has meanwhile been marked needs_review (an activation or revocation that landed while the POST was in flight),
 *  because the sweep reads the server by exact id. Never throws: the create has already happened, a lost settle only leaves the row for the sweep. */
export async function settleDispatch(v: VerifiedImage, dispatchId: string, outcome: DispatchOutcome, now: number): Promise<void> {
  const db = typeof v === "object" && v !== null ? issued.get(v) : undefined;
  if (!db) return;
  try {
    if ("created" in outcome) {
      await db.batch([
        db.prepare("UPDATE image_dispatch_auth SET provider_server_id=? WHERE dispatch_id=? AND provider_server_id IS NULL").bind(outcome.created, dispatchId),
        db.prepare("UPDATE image_dispatch_auth SET state='settled_created',settled_at=? WHERE dispatch_id=? AND state='open'").bind(now, dispatchId),
      ]);
    } else {
      await db.prepare("UPDATE image_dispatch_auth SET state='settled_failed',settled_at=? WHERE dispatch_id=? AND state='open'").bind(now, dispatchId).run();
    }
  } catch { /* the row stays open; the sweep covers it */ }
}

/** The adapters call this before any fetch. A copy, a stale capability, another provider or another environment is refused as not sent. */
export function assertVerifiedImage(v: unknown, want: { provider: "hetzner" | "vultr"; now: number; env?: SigEnv }): VerifiedImage {
  if (typeof v !== "object" || v === null || !issued.has(v)) throw new ImageRefused("image_unverified_call");
  const x = v as VerifiedImage;
  if (x.provider !== want.provider || (want.env && x.env !== want.env) || want.now > x.expiresAt) throw new ImageRefused("image_unverified_call");
  return x;
}

export function buildEnvOf(env: unknown, deps?: VerifyDeps): BuildEnv | "conflict" | "invalid" {
  const declared = deps?.buildEnv ?? (typeof __MURAGE_BUILD_ENV__ === "string" ? __MURAGE_BUILD_ENV__ : (isStagingEnv(env) ? "staging" : "production"));
  if (declared === "production") return isStagingEnv(env) ? "conflict" : "production";
  if (declared === "staging") return "staging";
  return "invalid";
}

// ---- key handling ---------------------------------------------------------------------------------------------------------------------

const hex = (b: ArrayBuffer | Uint8Array) => Array.from(b instanceof Uint8Array ? b : new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
export const sha256Hex = async (data: string | Uint8Array) =>
  hex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? new TextEncoder().encode(data) : (data as BufferSource)));
const fromB64 = (s: string): Uint8Array | null => {
  try { if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null; const bin = atob(s); return Uint8Array.from(bin, (c) => c.charCodeAt(0)); } catch { return null; }
};
export interface LoadedKey { fp: string; key: CryptoKey }
/** The comma-separated SPKI list of B5_IMAGE_VERIFY_PUBKEY: at most two, each a P-256 key whose fingerprint is pinned in code. Null when invalid. */
export async function loadVerifyKeys(raw: string | undefined, trust: ImageTrust): Promise<LoadedKey[] | null> {
  if (!raw || !raw.trim()) return null;
  const parts = raw.split(",").map((p) => p.trim());
  if (parts.length > 2 || parts.some((p) => !p)) return null;
  const out: LoadedKey[] = [];
  for (const p of parts) {
    const der = fromB64(p);
    if (!der) return null;
    const fp = await sha256Hex(der);
    if (!trust.fps.includes(fp)) return null;
    try { out.push({ fp, key: await crypto.subtle.importKey("spki", der as BufferSource, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]) }); }
    catch { return null; }
  }
  return out;
}

export async function alert(env: Env, kind: string, severity: string, detail: string, now: number) {
  try { await persistAlert(env, { homeId: "platform", kind, severity, detail: detail.slice(0, 300) }, now); } catch { /* an alert never changes the refusal */ }
}

// ---- policy epoch ---------------------------------------------------------------------------------------------------------------------

/** The durable epoch only ever rises. Returns the stored epoch after raising it to this bundle's. A D1 error propagates (fail closed). */
export async function readPolicyEpoch(env: Env, bundleEpoch: number): Promise<number> {
  await env.DB.prepare("INSERT INTO image_policy (id,epoch) VALUES ('current',?) ON CONFLICT(id) DO UPDATE SET epoch=MAX(epoch,excluded.epoch)").bind(bundleEpoch).run();
  const row = await env.DB.prepare("SELECT epoch FROM image_policy WHERE id='current'").first<{ epoch: number }>();
  if (!row || !Number.isSafeInteger(row.epoch)) throw new Error("policy_epoch_unreadable");
  return row.epoch;
}

// ---- re-check at provider --------------------------------------------------------------------------------------------------------------

interface HzImage { id?: number; type?: string; status?: string; deleted?: string | null; created?: string; image_size?: number | null; architecture?: string }
async function recheck(env: Env, sigEnv: SigEnv, image: string, arch: "x86" | "arm", sigHash: string, entry: { createdAt: string; imageSize: string },
  now: number, deps: VerifyDeps): Promise<number> {
  const fail = (code: string) => new ImageRefused(code);
  let cached: { created_at: string; image_size: string; checked_at: number } | null;
  try {
    cached = await env.DB.prepare("SELECT created_at,image_size,checked_at FROM image_recheck WHERE env=? AND image_id=? AND sig_hash=? AND arch=?")
      .bind(sigEnv, image, sigHash, arch).first();
  } catch { throw fail("image_recheck_failed"); }
  if (cached && Number.isFinite(cached.checked_at) && now - RECHECK_TTL_MS < cached.checked_at && cached.checked_at <= now
    && cached.created_at === entry.createdAt && cached.image_size === entry.imageSize) return cached.checked_at; // a hit never extends: bounded by the ORIGINAL check
  const drop = async () => { try { await env.DB.prepare("DELETE FROM image_recheck WHERE env=? AND image_id=? AND sig_hash=? AND arch=?").bind(sigEnv, image, sigHash, arch).run(); } catch { /* the next check re-reads */ } };
  let body: { image?: HzImage };
  try {
    if (!env.HCLOUD_TOKEN) throw new Error("no_token");
    const res = await (deps.fetch ?? fetch)(`https://api.hetzner.cloud/v1/images/${image}`,
      { headers: { authorization: `Bearer ${env.HCLOUD_TOKEN}` }, signal: AbortSignal.timeout(RECHECK_TIMEOUT_MS) });
    if (res.status !== 200) throw new Error("status");
    body = await res.json() as { image?: HzImage };
  } catch { await drop(); throw fail("image_recheck_failed"); }
  const img = body?.image;
  if (!img || typeof img !== "object") { await drop(); throw fail("image_recheck_failed"); }
  if (String(img.id) !== image || img.type !== "snapshot" || img.status !== "available" || (img.deleted !== null && img.deleted !== undefined)) { await drop(); throw fail("image_recheck_failed"); }
  if (img.created !== entry.createdAt || imageSizeText(img.image_size) !== entry.imageSize) {
    await drop(); await alert(env, "image.changed", "high", `image ${image} no longer matches its signed entry; re-sign it`, now); throw fail("image_changed");
  }
  if (img.architecture !== arch) { await drop(); throw fail("image_arch_mismatch"); }
  try {
    await env.DB.prepare("INSERT INTO image_recheck (env,image_id,sig_hash,created_at,image_size,arch,checked_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(env,image_id,sig_hash,arch) DO UPDATE SET created_at=excluded.created_at,image_size=excluded.image_size,checked_at=excluded.checked_at")
      .bind(sigEnv, image, sigHash, entry.createdAt, entry.imageSize, arch, now).run();
  } catch { throw fail("image_recheck_failed"); }
  return now;
}

/** Production creation never carries operator ssh keys (check-deploy enforces [] too; parsing never refuses, so cleanup keeps working). */
export function assertNoProdSshKeys(env: Env, config: { sshKeyIds?: number[]; vultr?: { sshKeyIds?: unknown[] } }, deps: VerifyDeps = {}): void {
  if (buildEnvOf(env, deps) === "staging") return;
  if ((config.sshKeyIds?.length ?? 0) > 0 || (config.vultr?.sshKeyIds?.length ?? 0) > 0) throw new ImageRefused("ssh_keys_prod_forbidden");
}

// ---- the gate -------------------------------------------------------------------------------------------------------------------------

/** Verifies one image for one creation. Every throw is an ImageRefused with a stable code and nothing has been sent to the provider. */
export async function verifyImageForUse(env: Env, config: Pick<ProvisionerConfig, "imageKinds">, req: { provider: "hetzner" | "vultr"; image: string; arch: "x86" | "arm" },
  now: number, deps: VerifyDeps = {}): Promise<VerifiedImage> {
  // Provisioning off (freeze deploy): every creation path (new-home dispatch, pool refill, rebuild) stops here, before any provider call.
  // Absent means open. Existing homes' status, power, sign-in and billing never come through this gate.
  if (env.CLOUD_PROVISIONING_OPEN === "false") throw new ImageRefused("provisioning_closed");
  const trust = deps.trust ?? DEFAULT_TRUST;
  const build = buildEnvOf(env, deps);
  if (build === "conflict") { await alert(env, "image.env_conflict", "high", "production bundle with the staging switch on", now); throw new ImageRefused("image_env_conflict"); }
  if (build === "invalid") throw new ImageRefused("image_env_conflict");
  const sigEnv = sigEnvOf(build);
  if (req.provider === "vultr") throw new ImageRefused("image_vultr_unverifiable");
  if (!validImageId(req.image)) throw new ImageRefused("image_id_invalid");
  const kinds: unknown = config.imageKinds;
  const raw = kinds !== null && typeof kinds === "object" && !Array.isArray(kinds) && Object.hasOwn(kinds, req.image) ? (kinds as Record<string, unknown>)[req.image] : undefined;
  if (raw === undefined) throw new ImageRefused("image_kind_unknown");
  if (raw !== null && typeof raw === "object" && (raw as { kind?: unknown }).kind === "staging-ops-ssh") {
    if (build !== "staging") throw new ImageRefused("image_staging_only");
    if (trust.revoked.includes(req.image)) throw new ImageRefused("image_revoked");
    return mint({ provider: req.provider, image: req.image, arch: req.arch, env: sigEnv, expiresAt: now + 60_000, epoch: trust.epoch, validUntil: now + RECHECK_TTL_MS,
      keyFp: "staging-ops-ssh", checkSha256: "" }, env.DB);
  }
  const parsed = parseCustomerEntry(raw);
  if (!parsed.ok) throw new ImageRefused("image_sig_malformed");
  const entry = parsed.entry;
  if (trust.revoked.includes(req.image)) throw new ImageRefused("image_revoked");
  const keys = await loadVerifyKeys(env.B5_IMAGE_VERIFY_PUBKEY, trust);
  if (!keys) { await alert(env, "image.pubkey_invalid", "high", "B5_IMAGE_VERIFY_PUBKEY is missing or not a pinned key", now); throw new ImageRefused("image_pubkey_invalid"); }
  const key = keys.find((k) => k.fp === entry.keyFp);
  if (!key) throw new ImageRefused("image_sig_wrong_key");
  if (entry.env !== sigEnv) throw new ImageRefused("image_env_mismatch");
  if (!trust.checks.includes(entry.checkSha256)) throw new ImageRefused("image_check_unaccepted");
  // verified_at: not in the future (5 min skew), not before the image was created, and inside the 180 days.
  const verifiedMs = parseVerifiedAtMs(entry.verifiedAt); const createdMs = parseCreatedMs(entry.createdAt);
  if (verifiedMs === null || createdMs === null || verifiedMs > now + 300_000 || verifiedMs < createdMs || now - verifiedMs > IMAGE_SIG_MAX_AGE_DAYS * DAY_MS) {
    throw new ImageRefused("image_sig_stale");
  }
  const left = daysLeft(verifiedMs, now);
  const bytes = new TextEncoder().encode(buildPayload({ imageId: req.image, createdAt: entry.createdAt, imageSize: entry.imageSize, env: sigEnv,
    checkSha256: entry.checkSha256, verdict: "pass", verifiedAt: entry.verifiedAt }));
  const raw64 = decodeStoredSig(entry.sig)!;
  let ok = false;
  try { ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key.key, raw64 as BufferSource, bytes); } catch { ok = false; }
  if (!ok) throw new ImageRefused("image_sig_invalid");
  // The durable epoch: a bundle older than the stored policy cannot create servers.
  let stored: number;
  try { stored = await readPolicyEpoch(env, trust.epoch); } catch { throw new ImageRefused("image_recheck_failed"); }
  if (stored > trust.epoch) { await alert(env, "image.policy_rolled_back", "high", `stored epoch ${stored} is above this bundle's ${trust.epoch}`, now); throw new ImageRefused("image_policy_rolled_back"); }
  const checkedAt = await recheck(env, sigEnv, req.image, req.arch, await sha256Hex(raw64), entry, now, deps);
  // Expiry warnings (30 and 7 days before). Raised on use, and by the sweep in expiryAlerts below.
  await raiseExpiryAlerts(env, req.image, left, now);
  const sigExpiry = verifiedMs + IMAGE_SIG_MAX_AGE_DAYS * DAY_MS;
  return mint({ provider: req.provider, image: req.image, arch: req.arch, env: sigEnv, epoch: trust.epoch,
    expiresAt: Math.min(now + 60_000, checkedAt + RECHECK_TTL_MS, sigExpiry), validUntil: Math.min(checkedAt + RECHECK_TTL_MS, sigExpiry),
    keyFp: entry.keyFp, checkSha256: entry.checkSha256 }, env.DB);
}

/** Alert at 30 days and at 7 days before a signature expires. Deduplicated by (kind, image) through the open-alert index. */
export async function raiseExpiryAlerts(env: Env, image: string, left: number, now: number): Promise<void> {
  for (const d of IMAGE_SIG_ALERT_DAYS) {
    if (left <= d) { await alert(env, `image.sig_expiry_${d}d.${image}`, d <= 7 ? "high" : "medium", `image ${image} signature expires in ${Math.max(0, Math.ceil(left))} days; re-sign it`, now); }
  }
}
/** The scheduler's sweep: every configured production image, checked for the expiry alerts only (no network). */
export async function expiryAlerts(env: Env, config: Pick<ProvisionerConfig, "images" | "imageKinds">, now: number): Promise<void> {
  for (const image of [config.images.hetzner.x86, config.images.hetzner.arm]) {
    if (!image) continue;
    const kinds = config.imageKinds as unknown;
    const raw = kinds && typeof kinds === "object" && Object.hasOwn(kinds, image) ? (kinds as Record<string, unknown>)[image] : undefined;
    const p = parseCustomerEntry(raw);
    if (!p.ok) continue;
    const v = parseVerifiedAtMs(p.entry.verifiedAt);
    if (v !== null) await raiseExpiryAlerts(env, image, daysLeft(v, now), now);
  }
}
export { b64urlEncode };
