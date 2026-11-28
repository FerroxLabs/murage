// Ring publisher (designs/RINGS-DESIGN.md sections 4-6, B7). Owner: rings BUILD lane; ring ops are run by MAIN
// through release.yml `ring_op` in the assemble job (the only job holding RELEASES_PAT). Every op reads the
// current signed manifest from the `rings` branch, applies one transition, signs the result with the release key,
// re-verifies it against the pinned public key with the same parser the client uses, and writes rings.json +
// rings.json.asc in ONE commit (a reader never sees a new file next to an old signature).
// This module holds the gates and the order only. Every GitHub write (the promote flip, pin-latest, the rings
// branch commit) and the gpg key live in release-guard.mjs behind its release prerequisite, reached only through
// the fixed guard commands `ring-publish-internal` and `ring-op` (MAIN-RULING 2026-11-27 option A); runRingOp gets
// them as `writers`, so this file never mutates a release itself.
import { KILL_SWITCH_IDS } from "../shared/kill-switch-ids.mjs";
import { RINGS, compareVersions, parseRingsManifest, versionInRange } from "../shared/rings-manifest.mjs";
import { verifyDetachedSignature } from "../electron/update-signature.mjs";

export const RINGS_REPO = "FerroxLabs/murage-releases";
export const RINGS_BRANCH = "rings";
export const MANIFEST_PATH = "rings/rings.json";
export const SIGNATURE_PATH = "rings/rings.json.asc";
export const HOUR_MS = 3_600_000;
export const DAY_GAP_MS = 20 * HOUR_MS;
export const EXPIRY_MS = 72 * HOUR_MS;
export const KILL_CODES = Object.freeze(["kill-safety", "kill-data", "kill-perf"]);
export const RING_OPS = Object.freeze(["publish-internal", "advance-beta", "promote-all", "halt", "resume", "kill", "resign"]);
const FEEDS = Object.freeze(["latest.yml", "latest-mac.yml", "latest-linux.yml"]);
const RECEIPTS = Object.freeze(["BANNERGATE", "RING0-MAC", "RING0-WIN"]);
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function refuse(message) { throw new Error(`ring-op refused: ${message}`); }
function version(value, name = "version") {
  if (typeof value !== "string" || !VERSION.test(value)) refuse(`${name} must be x.y.z`);
  return value;
}
const iso = (ms) => new Date(ms).toISOString();
const utcDate = (ms) => iso(ms).slice(0, 10);
const words = (line) => String(line ?? "").split(/\s+/).filter(Boolean);

/** Section 5: a later UTC calendar date than `since` AND at least 20 h after it. Days are publisher-side only. */
export function assertCalendarGate(since, now, label) {
  const at = Date.parse(since);
  if (!Number.isFinite(at)) refuse(`${label}.since is not a time`);
  if (!(utcDate(now) > utcDate(at))) refuse(`${label} since ${utcDate(at)}: the next step needs a later UTC date`);
  if (now - at < DAY_GAP_MS) refuse(`${label} since ${iso(at)}: the next step needs 20 h (${((now - at) / HOUR_MS).toFixed(1)} h so far)`);
}

/** D1 receipts: the three MAIN attestation lines, each naming v as a whole word and PASS. */
export function assertReceipts(receipts, v) {
  const lines = Array.isArray(receipts) ? receipts : [];
  for (const kind of RECEIPTS) {
    const line = lines.find((entry) => words(entry)[0] === kind);
    if (!line) refuse(`receipt ${kind} missing`);
    if (!words(line).includes(v) || !words(line).includes("PASS")) refuse(`receipt ${kind} does not name ${v} PASS`);
  }
}

const plain = (manifest) => manifest && ({
  schema: 1, seq: manifest.seq, issuedAt: iso(manifest.issuedAt), expiresAt: iso(manifest.expiresAt),
  rings: Object.fromEntries(RINGS.map((name) => [name, { version: manifest.rings[name].version, since: manifest.rings[name].since, halted: manifest.rings[name].halted }])),
  kill: manifest.kill.map((entry) => ({ id: entry.id, versions: entry.versions, code: entry.code })),
});

/** One transition (sections 5-6). `current` = the verified manifest on the rings branch (parseRingsManifest
 * shape) or null when none was ever written. Returns the next manifest as plain JSON (seq+1, issued now, expires
 * +72 h), or null when the op is already in effect (each op is idempotent so a failed run can be re-run). */
