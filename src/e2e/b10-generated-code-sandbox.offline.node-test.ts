// Offline proof of the B10 generated-code boundary with synthetic hostile code
// only: a canary file and a 127.0.0.1 listener this test creates, a synthetic
// parent secret, and busy loops. No model-generated code, network host,
// credential or home path is touched.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { evaluateJsFunction } from "./b09-b10-family-fixture.ts";
import {
  acceptBoundaryFrame, isQualifiedGeneratedCodeSandbox, qualifyGeneratedCodeSandbox, runInSeatbelt, type BoundaryLimits, type QualifiedGeneratedCodeSandbox,
} from "./b10-generated-code-sandbox.ts";

const onDarwin = process.platform === "darwin";
const macOnly = { skip: onDarwin ? false : "the Seatbelt boundary exists only on macOS; the fail-closed test covers this host" };
let qualification: Promise<QualifiedGeneratedCodeSandbox> | undefined;
const sandbox = () => (qualification ??= qualifyGeneratedCodeSandbox());
const LIMITS: BoundaryLimits = { deadlineMs: 5_000, maxStdoutBytes: 64 * 1024, maxStderrBytes: 4 * 1024 };

async function withRoot(prefix: string, body: (root: string) => Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  try { await body(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

async function listener(): Promise<{ server: Server; port: number; hits: () => number }> {
  let hits = 0;
  const server = createServer((socket) => { hits += 1; socket.destroy(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return { server, port: (server.address() as AddressInfo).port, hits: () => hits };
}

const marked = (marker: string) => execFileSync("/bin/ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8" }).split("\n").filter((line) => line.includes(marker));
const gone = (target: number) => {
  try { process.kill(target, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
};

test("generated code fails closed before it runs: no sandbox, a forged sandbox, an unsupported platform, a missing runtime, an unenforcing runtime or a weak profile", async () => {
  const marker = "__b10_guest_code_ran";
  const code = `globalThis.${marker} = true; function run() { return 1; }`;
  assert.throws(() => evaluateJsFunction(code, "run", [[]]), /GENERATED_CODE_SANDBOX_REQUIRED/);
  const forged = { report: {}, evaluate: () => { Reflect.set(globalThis, marker, true); return Promise.resolve({ loaded: true, results: [] }); } };
  assert.equal(isQualifiedGeneratedCodeSandbox(forged), false);
  assert.throws(() => evaluateJsFunction(code, "run", [[]], forged as unknown as QualifiedGeneratedCodeSandbox), /GENERATED_CODE_SANDBOX_REQUIRED/);
  assert.equal(Reflect.get(globalThis, marker), undefined);
  await withRoot("b10-fail-closed-", async (root) => {
    const log = join(root, "invocations.log");
    // A stand-in runtime that records each invocation and runs the command with no profile at all.
    const unenforcing = join(root, "sandbox-exec");
    writeFileSync(unenforcing, `#!/bin/sh\ncase "$*" in *B10_SANDBOX_SELF_TEST*) echo self-test >> '${log}' ;; *) echo other >> '${log}' ;; esac\nshift 2\nexec "$@"\n`);
    chmodSync(unenforcing, 0o755);
    await assert.rejects(qualifyGeneratedCodeSandbox({ platform: "linux", sandboxExec: unenforcing }), /GENERATED_CODE_SANDBOX_UNSUPPORTED: the Seatbelt boundary exists only on macOS/);
    await assert.rejects(qualifyGeneratedCodeSandbox({ platform: "darwin", sandboxExec: join(root, "absent-sandbox-exec") }), /GENERATED_CODE_SANDBOX_UNSUPPORTED: .* is not an executable/);
    assert.equal(existsSync(log), false, "no process starts on an unsupported host");
    if (!onDarwin) return;
    await assert.rejects(qualifyGeneratedCodeSandbox({ sandboxExec: unenforcing }), (error: Error) => {
      assert.match(error.message, /^GENERATED_CODE_SANDBOX_UNQUALIFIED: /);
      for (const check of ["readCanary", "writeOutside", "spawnShell", "connect", "loopback listener accepted"]) assert.match(error.message, new RegExp(check));
      return true;
    });
    const invocations = readFileSync(log, "utf8").trim().split("\n");
    assert.deepEqual([...new Set(invocations)], ["self-test"], "only the trusted self-test ran under the unenforcing runtime");
    await assert.rejects(qualifyGeneratedCodeSandbox({ profile: () => "(version 1)\n(allow default)" }), /GENERATED_CODE_SANDBOX_UNQUALIFIED: .*readCanary was not denied/);
  });
});

test("qualification proves the Seatbelt boundary on this host before a sandbox is issued", macOnly, async () => {
  const issued = await sandbox();
  assert.equal(isQualifiedGeneratedCodeSandbox(issued), true);
  assert.equal(issued.report.runtime.sandboxExec, "/usr/bin/sandbox-exec");
  for (const key of ["readCanary", "statCanary", "listOutside", "writeOutside", "linkCanary", "spawnNode", "spawnShell", "connect"]) assert.match(issued.report.checks[key] ?? "", /^denied (EPERM|EACCES)$/, key);
  assert.equal(issued.report.checks.writeScratch, "allowed");
  assert.equal(issued.report.checks.loopbackConnections, "0");
  assert.match(issued.report.checks.environment ?? "", /^(empty|only __CF_)/);
  assert.match(issued.report.checks.termination ?? "", /SIGKILL at deadline, pid \d+ and group gone/);
});

test("the original executable deliverable checks run behind the boundary: add, the TypeError revision and slugify", macOnly, async () => {
  const issued = await sandbox();
  const add = [[2, 3], [-2, 3]];
  assert.deepEqual(await evaluateJsFunction("function add(a, b) { return a + b; }\n", "add", add, issued), { loaded: true, results: [{ args: [2, 3], value: 5 }, { args: [-2, 3], value: 1 }] });
  assert.deepEqual((await evaluateJsFunction("export function add(a, b) {\n  return a + b;\n}\n", "add", add, issued)).results.map((result) => result.value), [5, 1]);
  assert.deepEqual((await evaluateJsFunction("module.exports = { add: (a, b) => a + b };", "add", add, issued)).results.map((result) => result.value), [5, 1]);
  assert.deepEqual((await evaluateJsFunction("const add = (a, b) => a + b;", "add", add, issued)).results.map((result) => result.value), [5, 1]);
  assert.deepEqual((await evaluateJsFunction("function add(a, b) { return a - b; }", "add", add, issued)).results.map((result) => result.value), [-1, -5]);
  const strict = "function add(a, b) {\n  if (typeof a !== 'number' || typeof b !== 'number') throw new TypeError('numbers only');\n  return a + b;\n}\n";
  assert.deepEqual(await evaluateJsFunction(strict, "add", [[2, 3], ["2", 3]], issued), { loaded: true, results: [{ args: [2, 3], value: 5 }, { args: ["2", 3], threw: "TypeError" }] });
  assert.deepEqual((await evaluateJsFunction("function add(a, b) { if (typeof a !== 'number') throw new Error('x'); return a + b; }", "add", [["2", 3]], issued)).results, [{ args: ["2", 3], threw: "Error" }]);
  assert.deepEqual(await evaluateJsFunction("function slugify(title) { return title.toLowerCase().replace(/\\s+/g, '-'); }", "slugify", [["Hello World"]], issued), { loaded: true, results: [{ args: ["Hello World"], value: "hello-world" }] });
  assert.deepEqual((await evaluateJsFunction("function slugify(title) { return title.replace(/ /g, '-'); }", "slugify", [["Hello World"]], issued)).results, [{ args: ["Hello World"], value: "Hello-World" }]);
  assert.deepEqual(await evaluateJsFunction("function other() { return 1; }", "add", add, issued), { loaded: false, error: "function add was not defined", results: [] });
  assert.equal((await evaluateJsFunction("function add(a, b) { return a +", "add", add, issued)).loaded, false);
  assert.deepEqual((await evaluateJsFunction("function add() { return 0 / 0; }", "add", [[]], issued)).results, [{ args: [], value: "NaN" }]);
  assert.throws(() => evaluateJsFunction("", "a b", [], issued), /invalid function name/);
});

test("host-realm escape attempts from generated code reach no process, canary, network or child process", macOnly, async () => {
  const issued = await sandbox();
  await withRoot("b10-escape-", async (root) => {
    const canaryText = `B10-ESCAPE-CANARY-${randomBytes(12).toString("hex")}`;
    const canary = join(root, "canary.txt");
    writeFileSync(canary, canaryText);
    const loopback = await listener();
    try {
      const code = `function probe(kind) {
        const use = (host) => {
          if (!host || typeof host.getBuiltinModule !== "function") return "no process: " + typeof host;
          const fs = host.getBuiltinModule("node:fs");
          host.getBuiltinModule("node:net").connect(${loopback.port}, "127.0.0.1");
          return "HOST REACHED " + fs.readFileSync(${JSON.stringify(canary)}, "utf8") + " " + String(host.getBuiltinModule("node:child_process").execSync("echo spawned"));
        };
        if (kind === "global") return use(globalThis.constructor.constructor("return process")());
        if (kind === "module") return use(module.constructor.constructor("return process")());
        if (kind === "arrow") return use((() => 0).constructor("return process")());
        if (kind === "error") return use(new Error("x").constructor.constructor("return process")());
        if (kind === "stack") {
          Error.prepareStackTrace = (_error, sites) => sites.map((site) => [site.getThis(), site.getFunction()]);
          const frames = new Error("x").stack;
          const found = Array.isArray(frames) ? frames.flat().filter((item) => item && (typeof item === "object" || typeof item === "function")) : [];
          return found.some((item) => item.process || item.constructor !== Object && item.constructor !== Function && item.constructor !== Array) ? use(found.find((item) => item.process).process) : "no host frames: " + typeof frames;
        }
        if (kind === "require") return use(require("node:fs"));
        if (kind === "process") return use(process);
        if (kind === "fetch") return fetch("http://127.0.0.1:${loopback.port}/");
        if (kind === "import") { import("node:fs").then((m) => { globalThis.leak = typeof m.readFileSync; }, () => { globalThis.leak = "rejected"; }); return "scheduled"; }
        if (kind === "import-result") return String(globalThis.leak);
        return "unknown";
      }`;
      const kinds = ["global", "module", "arrow", "error", "stack", "require", "process", "fetch", "import", "import-result"];
      const evaluation = await evaluateJsFunction(code, "probe", kinds.map((kind) => [kind]), issued);
      assert.equal(evaluation.loaded, true, JSON.stringify(evaluation));
      const byKind = Object.fromEntries(evaluation.results.map((result) => [String(result.args[0]), result]));
      for (const kind of ["global", "module", "arrow", "error"]) assert.equal(byKind[kind]!.threw, "EvalError", `${kind}: ${JSON.stringify(byKind[kind])}`);
      for (const kind of ["require", "process", "fetch"]) assert.equal(byKind[kind]!.threw, "ReferenceError", `${kind}: ${JSON.stringify(byKind[kind])}`);
      assert.notEqual(byKind["import-result"]!.value, "function", JSON.stringify(byKind));
      const text = JSON.stringify(evaluation);
      assert.equal(text.includes(canaryText), false);
      assert.equal(text.includes("HOST REACHED"), false, text);
      assert.equal(text.includes("spawned"), false, text);
      await delay(100);
      assert.equal(loopback.hits(), 0);
    } finally { loopback.server.close(); }
  });
});

test("with full process access inside the boundary, a host canary, writes outside scratch, links, a loopback listener, child processes and parent secrets stay out of reach", macOnly, async () => {
  await sandbox();
  await withRoot("b10-os-boundary-", async (root) => {
    const scratch = join(root, "scratch"), outside = join(root, "outside");
    mkdirSync(scratch);
    mkdirSync(outside);
    const canaryText = `B10-OS-CANARY-${randomBytes(12).toString("hex")}`;
    const canary = join(outside, "canary.txt");
    writeFileSync(canary, canaryText);
    const outsideWrite = join(outside, "guest-write.txt");
    const secretName = "B10_SANDBOX_SYNTHETIC_PARENT_SECRET", secretValue = `synthetic-parent-secret-${randomBytes(12).toString("hex")}`;
    process.env[secretName] = secretValue;
    const loopback = await listener();
    try {
      const nonce = randomBytes(32).toString("hex");
      const script = `"use strict";
const fs = require("node:fs"), net = require("node:net"), cp = require("node:child_process");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const out = {};
const attempt = (key, action) => { try { out[key] = { ok: true, value: action() }; } catch (error) { out[key] = { ok: false, code: String(error && error.code) }; } };
attempt("readCanary", () => fs.readFileSync(input.canary, "utf8"));
attempt("statCanary", () => fs.statSync(input.canary).size);
attempt("listOutside", () => fs.readdirSync(input.outside));
attempt("writeOutside", () => fs.writeFileSync(input.outsideWrite, "guest"));
attempt("symlinkRead", () => { fs.symlinkSync(input.canary, "symlinked-canary.txt"); return fs.readFileSync("symlinked-canary.txt", "utf8"); });
attempt("hardlinkRead", () => { fs.linkSync(input.canary, "hardlinked-canary.txt"); return fs.readFileSync("hardlinked-canary.txt", "utf8"); });
attempt("cloneRead", () => { fs.copyFileSync(input.canary, "cloned-canary.txt", fs.constants.COPYFILE_FICLONE); return fs.readFileSync("cloned-canary.txt", "utf8"); });
attempt("renameIn", () => fs.renameSync(input.canary, "moved-canary.txt"));
attempt("writeScratch", () => { fs.writeFileSync("inside.txt", "ok"); return fs.readFileSync("inside.txt", "utf8"); });
attempt("spawnNode", () => { const r = cp.spawnSync(process.execPath, ["-e", ""]); if (r.error) throw r.error; return r.status; });
attempt("spawnShell", () => { const r = cp.spawnSync("/bin/sh", ["-c", "exit 0"]); if (r.error) throw r.error; return r.status; });
attempt("environment", () => Object.keys(process.env));
attempt("environmentValues", () => Object.values(process.env).join("|"));
let done = false;
const socket = net.connect({ host: "127.0.0.1", port: input.port });
const finish = (result) => { if (done) return; done = true; out.connect = result; socket.destroy(); fs.writeSync(1, JSON.stringify({ nonce: input.nonce, out }) + "\\n"); process.exit(0); };
socket.once("connect", () => finish({ ok: true }));
socket.once("error", (error) => finish({ ok: false, code: String(error.code) }));
`;
      const run = await runInSeatbelt({ script, scratch, limits: LIMITS, stdin: JSON.stringify({ nonce, canary, outside, outsideWrite, port: loopback.port }) });
      const verdict = acceptBoundaryFrame(run, nonce);
      assert.equal(verdict.ok, true, JSON.stringify({ verdict, stderr: run.stderr.toString("utf8") }));
      const out = verdict.frame.out as Record<string, { ok: boolean; code?: string; value?: unknown }>;
      for (const key of ["readCanary", "statCanary", "listOutside", "writeOutside", "symlinkRead", "hardlinkRead", "cloneRead", "renameIn", "spawnNode", "spawnShell", "connect"]) {
        assert.equal(out[key]!.ok, false, `${key}: ${JSON.stringify(out[key])}`);
        assert.match(out[key]!.code ?? "", /^(EPERM|EACCES)$/, `${key}: ${JSON.stringify(out[key])}`);
      }
      assert.deepEqual(out.writeScratch, { ok: true, value: "ok" });
      assert.deepEqual((out.environment!.value as string[]).filter((key) => !key.startsWith("__CF_")), []);
      assert.equal(String(out.environmentValues!.value).includes(secretValue), false);
      const bytes = run.stdout.toString("utf8") + run.stderr.toString("utf8");
      assert.equal(bytes.includes(canaryText), false);
      assert.equal(bytes.includes(secretValue), false);
      assert.equal(existsSync(outsideWrite), false);
      assert.equal(readFileSync(canary, "utf8"), canaryText);
      await delay(100);
      assert.equal(loopback.hits(), 0);
      assert.equal(run.groupGone, true);
      // Replacing the process image is refused too; Node 24 aborts on a failed execve instead of throwing, so it runs alone.
      const exec = await runInSeatbelt({ script: `"use strict"; require("node:fs").writeSync(1, "before-execve\\n"); process.execve("/bin/sh", ["/bin/sh", "-c", "echo EXECVE-RAN"]);`, scratch, limits: { ...LIMITS, maxStderrBytes: 256 * 1024 }, stdin: "" });
      assert.equal(exec.stdout.toString("utf8"), "before-execve\n");
      assert.match(exec.stderr.toString("utf8"), /process\.execve failed with error code EPERM/);
      assert.ok(exec.signal !== null || exec.exitCode !== 0, JSON.stringify({ signal: exec.signal, exitCode: exec.exitCode }));
      assert.equal(acceptBoundaryFrame(exec, nonce).ok, false);
      assert.equal(exec.groupGone, true);
    } finally {
      loopback.server.close();
      delete process.env[secretName];
    }
  });
});

test("termination is hard and owned: a SIGTERM-ignoring busy loop that tries a detached child is SIGKILLed, its pid and group are gone and no marked process survives", macOnly, async () => {
  const issued = await sandbox();
  await withRoot("b10-kill-", async (root) => {
    const scratch = join(root, "scratch");
    mkdirSync(scratch);
    const marker = `B10_KILL_MARKER_${randomBytes(8).toString("hex")}`;
    const script = `"use strict";
// ${marker}
const fs = require("node:fs"), cp = require("node:child_process");
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => {});
let child;
try { const spawned = cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000) // ${marker}"], { detached: true, stdio: "ignore" }); spawned.on("error", () => {}); child = String(spawned.pid); spawned.unref(); } catch (error) { child = String(error.code); }
fs.writeSync(1, "spinning child=" + child + "\\n");
for (;;) {}
`;
    const started = Date.now();
    const running = runInSeatbelt({ script, scratch, limits: { ...LIMITS, deadlineMs: 2_500 }, stdin: "" });
    await delay(1_000);
    const during = marked(marker);
    const run = await running;
    assert.ok(during.length >= 1, "the marker scan sees the running guest, so an empty scan after the kill is meaningful");
    assert.equal(run.timedOut, true);
    assert.equal(run.signal, "SIGKILL");
    assert.equal(run.groupGone, true);
    assert.equal(gone(run.pid), true);
    assert.equal(gone(-run.pid), true);
    assert.match(run.stdout.toString("utf8"), /^spinning child=EPERM\n$/);
    assert.deepEqual(marked(marker), []);
    assert.ok(Date.now() - started < 2_500 + 3_000);
    assert.deepEqual(acceptBoundaryFrame(run, "unused"), { ok: false, reason: "the deadline expired and the process group was killed" });
    // Through the evaluator: the in-context time limit, then the OS deadline when that limit is longer than the run.
    assert.deepEqual(await evaluateJsFunction("function spin() { for (;;) {} }", "spin", [[]], issued), { loaded: false, error: "a call exceeded the time limit", results: [] });
    assert.deepEqual(await evaluateJsFunction("while (true) {}", "never", [[]], issued), { loaded: false, error: "generated code exceeded the time limit while loading", results: [] });
    assert.deepEqual(await issued.evaluate("function spin() { for (;;) {} }", "spin", [[]], { deadlineMs: 600 }), { loaded: false, error: "GENERATED_CODE_SANDBOX_REJECTED: the deadline expired and the process group was killed", results: [] });
    assert.deepEqual(await issued.evaluate("function spin() { Promise.resolve().then(function again() { for (;;) {} }); return 1; }", "spin", [[]]), { loaded: false, error: "a call exceeded the time limit", results: [] });
    assert.deepEqual(await issued.evaluate("Object.defineProperty(globalThis, 'spin', { get() { for (;;) {} } });", "spin", [[]]), { loaded: false, error: "resolving the function exceeded the time limit", results: [] });
    // Guest code cannot forge the backend timeout: fast throws copying its code and message keep their failure label.
    const forgedError = "Object.assign(new Error('Script execution timed out after 1000ms'), { code: 'ERR_SCRIPT_EXECUTION_TIMEOUT' })";
    assert.deepEqual(await evaluateJsFunction(`throw ${forgedError};`, "never", [[]], issued), { loaded: false, error: "Error: Script execution timed out after 1000ms", results: [] });
    const forgedObject = "{ name: 'Error', message: 'Script execution timed out after 1000ms', code: 'ERR_SCRIPT_EXECUTION_TIMEOUT' }";
    const throwsOnCall = `let reads = 0; Object.defineProperty(globalThis, "spin", { get() { reads += 1; if (reads > 2) throw ${forgedObject}; return function spin() { return 1; }; } });`;
    assert.deepEqual(await evaluateJsFunction(throwsOnCall, "spin", [[]], issued), { loaded: false, error: "a call failed outside the function: Error: Script execution timed out after 1000ms", results: [] });
    const throwsOnResolve = `Object.defineProperty(globalThis, "spin", { get() { throw ${forgedError}; } });`;
    assert.deepEqual(await evaluateJsFunction(throwsOnResolve, "spin", [[]], issued), { loaded: false, error: "Error: Script execution timed out after 1000ms", results: [] });
  });
});

test("a result is accepted only as one nonce-framed line after exit 0: forged frames with a failing exit, a signal, a hang, extra output, stderr, a wrong nonce or oversized output are rejected", macOnly, async () => {
  const issued = await sandbox();
  await withRoot("b10-frame-", async (root) => {
    const scratch = join(root, "scratch");
    mkdirSync(scratch);
    const nonce = randomBytes(32).toString("hex");
    const forge = `"use strict"; const fs = require("node:fs"); const input = JSON.parse(fs.readFileSync(0, "utf8")); const line = JSON.stringify({ nonce: input.nonce, loaded: true, results: [{ args: [2, 3], value: 5 }] }) + "\\n";`;
    const cases: Array<[string, string, BoundaryLimits, RegExp | null]> = [
      ["control: one frame then exit 0", `${forge} fs.writeSync(1, line);`, LIMITS, null],
      ["frame then exit 3", `${forge} fs.writeSync(1, line); process.exit(3);`, LIMITS, /^the process exited 3$/],
      ["frame then SIGKILL", `${forge} fs.writeSync(1, line); process.kill(process.pid, "SIGKILL");`, LIMITS, /^the process ended by signal SIGKILL$/],
      ["frame then SIGTERM", `${forge} fs.writeSync(1, line); process.kill(process.pid, "SIGTERM");`, LIMITS, /^the process ended by signal SIGTERM$/],
      ["frame then a SIGTERM-ignoring hang", `${forge} process.on("SIGTERM", () => {}); fs.writeSync(1, line); for (;;) {}`, { ...LIMITS, deadlineMs: 800 }, /^the deadline expired/],
      ["frame then extra stdout", `${forge} fs.writeSync(1, line); fs.writeSync(1, "extra\\n");`, LIMITS, /^stdout is not exactly one framed line$/],
      ["two frames", `${forge} fs.writeSync(1, line + line);`, LIMITS, /^stdout is not exactly one framed line$/],
      ["frame without newline", `${forge} fs.writeSync(1, line.trim());`, LIMITS, /^stdout is not exactly one framed line$/],
      ["frame then stderr", `${forge} fs.writeSync(1, line); fs.writeSync(2, "note\\n");`, LIMITS, /^the process wrote to stderr$/],
      ["wrong nonce", `${forge} fs.writeSync(1, line.replace(input.nonce, "0".repeat(64)));`, LIMITS, /^the frame nonce does not match this run$/],
      ["oversized stdout", `${forge} const chunk = "x".repeat(65536); for (let i = 0; i < 64; i += 1) fs.writeSync(1, chunk);`, LIMITS, /^stdout exceeded its byte limit$/],
      ["oversized stderr", `${forge} fs.writeSync(1, line); const chunk = "x".repeat(8192); for (let i = 0; i < 64; i += 1) fs.writeSync(2, chunk);`, LIMITS, /^stderr exceeded its byte limit$/],
    ];
    for (const [label, script, limits, expected] of cases) {
      const run = await runInSeatbelt({ script, scratch, limits, stdin: JSON.stringify({ nonce }) });
      const verdict = acceptBoundaryFrame(run, nonce);
      if (expected === null) assert.equal(verdict.ok, true, `${label}: ${JSON.stringify(verdict)}`);
      else {
        assert.equal(verdict.ok, false, label);
        assert.match((verdict as { reason: string }).reason, expected, label);
      }
      assert.equal(run.groupGone, true, label);
    }
    const oversized = await issued.evaluate("function big() { return 'x'.repeat(8192); }", "big", [[]], { maxStdoutBytes: 4096 });
    assert.equal(oversized.loaded, false);
    assert.match(oversized.error ?? "", /oversized reply|exceeded its byte limit/);
    assert.equal(JSON.stringify(oversized).includes("x".repeat(100)), false);
  });
});
