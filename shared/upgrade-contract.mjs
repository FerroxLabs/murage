// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The one shape every producer of upgrade status sends and every screen reads (contract version 2). Producers: the progress tracker, the
// start-up note, the heartbeat thread, the pre-listen responder and /api/health. Consumers: the shell's upgrade window and the app's strip,
// settings detail and reclaim offer, each through the reducer in upgrade-machine.mjs.
//
// Every field is required. "Not known" is a value (the string "unknown", or an explicit `exact:false` / `stable:false`), never an absent
// field, so a screen cannot turn an omission into a claim. A producer that is missing something throws (buildUpgradeState); a consumer that
// is given something malformed is told so (parseUpgradeState) and keeps what it was showing. No words live here: `holdKey` and `phase` are
// ids the screens translate.
//
// The kit below is one self-contained function on purpose: the worker threads that speak for a blocked server are created from source text and
// cannot import this module, so UPGRADE_CONTRACT_SOURCE is made from the very same function (its test runs both and compares their output).

/** The version a reading must carry. A reading with no version came from a server that predates the contract (shown as indeterminate only). */
export const CONTRACT_V = 2;

function contractKit() {
  const CONTRACT = 2;
  const SOURCES = ["note", "responder", "health"];
  const STAGES = ["starting", "background", "blocked", "idle", "unknown"];
  const PHASES = ["checking", "copying", "migrating", "search-index", "output-index", "references", "shapes", "learning", "lineage", "writetime", "marker", "storage", "message-index", "masking", "settling"];
  const UNITS = ["messages", "conversations", "bytes", "sets", "open", "none"];
  const STORAGE = ["converting", "reclaim-available", "waiting-for-disk", "idle", "unknown"];
  const MODES = ["off", "capture", "active", "paused", "unknown"];
  const TRI = [true, false, "unknown"];
  const ONOFF = ["on", "off", "unknown"];
  /** What each phase counts when (and only when) its figures are exact: the unit a screen may show a "done of total" for. Every other phase is "none". */
  const COUNTED = { copying: "bytes", lineage: "conversations", "message-index": "messages", storage: "sets", marker: "open" };
  const KEYS = ["v", "launch", "seq", "source", "stage", "phase", "overall", "complete", "held", "holdKey", "capture", "recall", "storedMode", "counts", "keepOpen", "step", "eta", "storage", "heartbeatAt", "progressAt", "blocked", "checking"];
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const count = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const whole = (value) => count(value) && Number.isInteger(value);
  const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

  /** The reason a value is not a valid state, or null. */
  function problem(s) {
    if (!isObject(s)) return "not-an-object";
    for (const key of KEYS) if (!has(s, key) || s[key] === undefined) return "missing:" + key;
    if (s.v !== CONTRACT) return "version";
    if (typeof s.launch !== "string" || !(s.launch === "unknown" || /^[0-9a-f]{64}$/.test(s.launch))) return "launch";
    if (!whole(s.seq)) return "seq";
    if (!SOURCES.includes(s.source)) return "source";
    if (!STAGES.includes(s.stage)) return "stage";
    if (!(s.phase === "none" || s.phase === "unknown" || PHASES.includes(s.phase))) return "phase";
    if (!(s.overall === "unknown" || (typeof s.overall === "number" && s.overall >= 0 && s.overall <= 1))) return "overall";
    if (!TRI.includes(s.complete)) return "complete";
    if (!TRI.includes(s.held)) return "held";
    if (!(s.holdKey === null || (typeof s.holdKey === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(s.holdKey)))) return "holdKey";
    if ((s.held === true) !== (s.holdKey !== null)) return "holdKey-vs-held";
    if (!ONOFF.includes(s.capture)) return "capture";
    if (!ONOFF.includes(s.recall)) return "recall";
    if (s.held === true && (s.capture !== "off" || s.recall !== "off")) return "held-but-capturing";
    if (s.held === true && s.complete === true) return "held-but-complete";
    if (!MODES.includes(s.storedMode)) return "storedMode";
    if (!TRI.includes(s.keepOpen)) return "keepOpen";
    if (!STORAGE.includes(s.storage)) return "storage";
    // whether earlier memory is being checked in the background outside the upgrade's own jobs (a large set's proof): true, false or "unknown"
    if (!TRI.includes(s.checking)) return "checking";
    const counts = s.counts;
    if (!isObject(counts) || typeof counts.exact !== "boolean") return "counts";
    if (counts.exact) {
      if (!whole(counts.messages) || !whole(counts.conversations) || !whole(counts.memoryRecords)) return "counts-figures";
      if (!(counts.firstMessageAt === null || (typeof counts.firstMessageAt === "number" && Number.isFinite(counts.firstMessageAt) && counts.firstMessageAt > 0))) return "counts-first";
    }
    const step = s.step;
    if (!isObject(step) || !count(step.awakeElapsedMs) || !UNITS.includes(step.unit)) return "step";
    if (step.unit === "none") { if (step.done !== undefined || step.total !== undefined) return "step-uncounted"; }
    else if (step.unit === "open") {
      // an open-ended step: what has been handled so far, never a total (its end moves as it goes), so a screen shows no percent and no time left
      if (!count(step.done) || step.total !== undefined) return "step-figures";
      if (COUNTED[s.phase] !== step.unit) return "step-unit";
    } else {
      if (!count(step.done) || !count(step.total) || step.done > step.total) return "step-figures";
      if (COUNTED[s.phase] !== step.unit) return "step-unit";
    }
    const eta = s.eta;
    if (!isObject(eta) || typeof eta.stable !== "boolean") return "eta";
    if (eta.stable && !count(eta.ms)) return "eta-ms";
    if (!(s.heartbeatAt === null || count(s.heartbeatAt))) return "heartbeatAt";
    if (!(s.progressAt === null || count(s.progressAt))) return "progressAt";
    if (s.blocked !== null && !(isObject(s.blocked) && typeof s.blocked.code === "string" && /^[A-Z_]{1,60}$/.test(s.blocked.code))) return "blocked";
    if ((s.stage === "blocked") !== (s.blocked !== null)) return "blocked-vs-stage";
    if (s.stage === "idle" && s.phase !== "none") return "idle-phase";
    return null;
  }
  /** A clean copy: known fields only, in a fixed order (the step's total is never below its done). */
  function clean(s) {
    const step = { awakeElapsedMs: s.step.awakeElapsedMs, unit: s.step.unit };
    if (s.step.unit === "open") step.done = s.step.done;
    else if (s.step.unit !== "none") { step.done = s.step.done; step.total = Math.max(s.step.total, s.step.done); }
    const out = {};
    for (const key of KEYS) out[key] = s[key];
    out.step = step;
    out.counts = s.counts.exact ? { exact: true, messages: s.counts.messages, conversations: s.counts.conversations, memoryRecords: s.counts.memoryRecords, firstMessageAt: s.counts.firstMessageAt } : { exact: false };
    out.eta = s.eta.stable ? { stable: true, ms: s.eta.ms } : { stable: false };
    out.blocked = s.blocked === null ? null : { code: s.blocked.code };
    return out;
  }
  /** The producer's helper. Throws when anything is missing or inconsistent: a producer must say what it knows and mark the rest "unknown". */
  function buildUpgradeState(input) {
    // the total of a counted step can never be below what was done (live writes move the total)
    const raised = isObject(input) && isObject(input.step) && input.step.unit !== "none" && count(input.step.done) && count(input.step.total) && input.step.total < input.step.done
      ? { ...input, step: { ...input.step, total: input.step.done } } : input;
    const reason = problem(raised);
    if (reason) throw new Error("upgrade state is not valid: " + reason);
    return clean(raised);
  }
  /** The consumer's helper: { ok: true, state } or { ok: false, reason } ("legacy" for a server that predates the contract). Never throws. */
  function parseUpgradeState(raw) {
    try {
      if (!isObject(raw)) return { ok: false, reason: "not-an-object" };
      if (raw.v === undefined) return { ok: false, reason: "legacy" };
      const reason = problem(raw);
      return reason ? { ok: false, reason } : { ok: true, state: clean(raw) };
    } catch { return { ok: false, reason: "malformed" }; }
  }
  /** The same state with some fields replaced and everything re-checked (a thread that speaks for a blocked server stamps its own source and clock). */
  function restampUpgradeState(state, patch) { return buildUpgradeState({ ...state, ...patch }); }
  /** What a producer says before it knows anything: every field is explicit, nothing is claimed. */
  function unknownUpgradeState(overrides) {
    return buildUpgradeState({
      v: CONTRACT, launch: "unknown", seq: 0, source: "health", stage: "unknown", phase: "unknown", overall: "unknown", complete: "unknown", held: "unknown", holdKey: null,
      capture: "unknown", recall: "unknown", storedMode: "unknown", counts: { exact: false }, keepOpen: "unknown", step: { awakeElapsedMs: 0, unit: "none" }, eta: { stable: false },
      storage: "unknown", heartbeatAt: null, progressAt: null, blocked: null, checking: "unknown", ...(overrides || {}),
    });
  }
  /** Time awake: each tick adds the gap since the last one, but never more than `cap`, so a machine asleep for ten minutes adds a few seconds, not ten minutes. */
  function createAwakeMeter(cap, now) {
    const clock = typeof now === "function" ? now : Date.now;
    let total = 0, last = clock();
    return {
      tick() { const at = clock(); total += Math.max(0, Math.min(cap, at - last)); last = at; return total; },
      total() { return total; },
      reset() { total = 0; last = clock(); },
    };
  }
  return { CONTRACT, SOURCES, STAGES, PHASES, UNITS, STORAGE, MODES, COUNTED, KEYS, buildUpgradeState, parseUpgradeState, restampUpgradeState, unknownUpgradeState, createAwakeMeter, problem };
}

