// SPDX-License-Identifier: AGPL-3.0-or-later
// Image readiness for sales (KMS signing design 9.8, 10.5, amended by 12.3). One row, image_readiness: per arch, whether a home can be built from a
// verified image right now, until when that stays true, and the policy epoch of the bundle that computed it.
//
//   WRITER   sweepImageReadiness runs on the 5-minute cron and stores the row.
//   READER   sales admission (reserve, checkout, checkout resume; image-admission.ts) uses the row. A missing or unreadable row, a row older than
//            30 minutes, or a config_hash or epoch that differs from this bundle's means: recompute inline (5 s budget), store, then use. An inline
//            failure holds sales (fail closed). Existing-customer operations never read it.
//   HOLD     ON after 2 consecutive zero runs, at once for a config fault (steps 1-11 of verifyImageForUse or a creation-wide prerequisite), and at
//            once when no arch is still inside its valid_until.
import { CAPACITY_LINE } from "./self-service";
import { HTTPError } from "./http";
import { provisionerConfig } from "./b5-config";
import { persistAlert } from "./ops-monitor";
import {
  DEFAULT_TRUST, ImageRefused, alert as imageAlert, assertNoProdSshKeys, loadVerifyKeys, readPolicyEpoch, sha256Hex, verifyImageForUse, type VerifyDeps,
} from "./image-signature";

export const READINESS_STALE_MS = 30 * 60_000;
export const INLINE_BUDGET_MS = 5_000;
/** A row stamped further ahead than this is unreadable, not fresh. */
const CLOCK_SKEW_MS = 60_000;
export const ARCHES = ["x86", "arm"] as const;
export type Arch = (typeof ARCHES)[number];

/** Refusals that come from step 12 (the provider re-check): transient, so a zero caused by them waits for the second run. */
const RECHECK_CODES = new Set(["image_recheck_failed", "image_changed", "image_arch_mismatch"]);

export interface ArchResult { ok: boolean; validUntil: number; code?: string }
/** What one probe of the environment found. prerequisite is a creation-wide fault (a config fault); archs is the per-arch gate. */
export interface Probe { prerequisite: string | null; archs: Record<Arch, ArchResult> }
export type ReadinessCheck = (env: Env, now: number) => Promise<Probe>;

export interface ReadinessRow {
  config_hash: string; epoch: number; usable_x86: number; usable_arm: number; valid_until_x86: number; valid_until_arm: number; zero_runs: number; checked_at: number;
}

// ---- test seam ------------------------------------------------------------------------------------------------------------------------

interface Seam { check?: ReadinessCheck; verify?: VerifyDeps; bundleEpoch?: number }
let seam: Seam = {};
/** Test seam, reachable from code only: `check` replaces the environment probe (config, keys, per-arch gate), `verify` feeds the real probe's
 *  verifyImageForUse (trust, fetch, buildEnv), `bundleEpoch` stands for the running bundle's policy epoch. No argument restores the real thing. */
export function setImageReadinessForTests(next?: Seam): void { seam = next ?? {}; }

const bundleEpoch = (): number => seam.bundleEpoch ?? (seam.verify?.trust ?? DEFAULT_TRUST).epoch;

/** The freeze marker (KMS design 12.1/12.4): a frozen build creates nothing, so nothing may be sold on it. */
const isFrozen = (env: Env): boolean => env.CLOUD_FREEZE === "true";
/** The provisioning switch (KMS design 9.4): "false" refuses every creation, so nothing may be sold either. */
const isProvisioningClosed = (env: Env): boolean => env.CLOUD_PROVISIONING_OPEN === "false";

/** The key a stored row must match to be used by this bundle: sha256 of the provisioner config text, the verify-key text and the bundle epoch. */
export async function currentKey(env: Env): Promise<{ hash: string; epoch: number }> {
  const epoch = bundleEpoch();
  return { hash: await sha256Hex(JSON.stringify([env.B5_PROVISIONER_CONFIG ?? "", env.B5_IMAGE_VERIFY_PUBKEY ?? "", epoch, isFrozen(env), isProvisioningClosed(env)])), epoch };
}

// ---- the probe ------------------------------------------------------------------------------------------------------------------------

