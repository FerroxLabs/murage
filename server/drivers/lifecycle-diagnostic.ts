// Engine lifecycle diagnostics, schema v1 (0.1.52 R1-T8, per
// 0152-RELIABILITY-DESIGN.md "R1: bounded lifecycle evidence").
//
// One bounded, allowlisted NDJSON record per lifecycle transition of a
// provider child process, written into the existing native protocol tee
// (same 0600 file, 64 KiB record and 4 MiB + 4 MiB retention). Records let a
// retained incident tell a requested stop, an observed RPC rejection and an
// unsolicited close apart, and tie each one to exactly one child generation
// and turn. A `closed` with no earlier `stop_requested` means the initiator is
// unknown; nothing here infers one, and nothing rewrites an earlier record.
//
// Privacy: every field is typed, enumerated or pattern-checked. No prompts,
// tool inputs or results, stderr, env, argv, URLs, filesystem paths, account
// names, credentials or hashes of secrets. A record that fails validation or
// exceeds its byte bound is omitted and counted. Logging never throws into,
// retries or changes a turn.
import { randomUUID } from "node:crypto";
import { constants as osConstants } from "node:os";

import type { StopRoute, StopRouteObservation, StopRouteResult } from "../procs.ts";
import { redactSecretsInText } from "../redact.ts";
import { appendNative } from "./native.ts";

export const LIFECYCLE_TYPE = "engine_lifecycle";
export const LIFECYCLE_SCHEMA = 1;
/** Native-tee `dir` tag: keeps lifecycle rows apart from in/out protocol rows. */
export const LIFECYCLE_DIR = "lifecycle";
export const LIFECYCLE_SOURCE = "murage.engine-lifecycle";
export const LIFECYCLE_MAX_EVENT_BYTES = 2 * 1024;
export const LIFECYCLE_MAX_EVENTS_PER_CHILD = 128;
export const LIFECYCLE_MAX_PENDING_METHODS = 8;

export const LIFECYCLE_EVENTS = [
  "spawn_requested", "spawned", "spawn_failed", "rpc_requested", "rpc_rejected", "stop_requested",
  "stop_route", "stop_route_result", "turn_settled", "closed", "events_omitted",
] as const;
export type LifecycleEventName = (typeof LIFECYCLE_EVENTS)[number];

export const LIFECYCLE_STOP_REASONS = [
  "user_cancel", "driver_dispose", "turn_complete", "turn_failure", "cancel_timeout", "unspecified",
] as const;
export type LifecycleStopReason = (typeof LIFECYCLE_STOP_REASONS)[number];

const STOP_ROUTES = [
  "windows_taskkill", "windows_child_kill", "posix_group_sigterm", "posix_child_sigterm", "already_exited",
] as const satisfies readonly StopRoute[];
const STOP_ROUTE_RESULTS = ["requested", "succeeded", "failed", "fallback"] as const satisfies readonly StopRouteResult[];

/** The existing safe ACP diagnostic set; anything else is `other`. */
export const LIFECYCLE_RPC_METHODS = [
  "initialize", "authenticate", "session/new", "session/load", "session/prompt",
  "session/set_mode", "session/set_model", "session/set_config_option",
] as const;
const RPC_METHODS: ReadonlySet<string> = new Set(LIFECYCLE_RPC_METHODS);

const ERRNO_CATEGORIES: ReadonlySet<string> = new Set([
  "ENOENT", "EACCES", "EPERM", "ESRCH", "EINVAL", "ENAMETOOLONG", "E2BIG", "EAGAIN",
  "ENOMEM", "EMFILE", "ETIMEDOUT", "EPIPE", "ECHILD",
]);
const PLATFORMS: ReadonlySet<string> = new Set(["darwin", "linux", "win32"]);
const SIGNALS: ReadonlySet<string> = new Set(Object.keys(osConstants.signals));
const OMITTED_REASONS = ["budget", "size", "invalid"] as const;
type OmittedReason = (typeof OMITTED_REASONS)[number];

const OPAQUE_ID = /^[A-Za-z0-9._:@+-]{1,128}$/;
const SHORT_VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,24})?$/;

export interface LifecycleFields {
  pid?: number | null;
  rpcId?: number;
  method?: string;
  rpcCode?: number;
  httpStatus?: number;
  pendingMethods?: readonly string[];
  pendingCount?: number;
  reason?: LifecycleStopReason;
  route?: StopRoute;
  result?: StopRouteResult;
  errno?: string;
  code?: number | null;
  signal?: string | null;
  settled?: boolean;
  cancelRequested?: boolean;
  promptSent?: boolean;
}

