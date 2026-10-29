// The Windows Sentinel trampoline (1.0.9): only the exact task shape runs, only the entry its descriptor names for THIS
// executable with the recorded digest, with an allowlisted environment plus ELECTRON_RUN_AS_NODE=1; anything else is a
// usage exit and never starts the app. electron/main.mjs imports the trampoline entry before anything else.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  SENTINEL_TRAMPOLINE_FLAG, TRAMPOLINE_FAILED_EXIT, TRAMPOLINE_TIMEOUT_MS, TRAMPOLINE_USAGE_EXIT, isTrampolineLaunch, parseTrampolineArguments, runTrampoline, trampolineEnvironment,
} from "./sentinel-trampoline.mjs";

const ID = "0123456789abcdef0123456789abcdef";
const EXE = "C:\\Program Files\\Murage\\Murage.exe";
const OUT = `C:\\Users\\O Name\\AppData\\Local\\MurageSentinel\\${ID}`;
const ENTRY = `${OUT}\\runtime\\cli-0123456789abcdef.js`;
const DESCRIPTOR = `${OUT}\\descriptor.json`;
const argv = (...rest) => [EXE, SENTINEL_TRAMPOLINE_FLAG, ENTRY, DESCRIPTOR, "--once", ...rest];
const ENTRY_BYTES = Buffer.from("// scanner entry\n");
const SHA = createHash("sha256").update(ENTRY_BYTES).digest("hex");
const files = (descriptor = { executable: { path: EXE, entry: ENTRY, sha256: SHA } }, entry = ENTRY_BYTES) => ({
  read: (file, encoding) => { if (file === DESCRIPTOR) return encoding ? JSON.stringify(descriptor) : Buffer.from(JSON.stringify(descriptor)); if (file === ENTRY) return entry; throw Object.assign(new Error("absent"), { code: "ENOENT" }); },
  size: file => (file === DESCRIPTOR ? JSON.stringify(descriptor).length : entry.length),
});

test("only the first argument selects the trampoline", () => {
  assert.equal(isTrampolineLaunch(argv()), true);
  assert.equal(isTrampolineLaunch([EXE, "--murage-login", SENTINEL_TRAMPOLINE_FLAG]), false);
  assert.equal(isTrampolineLaunch([EXE]), false);
});

test("accepts exactly <exe> --murage-sentinel-scan <entry> <descriptor> --once with the owned folder layout", () => {
  assert.deepEqual(parseTrampolineArguments(argv(), "win32"), { entry: ENTRY, descriptor: DESCRIPTOR });
  const refused = [
    argv("--extra"), [EXE, SENTINEL_TRAMPOLINE_FLAG, ENTRY, DESCRIPTOR, "--watch"], [EXE, SENTINEL_TRAMPOLINE_FLAG, ENTRY, DESCRIPTOR],
    [EXE, SENTINEL_TRAMPOLINE_FLAG, "cli-0123456789abcdef.js", DESCRIPTOR, "--once"],
    [EXE, SENTINEL_TRAMPOLINE_FLAG, `${OUT}\\runtime\\evil.js`, DESCRIPTOR, "--once"],
    [EXE, SENTINEL_TRAMPOLINE_FLAG, `C:\\Elsewhere\\runtime\\cli-0123456789abcdef.js`, DESCRIPTOR, "--once"],
    [EXE, SENTINEL_TRAMPOLINE_FLAG, ENTRY, `${OUT}\\other.json`, "--once"],
    [EXE, SENTINEL_TRAMPOLINE_FLAG, ENTRY.replace("MurageSentinel", "Other"), DESCRIPTOR.replace("MurageSentinel", "Other"), "--once"],
    [EXE, SENTINEL_TRAMPOLINE_FLAG, `\\\\server\\share\\MurageSentinel\\${ID}\\runtime\\cli-0123456789abcdef.js`, `\\\\server\\share\\MurageSentinel\\${ID}\\descriptor.json`, "--once"],
    [EXE, SENTINEL_TRAMPOLINE_FLAG, `${OUT}\\runtime\\..\\runtime\\cli-0123456789abcdef.js`, DESCRIPTOR, "--once"],
  ];
  for (const value of refused) assert.equal(parseTrampolineArguments(value, "win32"), null, JSON.stringify(value));
});

