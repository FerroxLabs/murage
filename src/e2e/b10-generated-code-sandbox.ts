// B10 generated-code boundary. Saved generated JavaScript runs only inside a
// separate node process confined by the macOS Seatbelt kernel sandbox
// (/usr/bin/sandbox-exec, part of the base OS and the mechanism Claude Code and
// Codex CLI use for their macOS sandboxes). Node vm runs inside that process as
// defense in depth only; it is never the boundary.
//
// Per run:
// - a deny-default profile: no network (loopback included), no fork/spawn and
//   no exec except the node binary itself, no file reads except the node binary,
//   OS system libraries, the root directory listing and metadata of the
//   node/scratch path ancestors; reads and writes only in a fresh scratch dir
// - an empty environment, its own process group, SIGKILL of the whole group at
//   the deadline (SIGTERM is never relied on), and the pid and group confirmed
//   gone before any output is considered
// - byte-bounded stdout and stderr; overflow kills the group and fails the run
// - a result is accepted only as exactly one nonce-framed JSON line on stdout,
//   with empty stderr, after exit code 0 with no signal and no deadline
// Qualification runs trusted synthetic probes through the same profile against a
// canary file, a 127.0.0.1 listener and a SIGTERM-ignoring busy loop. Without a
// passing qualification no sandbox is issued, so generated code never runs.
import { spawn } from "node:child_process";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export interface JsEvaluation { loaded: boolean; error?: string; results: Array<{ args: unknown[]; value?: unknown; threw?: string }> }

export interface BoundaryLimits { deadlineMs: number; maxStdoutBytes: number; maxStderrBytes: number }
export interface EvaluationLimits extends BoundaryLimits { guestTimeoutMs: number; maxCodeBytes: number; maxCallsBytes: number }
export const EVALUATION_LIMITS: Readonly<EvaluationLimits> = Object.freeze({
  deadlineMs: 5_000, guestTimeoutMs: 1_000, maxStdoutBytes: 256 * 1024, maxStderrBytes: 16 * 1024, maxCodeBytes: 256 * 1024, maxCallsBytes: 64 * 1024,
});

export interface BoundaryRun {
  pid: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  overflow: "stdout" | "stderr" | null;
  stdout: Buffer;
  stderr: Buffer;
  /** The child pid and its whole process group were confirmed absent (ESRCH) after exit. */
  groupGone: boolean;
  elapsedMs: number;
}

export interface HostSupport { platform?: NodeJS.Platform; sandboxExec?: string; nodeBin?: string }
export type SeatbeltProfile = (nodeBin: string, scratch: string) => string;
export interface SeatbeltRunRequest extends HostSupport {
  /** Trusted runner source given to node -e inside the boundary. */
  script: string;
  stdin: string;
  /** The only readable/writable directory; created by the caller. */
  scratch: string;
  limits: BoundaryLimits;
  /** Test seam: a weaker profile must fail qualification. */
  profile?: SeatbeltProfile;
}

const NODE_FLAGS = ["--no-warnings", "--jitless", "--disallow-code-generation-from-strings", "--max-old-space-size=128"];
const FUNCTION_NAME = /^[A-Za-z_$][\w$]*$/;

function profilePath(path: string): string {
  const unsafe = [...path].some((character) => character === "\"" || character === "\\" || character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f);
  if (!isAbsolute(path) || unsafe) throw new Error(`GENERATED_CODE_SANDBOX_UNSUPPORTED: path cannot be written into a Seatbelt profile: ${JSON.stringify(path)}`);
  return `"${path}"`;
}

function pathAndAncestors(path: string): string[] {
  const paths: string[] = [];
  for (let current = path; ; current = dirname(current)) {
    paths.push(current);
    if (dirname(current) === current) return paths;
  }
}