const kit = contractKit();
export const SOURCES = Object.freeze([...kit.SOURCES]);
export const STAGES = Object.freeze([...kit.STAGES]);
export const PHASE_IDS = Object.freeze([...kit.PHASES]);
export const CONTRACT_KEYS = Object.freeze([...kit.KEYS]);
/** The only phases a screen may show a "done of total" for, and the unit of each. Everything else shows activity and elapsed time. */
export const COUNTED_UNITS = Object.freeze({ ...kit.COUNTED });
export const buildUpgradeState = kit.buildUpgradeState;
export const parseUpgradeState = kit.parseUpgradeState;
export const restampUpgradeState = kit.restampUpgradeState;
export const unknownUpgradeState = kit.unknownUpgradeState;
export const createAwakeMeter = kit.createAwakeMeter;
/** A gap between two ticks of a clock that counts awake time is capped at twice the heartbeat interval. */
export const AWAKE_GAP_CAP_MS = 4_000;
/** The same kit as plain source, for worker threads created from a string: defines buildUpgradeState, parseUpgradeState, restampUpgradeState,
 * unknownUpgradeState and createAwakeMeter. Test: it must give the same answers as this module (shared/upgrade-contract.node-test.mjs). */
export const UPGRADE_CONTRACT_SOURCE = `
const __contract = (${contractKit.toString()})();
const { buildUpgradeState, parseUpgradeState, restampUpgradeState, unknownUpgradeState, createAwakeMeter } = __contract;
`;

