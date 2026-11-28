// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { LegFailure } from "./leg.mjs";
import { validatePermissionBoundary } from "./permission-boundary.mjs";
import { assertMetadata, parseClosed, ReceiptError, SCHEMAS, validateClosed } from "./receipt-schema.mjs";
import { gradeS1 } from "./validate-s1.mjs";
import { gradeS2 } from "./validate-s2.mjs";
import { gradeS3 } from "./validate-s3.mjs";
import { gradeS4 } from "./validate-s4.mjs";

// Qualification ledger, gate reader and fence reader (O23). One state machine per key (spike, target):
// ABSENT -> REQUESTED(g, fence) -> PROVEN | FAILED | INCOMPLETE. Every write goes to BOTH replicas with O_EXCL
// semantics; nothing but `record` and `sweep` ever writes a result. MAIN is the only writer (Owners).

export class QualError extends Error {
  constructor(code, { exit = 3, hint } = {}) {
    super(code);
    this.code = code;
    this.exit = exit;
    this.hint = hint;
  }
}

const HOUR = 3600e3;
const DEADLINE = { S1: 3 * HOUR, "S1-build": 3 * HOUR, S2: 3 * HOUR, S3: HOUR, S4: HOUR };
export const KEY_TARGETS = {
  S1: ["mac-a", "mac-b", "win-a", "linux-vm"], "S1-build": ["mac-a", "win-a"], S2: ["linux-box"],
  S3: ["mac-a", "mac-b", "win-a", "linux-vm"], S4: ["gh"],
};
const NEEDS_OS = new Set(["S1", "S1-build", "S2", "S3"]);
const NEEDS_N = new Set(["S1", "S1-build", "S3"]);
const GRADE = { S1: gradeS1, "S1-build": gradeS1, S2: gradeS2, S3: gradeS3, S4: gradeS4 };
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canon = (value) => JSON.stringify(value, (_, v) => (v && typeof v === "object" && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
const keyName = (spike, target) => `${spike}-${target}`;
const OBS_RE = /^(\d+)\.obs\.json$/;

// The ledger never lives in a repo tree or a lane job dir (EVIDENCE NEVER IN THE REPO TREE).
export function assertRootOutsideTrees(root) {
  let dir = resolve(root);
  if (existsSync(dir)) dir = realpathSync(dir);
  if (/(^|[\\/])swarm-b[\\/][^\\/]+([\\/]|$)/.test(dir)) throw new QualError("ROOT_IN_TREE");
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) throw new QualError("ROOT_IN_TREE");
    if (dirname(at) === at) break;
  }
}