/** The deny-default Seatbelt profile for one run: node itself, OS libraries, and one scratch directory. */
export function seatbeltProfile(nodeBin: string, scratch: string): string {
  const metadata = [...new Set([...pathAndAncestors(nodeBin), ...pathAndAncestors(scratch)])].map((path) => `(literal ${profilePath(path)})`).join(" ");
  return [
    "(version 1)",
    "(deny default)",
    `(allow process-exec (literal ${profilePath(nodeBin)}))`,
    `(allow file-read* file-map-executable (literal ${profilePath(nodeBin)}))`,
    "(allow file-read* file-map-executable (subpath \"/usr/lib\") (subpath \"/System/Library\") (subpath \"/System/Volumes/Preboot/Cryptexes\") (subpath \"/System/Cryptexes\") (subpath \"/private/var/db/dyld\"))",
    // node aborts at startup without reading the root directory; its entries are the OS layout, not file contents
    "(allow file-read-data (literal \"/\"))",
    `(allow file-read-metadata ${metadata})`,
    `(allow file-read* file-write* (subpath ${profilePath(scratch)}))`,
    "(allow file-read* file-write-data (literal \"/dev/null\"))",
    "(allow file-read* (literal \"/dev/urandom\") (literal \"/dev/random\"))",
    // node aborts at startup without sysctl reads (CPU count, OS release)
    "(allow sysctl-read)",
    "(allow signal (target self))",
    "(allow process-info* (target self))",
    "(deny network*)",
    "(deny process-fork)",
    "(deny file-link)",
  ].join("\n");
}

function supportedRuntime(options: HostSupport): { sandboxExec: string; nodeBin: string } {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") throw new Error(`GENERATED_CODE_SANDBOX_UNSUPPORTED: the Seatbelt boundary exists only on macOS (platform ${platform})`);
  const sandboxExec = options.sandboxExec ?? SANDBOX_EXEC;
  try { accessSync(sandboxExec, constants.X_OK); }
  catch { throw new Error(`GENERATED_CODE_SANDBOX_UNSUPPORTED: ${sandboxExec} is not an executable on this host`); }
  let nodeBin: string;
  try { nodeBin = realpathSync(options.nodeBin ?? process.execPath); accessSync(nodeBin, constants.X_OK); }
  catch { throw new Error(`GENERATED_CODE_SANDBOX_UNSUPPORTED: node binary ${options.nodeBin ?? process.execPath} is not an executable`); }
  profilePath(nodeBin);
  return { sandboxExec, nodeBin };
}

const isGone = (target: number): boolean => {
  try { process.kill(target, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
};

/** One node process inside the Seatbelt profile, in its own process group, hard-killed at the deadline or on output overflow. */
export async function runInSeatbelt(request: SeatbeltRunRequest): Promise<BoundaryRun> {
  const { sandboxExec, nodeBin } = supportedRuntime(request);
  const scratch = realpathSync(request.scratch);
  const profile = (request.profile ?? seatbeltProfile)(nodeBin, scratch);
  const started = Date.now();
  const child = spawn(sandboxExec, ["-p", profile, nodeBin, ...NODE_FLAGS, "-e", request.script], { cwd: scratch, env: {}, stdio: ["pipe", "pipe", "pipe"], detached: true });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  } catch (error) {
    throw new Error(`GENERATED_CODE_SANDBOX_UNSUPPORTED: ${sandboxExec} could not start: ${error instanceof Error ? error.message : String(error)}`);
  }
  child.on("error", () => { /* signal delivery to an exited child is not an error here */ });
  const pid = child.pid!;
  const killGroup = () => { try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ } };
  let timedOut = false;
  let overflow: BoundaryRun["overflow"] = null;
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  const collect = (stream: NodeJS.ReadableStream, which: "stdout" | "stderr", limit: number, chunks: Buffer[]) => {
    let size = 0;
    stream.on("data", (chunk: Buffer) => {
      if (overflow) return;
      size += chunk.length;
      if (size > limit) { overflow = which; killGroup(); return; }
      chunks.push(chunk);
    });
  };
  collect(child.stdout!, "stdout", request.limits.maxStdoutBytes, stdout);
  collect(child.stderr!, "stderr", request.limits.maxStderrBytes, stderr);
  const deadline = setTimeout(() => { timedOut = true; killGroup(); }, request.limits.deadlineMs);
  child.stdin!.on("error", () => { /* the child may exit before reading its input */ });
  child.stdin!.end(request.stdin);
  const exit = await exited;
  clearTimeout(deadline);
  // A pgid is never reused while its group exists, so anything left in it is ours.
  if (!isGone(-pid)) killGroup();
  const drained = await Promise.race([closed.then(() => true), delay(2_000).then(() => false)]);
  if (!drained) { child.stdout!.destroy(); child.stderr!.destroy(); }
  let groupGone = false;
  for (let attempt = 0; attempt < 40 && !groupGone; attempt += 1) {
    groupGone = isGone(pid) && isGone(-pid);
    if (!groupGone) { killGroup(); await delay(50); }
  }
  return { pid, exitCode: exit.code, signal: exit.signal, timedOut, overflow, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), groupGone, elapsedMs: Date.now() - started };
}

