// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

// Closed receipt schema and redaction (O23 section 3). Order is fixed: step 1 parse against the CLOSED schema
// (UNTYPED_FIELD), step 2 raw-byte keyword/JWT backstop (REDACTION), step 3 the 40+ run rule on string values
// that are NOT validated hash fields. A clean receipt full of typed sha256/sha512/cdhash/git-sha values is stored.

export class ReceiptError extends Error {
  constructor(code, path) {
    super(`${code}${path ? ` at ${path}` : ""}`);
    this.code = code;
    this.path = path;
  }
}

export const SPIKES = ["S1", "S1-build", "S2", "S3", "S4"];
export const TARGETS = ["mac-a", "mac-b", "win-a", "linux-vm", "linux-box", "gh"];
export const OS_NAMES = ["macos", "windows", "linux"];

const HASH = {
  sha256: /^[0-9a-f]{64}$/,
  hex40: /^[0-9a-f]{40}$/,
  sha512: /^[A-Za-z0-9+/]{86}==$/,
};
const FORMAT = {
  utc: /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/,
  build: /^[0-9A-Za-z][0-9A-Za-z._+-]{0,39}$/,
};

// A type is: "bool" | "int" | "uint" | a key of HASH / FORMAT | ["enum", ...] | {object spec} | ["array", type, max] | ["opt", type].
const isEnum = (type) => Array.isArray(type) && type[0] === "enum";
export const enumOf = (...values) => ["enum", ...values];
export const arrayOf = (type, max = 16) => ["array", type, max];
export const opt = (type) => ["opt", type];
const isOpt = (type) => Array.isArray(type) && type[0] === "opt";

function check(type, value, path, strings) {
  if (isOpt(type)) return value === undefined ? undefined : check(type[1], value, path, strings);
  if (value === undefined) throw new ReceiptError("UNTYPED_FIELD", path);
  if (type === "bool") {
    if (typeof value !== "boolean") throw new ReceiptError("UNTYPED_FIELD", path);
  } else if (type === "int") {
    if (!Number.isSafeInteger(value)) throw new ReceiptError("UNTYPED_FIELD", path);
  } else if (type in HASH) {
    if (typeof value !== "string" || !HASH[type].test(value)) throw new ReceiptError("UNTYPED_FIELD", path);
  } else if (type in FORMAT) {
    if (typeof value !== "string" || !FORMAT[type].test(value)) throw new ReceiptError("UNTYPED_FIELD", path);
    strings.push([path, value]);
  } else if (isEnum(type)) {
    if (typeof value !== "string" || !type.slice(1).includes(value)) throw new ReceiptError("UNTYPED_FIELD", path);
    strings.push([path, value]);
  } else if (Array.isArray(type) && type[0] === "array") {
    if (!Array.isArray(value) || value.length > type[2]) throw new ReceiptError("UNTYPED_FIELD", path);
    value.forEach((item, index) => check(type[1], item, `${path}[${index}]`, strings));
  } else if (type && typeof type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReceiptError("UNTYPED_FIELD", path);
    for (const key of Object.keys(value)) {
      if (!(key in type)) throw new ReceiptError("UNTYPED_FIELD", `${path}.${key}`);
    }
    for (const [key, sub] of Object.entries(type)) check(sub, value[key], `${path}.${key}`, strings);
  } else {
    throw new Error("bad schema type");
  }
  return undefined;
}

// Step 1. Every field by JSON path and exact format; an unknown key or a mistyped value is UNTYPED_FIELD.
export function parseClosed(value, schema) {
  const strings = [];
  check(schema, value, "$", strings);
  return strings;
}

// Step 2. Keyword and token SHAPES only. Never a length rule here: a typed sha256 is 64 chars and must pass.
const BACKSTOP = [/sk-ant/, /access_token/, /refresh_token/, /Bearer /, /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./];
export function scanBackstop(bytes) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes);
  if (BACKSTOP.some((pattern) => pattern.test(text))) throw new ReceiptError("REDACTION");
  return true;
}