test("runs this executable once with the entry, an allowlisted environment and ELECTRON_RUN_AS_NODE=1", () => {
  const seen = [];
  const code = runTrampoline({
    argv: argv(), platform: "win32", execPath: EXE, ...files(),
    env: { USERPROFILE: "C:\\Users\\O Name", LOCALAPPDATA: "C:\\Users\\O Name\\AppData\\Local", SystemRoot: "C:\\Windows", ANTHROPIC_API_KEY: "sk-ant-x", PATH: "C:\\bin", NODE_OPTIONS: "--require x" },
    spawn: (exe, args, options) => { seen.push({ exe, args, options }); return { status: 0 }; },
  });
  assert.equal(code, 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].exe, EXE);
  assert.deepEqual(seen[0].args, [ENTRY, DESCRIPTOR, "--once"]);
  assert.deepEqual(seen[0].options.env, { USERPROFILE: "C:\\Users\\O Name", LOCALAPPDATA: "C:\\Users\\O Name\\AppData\\Local", SystemRoot: "C:\\Windows", ELECTRON_RUN_AS_NODE: "1" });
  assert.equal(seen[0].options.shell, false);
  assert.equal(seen[0].options.windowsHide, true);
  assert.equal(seen[0].options.timeout, TRAMPOLINE_TIMEOUT_MS);
  assert.ok(TRAMPOLINE_TIMEOUT_MS < 60_000, "inside the task's 1 minute limit");
});

test("passes the scanner's exit code on; a crash or a spawn failure is a failure", () => {
  const run = spawn => runTrampoline({ argv: argv(), platform: "win32", execPath: EXE, ...files(), env: {}, spawn });
  assert.equal(run(() => ({ status: 10 })), 10);
  assert.equal(run(() => ({ status: null, signal: "SIGKILL" })), TRAMPOLINE_FAILED_EXIT);
  assert.equal(run(() => { throw new Error("spawn"); }), TRAMPOLINE_FAILED_EXIT);
});

test("never runs an entry its descriptor does not name for this executable with this digest", () => {
  let spawned = 0;
  const run = (overrides, execPath = EXE) => runTrampoline({ argv: argv(), platform: "win32", execPath, env: {}, spawn: () => { spawned++; return { status: 0 }; }, ...overrides });
  assert.equal(run(files(undefined, Buffer.from("// tampered\n"))), TRAMPOLINE_USAGE_EXIT);
  assert.equal(run(files({ executable: { path: EXE, entry: `${OUT}\\runtime\\cli-ffffffffffffffff.js`, sha256: SHA } })), TRAMPOLINE_USAGE_EXIT);
  assert.equal(run(files({ executable: { path: "C:\\Other\\Other.exe", entry: ENTRY, sha256: SHA } })), TRAMPOLINE_USAGE_EXIT);
  assert.equal(run(files({ executable: { path: EXE, entry: ENTRY, sha256: null } })), TRAMPOLINE_USAGE_EXIT);
  assert.equal(run({ read: () => { throw new Error("gone"); }, size: () => 10 }), TRAMPOLINE_USAGE_EXIT);
  assert.equal(run({ ...files(), size: () => 9 * 1024 }), TRAMPOLINE_USAGE_EXIT, "an oversized descriptor is refused");
  assert.equal(spawned, 0);
  // The executable comparison folds case on Windows only.
  assert.equal(run(files(), EXE.toUpperCase()), 0);
  assert.equal(spawned, 1);
  assert.equal(runTrampoline({ argv: argv("--x"), platform: "win32", execPath: EXE, env: {}, spawn: () => { spawned++; return { status: 0 }; } }), TRAMPOLINE_USAGE_EXIT);
  assert.equal(spawned, 1);
});

test("the environment keeps only the allowlist and adds ELECTRON_RUN_AS_NODE", () => {
  assert.deepEqual(trampolineEnvironment({ TEMP: "C:\\t", SECRET: "x", HOME: "a\0b" }), { TEMP: "C:\\t", ELECTRON_RUN_AS_NODE: "1" });
});

test("electron/main.mjs imports the trampoline entry before any other app module", () => {
  const main = readFileSync(path.join(import.meta.dirname, "main.mjs"), "utf8");
  // The proxy launch guard module stays first (proxy-launch-guard.node-test.mjs); it only defines the guard and runs
  // nothing at evaluation, so the trampoline entry is the first module that acts, before every other app module.
  const imports = main.split("\n").filter(line => line.startsWith("import "));
  assert.deepEqual(imports.slice(0, 2), ['import { enforceProxyLaunchGuard } from "./proxy-launch-guard.mjs";', 'import "./sentinel-trampoline-entry.mjs";']);
  const guard = readFileSync(path.join(import.meta.dirname, "proxy-launch-guard.mjs"), "utf8");
  assert.deepEqual(guard.split("\n").filter(line => line.startsWith("import ")), ['import { SPAWNED_PROXY_FILES } from "../shared/spawned-proxies.mjs";']);
  const entry = readFileSync(path.join(import.meta.dirname, "sentinel-trampoline-entry.mjs"), "utf8");
  assert.match(entry, /if \(isTrampolineLaunch\(process\.argv\) && !process\.env\.ELECTRON_RUN_AS_NODE\) process\.exit\(runTrampoline\(\)\);/);
});