export type FrameVerdict = { ok: true; frame: Record<string, unknown> } | { ok: false; reason: string };

/** The only accepted result channel: exit 0, no signal, no deadline, no overflow, empty stderr, and exactly one JSON line carrying this run's nonce. */
export function acceptBoundaryFrame(run: BoundaryRun, nonce: string): FrameVerdict {
  if (run.overflow) return { ok: false, reason: `${run.overflow} exceeded its byte limit` };
  if (run.timedOut) return { ok: false, reason: "the deadline expired and the process group was killed" };
  if (run.signal !== null) return { ok: false, reason: `the process ended by signal ${run.signal}` };
  if (run.exitCode !== 0) return { ok: false, reason: `the process exited ${run.exitCode}` };
  if (!run.groupGone) return { ok: false, reason: "the process group was not confirmed gone" };
  if (run.stderr.length > 0) return { ok: false, reason: "the process wrote to stderr" };
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(run.stdout); }
  catch { return { ok: false, reason: "stdout is not UTF-8" }; }
  if (!text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) return { ok: false, reason: "stdout is not exactly one framed line" };
  let frame: unknown;
  try { frame = JSON.parse(text.slice(0, -1)); }
  catch { return { ok: false, reason: "the frame is not JSON" }; }
  if (frame === null || typeof frame !== "object" || Array.isArray(frame)) return { ok: false, reason: "the frame is not an object" };
  if ((frame as Record<string, unknown>).nonce !== nonce) return { ok: false, reason: "the frame nonce does not match this run" };
  return { ok: true, frame: frame as Record<string, unknown> };
}