export function applyRingOp(current, op, input = {}, now = Date.now()) {
  if (!RING_OPS.includes(op)) refuse(`unknown op ${JSON.stringify(op)}`);
  if (!current && op !== "publish-internal") refuse("no ring manifest exists yet; the first op is publish-internal");
  const next = current ? plain(current) : null;
  const ringIndex = (name) => { const i = RINGS.indexOf(name); if (i < 0) refuse(`unknown ring ${JSON.stringify(name)}`); return i; };
  let changed = false;
  if (op === "publish-internal") {
    const v = version(input.version);
    if (!next) {
      // Bootstrap manifest: beta and all hold the current GitHub latest (what every client already gets).
      const latest = version(input.latest, "latest");
      if (compareVersions(v, latest) <= 0) refuse(`${v} is not newer than latest ${latest}`);
      return seal({ schema: 1, seq: Math.max(1, Number(input.floorSeq ?? 0) + 1), rings: {
        internal: { version: v, since: iso(now), halted: false },
        beta: { version: latest, since: iso(now), halted: false },
        all: { version: latest, since: iso(now), halted: false } }, kill: [] }, now);
    }
    const ring = next.rings.internal;
    if (ring.version === v && !ring.halted) return null;
    if (compareVersions(v, ring.version) < 0) refuse(`internal already holds ${ring.version}, newer than ${v}`);
    if (ring.version !== v) Object.assign(ring, { version: v, since: iso(now) });
    ring.halted = false; // a fix-forward release enters through D0 (section 6)
    changed = true;
  } else if (op === "advance-beta") {
    const v = version(input.version), { internal, beta } = next.rings;
    if (beta.version === v) return null;
    if (internal.version !== v) refuse(`internal holds ${internal.version}, not ${v}`);
    if (internal.halted || beta.halted) refuse("a halted ring is never advanced; resume it first");
    if (compareVersions(v, beta.version) <= 0) refuse(`beta already holds ${beta.version}`);
    assertCalendarGate(internal.since, now, "internal");
    assertReceipts(input.receipts, v);
    Object.assign(beta, { version: v, since: iso(now) });
    changed = true;
  } else if (op === "promote-all") {
    const v = version(input.version), { internal, beta, all } = next.rings;
    if (all.version === v) return null;
    if (RINGS.some((name) => next.rings[name].halted)) refuse("open halt: resume first");
    if (compareVersions(v, all.version) <= 0) refuse(`all already holds ${all.version}`);
    const bootstrap = words(input.bootstrap);
    const isBootstrap = bootstrap.length > 0;
    if (isBootstrap) {
      // The one exemption (section 5 BOOTSTRAP): Sean's board line, and the gate runs on internal's day.
      const at = bootstrap.indexOf("YES");
      if (bootstrap[0] !== "MAIN-RULING" || bootstrap[at - 1] !== "SEAN" || bootstrap.slice(at + 1, at + 4).join(" ") !== `rings bootstrap ${v}`) refuse("bootstrap needs a MAIN-RULING ... SEAN YES rings bootstrap <v> line");
      if (internal.version !== v) refuse(`internal holds ${internal.version}, not ${v}`);
    } else if (beta.version !== v) refuse(`beta holds ${beta.version}, not ${v}: beta.since belongs to another version`);
    if (!words(input.waiver).length) assertCalendarGate(isBootstrap ? internal.since : beta.since, now, isBootstrap ? "internal" : "beta");
    else if (!words(input.waiver).includes("SEAN") || !words(input.waiver).includes(v)) refuse("a waiver is a board line naming SEAN and the version");
    Object.assign(all, { version: v, since: iso(now) });
    changed = true;
  } else if (op === "halt") {
    const bad = version(input.version), previous = version(input.previous, "previous");
    if (compareVersions(previous, bad) >= 0) refuse(`previous ${previous} must be older than ${bad}`);
    // Halting a ring halts every wider ring, and each halted ring is pinned to the version it had before `bad`
    // (the client never reads `halted` alone: the pin is what stops the offer, Fable M5).
    for (const name of RINGS.slice(ringIndex(input.ring))) {
      const ring = next.rings[name];
      if (compareVersions(ring.version, bad) >= 0 && ring.version !== previous) { ring.version = previous; changed = true; }
      if (!ring.halted) { ring.halted = true; changed = true; }
    }
    if (!changed) return null;
  } else if (op === "resume") {
    const ring = next.rings[RINGS[ringIndex(input.ring)]];
    if (!ring.halted) return null;
    ring.halted = false; // resume never advances (section 6)
    changed = true;
  } else if (op === "kill") {
    if (!KILL_SWITCH_IDS.includes(input.id)) refuse(`unknown kill id ${JSON.stringify(input.id)}`);
    if (!KILL_CODES.includes(input.code)) refuse("the kill code is one of kill-safety, kill-data, kill-perf (never free text)");
    try { versionInRange("0.0.0", input.versions); } catch { refuse("versions must be a range like \">=1.0.25 <1.0.26\""); }
    if (next.kill.some((entry) => entry.id === input.id && entry.versions === input.versions.trim())) return null;
    next.kill.push({ id: input.id, versions: input.versions.trim(), code: input.code });
    changed = true;
  } else if (op === "resign") changed = true; // content unchanged, new seq and window (R3)
  return changed ? seal(next, now) : null;
}