const noArch = (code: string): ArchResult => ({ ok: false, validUntil: 0, code });
const refusedProbe = (prerequisite: string): Probe => ({ prerequisite, archs: { x86: noArch(prerequisite), arm: noArch(prerequisite) } });

/** The real probe: the creation-wide prerequisites, then verifyImageForUse (steps 1-12) for each arch's configured image. */
const realCheck: ReadinessCheck = async (env, now) => {
  const verify = seam.verify ?? {};
  let config;
  try { config = provisionerConfig(env); } catch { return refusedProbe("config_invalid"); }
  try { assertNoProdSshKeys(env, config, verify); } catch (e) { return refusedProbe(e instanceof ImageRefused ? e.code : "ssh_keys_prod_forbidden"); }
  if (!(await loadVerifyKeys(env.B5_IMAGE_VERIFY_PUBKEY, verify.trust ?? DEFAULT_TRUST))) return refusedProbe("image_pubkey_invalid");
  const one = async (arch: Arch): Promise<ArchResult> => {
    const image = config.images.hetzner[arch];
    if (!image) return noArch("image_not_configured");
    try {
      const v = await verifyImageForUse(env, config, { provider: "hetzner", image, arch }, now, verify);
      return { ok: true, validUntil: v.validUntil };
    } catch (e) { return noArch(e instanceof ImageRefused ? e.code : "image_recheck_failed"); }
  };
  const [x86, arm] = await Promise.all([one("x86"), one("arm")]);
  return { prerequisite: null, archs: { x86, arm } };
};

export interface Computed { key: { hash: string; epoch: number }; usable: Record<Arch, boolean>; validUntil: Record<Arch, number>; fault: boolean }

/** One full evaluation. D1 trouble reading the durable epoch counts as a failed (non-fault) run. */
export async function computeReadiness(env: Env, now: number): Promise<Computed> {
  const key = await currentKey(env);
  let probe: Probe;
  let stored: number | null = null;
  try { stored = await readPolicyEpoch(env, key.epoch); } catch { stored = null; }
  if (stored === null) probe = { prerequisite: null, archs: { x86: noArch("image_recheck_failed"), arm: noArch("image_recheck_failed") } };
  else if (stored > key.epoch) probe = refusedProbe("image_policy_rolled_back");
  else if (isFrozen(env)) probe = refusedProbe("build_frozen");
  else if (isProvisioningClosed(env)) probe = refusedProbe("provisioning_closed");
  else probe = await (seam.check ?? realCheck)(env, now);
  const ok = (a: Arch) => probe.prerequisite === null && probe.archs[a].ok;
  const usable = { x86: ok("x86"), arm: ok("arm") };
  const total = Number(usable.x86) + Number(usable.arm);
  // A zero is a config fault unless a step-12 (network) refusal is part of it.
  const fault = probe.prerequisite !== null || (total === 0 && ARCHES.every((a) => !RECHECK_CODES.has(probe.archs[a].code ?? "")));
  return { key, usable, validUntil: { x86: usable.x86 ? probe.archs.x86.validUntil : 0, arm: usable.arm ? probe.archs.arm.validUntil : 0 }, fault };
}

// ---- the row --------------------------------------------------------------------------------------------------------------------------

const ROW_SQL = `SELECT p.epoch AS current, r.config_hash, r.epoch, r.usable_x86, r.usable_arm, r.valid_until_x86, r.valid_until_arm, r.zero_runs, r.checked_at
  FROM (SELECT 1 AS one) o LEFT JOIN image_readiness r ON r.id='current' LEFT JOIN image_policy p ON p.id='current'`;
type Loaded = { current: number | null; row: ReadinessRow | null };
async function load(env: Env): Promise<Loaded> {
  const r = await env.DB.prepare(ROW_SQL).first<Record<string, number | string | null>>();
  if (!r) return { current: null, row: null };
  const current = typeof r.current === "number" ? r.current : null;
  if (r.config_hash === null || r.config_hash === undefined) return { current, row: null };
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
  const row = { config_hash: String(r.config_hash), epoch: num(r.epoch), usable_x86: num(r.usable_x86), usable_arm: num(r.usable_arm), valid_until_x86: num(r.valid_until_x86),
    valid_until_arm: num(r.valid_until_arm), zero_runs: num(r.zero_runs), checked_at: num(r.checked_at) };
  return { current, row: Object.values(row).some((v) => typeof v === "number" && Number.isNaN(v)) ? null : row };
}