// Trusted runner executed by node -e inside the boundary. The generated code is
// compiled into a vm context created with DONT_CONTEXTIFY (no host object backs
// its global), code generation from strings and wasm disabled, and microtasks
// drained inside each timed evaluation. Only JSON strings and primitives cross
// between the runner and that context; calls run inside timed evaluations.
const EVALUATOR_SCRIPT = String.raw`"use strict";
const fs = require("node:fs");
const vm = require("node:vm");
const { isProxy } = require("node:util").types;
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const context = vm.createContext(vm.constants.DONT_CONTEXTIFY, { name: "b10-generated-code", codeGeneration: { strings: false, wasm: false }, microtaskMode: "afterEvaluate" });
// The time limit is carried by a host-realm stage script around each guest evaluation, not by the
// guest run itself. Node raises ERR_SCRIPT_EXECUTION_TIMEOUT from C++ in the current context of the
// run whose watchdog fired: with the limit on the guest run that is the guest realm, where guest code
// can build an identical object; here it is the host realm, which guest code cannot reach.
const stage = new vm.Script("__b10stage()", { filename: "b10-stage.js" });
const run = (source, filename) => {
  const script = new vm.Script(source, { filename });
  globalThis.__b10stage = () => script.runInContext(context, { displayErrors: false, breakOnSigint: false });
  try { return stage.runInThisContext({ timeout: input.guestTimeoutMs, displayErrors: false, breakOnSigint: false }); }
  finally { delete globalThis.__b10stage; }
};
// The backend's timeout: a host-realm object whose own code is ERR_SCRIPT_EXECUTION_TIMEOUT. Guest throws
// are primitives or guest-realm objects, so they never match. Checked without running guest traps or getters.
const isBackendTimeout = (thrown) => {
  if (thrown === null || typeof thrown !== "object" || isProxy(thrown) || Object.getPrototypeOf(thrown) !== Error.prototype) return false;
  const code = Object.getOwnPropertyDescriptor(thrown, "code");
  return code !== undefined && code.value === "ERR_SCRIPT_EXECUTION_TIMEOUT";
};
const bootstrap = function () {
  "use strict";
  const define = Object.defineProperty, stringify = JSON.stringify, parse = JSON.parse, apply = Reflect.apply, finite = Number.isFinite, text = String;
  const slot = (key, value, writable) => define(globalThis, key, { value, writable, enumerable: false, configurable: false });
  const moduleObject = { exports: {} };
  slot("module", moduleObject, true);
  slot("exports", moduleObject.exports, true);
  slot("__b10thrown", undefined, true);
  slot("__b10describe", (thrown) => {
    try {
      if (thrown !== null && (typeof thrown === "object" || typeof thrown === "function")) {
        const name = thrown.name, message = thrown.message;
        return text(typeof name === "string" ? name : "Error") + ": " + text(typeof message === "string" ? message : "");
      }
      return "threw a " + typeof thrown;
    } catch (_ignored) { return "unprintable guest error"; }
  }, false);
  slot("__b10exported", (name) => {
    const holder = globalThis.module;
    const exported = holder !== null && typeof holder === "object" ? holder.exports : undefined;
    return typeof exported === "function" ? exported : exported !== null && typeof exported === "object" ? exported[name] : undefined;
  }, false);
  slot("__b10call", (fn, argsJson) => {
    if (typeof fn !== "function") return stringify({ missing: true });
    let value;
    try { value = apply(fn, undefined, parse(argsJson)); }
    catch (thrown) {
      let name = "Error";
      try { if (thrown !== null && typeof thrown === "object" && typeof thrown.name === "string") name = thrown.name; } catch (_ignored) { name = "Error"; }
      return stringify({ threw: name });
    }
    if (typeof value === "number" && !finite(value)) value = text(value);
    let json;
    try { json = stringify(value); } catch (_ignored) { return stringify({ unserializable: true }); }
    return json === undefined ? "{}" : '{"value":' + json + "}";
  }, false);
};
const describe = (thrown) => {
  if (thrown === null || (typeof thrown !== "object" && typeof thrown !== "function")) return typeof thrown === "string" ? "threw: " + thrown.slice(0, 300) : "threw a " + typeof thrown;
  if (!isProxy(thrown) && thrown instanceof Error) return String(thrown.name) + ": " + String(thrown.message).slice(0, 300);
  try {
    context.__b10thrown = thrown;
    const described = run("__b10describe(__b10thrown)", "b10-describe.js");
    return typeof described === "string" ? described.slice(0, 300) : "unprintable guest error";
  } catch (_ignored) { return "unprintable guest error"; }
};
const failed = (error) => ({ loaded: false, error, results: [] });
const main = () => {
  const name = String(input.name);
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return failed("invalid function name");
  try { run("(" + bootstrap.toString() + ")();", "b10-bootstrap.js"); }
  catch (thrown) { return failed("sandbox bootstrap failed: " + describe(thrown)); }
  try { run(String(input.code), "generated.js"); }
  catch (thrown) { return failed(isBackendTimeout(thrown) ? "generated code exceeded the time limit while loading" : describe(thrown)); }
  const resolver = "(typeof " + name + " === 'function' ? " + name + " : __b10exported(" + JSON.stringify(name) + "))";
  let found;
  try { found = run("typeof " + resolver + " === 'function'", "b10-resolve.js"); }
  catch (thrown) { return failed(isBackendTimeout(thrown) ? "resolving the function exceeded the time limit" : describe(thrown)); }
  if (found !== true) return failed("function " + name + " was not defined");
  const results = [];
  for (const args of input.calls) {
    let reply;
    try { reply = run("__b10call(" + resolver + ", " + JSON.stringify(JSON.stringify(args)) + ");", "b10-call.js"); }
    catch (thrown) { return failed(isBackendTimeout(thrown) ? "a call exceeded the time limit" : "a call failed outside the function: " + describe(thrown)); }
    if (typeof reply !== "string" || reply.length > input.maxReplyChars) return failed("a call returned an unreadable or oversized reply");
    let parsed;
    try { parsed = JSON.parse(reply); } catch (_ignored) { return failed("a call returned an unreadable reply"); }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return failed("a call returned an unreadable reply");
    if (parsed.missing === true) return failed("function " + name + " was not defined");
    if (parsed.unserializable === true) results.push({ args, threw: "UnserializableResult" });
    else if (typeof parsed.threw === "string") results.push({ args, threw: parsed.threw.slice(0, 200) });
    else if (Object.prototype.hasOwnProperty.call(parsed, "value")) results.push({ args, value: parsed.value });
    else results.push({ args });
  }
  return { loaded: true, results };
};
const bytes = Buffer.from(JSON.stringify(Object.assign({ nonce: String(input.nonce) }, main())) + "\n", "utf8");
for (let offset = 0; offset < bytes.length;) offset += fs.writeSync(1, bytes, offset, bytes.length - offset);
process.exit(0);
`;