function seal(manifest, now) {
  return { ...manifest, seq: manifest.seq + (manifest.issuedAt ? 1 : 0), issuedAt: iso(now), expiresAt: iso(now + EXPIRY_MS) };
}

/** Serialize, sign and prove the result is a manifest the shipped client accepts with its pinned key. */
export function signManifest(manifest, { sign, publicKey, previousSeq = 0 }) {
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const signature = String(sign(bytes));
  const parsed = parseRingsManifest(bytes, signature, { publicKey, verify: verifyDetachedSignature });
  if (parsed.seq <= previousSeq) refuse(`seq ${parsed.seq} is not above ${previousSeq}`);
  return { bytes, signature, parsed };
}

function contents(path, { apiGet, run, ref = RINGS_BRANCH }) {
  const file = apiGet(`repos/${RINGS_REPO}/contents/${path}?ref=${ref}`, { allow404: true, run });
  if (file === null) return null;
  if (file?.encoding !== "base64" || typeof file.content !== "string") throw new Error(`${path} on ${RINGS_BRANCH} is not a file`);
  return Buffer.from(file.content, "base64");
}

/** The verified manifest on the rings branch (null when none was ever written), read AT one commit: `head` is the
 * commit it came from (null = no branch). A write is based on exactly that commit (writeRingsBranch), so an op
 * computed from a manifest another op has since replaced can never land (Astra r4: a racing promote over a halt). */
export function readRingsHead({ apiGet, run, publicKey }) {
  const head = apiGet(`repos/${RINGS_REPO}/git/ref/heads/${RINGS_BRANCH}`, { allow404: true, run })?.object?.sha ?? null;
  if (!head) return { head: null, manifest: null };
  const bytes = contents(MANIFEST_PATH, { apiGet, run, ref: head }), signature = contents(SIGNATURE_PATH, { apiGet, run, ref: head });
  if (bytes === null && signature === null) return { head, manifest: null };
  if (bytes === null || signature === null) throw new Error("the rings branch has only one of rings.json / rings.json.asc; refusing to proceed");
  return { head, manifest: parseRingsManifest(bytes, signature.toString("utf8"), { publicKey, verify: verifyDetachedSignature }) };
}
export function readRingsBranch(deps) { return readRingsHead(deps).manifest; }

/** verify-published (section 5): v is a published release (not a draft) carrying the three feeds, uploaded with a digest. */
export function assertPublished(v, { apiGet, run, prerelease }) {
  const release = apiGet(`repos/${RINGS_REPO}/releases/tags/v${v}`, { run });
  if (release?.tag_name !== `v${v}` || release.draft !== false) refuse(`v${v} is not a published release`);
  if (prerelease !== undefined && release.prerelease !== prerelease) refuse(`v${v} is ${release.prerelease ? "" : "not "}a prerelease`);
  for (const feed of FEEDS) {
    const asset = (release.assets ?? []).find((entry) => entry.name === feed);
    if (!asset || asset.state !== "uploaded" || !/^sha256:[0-9a-f]{64}$/.test(String(asset.digest ?? ""))) refuse(`v${v} has no uploaded ${feed} with a digest`);
  }
  return release;
}

/** One ring op end to end. Steps that touch GitHub check their own state first, so a re-run after a partial
 * failure (promote: flip done, manifest write failed) finishes the remaining half only. */