export type LifecycleRecord = Record<string, unknown> & {
  type: typeof LIFECYCLE_TYPE;
  schema: typeof LIFECYCLE_SCHEMA;
  event: LifecycleEventName;
  processGeneration: string;
  sequence: number;
};

export type LifecycleSink = (
  threadId: string,
  entry: { dir: typeof LIFECYCLE_DIR; source: string; msg: LifecycleRecord },
) => void;

export interface LifecycleRecorderOptions {
  /** Native-stream key only; never copied into the record. */
  threadId: string;
  driver: string;
  instanceId?: string;
  turnId?: string;
  /** Existing cached identities only; missing is null (no probe per turn). */
  appVersion?: string | null;
  engineVersion?: string | null;
  platform?: NodeJS.Platform;
  sink?: LifecycleSink;
  now?: () => number;
  maxEvents?: number;
  maxEventBytes?: number;
}

export interface LifecycleRecorder {
  readonly generation: string;
  record(event: Exclude<LifecycleEventName, "events_omitted">, fields?: LifecycleFields): void;
  /** killCliTree observer: route choice → stop_route, outcome → stop_route_result. */
  readonly observeStopRoute: (observation: StopRouteObservation) => void;
}

/** Reserved slots survive the ordinary budget: first stop request, one turn
 * settlement and one close. */
const RESERVED: ReadonlySet<string> = new Set(["stop_requested", "turn_settled", "closed"]);