// Trusted synthetic hostile probe with full process access inside the boundary. B10_SANDBOX_SELF_TEST
const SELF_TEST_SCRIPT = String.raw`"use strict";
// B10_SANDBOX_SELF_TEST
const fs = require("node:fs");
const net = require("node:net");
const childProcess = require("node:child_process");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const outcome = {};
const attempt = (key, action) => {
  try { outcome[key] = { ok: true, value: action() }; }
  catch (error) { outcome[key] = { ok: false, code: String(error && error.code) }; }
};
const spawnAttempt = (file, args) => () => {
  const result = childProcess.spawnSync(file, args, { stdio: "ignore", timeout: 2000 });
  if (result.error) throw result.error;
  return result.status;
};
attempt("readCanary", () => fs.readFileSync(input.canary, "utf8").length);
attempt("statCanary", () => fs.statSync(input.canary).size);
attempt("listOutside", () => fs.readdirSync(input.outside).length);
attempt("writeOutside", () => { fs.writeFileSync(input.forbiddenWrite, "guest"); return true; });
attempt("linkCanary", () => { fs.linkSync(input.canary, "linked-canary.txt"); return fs.readFileSync("linked-canary.txt", "utf8").length; });
attempt("writeScratch", () => { fs.writeFileSync("scratch-probe.txt", "ok"); return fs.readFileSync("scratch-probe.txt", "utf8"); });
attempt("spawnNode", spawnAttempt(process.execPath, ["-e", ""]));
attempt("spawnShell", spawnAttempt("/bin/sh", ["-c", "exit 0"]));
attempt("environment", () => Object.keys(process.env));
let finished = false;
const socket = net.connect({ host: "127.0.0.1", port: input.port });
const finish = (result) => {
  if (finished) return;
  finished = true;
  outcome.connect = result;
  socket.destroy();
  fs.writeSync(1, JSON.stringify({ nonce: input.nonce, outcome }) + "\n");
  process.exit(0);
};
socket.once("connect", () => finish({ ok: true }));
socket.once("error", (error) => finish({ ok: false, code: String(error.code) }));
`;

const TERMINATION_SELF_TEST_SCRIPT = String.raw`"use strict";
// B10_SANDBOX_SELF_TEST termination
process.on("SIGTERM", () => {});
require("node:fs").writeSync(1, "spinning\n");
for (;;) {}
`;

export interface QualificationReport { runtime: { platform: string; sandboxExec: string; nodeBin: string }; checks: Record<string, string>; elapsedMs: number }

const ISSUE = Symbol("b10-qualified-sandbox");
const issued = new WeakSet<object>();

export function isQualifiedGeneratedCodeSandbox(value: unknown): value is QualifiedGeneratedCodeSandbox {
  return typeof value === "object" && value !== null && issued.has(value);
}

/** Issued only by qualifyGeneratedCodeSandbox(); evaluates generated code inside the qualified boundary. */
export class QualifiedGeneratedCodeSandbox {
  readonly report: QualificationReport;
  readonly #runtime: { sandboxExec: string; nodeBin: string };
  readonly #profile: SeatbeltProfile;

  constructor(token: symbol, runtime: { sandboxExec: string; nodeBin: string }, profile: SeatbeltProfile, report: QualificationReport) {
    if (token !== ISSUE) throw new Error("GENERATED_CODE_SANDBOX_REQUIRED: sandboxes are issued only by qualifyGeneratedCodeSandbox()");
    this.#runtime = runtime;
    this.#profile = profile;
    this.report = report;
    issued.add(this);
  }