export function runRingOp(op, input, { apiGet, run, sign, publicKey, writers, now = Date.now(), log = () => {} }) {
  const { promoteRelease, pinLatest, writeRingsBranch } = writers;
  const { head, manifest: current } = readRingsHead({ apiGet, run, publicKey });
  if (op === "publish-internal") {
    assertPublished(input.version, { apiGet, run, prerelease: true });
    if (!current && !input.latest) input = { ...input, latest: String(apiGet(`repos/${RINGS_REPO}/releases/latest`, { run })?.tag_name ?? "").replace(/^v/, "") };
  }
  if (op === "advance-beta") assertPublished(input.version, { apiGet, run, prerelease: true });
  // halt pins every halted ring to `previous` in the SIGNED manifest, so `previous` must already be a promoted
  // release (published, not a prerelease, carrying the feeds) before anything is signed (Astra/Opus 4222cd33ed
  // High: a D0 prerelease, a draft or a missing tag must never become a ring target).
  if (op === "halt") assertPublished(version(input.previous, "previous"), { apiGet, run, prerelease: false });
  const next = applyRingOp(current, op, input, now); // every gate runs before anything on GitHub changes
  // Sign (and self-verify) before any GitHub change, so a bad key never leaves a half-done op.
  const signedManifest = next && signManifest(next, { sign, publicKey, previousSeq: current?.seq ?? 0 });
  const write = () => {
    writeRingsBranch(signedManifest, { message: `rings: ${op} seq ${next.seq}`, parent: head });
    const written = readRingsBranch({ apiGet, run, publicKey });
    if (written?.seq !== next.seq) throw new Error(`the rings branch reads seq ${written?.seq}, not ${next.seq}`);
  };
  // promote-all with nothing to do (all already holds v) never touches GitHub: after a pin-latest, re-running
  // promote-all must not make the pinned-back release latest again.
  let latestBefore = null; // the release that was latest before this run's flip (always eligible to be latest again)
  if (op === "promote-all" && next) {
    assertPublished(input.version, { apiGet, run });
    const latest = apiGet(`repos/${RINGS_REPO}/releases/latest`, { run });
    if (latest?.tag_name !== `v${input.version}`) {
      latestBefore = String(latest?.tag_name ?? "").replace(/^v/, "") || null;
      promoteRelease(apiGet(`repos/${RINGS_REPO}/releases/tags/v${input.version}`, { run }).id);
      const after = apiGet(`repos/${RINGS_REPO}/releases/latest`, { run });
      if (after?.tag_name !== `v${input.version}`) throw new Error(`releases/latest is ${after?.tag_name ?? "missing"} after the flip, not v${input.version}`);
    }
  }
  // halt: the signed halt is written FIRST (ring-aware clients stop at once), then, after D2, GitHub latest is
  // pinned back for pre-ring clients. A pin-latest failure leaves the halt in force and fails the run red.
  if (next && op === "promote-all") {
    try { write(); } catch (error) {
      // Our write lost a race. If what landed meanwhile is a halt (or anything that is not all=v), latest must not
      // stay on v: put back the release that was latest before THIS run's flip (the signed `all` target may itself
      // have been pinned back to a prerelease by a standalone pin-latest, Astra r4 pass 2), then fail red.
      // A transient failure with the branch unchanged keeps the flip: the re-run writes the manifest (B7(h)).
      const { head: headNow, manifest: now_ } = readRingsHead({ apiGet, run, publicKey });
      if (latestBefore && headNow !== head && now_ && (RINGS.some((name) => now_.rings[name].halted) || now_.rings.all.version !== input.version)
          && apiGet(`repos/${RINGS_REPO}/releases/latest`, { run })?.tag_name === `v${input.version}`) {
        pinLatest(input.version, latestBefore);
      }
      throw error;
    }
  } else if (next) write();
  if (op === "halt") {
    const latest = apiGet(`repos/${RINGS_REPO}/releases/latest`, { run });
    if (latest?.tag_name === `v${input.version}`) pinLatest(input.version, input.previous);
  }
  if (!next) { log(`ring-op ${op}: already in effect (seq ${current?.seq})`); return null; }
  log(`ring-op ${op}: seq ${next.seq} internal=${next.rings.internal.version} beta=${next.rings.beta.version}${next.rings.beta.halted ? "(halted)" : ""} all=${next.rings.all.version}${next.rings.all.halted ? "(halted)" : ""} kills=${next.kill.length}`);
  return next;
}

/** R2 build floor: the seq live on the rings branch when the build was made (0 when no manifest exists yet). */
export function ringsFloor(bytes, signature, publicKey) {
  if (bytes === null && signature === null) return { seq: 0 };
  return { seq: parseRingsManifest(bytes, signature, { publicKey, verify: verifyDetachedSignature }).seq };
}

/** rings-floor.json written by release.yml before packaging; every platform job asserts it before it builds. */
export function assertRingsFloorFile(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("rings-floor.json is not JSON"); }
  if (!value || Object.keys(value).join() !== "seq" || !Number.isSafeInteger(value.seq) || value.seq < 0) throw new Error("rings-floor.json must be exactly {\"seq\": <integer >= 0>}");
  return value.seq;
}

/** release.yml `ring_args`: space-separated key=value pairs from a fixed key list (anything else refuses). */
export function parseRingArgs(text) {
  const keys = { ring: "ring", previous: "previous", kill_id: "id", kill_versions: "versions", kill_code: "code" };
  const out = {};
  // kill_versions holds a space-separated range, so it must be quoted: kill_versions=">=1.0.25 <1.0.26".
  for (const match of String(text).matchAll(/([a-z_]+)=("([^"]*)"|\S+)/g)) {
    if (!(match[1] in keys)) refuse(`unknown ring_args key ${match[1]}`);
    out[keys[match[1]]] = match[3] ?? match[2];
  }
  return out;
}