// Step 3. The 40+ run rule, only for string values that are not validated hash fields. After the closed schema
// there are none; it is the guard against later schema loosening.
const RUN = /[A-Za-z0-9+/_-]{40,}/;
export function scanRuns(strings) {
  for (const [path, value] of strings) if (RUN.test(value)) throw new ReceiptError("REDACTION", path);
  return true;
}

export function validateClosed(bytes, schema) {
  let receipt;
  try { receipt = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes); } catch { throw new ReceiptError("UNTYPED_FIELD", "$"); }
  const strings = parseClosed(receipt, schema);
  scanBackstop(bytes);
  scanRuns(strings);
  return receipt;
}

// Fence components (one typed slot per component; a spike's fence uses only its own).
export const FENCE = {
  n1_asset_sha256: opt("sha256"), n_asset_sha256: opt("sha256"),
  os: opt({ name: enumOf(...OS_NAMES), build: "build" }),
  probe_sha256: opt("sha256"), validator_sha256: opt("sha256"),
  epoch: opt("int"), app_id: opt("int"), repo_id: opt("int"),
};

export const COMMON = {
  spike: enumOf(...SPIKES), target: enumOf(...TARGETS), gen: "int", fence: FENCE,
  observed: { os_name: enumOf(...OS_NAMES), build: "build" },
  probe_sha256: "sha256", started: "utc", ended: "utc",
};

const line = { kind: enumOf("stop-quit", "stop-system-shutdown", "exited-0", "updater-signature-ok", "none"), line: "int", sha256: "sha256" };
const noLine = opt(line);

export const SCHEMAS = {
  S1: {
    ...COMMON,
    switches_passed: "bool", updater_fetch: "bool", transfer_status: enumOf("200", "206", "none"),
    consumed_sha256: "sha256", relaunch: "bool", identity: enumOf("N", "N-1", "control", "unknown"),
    identity_cdhash: opt("hex40"), success_line: noLine,
    control_kind: enumOf("hash-valid-sig-invalid", "bad-asc", "byte-flip", "none"),
    control_result: enumOf("refused", "accepted", "absent"),
    control_refusal_source: enumOf("publisher-error", "updater-log", "shipit-stderr", "asc-verify", "none"),
    control_relaunched_tampered: "bool",
    signature_source: enumOf("completed", "unrouted", "tls-failure", "not-applicable"),
  },
  S2: {
    ...COMMON,
    engine_version: "build",
    runs: arrayOf({ epoch: "int", completed: "bool", real_reply: "bool", sign_in_ui: "bool", auth_error: "bool", credential_valid: "bool", file_deleted: "bool" }, 4),
    residue: "bool", core: "bool", control: enumOf("no-credential", "completed", "absent"),
  },
  S3: {
    ...COMMON,
    exit_ms: "int", wait_signal: enumOf("none", "SIGKILL", "SIGTERM", "not-applicable"),
    stop: opt({ kind: enumOf("stop-quit", "stop-system-shutdown"), line: "int", sha256: "sha256", after_mark: "bool" }),
    exited: opt({ kind: enumOf("exited-0"), line: "int", sha256: "sha256", after_mark: "bool" }),
    log_rotated: "bool", hard_kill_control: enumOf("graded-failed", "graded-passed", "absent"),
  },
  S4: {
    ...COMMON,
    repo_guard: enumOf("ok", "is-releases"), token_scope: enumOf("ok", "includes-releases", "unreadable"),
    listed_repos_observed: "int",
    part_i: "bool", part_ii: "bool",
    part_iii_a: enumOf("refused-403", "refused-404-proven", "404-unproven", "server-error", "accepted"),
    part_iii_b: enumOf("rule-violation", "other", "accepted"),
    part_iii_c: "bool", part_iii_d: "bool", part_iv: arrayOf(enumOf("tag-move", "asset-replace", "asset-delete", "release-delete", "draft-edit"), 8), part_v: "bool",
  },
};
SCHEMAS["S1-build"] = SCHEMAS.S1;

// Request/result metadata are closed enums, never a login or machine name (r5 Fable M2).
export const METADATA = { requester: enumOf("main"), host: enumOf("mac", "hz") };
export function assertMetadata({ requester, host }) {
  parseClosed({ requester, host }, METADATA);
}