const HEX = (character) => character.repeat(64);
/** A valid state for tests and fixtures; `over` replaces fields. */
export function sampleState(over = {}) {
  return buildUpgradeState({
    v: CONTRACT_V, launch: HEX("a"), seq: 3, source: "health", stage: "background", phase: "message-index", overall: 0.5, complete: false, held: false, holdKey: null,
    capture: "on", recall: "on", storedMode: "active", counts: { exact: true, messages: 1200, conversations: 40, memoryRecords: 90, firstMessageAt: 1_600_000_000_000 }, keepOpen: true,
    step: { awakeElapsedMs: 12_000, unit: "messages", done: 300, total: 1200 }, eta: { stable: true, ms: 360_000 }, storage: "idle", heartbeatAt: 1_000, progressAt: 1_000, blocked: null, checking: false, ...over,
  });
}

/** Every case a consumer must survive: each combination of the tri-state fields, each missing field, an old server, a stale launch and junk.
 * `valid` says whether parseUpgradeState must accept it; `kind` names the case. */
export function contractFixtures() {
  const base = { ...sampleState() };
  const out = [];
  for (const held of [true, false, "unknown"]) for (const complete of [true, false, "unknown"]) for (const keepOpen of [true, false, "unknown"]) {
    const raw = { ...base, held, complete, keepOpen, holdKey: held === true ? "memoryStrip.hold" : null, ...(held === true ? { capture: "off", recall: "off" } : {}) };
    out.push({ name: `held=${held} complete=${complete} keepOpen=${keepOpen}`, kind: "tristate", raw, valid: !(held === true && complete === true) });
  }
  for (const key of CONTRACT_KEYS) { const raw = { ...base }; delete raw[key]; out.push({ name: `missing ${key}`, kind: "missing-field", raw, valid: false, legacy: key === "v" }); }
  out.push({ name: "old server (no v)", kind: "old-server", raw: { phaseId: "migrating", fraction: 0.4, overall: 0.4, keepOpen: true }, valid: false, legacy: true });
  out.push({ name: "future version", kind: "malformed", raw: { ...base, v: 3 }, valid: false });
  out.push({ name: "stale launch", kind: "stale-launch", raw: { ...base, launch: HEX("b") }, valid: true });
  out.push({ name: "unknown launch", kind: "unknown-launch", raw: { ...base, launch: "unknown", overall: "unknown" }, valid: true });
  for (const [name, raw] of [["null", null], ["string", "upgrading"], ["array", []], ["number", 7], ["nan overall", { ...base, overall: Number.NaN }], ["overall above one", { ...base, overall: 1.5 }], ["bad stage", { ...base, stage: "soon" }],
    ["counts without exact", { ...base, counts: { messages: 5 } }], ["approximate counts", { ...base, counts: { exact: false, messages: 5 } }, true], ["step without unit", { ...base, step: { awakeElapsedMs: 1 } }],
    ["counted unit on the wrong phase", { ...base, phase: "shapes" }], ["held while capturing", { ...base, held: true, holdKey: "memoryStrip.hold" }], ["stable eta without ms", { ...base, eta: { stable: true } }],
    ["checking not a tri-state", { ...base, checking: "yes" }], ["checking null", { ...base, checking: null }]]) {
    // an `exact:false` counts object that carries extra keys is accepted and cleaned (the extra figures are dropped, never shown)
    out.push({ name, kind: "malformed", raw, valid: raw?.counts?.exact === false });
  }
  return out;
}