export function createLifecycleRecorder(options: LifecycleRecorderOptions): LifecycleRecorder {
  const generation = randomUUID();
  const sink: LifecycleSink = options.sink ?? ((threadId, entry) => appendNative(threadId, entry));
  const now = options.now ?? (() => performance.now());
  const started = now();
  const maxEvents = options.maxEvents ?? LIFECYCLE_MAX_EVENTS_PER_CHILD;
  const maxEventBytes = options.maxEventBytes ?? LIFECYCLE_MAX_EVENT_BYTES;
  const platform = PLATFORMS.has(options.platform ?? process.platform) ? (options.platform ?? process.platform) : "other";

  // Identity is validated once. An invalid identity field is never written;
  // every event then counts as omitted/invalid rather than leaking it.
  const identity: Record<string, unknown> = { driver: options.driver };
  if (options.instanceId !== undefined) identity.instanceId = options.instanceId;
  if (options.turnId !== undefined) identity.turnId = options.turnId;
  identity.appVersion = options.appVersion ?? null;
  identity.engineVersion = options.engineVersion ?? null;
  const identityValid =
    opaqueId(options.driver) &&
    (options.instanceId === undefined || opaqueId(options.instanceId)) &&
    (options.turnId === undefined || opaqueId(options.turnId)) &&
    (identity.appVersion === null || version(identity.appVersion)) &&
    (identity.engineVersion === null || version(identity.engineVersion));

  let sequence = 0;
  let ordinary = 0;
  let omitted = 0;
  let omittedReason: OmittedReason | null = null;
  const reservedUsed = new Set<string>();

  const deliver = (msg: LifecycleRecord) => {
    try {
      sink(options.threadId, { dir: LIFECYCLE_DIR, source: LIFECYCLE_SOURCE, msg });
    } catch {
      /* logging failure never fails or retries a turn */
    }
  };
  const drop = (reason: OmittedReason) => {
    omitted += 1;
    // First cause wins so a budget overflow is not relabelled by a later one.
    omittedReason ??= reason;
  };
  const flushOmitted = () => {
    if (!omitted) return;
    const msg: LifecycleRecord = {
      type: LIFECYCLE_TYPE,
      schema: LIFECYCLE_SCHEMA,
      event: "events_omitted",
      processGeneration: generation,
      sequence: ++sequence,
      platform,
      elapsedMs: elapsed(),
      omitted,
      omittedReason: omittedReason ?? "invalid",
    };
    omitted = 0;
    omittedReason = null;
    deliver(msg);
  };
  const elapsed = () => Math.max(0, Math.round(now() - started));

  const record: LifecycleRecorder["record"] = (event, fields = {}) => {
    try {
      const reserved = RESERVED.has(event) && !reservedUsed.has(event);
      if (!reserved) {
        // Every ordinary observation takes a sequence number, so an omitted
        // one leaves a visible gap.
        const observed = ++sequence;
        if (ordinary >= maxEvents) return drop("budget");
        const msg = identityValid ? build(event, fields, observed) : null;
        if (!msg) return drop("invalid");
        if (Buffer.byteLength(JSON.stringify(msg)) > maxEventBytes) return drop("size");
        ordinary += 1;
        deliver(msg);
        return;
      }
      // Reserved slot: validate first. Pending omissions are reported once,
      // right before it, and only a delivered record uses the slot.
      const msg = identityValid ? build(event, fields, 0) : null;
      if (!msg) {
        drop("invalid");
        flushOmitted();
        return;
      }
      flushOmitted();
      msg.sequence = ++sequence;
      if (Buffer.byteLength(JSON.stringify(msg)) > maxEventBytes) {
        drop("size");
        flushOmitted();
        return;
      }
      reservedUsed.add(event);
      deliver(msg);
    } catch {
      /* never let diagnostics break a run */
    }
  };

  const build = (event: LifecycleEventName, fields: LifecycleFields, observed: number): LifecycleRecord | null => {
    if (!(LIFECYCLE_EVENTS as readonly string[]).includes(event)) return null;
    const msg: LifecycleRecord = {
      type: LIFECYCLE_TYPE,
      schema: LIFECYCLE_SCHEMA,
      event,
      processGeneration: generation,
      sequence: observed,
      ...identity,
      platform,
      elapsedMs: elapsed(),
    };
    if (fields.pid !== undefined) {
      if (fields.pid !== null && !positiveInt(fields.pid)) return null;
      msg.pid = fields.pid;
    }
    if (fields.rpcId !== undefined) {
      if (!Number.isSafeInteger(fields.rpcId) || fields.rpcId < 0) return null;
      msg.rpcId = fields.rpcId;
    }
    if (fields.method !== undefined) {
      if (typeof fields.method !== "string") return null;
      msg.method = rpcMethod(fields.method);
    }
    if (fields.rpcCode !== undefined) {
      if (!Number.isSafeInteger(fields.rpcCode)) return null;
      msg.rpcCode = fields.rpcCode;
    }
    if (fields.httpStatus !== undefined) {
      if (!Number.isInteger(fields.httpStatus) || fields.httpStatus < 100 || fields.httpStatus > 599) return null;
      msg.httpStatus = fields.httpStatus;
    }
    if (fields.pendingMethods !== undefined) {
      if (!Array.isArray(fields.pendingMethods) || fields.pendingMethods.some((m) => typeof m !== "string")) return null;
      msg.pendingMethods = [...new Set(fields.pendingMethods.map(rpcMethod))].sort().slice(0, LIFECYCLE_MAX_PENDING_METHODS);
    }
    if (fields.pendingCount !== undefined) {
      if (!Number.isSafeInteger(fields.pendingCount) || fields.pendingCount < 0) return null;
      msg.pendingCount = fields.pendingCount;
    }
    if (fields.reason !== undefined) {
      if (!(LIFECYCLE_STOP_REASONS as readonly string[]).includes(fields.reason)) return null;
      msg.reason = fields.reason;
    }
    if (fields.route !== undefined) {
      if (!(STOP_ROUTES as readonly string[]).includes(fields.route)) return null;
      msg.route = fields.route;
    }
    if (fields.result !== undefined) {
      if (!(STOP_ROUTE_RESULTS as readonly string[]).includes(fields.result)) return null;
      msg.result = fields.result;
    }
    if (fields.errno !== undefined) {
      if (typeof fields.errno !== "string") return null;
      msg.errno = ERRNO_CATEGORIES.has(fields.errno) ? fields.errno : "other";
    }
    if (fields.code !== undefined) {
      // Preserve a numeric Windows exit value exactly as supplied.
      if (fields.code !== null && !Number.isSafeInteger(fields.code)) return null;
      msg.code = fields.code;
    }
    if (fields.signal !== undefined) {
      if (fields.signal !== null && !SIGNALS.has(fields.signal)) return null;
      msg.signal = fields.signal;
    }
    for (const key of ["settled", "cancelRequested", "promptSent"] as const) {
      if (fields[key] === undefined) continue;
      if (typeof fields[key] !== "boolean") return null;
      msg[key] = fields[key];
    }
    return msg;
  };

  const observeStopRoute = (observation: StopRouteObservation) => {
    const choice = observation.result === "requested" || observation.result === "fallback";
    record(choice ? "stop_route" : "stop_route_result", {
      route: observation.route,
      result: observation.result,
      ...(observation.errno !== undefined ? { errno: observation.errno } : {}),
    });
  };

  return { generation, record, observeStopRoute };
}

function opaqueId(value: unknown): value is string {
  // Pattern first, then the shared secret detector: an ID-shaped credential
  // (an `sk-…` or `xai-…` token) is refused, never masked into the record.
  return typeof value === "string" && OPAQUE_ID.test(value) && redactSecretsInText(value) === value;
}
function version(value: unknown): boolean {
  return typeof value === "string" && SHORT_VERSION.test(value);
}
function positiveInt(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function rpcMethod(method: string): string {
  return RPC_METHODS.has(method) ? method : "other";
}

/** errno code of an unknown error, for the observer/diagnostic allowlist. */
export function errnoCategory(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}
