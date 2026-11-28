// Signed ring manifest (designs/RINGS-DESIGN.md section 4, R1-R4, K1-K2). Pure: the caller passes the
// bytes, the detached signature, the pinned key and a verifier (electron/update-signature.mjs
// verifyDetachedSignature). Nothing here fetches, writes or reports anything (P6).
export const RINGS = Object.freeze(["internal", "beta", "all"]);
export const MAX_MANIFEST_BYTES = 64 * 1024;
const KILL_CODES = new Set(["kill-safety", "kill-data", "kill-perf"]);
const TOP_KEYS = new Set(["schema", "seq", "issuedAt", "expiresAt", "rings", "kill"]);
const RING_KEYS = new Set(["version", "since", "halted"]);
const KILL_KEYS = new Set(["id", "versions", "code"]);
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function refuse(reason) {
  const error = new Error(`rings: refused ${reason}`);
  error.code = "ERR_MURAGE_RINGS_REFUSED";
  throw error;
}

function parseVersion(value) {
  const match = typeof value === "string" ? VERSION.exec(value) : null;
  return match ? match.slice(1, 4).map(Number) : null;
}

/** -1 / 0 / 1 for plain x.y.z versions; throws on anything else. */
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) refuse("version");
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

const time = (value) => {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) refuse("time");
  return ms;
};

// ">=1.0.25 <1.0.26": space-separated comparators, all must hold.
export function versionInRange(version, range) {
  if (typeof range !== "string" || !range.trim()) refuse("range");
  return range.trim().split(/\s+/).every((part) => {
    const match = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(part);
    if (!match) refuse("range");
    const c = compareVersions(version, match[2]);
    switch (match[1] ?? "=") {
      case ">=": return c >= 0;
      case "<=": return c <= 0;
      case ">": return c > 0;
      case "<": return c < 0;
      default: return c === 0;
    }
  });
}

/** R1: verify the exact bytes, then a strict schema. Returns the frozen manifest or throws `rings: refused <reason>`. */
export function parseRingsManifest(bytes, signatureArmor, { publicKey, verify }) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? "");
  if (data.length === 0 || data.length > MAX_MANIFEST_BYTES) refuse("size");
  if (typeof verify !== "function" || !publicKey) refuse("no-key");
  try { verify(data, String(signatureArmor ?? ""), publicKey); } catch { refuse("signature"); }
  let value;
  try { value = JSON.parse(data.toString("utf8")); } catch { refuse("json"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse("schema");
  for (const key of Object.keys(value)) if (!TOP_KEYS.has(key)) refuse("schema");
  if (value.schema !== 1 || !Number.isSafeInteger(value.seq) || value.seq < 1) refuse("schema");
  const issuedAt = time(value.issuedAt), expiresAt = time(value.expiresAt);
  if (expiresAt <= issuedAt) refuse("schema");
  const rings = {};
  if (!value.rings || typeof value.rings !== "object" || Array.isArray(value.rings)) refuse("schema");
  for (const key of Object.keys(value.rings)) if (!RINGS.includes(key)) refuse("schema");
  for (const name of RINGS) {
    const ring = value.rings[name];
    if (!ring || typeof ring !== "object" || Array.isArray(ring)) refuse("schema");
    for (const key of Object.keys(ring)) if (!RING_KEYS.has(key)) refuse("schema");
    if (!parseVersion(ring.version)) refuse("schema");
    if (ring.halted !== undefined && typeof ring.halted !== "boolean") refuse("schema");
    rings[name] = Object.freeze({ version: ring.version, since: new Date(time(ring.since)).toISOString(), halted: ring.halted === true });
  }
  const kill = [];
  if (value.kill !== undefined && !Array.isArray(value.kill)) refuse("schema");
  for (const entry of value.kill ?? []) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) refuse("schema");
    for (const key of Object.keys(entry)) if (!KILL_KEYS.has(key)) refuse("schema");
    if (typeof entry.id !== "string" || !/^[a-z0-9.]{1,64}$/.test(entry.id) || !KILL_CODES.has(entry.code)) refuse("schema");
    versionInRange("0.0.0", entry.versions); // validates the range syntax
    kill.push(Object.freeze({ id: entry.id, versions: entry.versions, code: entry.code }));
  }
  return Object.freeze({ seq: value.seq, issuedAt, expiresAt, rings: Object.freeze(rings), kill: Object.freeze(kill) });
}

/** R2: the manifest to keep. Only a higher seq at or above the build floor replaces the cached one. */
export function newerManifest(cached, fetched, floorSeq = 0) {
  if (!fetched || fetched.seq < floorSeq) return cached ?? null;
  if (!cached || fetched.seq > cached.seq) return fetched;
  return cached;
}

/** R3 + R4. Target version for a client in `membership` ({internal, beta}), or null when the manifest is
 * missing or expired (the caller then behaves as today: GitHub latest = ring all). */
export function ringTarget(manifest, membership = {}, now = Date.now()) {
  if (!manifest || now >= manifest.expiresAt) return null;
  const mine = ["all", ...(membership.beta || membership.internal ? ["beta"] : []), ...(membership.internal ? ["internal"] : [])];
  let target = null;
  for (const name of mine) {
    const version = manifest.rings[name].version;
    if (target === null || compareVersions(version, target) > 0) target = version;
  }
  return target;
}

/** K1/K2/R3: kill ids that apply to `version`. Kills stay in force after expiry; unknown ids are dropped. */
export function activeKills(manifest, version, knownIds) {
  if (!manifest) return [];
  const known = new Set(knownIds);
  return [...new Set(manifest.kill.filter((entry) => known.has(entry.id) && versionInRange(version, entry.versions)).map((entry) => entry.id))].sort();
}