// O_EXCL-equivalent publish: write a dot-prefixed temp (never matches the reader globs), fsync, then link(2)
// to the final name, which fails with EEXIST instead of overwriting. Returns "created" | "exists".
export function writeExcl(dir, name, body, kind) {
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.${name.split(".")[0]}.${kind}.tmp-${process.pid}`);
  const fd = openSync(temp, "wx", 0o600);
  try { writeSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    linkSync(temp, join(dir, name));
    return "created";
  } catch (error) {
    if (error.code === "EEXIST") return "exists";
    throw error;
  } finally {
    unlinkSync(temp);
  }
}

export const LEGS = ["mac-a", "win-a", "linux-vm"];

// `legs` is MAIN's configuration of which targets the release legs run on. A caller can never narrow it through
// gate args: an empty or caller-supplied list would let a gate pass with nothing proven.
export function openQual({ roots, now = () => Date.now(), host = "mac", fences, log = () => {}, skipLog = { at: 0 }, legs = LEGS }) {
  if (!Array.isArray(legs) || !legs.length || legs.some((leg) => !LEGS.includes(leg) && leg !== "mac-b")) throw new QualError("ARGS");
  for (const root of roots) assertRootOutsideTrees(root);
  const reachable = (root) => existsSync(root);
  const both = () => {
    if (!roots.every(reachable)) throw new QualError("REPLICA_UNREACHABLE", { hint: "run from the Mac" });
  };
  const listJson = (root, sub, re) => {
    const dir = join(root, sub);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((name) => re.test(name)).map((name) => ({ name, n: Number(re.exec(name)[1]) }));
  };
  const readJson = (file) => {
    try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; }
  };

  // Observations: one O_EXCL file per observation, ordered by the per-target sequence n (never the target's clock).
  function observations(target) {
    const byN = new Map();
    let invalid = false;
    for (const root of roots) {
      for (const { name, n } of listJson(root, `os/${target}`, OBS_RE)) {
        const obs = readJson(join(root, "os", target, name));
        if (!obs || obs.n !== n || obs.target !== target || typeof obs.build !== "string") { invalid = true; continue; }
        const prior = byN.get(n);
        if (prior && canon({ n, os_name: prior.os_name, build: prior.build }) !== canon({ n, os_name: obs.os_name, build: obs.build })) invalid = true;
        byN.set(n, obs);
      }
    }
    return { byN, invalid };
  }
  function currentOs(target) {
    const { byN, invalid } = observations(target);
    if (invalid) return { state: "INVALID" };
    if (!byN.size) return { state: "UNKNOWN" };
    const obs = byN.get(Math.max(...byN.keys()));
    return { state: "OK", n: obs.n, os: { name: obs.os_name, build: obs.build }, recorded: obs.recorded_utc };
  }
  function appendObservation(target, os) {
    both();
    const { byN, invalid } = observations(target);
    if (invalid) throw new QualError("OBSERVATION_INVALID");
    const n = (byN.size ? Math.max(...byN.keys()) : 0) + 1;
    const body = `${canon({ target, n, recorded_utc: new Date(now()).toISOString(), os_name: os.name, build: os.build })}\n`;
    for (const root of roots) {
      // Another writer took this n (a leg PREFLIGHT racing a receipt observation): refuse, never drop silently.
      if (writeExcl(join(root, "os", target), `${n}.obs.json`, body, "obs") !== "created") throw new QualError("OBSERVATION_RACE");
    }
    for (const root of roots) if (readFileSync(join(root, "os", target, `${n}.obs.json`), "utf8") !== body) throw new QualError("OBSERVATION_RACE");
    return n;
  }

  // Keys: every request/result file on both replicas, union, canonical compare.
  function readKey(spike, target) {
    const key = keyName(spike, target);
    const reqs = new Map();
    const results = new Map();
    let invalid = null;
    for (const root of roots) {
      if (!reachable(root)) return { invalid: "REPLICA_UNREACHABLE" };
      for (const [kind, map, re] of [["req", reqs, /^(\d+)\.req\.json$/], ["result", results, /^(\d+)\.result\.json$/]]) {
        for (const { name, n } of listJson(root, key, re)) {
          const value = readJson(join(root, key, name));
          if (!value) { invalid ??= "UNPARSEABLE"; continue; }
          const have = map.get(n);
          const canonical = kind === "req" ? canonReq(value) : canonResult(value);
          if (have && have.canonical !== canonical) invalid ??= "DIVERGED";
          map.set(n, have ?? { value, canonical });
        }
      }
    }
    return { reqs, results, invalid };
  }
  const canonReq = (r) => canon({ spike: r.spike, target: r.target, g: r.g, fence: r.fence, deadline: r.deadline, n_sha256: r.n_sha256 ?? null });
  const canonResult = (r) => canon({ spike: r.spike, target: r.target, g: r.g, state: r.state, reason: r.reason, receipt_sha256: r.receipt_sha256 ?? null });

  // The fence NOW: provider components (public asset digests, probe-file hashes, epoch, ids) plus the target's
  // current OS identity. Any unreadable component = UNKNOWN (never "matches").
  async function fenceNow(spike, target, args) {
    const base = await fences.components({ spike, target, ...args });
    const fence = { ...base.components };
    const unknown = Object.entries(fence).filter(([, v]) => v === null || v === undefined).map(([k]) => k);
    if (NEEDS_OS.has(spike)) {
      const os = currentOs(target);
      if (os.state !== "OK") unknown.push(`os(${os.state})`); else fence.os = os.os;
    }
    for (const k of unknown) delete fence[k];
    return { fence, unknown, hint: base.hint, nSha256: base.nSha256 ?? null };
  }

  // Ordering (r3, ASTRA n4:2596): await the fence FIRST, then read both replicas with no await in between, so a
  // request published during the fence lookup is always the one graded. `g` is the generation the state is for.
  // A pre-read may only refuse (INVALID / no request, which skip the fence lookup); it never grades a result.
  async function keyState(spike, target, args) {
    const early = gradeKey(spike, target, null);
    if (early.state === "INVALID" || !early.g) return early;
    const now = await fenceNow(spike, target, args);
    return gradeKey(spike, target, now);
  }
  function gradeKey(spike, target, now) {
    const read = readKey(spike, target);
    const key = keyName(spike, target);
    if (read.invalid) return { key, state: "INVALID", reason: read.invalid, hint: "run from the Mac" };
    const newest = read.reqs.size ? Math.max(...read.reqs.keys()) : 0;
    for (const g of read.results.keys()) if (!read.reqs.has(g)) return { key, state: "INVALID", reason: "RESULT_WITHOUT_REQUEST" };
    if (!newest) return { key, state: "PENDING" };
    const req = read.reqs.get(newest).value;
    if (!now) return { key, g: newest, state: "PENDING" };
    if (now.unknown.length || canon(now.fence) !== canon(req.fence)) return { key, g: newest, state: "STALE", reason: now.unknown.length ? "UNKNOWN" : "FENCE", hint: now.hint };
    const result = read.results.get(newest)?.value;
    if (!result) return { key, g: newest, state: "PENDING" };
    return { key, g: newest, state: result.state, reason: result.reason, spike, target };
  }

  // GO is issued only from this read: synchronous, after the caller's LAST await. Every PROVEN key must still be
  // the newest generation on both replicas, still PROVEN, and (OS-bound spikes) still match the current OS
  // observation; otherwise a newer request or observation superseded it while the gate was awaiting.
  function confirm(keys) {
    return keys.map((k) => {
      if (k.state !== "PROVEN") return k;
      const read = readKey(k.spike, k.target);
      const newest = read.reqs?.size ? Math.max(...read.reqs.keys()) : 0;
      const req = read.reqs?.get(k.g)?.value;
      const result = read.results?.get(k.g)?.value;
      let same = !read.invalid && newest === k.g && req && result?.state === "PROVEN";
      if (same && NEEDS_OS.has(k.spike)) {
        const os = currentOs(k.target);
        same = os.state === "OK" && canon(os.os) === canon(req.fence.os);
      }
      return same ? k : { key: k.key, g: k.g, state: "STALE", reason: "SUPERSEDED" };
    });
  }

  const checkArgs = (spike, target, cond) => { if (!cond) throw new QualError("ARGS"); };

  async function request({ spike, target, os, release, from, to, requester = "main", host: requestHost = host }) {
    both();
    try { assertMetadata({ requester, host: requestHost }); } catch { throw new QualError("UNTYPED_FIELD"); }
    checkArgs(spike, target, KEY_TARGETS[spike]?.includes(target));
    if (spike === "S1-build") checkArgs(spike, target, !release); else if (NEEDS_N.has(spike)) checkArgs(spike, target, Boolean(release));
    if (NEEDS_OS.has(spike)) {
      checkArgs(spike, target, Number.isSafeInteger(os));
      const cur = currentOs(target);
      if (cur.state !== "OK" || cur.n !== os || now() - Date.parse(cur.recorded) > HOUR) throw new QualError("PREFLIGHT", { hint: "run `qual preflight` on the Mac, then request with its n" });
    }
    const computed = await fenceNow(spike, target, { release, from, to });
    if (computed.unknown.length) throw new QualError("FENCE_UNKNOWN", { hint: computed.hint ?? computed.unknown.join(",") });
    let g = 1;
    const key = keyName(spike, target);
    for (const root of roots) for (const { n } of listJson(root, key, /^(\d+)\.req\.json$/)) g = Math.max(g, n + 1);
    const req = {
      spike, target, g, fence: computed.fence, deadline: new Date(now() + DEADLINE[spike]).toISOString(),
      n_sha256: NEEDS_N.has(spike) ? computed.nSha256 : null,
      os_n: NEEDS_OS.has(spike) ? os : null, requester, host: requestHost, written_at: new Date(now()).toISOString(),
    };
    if (NEEDS_N.has(spike) && !req.n_sha256) throw new QualError("FENCE_UNKNOWN", { hint: computed.hint });
    const body = `${canon(req)}\n`;
    for (const root of roots) {
      if (writeExcl(join(root, key), `${g}.req.json`, body, "req") !== "created") throw new QualError("CONFLICT");
    }
    return { g };
  }

  function maybeObserve(receipt, req) {
    // Fable M1: an observation from a receipt is appended only when it cannot revive a stale proof.
    const { byN } = observations(receipt.target);
    if (!req || req.os_n === null) return;
    if ([...byN.keys()].some((n) => n > req.os_n)) return;
    if (byN.get(req.os_n)?.build === receipt.observed.build && byN.get(req.os_n)?.os_name === receipt.observed.os_name) return;
    appendObservation(receipt.target, { name: receipt.observed.os_name, build: receipt.observed.build });
  }

  async function record({ spike, target, gen, receipt: bytes }) {
    both();
    let raw;
    try { raw = JSON.parse(bytes.toString()); } catch { throw new QualError("UNTYPED_FIELD"); }
    if (raw?.spike !== spike || raw.target !== target || raw.gen !== gen) throw new QualError("WRONG_KEY");
    let receipt;
    try { receipt = validateClosed(bytes, SCHEMAS[spike]); } catch (error) {
      if (error instanceof ReceiptError) throw new QualError(error.code);
      throw error;
    }
    const read = readKey(spike, target);
    if (read.invalid) throw new QualError("INVALID");
    const key = keyName(spike, target);
    const newest = read.reqs.size ? Math.max(...read.reqs.keys()) : 0;
    const existing = read.results.get(gen)?.value;
    const receiptSha = sha(bytes);
    if (existing && existing.receipt_sha256 === receiptSha && gen === newest) return { state: existing.state, reason: existing.reason, noop: true };
    const req = read.reqs.get(gen)?.value;
    if (gen !== newest || !req) { maybeObserve(receipt, req); throw new QualError("STALE_RECEIPT"); }
    if (now() > Date.parse(req.deadline)) { maybeObserve(receipt, req); throw new QualError("STALE_RECEIPT"); }
    const osMatches = !req.fence.os || (receipt.observed.os_name === req.fence.os.name && receipt.observed.build === req.fence.os.build);
    if (canon(receipt.fence) !== canon(req.fence) || !osMatches) { maybeObserve(receipt, req); throw new QualError("FENCE_MISMATCH"); }
    maybeObserve(receipt, req);
    const graded = GRADE[spike](receipt, { nSha256: req.n_sha256, epoch: req.fence.epoch });
    const result = {
      spike, target, g: gen, state: graded.state, reason: graded.reason, receipt_sha256: receiptSha,
      written_at: new Date(now()).toISOString(), host, requester: "main",
    };
    if (existing) {
      if (canonResult(existing) === canonResult(result)) return { ...graded, noop: true };
      throw new QualError("CONFLICT");
    }
    const body = `${canon(result)}\n`;
    for (const root of roots) {
      if (writeExcl(join(root, key), `${gen}.result.json`, body, "result") === "exists") {
        const other = readJson(join(root, key, `${gen}.result.json`));
        if (canonResult(other) !== canonResult(result)) throw new QualError("CONFLICT");
      }
    }
    return graded;
  }

  function sweep() {
    if (!roots.every(reachable)) {
      if (now() - skipLog.at >= HOUR) { skipLog.at = now(); log("SWEEP_SKIPPED_PEER"); }
      return { skipped: true, written: [] };
    }
    const written = [];
    const copy = (sub, name, from, to) => {
      if (existsSync(join(to, sub, name))) return;
      const text = readFileSync(join(from, sub, name));
      if (writeExcl(join(to, sub), name, text, "copy") === "created") written.push(`${sub}/${name}`);
    };
    // Order (Fable N3): first complete every lone file onto the other replica, THEN expire.
    const [a, b] = roots;
    const dirs = new Set();
    for (const root of roots) {
      for (const name of readdirSync(root)) if (name !== "os") dirs.add(name);
      if (existsSync(join(root, "os"))) for (const t of readdirSync(join(root, "os"))) dirs.add(`os/${t}`);
    }
    for (const sub of dirs) {
      for (const root of roots) {
        const dir = join(root, sub);
        if (!existsSync(dir)) continue;
        for (const name of readdirSync(dir)) {
          if (/^\.\d+\.[a-z]+\.tmp-\d+$/.test(name) || /^\.\d+\.\w+\.tmp-/.test(name)) { unlinkSync(join(dir, name)); continue; }
          if (/^\d+\.(req|result|obs)\.json$/.test(name)) copy(sub, name, root, root === a ? b : a);
        }
      }
    }
    for (const sub of dirs) {
      if (sub.startsWith("os/")) continue;
      const [spike, ...rest] = sub.split("-");
      const parsed = sub.startsWith("S1-build-") ? ["S1-build", sub.slice(9)] : [spike, rest.join("-")];
      const read = readKey(...parsed);
      if (read.invalid || !read.reqs.size) continue;
      const newest = Math.max(...read.reqs.keys());
      const req = read.reqs.get(newest).value;
      if (read.results.has(newest) || now() <= Date.parse(req.deadline)) continue;
      const result = { spike: req.spike, target: req.target, g: newest, state: "INCOMPLETE", reason: "TIMEOUT", receipt_sha256: null, written_at: new Date(now()).toISOString(), host, requester: "main" };
      for (const root of roots) {
        if (writeExcl(join(root, sub), `${newest}.result.json`, `${canon(result)}\n`, "result") === "created") written.push(`${sub}/${newest}.result.json`);
      }
    }
    return { skipped: false, written };
  }

  function required(forWhat) {
    const s3 = legs.map((target) => ["S3", target]);
    const s1 = legs.map((target) => ["S1", target]);
    const pre = [...s3, ["S2", "linux-box"]];
    if (forWhat === "pre") return pre;
    if (forWhat === "post") return [...s1, ...s3];
    if (forWhat === "flip") return [...pre, ...s1, ["S4", "gh"]];
    if (forWhat === "build") return [["S1-build", "mac-a"], ["S1-build", "win-a"]];
    throw new QualError("ARGS");
  }

  async function gate({ for: forWhat, manifest, from, to }, { fetchSnapshot, appId } = {}) {
    if (forWhat === "heartbeat") return boundaryGate({ fetchSnapshot, appId });
    if (["pre", "post", "flip"].includes(forWhat) && !manifest) throw new QualError("ARGS");
    const keys = [];
    for (const [spike, target] of required(forWhat)) {
      keys.push(await keyState(spike, target, { release: manifest, from, to }));
    }
    let boundary;
    if (forWhat === "flip" && keys.every((k) => k.state === "PROVEN")) boundary = await boundaryGate({ fetchSnapshot, appId });
    // No await below this line: the confirm read is the one GO is issued from.
    const confirmed = confirm(keys);
    const bad = confirmed.filter((k) => k.state !== "PROVEN");
    if (boundary && boundary.exit !== 0 && !bad.length) return { exit: 2, keys: confirmed, boundary: boundary.rule, bad: [{ key: "boundary", state: boundary.code }] };
    return { exit: bad.length ? 2 : 0, keys: confirmed, bad };
  }

  async function plan({ manifest, from, to }) {
    const wanted = new Map();
    for (const forWhat of ["pre", "post", "flip"]) for (const [s, t] of required(forWhat)) wanted.set(keyName(s, t), [s, t]);
    const out = [];
    for (const [spike, target] of wanted.values()) {
      const state = await keyState(spike, target, { release: manifest, from, to });
      if (state.state !== "PROVEN") out.push(state);
    }
    return out;
  }

  // Leg PREFLIGHT: append this leg's OS observation, then re-check the proofs the leg relies on (Q6).
  async function legPreflight({ target, os, relies, args = {} }) {
    let n;
    try { n = appendObservation(target, os); } catch { throw new LegFailure("QUAL_UNVERIFIED", "PREFLIGHT"); }
    const states = [];
    for (const [spike, tgt] of relies) {
      const state = await keyState(spike, tgt, args);
      if (state.state !== "PROVEN") throw new LegFailure("QUAL_STALE", "PREFLIGHT");
      states.push(state);
    }
    if (confirm(states).some((k) => k.state !== "PROVEN")) throw new LegFailure("QUAL_STALE", "PREFLIGHT");
    return n;
  }

  return { request, record, sweep, gate, plan, legPreflight, appendObservation, currentOs, keyState, required };
}

export async function boundaryGate({ fetchSnapshot, appId }) {
  let snapshot;
  try { snapshot = await fetchSnapshot(); } catch { return { exit: 2, code: "PERMISSION_UNVERIFIED", rule: "snapshot" }; }
  try {
    validatePermissionBoundary(snapshot, appId);
    return { exit: 0, keys: [], bad: [] };
  } catch (error) {
    return { exit: 2, code: error.code ?? "PERMISSION_UNVERIFIED", rule: error.rule ?? "snapshot" };
  }
}

// The one function every entry point calls first. `heartbeat` reads NO replica (the hz watchdog cannot reach the Mac).
export async function requireQualGate(args, deps = {}) {
  if (args.for === "heartbeat") return boundaryGate(deps);
  if (!deps.qual) throw new QualError("ARGS", { hint: "requireQualGate needs deps.qual" });
  return deps.qual.gate(args, deps);
}