/** Stores one evaluation. zero_runs counts consecutive zero results, atomically with the write; a config fault jumps straight to the hold. */
async function store(env: Env, c: Computed, now: number): Promise<void> {
  const total = Number(c.usable.x86) + Number(c.usable.arm);
  const first = total > 0 ? 0 : c.fault ? 2 : 1;
  await env.DB.prepare(`INSERT INTO image_readiness (id,config_hash,epoch,usable_x86,usable_arm,valid_until_x86,valid_until_arm,zero_runs,checked_at)
    VALUES ('current',?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET config_hash=excluded.config_hash, epoch=excluded.epoch, usable_x86=excluded.usable_x86, usable_arm=excluded.usable_arm,
      valid_until_x86=excluded.valid_until_x86, valid_until_arm=excluded.valid_until_arm, checked_at=excluded.checked_at,
      zero_runs=CASE WHEN excluded.usable_x86+excluded.usable_arm>0 THEN 0 WHEN ?=1 THEN MAX(image_readiness.zero_runs+1,2) ELSE image_readiness.zero_runs+1 END`)
    .bind(c.key.hash, c.key.epoch, Number(c.usable.x86), Number(c.usable.arm), c.validUntil.x86, c.validUntil.arm, first, now, Number(c.fault)).run();
}

/** True when sales are held on this row. `durable` is image_policy.epoch (12.3); a positive row past every valid_until holds at once (10.5). */
export function holdOn(row: ReadinessRow, durable: number | null, now: number): boolean {
  if (durable === null || row.epoch !== durable) return true;
  const live = (a: Arch) => (a === "x86" ? row.usable_x86 : row.usable_arm) === 1 && (a === "x86" ? row.valid_until_x86 : row.valid_until_arm) > now;
  if (ARCHES.some(live)) return false;
  if (row.usable_x86 + row.usable_arm > 0) return true;
  return row.zero_runs >= 2;
}

/** What the customer is told while sales are held for the images: the plain capacity line, never an error code of ours. */
export const readinessHold = () => new HTTPError(503, "sales_closed", { notice: CAPACITY_LINE });

const withBudget = <T>(work: Promise<T>, ms: number): Promise<T> => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("readiness_budget")), ms);
  work.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
});

/** Sales admission (reserve, checkout, resume). Throws the capacity hold, or returns when sales may go on. */
export async function assertSalesImagesReady(env: Env, now = Date.now()): Promise<void> {
  try {
    let { current, row } = await load(env);
    const key = await currentKey(env);
    const fresh = row !== null && row.checked_at <= now + CLOCK_SKEW_MS && now - row.checked_at <= READINESS_STALE_MS && row.config_hash === key.hash && row.epoch === key.epoch;
    if (!fresh) {
      await withBudget((async () => { await store(env, await computeReadiness(env, now), now); })(), INLINE_BUDGET_MS);
      ({ current, row } = await load(env));
    }
    // The switches are checked on EVERY admission, whatever the row says: a fresh positive row must never outvote a freeze or a provisioning-off hold.
    if (isFrozen(env) || isProvisioningClosed(env) || !row || holdOn(row, current, now)) throw readinessHold();
  } catch (e) {
    throw e instanceof HTTPError ? e : readinessHold();
  }
}

/** The 5-minute writer. Stores the row and alerts (deduplicated by kind) while sales are held. Never throws. */
export async function sweepImageReadiness(env: Env, now = Date.now()): Promise<void> {
  try {
    await store(env, await computeReadiness(env, now), now);
    const { current, row } = await load(env);
    if (!row || holdOn(row, current, now)) {
      await imageAlert(env, "image.sales_hold", "high", "sales are held: no verified image can be used (see the image readiness row)", now);
    }
  } catch {
    try { await persistAlert(env, { homeId: "platform", kind: "image.readiness_failed", severity: "high", detail: "the image readiness writer failed" }, now); } catch { /* the next run retries */ }
  }
}