  /** Loads the code and calls one named function with JSON arguments. Limits may only tighten the defaults. */
  evaluate(code: string, name: string, calls: readonly unknown[][], limits: Partial<EvaluationLimits> = {}): Promise<JsEvaluation> {
    if (!FUNCTION_NAME.test(name)) throw new Error("invalid function name");
    const bounded = Object.fromEntries(Object.entries(EVALUATION_LIMITS).map(([key, fallback]) => {
      const requested = limits[key as keyof EvaluationLimits];
      return [key, typeof requested === "number" && requested >= 1 ? Math.min(requested, fallback) : fallback];
    })) as unknown as EvaluationLimits;
    const callsJson = JSON.stringify(calls);
    if (Buffer.byteLength(callsJson) > bounded.maxCallsBytes) throw new Error(`calls exceed ${bounded.maxCallsBytes} bytes`);
    const source = code.replace(/^\s*export\s+(default\s+)?/gm, "");
    if (Buffer.byteLength(source) > bounded.maxCodeBytes) return Promise.resolve({ loaded: false, error: `generated code exceeds ${bounded.maxCodeBytes} bytes`, results: [] });
    return this.#evaluate(source, name, JSON.parse(callsJson) as unknown[][], bounded);
  }

  async #evaluate(source: string, name: string, calls: unknown[][], limits: EvaluationLimits): Promise<JsEvaluation> {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "b10-generated-code-")));
    try {
      const scratch = join(root, "scratch");
      mkdirSync(scratch);
      const nonce = randomBytes(32).toString("hex");
      const run = await runInSeatbelt({
        ...this.#runtime, profile: this.#profile, script: EVALUATOR_SCRIPT, scratch, limits,
        stdin: JSON.stringify({ nonce, code: source, name, calls, guestTimeoutMs: limits.guestTimeoutMs, maxReplyChars: limits.maxStdoutBytes }),
      });
      if (!run.groupGone) throw new Error(`GENERATED_CODE_SANDBOX_TERMINATION_UNCONFIRMED: process group ${run.pid} was still present after SIGKILL`);
      const verdict = acceptBoundaryFrame(run, nonce);
      return verdict.ok ? frameEvaluation(verdict.frame, calls) : rejected(verdict.reason);
    } finally { safeWipeSync(root); }
  }
}

const rejected = (reason: string): JsEvaluation => ({ loaded: false, error: `GENERATED_CODE_SANDBOX_REJECTED: ${reason}`, results: [] });

function frameEvaluation(frame: Record<string, unknown>, calls: readonly unknown[][]): JsEvaluation {
  if (Object.keys(frame).some((key) => !["nonce", "loaded", "error", "results"].includes(key))) return rejected("the frame carries unexpected fields");
  if (typeof frame.loaded !== "boolean" || !Array.isArray(frame.results)) return rejected("the frame is malformed");
  if (frame.error !== undefined && (typeof frame.error !== "string" || frame.error.length > 2_000)) return rejected("the frame error is malformed");
  if (!frame.loaded) return frame.results.length === 0 ? { loaded: false, error: typeof frame.error === "string" ? frame.error : "generated code did not load", results: [] } : rejected("an unloaded frame carries results");
  if (frame.results.length !== calls.length) return rejected("the frame does not answer every call");
  const results: JsEvaluation["results"] = [];
  for (const [index, item] of (frame.results as unknown[]).entries()) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return rejected(`result ${index} is malformed`);
    const entry = item as Record<string, unknown>;
    const threwOk = !("threw" in entry) || (typeof entry.threw === "string" && entry.threw.length <= 200 && !("value" in entry));
    if (Object.keys(entry).some((key) => !["args", "value", "threw"].includes(key)) || !isDeepStrictEqual(entry.args, calls[index]) || !threwOk) return rejected(`result ${index} is malformed`);
    results.push({ args: [...calls[index]!], ...("value" in entry ? { value: entry.value } : {}), ...(typeof entry.threw === "string" ? { threw: entry.threw } : {}) });
  }
  return { loaded: true, results };
}

type ProbeOutcome = Record<string, { ok?: boolean; code?: string; value?: unknown } | undefined>;

/** Proves the boundary on this host with trusted probes, then issues a sandbox. Throws before issuing one on any unsupported or failing check. */
export async function qualifyGeneratedCodeSandbox(options: HostSupport & { profile?: SeatbeltProfile } = {}): Promise<QualifiedGeneratedCodeSandbox> {
  const runtime = supportedRuntime(options);
  const profile = options.profile ?? seatbeltProfile;
  const started = Date.now();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "b10-sandbox-qualify-")));
  let connections = 0;
  const server = createServer((socket) => { connections += 1; socket.destroy(); });
  try {
    const scratch = join(root, "scratch"), outside = join(root, "outside");
    mkdirSync(scratch);
    mkdirSync(outside);
    const canary = join(outside, "canary.txt");
    writeFileSync(canary, `B10-QUALIFY-CANARY-${randomBytes(16).toString("hex")}`);
    const forbiddenWrite = join(outside, "written-from-guest.txt");
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
    const port = (server.address() as AddressInfo).port;
    const nonce = randomBytes(32).toString("hex");
    const probe = await runInSeatbelt({ ...runtime, profile, script: SELF_TEST_SCRIPT, scratch, limits: { deadlineMs: 5_000, maxStdoutBytes: 64 * 1024, maxStderrBytes: 16 * 1024 }, stdin: JSON.stringify({ nonce, canary, outside, forbiddenWrite, port }) });
    await delay(100);
    const failures: string[] = [];
    const checks: Record<string, string> = {};
    const verdict = acceptBoundaryFrame(probe, nonce);
    if (!verdict.ok) failures.push(`the self-test run was rejected: ${verdict.reason}`);
    else {
      const outcome = (verdict.frame.outcome ?? {}) as ProbeOutcome;
      for (const key of ["readCanary", "statCanary", "listOutside", "writeOutside", "linkCanary", "spawnNode", "spawnShell", "connect"]) {
        const item = outcome[key];
        if (item?.ok === false && (item.code === "EPERM" || item.code === "EACCES")) checks[key] = `denied ${item.code}`;
        else failures.push(`${key} was not denied (${JSON.stringify(item)})`);
      }
      if (outcome.writeScratch?.ok === true && outcome.writeScratch.value === "ok") checks.writeScratch = "allowed";
      else failures.push(`writeScratch did not work (${JSON.stringify(outcome.writeScratch)})`);
      const keys = outcome.environment?.ok === true && Array.isArray(outcome.environment.value) ? (outcome.environment.value as unknown[]).map(String) : null;
      if (keys && keys.every((key) => key.startsWith("__CF_"))) checks.environment = keys.length ? `only ${keys.join(",")}` : "empty";
      else failures.push(`the environment was not empty (${JSON.stringify(keys)})`);
    }
    if (existsSync(forbiddenWrite)) failures.push("a write outside the scratch directory landed");
    if (connections > 0) failures.push(`the loopback listener accepted ${connections} connection(s)`);
    else checks.loopbackConnections = "0";
    const spin = await runInSeatbelt({ ...runtime, profile, script: TERMINATION_SELF_TEST_SCRIPT, scratch, limits: { deadlineMs: 1_500, maxStdoutBytes: 1024, maxStderrBytes: 1024 }, stdin: "" });
    if (spin.timedOut && spin.signal === "SIGKILL" && spin.groupGone && spin.stdout.toString("utf8") === "spinning\n") checks.termination = `SIGTERM ignored, SIGKILL at deadline, pid ${spin.pid} and group gone`;
    else failures.push(`termination was not confirmed (${JSON.stringify({ timedOut: spin.timedOut, signal: spin.signal, groupGone: spin.groupGone, stdout: spin.stdout.toString("utf8").slice(0, 40) })})`);
    if (failures.length) throw new Error(`GENERATED_CODE_SANDBOX_UNQUALIFIED: ${failures.join("; ")}`);
    return new QualifiedGeneratedCodeSandbox(ISSUE, runtime, profile, { runtime: { platform: process.platform, ...runtime }, checks, elapsedMs: Date.now() - started });
  } finally {
    server.close();
    safeWipeSync(root);
  }
}
