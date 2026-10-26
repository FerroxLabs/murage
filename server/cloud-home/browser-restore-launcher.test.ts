// SPDX-License-Identifier: AGPL-3.0-or-later
// The launcher's browser-restore and browser-restore-mark modes: strict request validation, path
// confinement, the bounded child, and (the cross-language fixture) that what the launcher's step writes is
// exactly what the server's own store reads and writes, because it is the server's own store.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { runBrowserRestoreStep } from "../browser-restore-cli.ts";
import { decryptEngineData, encryptEngineData, markBrowserRestoreVisited, newestEngineState, prepareBrowserRestore } from "../browser-restore-store.ts";

const launcher = fileURLToPath(new URL("../../deploy/cloud-home/murage-turn-launch.py", import.meta.url));
const cli = fileURLToPath(new URL("../browser-restore-cli.ts", import.meta.url));
const KEY = "ab".repeat(32);
const SESSION = "fixture";
const INSTANCE = "i".repeat(22);
const ORIGIN = "https://shop.example";
const OTHER = "https://news.example:8443";

const GEN = "0123456789abcdef".repeat(2);
const harness = `import importlib.util,json,sys,os,io,types,inspect,pwd
spec=importlib.util.spec_from_file_location("restore_fixture",sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
def accepted(function, options):
    names=inspect.signature(function).parameters
    return {k:v for k,v in options.items() if k in names}
exec(sys.argv[2])`;
function python(code: string, payload = ""): string {
  return execFileSync("python3", ["-I", "-c", harness, launcher, code, payload], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function request(mode = "browser-restore", args: unknown[] = [], settings: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
  return { mode, bot: "bot-1", args, instance: INSTANCE, settings: { AGENT_BROWSER_SESSION: SESSION, AGENT_BROWSER_ENCRYPTION_KEY: KEY, AGENT_BROWSER_RESTORE_SAVE: "auto", ...settings }, ...extra };
}
function validates(input: unknown): boolean {
  const out = python(`
try:
    plan=module.validate_browser_restore_request(json.loads(sys.argv[3]),"/data/browser")
    print("OK",json.dumps(plan))
except ValueError as error:
    print("NO",error)`, JSON.stringify(input));
  return out.startsWith("OK");
}

let root = "";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "restore-launch-")); chmodSync(root, 0o711); });
afterEach(() => { removeTempDirSync(root); });

function home(bot = "bot-1") { return join(root, bot); }
function sessions(bot = "bot-1") { return join(home(bot), ".agent-browser", "sessions"); }
function seed(bot = "bot-1", origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }> = [{ origin: ORIGIN, localStorage: [{ name: "cart", value: "3" }] }, { origin: OTHER, localStorage: [{ name: "seen", value: "1" }] }], file = `${SESSION}-abc.json.enc`) {
  mkdirSync(sessions(bot), { recursive: true, mode: 0o700 });
  chmodSync(home(bot), 0o700);
  const state = { cookies: [{ name: "sid", value: "x", domain: "shop.example" }], origins: origins.map(item => ({ ...item, sessionStorage: [] })) };
  writeFileSync(join(sessions(bot), file), encryptEngineData(Buffer.from(JSON.stringify(state)), KEY), { mode: 0o600 });
}
type LaunchOptions = { alive?: boolean; live?: boolean; script?: string; wait?: number; limit?: number; isolate?: boolean };
// As root the step drops to `nobody` for real (the launcher's exec guard refuses uid 0); unprivileged, drop=False only skips the setuid.
const asRoot = process.getuid?.() === 0;
const stepAccount = asRoot ? 'pwd.getpwnam("nobody")' : "types.SimpleNamespace(pw_uid=os.getuid(),pw_gid=os.getgid())";
const nobody = asRoot ? { uid: Number(execFileSync("id", ["-u", "nobody"], { encoding: "utf8" })), gid: Number(execFileSync("id", ["-g", "nobody"], { encoding: "utf8" })) } : null;
// The step user must be able to read the step script (and this checkout's modules); a checkout under a 0700 home cannot be read by
// `nobody`, so as root there the step-running tests are skipped rather than run as root (which the launcher's exec guard refuses).
const canStep = !asRoot || spawnSync("runuser", ["-u", "nobody", "--", "test", "-r", cli]).status === 0;
const steps = canStep ? it : it.skip;
/** As root: everything under the browser root (the bots' homes and saved sessions, made by the test) becomes the step user's, as a real
 * home's browser profiles are the browser user's; the root directory itself stays the launcher's (owner=os.getuid()). */
function handToStep(directory = root): void {
  if (!nobody) return;
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const info = lstatSync(path);
    if (directory === root && info.isFile()) continue; // the launcher's own records at the root
    chownSync(path, nobody.uid, nobody.gid);
    if (info.isDirectory()) handToStep(path);
  }
}
const step = (options: LaunchOptions) => `node=${JSON.stringify(process.execPath)},script=${JSON.stringify(options.script ?? cli)},drop=${asRoot ? "True" : "False"},wait=${options.wait ?? 20},limit=${options.limit ?? 33554432},isolate=${options.isolate ? "True" : "False"}`;
/** Runs launch_browser_restore as the test user (no privilege change), with the real step script under this node.
 * isolate (root only): the step's own mount and pid namespaces, as on a Cloud home. */
function launch(input: unknown, options: LaunchOptions = {}) {
  handToStep();
  const code = `
req=json.loads(sys.argv[3])
out=io.BytesIO()
account=${stepAccount}
try:
    module.launch_browser_restore(req,**accepted(module.launch_browser_restore,dict(root=${JSON.stringify(root)},account=account,fence=lambda r:None,alive=lambda h,s:${options.alive ? "True" : "False"},live=lambda *a:${options.live ? "True" : "False"},owner=os.getuid(),out=out,${step(options)})))
    print("DONE",out.getvalue().decode())
except Exception as error:
    print("FAIL",type(error).__name__,error)`;
  return python(code, JSON.stringify(input)).trim();
}
/** A browser host starting (ensure_session_host's split), for the given request's bot. Prints the generation or None. */
function hostStart(input: unknown, options: LaunchOptions = {}) {
  handToStep();
  const code = `
req=json.loads(sys.argv[3])
account=${stepAccount}
if not hasattr(module,"split_for_host"):
    print("MISSING")
else:
    print(module.split_for_host(req,${JSON.stringify(root)}+"/"+req["bot"],${JSON.stringify(root)},owner=os.getuid(),alive=lambda h,s:${options.alive ? "True" : "False"},live=lambda *a:${options.live ? "True" : "False"},account=account,${step(options)}))`;
  return python(code, JSON.stringify(input)).trim();
}
/** The generation the launcher recorded for the fixture session, or "" */
function generationFile(bot = "bot-1") { const path = join(root, `.restore-${bot}.${SESSION}`); return existsSync(path) ? readFileSync(path, "utf8") : ""; }
const done = (text: string) => { expect(text.startsWith("DONE "), text).toBe(true); return JSON.parse(text.slice(5)); };
const spec = (bot = "bot-1") => ({ env: { HOME: home(bot), AGENT_BROWSER_RESTORE: SESSION, AGENT_BROWSER_ENCRYPTION_KEY: KEY, AGENT_BROWSER_RESTORE_SAVE: "auto" } }) as never;

it("accepts exactly the two request shapes the relay sends and nothing else", () => {
  expect(validates(request())).toBe(true);
  expect(validates(request("browser-restore-mark", [GEN, ORIGIN]))).toBe(true);
  expect(validates(request("browser-restore-mark", [GEN, "http://127.0.0.1:3000"]))).toBe(true);
  expect(validates(request("browser-restore-mark", [GEN, "http://[::1]:8080"]))).toBe(true);
  expect(validates(request("browser-restore", [], { AGENT_BROWSER_RESTORE: SESSION }))).toBe(true);
  // another mode, extra keys, a bad bot or instance
  expect(validates(request("browser"))).toBe(false);
  expect(validates(request("browser-restore", [], {}, { cwd: "/" }))).toBe(false);
  expect(validates({ ...request(), bot: "../x" })).toBe(false);
  expect(validates({ ...request(), bot: "a/b" })).toBe(false);
  expect(validates({ ...request(), bot: "x".repeat(65) })).toBe(false);
  expect(validates({ ...request(), instance: "short" })).toBe(false);
  const { instance: _instance, ...noInstance } = request(); expect(validates(noInstance)).toBe(false);
  // arguments: restore takes none, mark takes its generation and one origin
  expect(validates(request("browser-restore", [ORIGIN]))).toBe(false);
  expect(validates(request("browser-restore-mark", []))).toBe(false);
  expect(validates(request("browser-restore-mark", [ORIGIN]))).toBe(false);
  expect(validates(request("browser-restore-mark", [GEN, ORIGIN, OTHER]))).toBe(false);
  expect(validates(request("browser-restore-mark", [ORIGIN, GEN]))).toBe(false);
  expect(validates(request("browser-restore-mark", [GEN.toUpperCase(), ORIGIN]))).toBe(false);
  expect(validates(request("browser-restore-mark", [GEN.slice(1), ORIGIN]))).toBe(false);
  expect(validates(request("browser-restore-mark", [GEN, 5]))).toBe(false);
  expect(validates({ ...request("browser-restore-mark", [GEN, ORIGIN]), args: "https://shop.example" })).toBe(false);
});

it("refuses anything but a bare origin to mark", () => {
  for (const bad of ["https://shop.example/", "https://shop.example/path", "https://shop.example?x=1", "https://shop.example#f", "https://user@shop.example", "https://user:pw@shop.example", "ftp://shop.example", "javascript:1", "about:blank", "shop.example", "HTTPS://shop.example", "https://", "https://shop.example:0", "https://shop.example:70000", "https://shop.example:", "https://shop example", "https://shop.example\n", "https://shop.example\0", "https://-bad.example/", "--flag", "-x", "https://" + "a".repeat(300) + ".example", "https://[zz]", "https://[::1", "http://127.0.0.1:99999"]) {
    expect(validates(request("browser-restore-mark", [GEN, bad])), bad).toBe(false);
  }
});

it("refuses a request whose settings are not exactly the session's own", () => {
  expect(validates(request("browser-restore", [], { AGENT_BROWSER_ENCRYPTION_KEY: "short" }))).toBe(false);
  expect(validates(request("browser-restore", [], { AGENT_BROWSER_ENCRYPTION_KEY: "AB".repeat(32) }))).toBe(false);
  expect(validates(request("browser-restore", [], { AGENT_BROWSER_SESSION: "a b" }))).toBe(false);
  expect(validates(request("browser-restore", [], { AGENT_BROWSER_SESSION: "../x" }))).toBe(false);
  expect(validates(request("browser-restore", [], { AGENT_BROWSER_RESTORE_SAVE: "never" }))).toBe(false);
  expect(validates(request("browser-restore", [], { AGENT_BROWSER_RESTORE: "other" }))).toBe(false);
  expect(validates(request("browser-restore", [], { CI: "1" }))).toBe(false);
  expect(validates(request("browser-restore", [], { NODE_OPTIONS: "--require /tmp/x" }))).toBe(false);
  expect(validates(request("browser-restore", [], { LD_PRELOAD: "/tmp/x.so" }))).toBe(false);
  expect(validates({ ...request(), settings: null })).toBe(false);
  expect(validates({ ...request(), settings: { AGENT_BROWSER_SESSION: SESSION } })).toBe(false);
});

it("builds the step's whole environment from five names, the key only in the environment and never on argv", () => {
  const plan = JSON.parse(python(`print(json.dumps(module.validate_browser_restore_request(json.loads(sys.argv[3]),"/data/browser")))`, JSON.stringify(request("browser-restore-mark", [GEN, ORIGIN]))));
  expect(Object.keys(plan.env).sort()).toEqual(["AGENT_BROWSER_ENCRYPTION_KEY", "AGENT_BROWSER_RESTORE", "AGENT_BROWSER_RESTORE_SAVE", "HOME", "PATH"]);
  expect(plan.env.HOME).toBe("/data/browser/bot-1");
  expect(plan.user).toBe("murage-browser");
  expect(plan.argv).toEqual(["mark", ORIGIN]);
  expect(JSON.stringify(plan.argv)).not.toContain(KEY);
});

steps("splits the saved session as the browser user would and hands the storage back, then marks a visit", () => {
  seed();
  const answer = done(launch(request()));
  expect(answer.state).toBe("ready");
  expect(answer.generation).toMatch(/^[a-f0-9]{32}$/u);
  expect(generationFile()).toBe(`${answer.generation} split\n`);
  expect(Object.keys(answer.origins).sort()).toEqual([ORIGIN, OTHER].sort());
  expect(answer.origins[ORIGIN].localStorage).toEqual([{ name: "cart", value: "3" }]);
  expect(answer.cookies).toBe(1);
  expect(JSON.stringify(answer)).not.toContain(KEY);
  // the engine's state file now holds the cookies only; the storage is in the store beside it
  const engine = JSON.parse(decryptEngineData(readFileSync(newestEngineState(sessions(), SESSION)!), KEY).toString("utf8"));
  expect(engine.origins).toEqual([]); expect(engine.cookies).toHaveLength(1);
  const sidecarPath = join(sessions(), `${SESSION}.murage-storage.enc`);
  expect(existsSync(sidecarPath)).toBe(true);
  expect(done(launch(request("browser-restore-mark", [answer.generation, ORIGIN]))).state).toBe("marked");
  const sidecar = JSON.parse(decryptEngineData(readFileSync(sidecarPath), KEY).toString("utf8"));
  expect(sidecar.version).toBe(1); expect(sidecar.visited).toEqual([ORIGIN]);
  expect(Object.keys(sidecar.origins).sort()).toEqual([ORIGIN, OTHER].sort());
  expect(typeof sidecar.origins[ORIGIN].seenAt).toBe("number");
  // marking again changes nothing but the last-seen time
  expect(done(launch(request("browser-restore-mark", [answer.generation, ORIGIN]))).state).toBe("marked");
  expect(JSON.parse(decryptEngineData(readFileSync(sidecarPath), KEY).toString("utf8")).visited).toEqual([ORIGIN]);
});

steps("reads and writes the one store format both ways (the cross-language fixture)", () => {
  // The server's own store writes first, the launcher's step reads it.
  seed();
  const local = prepareBrowserRestore(spec(), () => {})!;
  expect(local.origins).toBe(2);
  local.restored(ORIGIN);
  const sidecarPath = join(sessions(), `${SESSION}.murage-storage.enc`);
  expect(JSON.parse(decryptEngineData(readFileSync(sidecarPath), KEY).toString("utf8")).visited).toEqual([ORIGIN]);
  // The engine saves again (a new origin, and the visited shop origin emptied by a sign-out) ...
  const state = { cookies: [{ name: "sid", value: "y", domain: "shop.example" }], origins: [{ origin: "https://new.example", localStorage: [{ name: "k", value: "v" }], sessionStorage: [] }] };
  writeFileSync(newestEngineState(sessions(), SESSION)!, encryptEngineData(Buffer.from(JSON.stringify(state)), KEY));
  // ... and the launcher's step merges it by the same rules: shop (visited, missing from the save) is dropped, news (never opened) is kept.
  const answer = done(launch(request()));
  expect(Object.keys(answer.origins).sort()).toEqual([OTHER, "https://new.example"].sort());
  // The server's own store reads what the launcher wrote: nothing is waiting for the engine to re-save, the visited list was consumed.
  const again = prepareBrowserRestore(spec(), () => {})!;
  expect(again.origins).toBe(2);
  expect(again.pending(OTHER)).toEqual({ localStorage: [{ name: "seen", value: "1" }], sessionStorage: [] });
});

steps("reads the old `restored` list name and prunes by the same age and count rules", () => {
  seed();
  const sidecarPath = join(sessions(), `${SESSION}.murage-storage.enc`);
  const old = Date.now() - 91 * 24 * 60 * 60 * 1000;
  const sidecar = { version: 1, origins: { [ORIGIN]: { localStorage: [{ name: "a", value: "1" }], sessionStorage: [], seenAt: old }, [OTHER]: { localStorage: [{ name: "b", value: "2" }], sessionStorage: [], seenAt: Date.now() } }, restored: [OTHER], written: "" };
  writeFileSync(sidecarPath, encryptEngineData(Buffer.from(JSON.stringify(sidecar)), KEY));
  // remove the engine state so only the store is read
  for (const name of readdirSync(sessions())) if (name.endsWith(".json.enc")) rmSync(join(sessions(), name));
  const answer = done(launch(request()));
  expect(answer.state).toBe("ready");
  expect(Object.keys(answer.origins)).toEqual([OTHER]);
});

steps("answers none and changes nothing when there is no home, no session files or a running session", () => {
  expect(done(launch(request()))).toEqual({ state: "none", logs: [] });
  expect(done(launch(request("browser-restore-mark", [GEN, ORIGIN])))).toEqual({ state: "stale" });
  mkdirSync(home(), { mode: 0o700 }); chmodSync(home(), 0o700);
  expect(done(launch(request())).state).toBe("none");
  removeTempDirSync(home()); rmSync(join(root, `.restore-bot-1.${SESSION}`), { force: true });
  seed();
  const before = readFileSync(newestEngineState(sessions(), SESSION)!);
  expect(done(launch(request(), { alive: true }))).toEqual({ state: "none", logs: [] });
  expect(done(launch(request(), { live: true }))).toEqual({ state: "none", logs: [] });
  expect(readFileSync(newestEngineState(sessions(), SESSION)!).equals(before)).toBe(true);
  expect(existsSync(join(sessions(), `${SESSION}.murage-storage.enc`))).toBe(false);
});

steps("refuses a home or session directory that is a link, and a session file that is a link", () => {
  // home itself a link to another bot's directory
  seed("bot-2");
  symlinkSync(home("bot-2"), home("bot-1"));
  expect(launch(request())).toMatch(/^FAIL/);
  rmSync(home("bot-1"));
  // sessions directory a link
  mkdirSync(join(home("bot-1"), ".agent-browser"), { recursive: true, mode: 0o700 }); chmodSync(home("bot-1"), 0o700);
  symlinkSync(sessions("bot-2"), sessions("bot-1"));
  expect(launch(request())).toMatch(/^FAIL/);
  writeFileSync(join(root, `.restore-bot-1.${SESSION}`), `${GEN} hosted\n`, { mode: 0o600 });
  expect(launch(request("browser-restore-mark", [GEN, ORIGIN]))).toMatch(/^FAIL/);
  rmSync(sessions("bot-1"));
  // a state file that is a link out of the home
  mkdirSync(sessions("bot-1"), { recursive: true, mode: 0o700 });
  symlinkSync(newestEngineState(sessions("bot-2"), SESSION)!, join(sessions("bot-1"), `${SESSION}-evil.json.enc`));
  const before = readFileSync(newestEngineState(sessions("bot-2"), SESSION)!);
  expect(launch(request())).toMatch(/^FAIL/);
  expect(readFileSync(newestEngineState(sessions("bot-2"), SESSION)!).equals(before)).toBe(true);
  // home with the wrong mode
  removeTempDirSync(home("bot-1")); mkdirSync(sessions("bot-1"), { recursive: true }); chmodSync(home("bot-1"), 0o755);
  expect(launch(request())).toMatch(/^FAIL/);
});

steps("refuses a browser directory that is not the root-owned 0711 one", () => {
  chmodSync(root, 0o755);
  seed();
  expect(launch(request())).toMatch(/^FAIL/);
});

steps("bounds the step: a step that outlasts the deadline or prints too much fails closed", () => {
  seed();
  const slow = join(root, "slow.mjs"); writeFileSync(slow, "setTimeout(() => {}, 30000);\n");
  const started = Date.now();
  expect(launch(request(), { script: slow, wait: 1 })).toMatch(/^FAIL Refusal/);
  expect(Date.now() - started).toBeLessThan(15_000);
  const loud = join(root, "loud.mjs"); writeFileSync(loud, "process.stdout.write('x'.repeat(5000));\n");
  expect(launch(request(), { script: loud, limit: 100 })).toMatch(/^FAIL Refusal/);
  const failing = join(root, "failing.mjs"); writeFileSync(failing, "process.exit(3);\n");
  expect(launch(request(), { script: failing })).toMatch(/^FAIL Refusal/);
});

steps("gives the step only its five environment names", () => {
  seed();
  const { generation } = done(launch(request()));
  const probe = join(root, "probe.mjs"); writeFileSync(probe, "process.stdout.write(JSON.stringify({ env: Object.keys(process.env).sort(), cwd: process.cwd(), argv: process.argv.slice(2) }));\n");
  const answer = done(launch(request("browser-restore-mark", [generation, ORIGIN]), { script: probe }));
  expect(answer.env.filter((name: string) => !name.startsWith("LC_"))).toEqual(["AGENT_BROWSER_ENCRYPTION_KEY", "AGENT_BROWSER_RESTORE", "AGENT_BROWSER_RESTORE_SAVE", "HOME", "PATH"]);
  expect(answer.cwd.endsWith("/bot-1")).toBe(true);
  expect(answer.argv).toEqual(["mark", ORIGIN]);
});

it("the step refuses a mark that is not a bare origin and prints only a fixed phrase on a refusal", () => {
  seed();
  const run = (args: string[]) => { try { execFileSync(process.execPath, [cli, ...args], { env: { HOME: home(), AGENT_BROWSER_RESTORE: SESSION, AGENT_BROWSER_ENCRYPTION_KEY: KEY, AGENT_BROWSER_RESTORE_SAVE: "auto", PATH: process.env.PATH! }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); return "ok"; } catch (error) { return (error as { stderr: string }).stderr; } };
  expect(run(["mark", "https://shop.example/path"])).toBe("Browser restore refused\n");
  expect(run(["mark"])).toBe("Browser restore refused\n");
  expect(run(["prepare", "extra"])).toBe("Browser restore refused\n");
  expect(run(["prepare"])).toBe("Browser restore refused\n");
  expect(run(["snapshot", "extra"])).toBe("Browser restore refused\n");
  expect(run(["other"])).toBe("Browser restore refused\n");
  expect(run([])).toBe("Browser restore refused\n");
});

it("is wired in: dispatched, bundled, and pinned in the engine manifest", () => {
  const source = readFileSync(launcher, "utf8");
  expect(source).toMatch(/elif request\.get\("mode"\) in BROWSER_RESTORE_MODES:\n\s+launch_browser_restore\(request\)/);
  expect(readFileSync(fileURLToPath(new URL("../../scripts/bundle-server.mjs", import.meta.url)), "utf8")).toContain('"browser-restore-cli.ts"');
  const build = readFileSync(fileURLToPath(new URL("../../deploy/cloud-home/build-image.sh", import.meta.url)), "utf8");
  expect(build).toContain('manifest["browserRestore"]'); expect(build).toContain("/opt/murage/dist-server/browser-restore-cli.js");
});

// ── Astra cloud-browser review (REVISE) fixes ──────────────────────────────────────────────────────────
const repo = fileURLToPath(new URL("../../", import.meta.url));
const sleepMs = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const sidecarOf = (bot = "bot-1") => JSON.parse(decryptEngineData(readFileSync(join(sessions(bot), `${SESSION}.murage-storage.enc`)), KEY).toString("utf8"));
/** Root with CAP_SYS_ADMIN (the Cloud home's launcher, or a privileged test container): the step's namespaces work. */
const canIsolate = (() => {
  if (process.platform !== "linux" || process.getuid?.() !== 0) return false;
  try { return execFileSync("python3", ["-I", "-c", "import ctypes,os\npid=os.fork()\nif pid==0: os._exit(0 if ctypes.CDLL(None,use_errno=True).unshare(0x20020000)==0 else 1)\nprint(os.waitstatus_to_exitcode(os.waitpid(pid,0)[1]))"], { encoding: "utf8" }).trim() === "0"; }
  catch { return false; }
})();
/** The isolated step masks /tmp, so its fixture lives in the repository checkout (never under /tmp). */
let outside = "";
function isolatedFixture() {
  outside = mkdtempSync(join(repo, ".restore-iso-"));
  removeTempDirSync(root);
  root = join(outside, "browser"); mkdirSync(root); chmodSync(root, 0o711);
  return outside;
}
afterEach(() => { if (outside) removeTempDirSync(outside); outside = ""; });

steps("#1 the isolated step sees only its own bot's home: no sibling, no other bot's file, its own /proc", { skip: !canIsolate || !canStep }, () => {
  const base = isolatedFixture();
  seed("bot-1"); seed("bot-2", [{ origin: "https://victim.example", localStorage: [{ name: "token", value: "secret" }] }]);
  const probe = join(base, "probe.mjs");
  writeFileSync(probe, `import { readdirSync, readFileSync } from "node:fs";
const tryIt = (f) => { try { return f(); } catch (error) { return error.code; } };
process.stdout.write(JSON.stringify({
  siblings: tryIt(() => readdirSync(process.env.HOME + "/..")),
  other: tryIt(() => readdirSync(process.env.HOME + "/../bot-2/.agent-browser/sessions")),
  own: tryIt(() => readdirSync(process.env.HOME + "/.agent-browser/sessions").length),
  procs: tryIt(() => readdirSync("/proc").filter(name => /^[0-9]+$/.test(name)).length),
  tmp: tryIt(() => readdirSync("/tmp").length),
}));
`);
  const answer = done(launch(request(), { script: probe, isolate: true }));
  expect(answer.siblings).toEqual(["bot-1"]);
  expect(answer.other).toBe("ENOENT");
  expect(answer.own).toBe(1);
  expect(answer.procs).toBeLessThanOrEqual(2);
  expect(answer.tmp).toBe(0);
});

steps("#1 a concurrent link/rename swap toward another bot's directory is never followed", { skip: !canIsolate || !canStep, timeout: 120_000 }, () => {
  isolatedFixture();
  seed("bot-1"); seed("bot-2", [{ origin: "https://victim.example", localStorage: [{ name: "token", value: "secret" }] }]);
  const victim = newestEngineState(sessions("bot-2"), SESSION)!;
  const before = sha(victim);
  // Two planted links, absolute and relative, swapped with the real directory as fast as the kernel allows.
  const agent = join(home("bot-1"), ".agent-browser");
  symlinkSync(sessions("bot-2"), join(agent, "absolute"));
  symlinkSync("../../bot-2/.agent-browser/sessions", join(agent, "relative"));
  // Each link is swapped in for a moment and back (RENAME_EXCHANGE), at random sub-5 ms intervals, so steps
  // both get through and meet a link mid-way.
  const swapper = spawn("python3", ["-I", "-c", `import ctypes,sys,time,random
libc=ctypes.CDLL(None,use_errno=True)
a=sys.argv[1].encode();b=sys.argv[2].encode();c=sys.argv[3].encode()
end=time.time()+110
while time.time()<end:
    for link in (b,c):
        libc.renameat2(-100,a,-100,link,2); time.sleep(random.random()*0.004)
        libc.renameat2(-100,a,-100,link,2); time.sleep(random.random()*0.004)
`, join(agent, "sessions"), join(agent, "absolute"), join(agent, "relative")], { stdio: "ignore" });
  try {
    const outputs: string[] = [];
    let generation = "";
    for (let i = 0; i < 60; i++) {
      const answer = launch(request(), { isolate: true });
      outputs.push(answer);
      if (answer.startsWith("DONE ")) generation = JSON.parse(answer.slice(5)).generation ?? generation;
      if (generation) outputs.push(launch(request("browser-restore-mark", [generation, "https://victim.example"]), { isolate: true }));
    }
    // The race was really run: steps got through while the links were being swapped.
    expect(outputs.filter(output => output.startsWith("DONE ")).length).toBeGreaterThanOrEqual(3);
    expect(outputs.join("\n")).not.toContain("victim");
    expect(outputs.join("\n")).not.toContain("secret");
  } finally { swapper.kill("SIGKILL"); }
  // The other bot's files were never read into an answer, rewritten or given a store.
  expect(sha(victim)).toBe(before);
  expect(readdirSync(sessions("bot-2")).filter(name => !name.startsWith(".")).sort()).toEqual([`${SESSION}-abc.json.enc`]);
});

steps("#2 refuses oversize input before reading it: one file over its bound, or all files over theirs", () => {
  seed();
  // One plain engine file just over 32 MiB.
  const big = join(sessions(), `${SESSION}-big.json`);
  writeFileSync(big, JSON.stringify({ cookies: [], origins: [{ origin: ORIGIN, localStorage: [{ name: "pad", value: "x".repeat(32 * 1024 * 1024) }], sessionStorage: [] }] }));
  expect(launch(request())).toMatch(/^FAIL Refusal/);
  expect(statSync(big).size).toBeGreaterThan(32 * 1024 * 1024);
  rmSync(big);
  // Two files each under the bound, together over the 48 MiB total.
  for (const name of ["a", "b"]) writeFileSync(join(sessions(), `${SESSION}-${name}.json`), JSON.stringify({ cookies: [], origins: [{ origin: ORIGIN, localStorage: [{ name: "pad", value: "y".repeat(25 * 1024 * 1024) }], sessionStorage: [] }] }));
  expect(launch(request())).toMatch(/^FAIL Refusal/);
  expect(existsSync(join(sessions(), `${SESSION}.murage-storage.enc`))).toBe(false);
});

it("#2 the server-asked modes run in a limited browser scope (memory, tasks, runtime)", () => {
  const out = python(`
for mode,args in (("browser-restore",[]),("browser-restore-mark",[${JSON.stringify(GEN)},${JSON.stringify(ORIGIN)}])):
    req=json.loads(sys.argv[3]); req["mode"]=mode; req["args"]=args
    plan=module.scope_plan(req)
    print(json.dumps(plan))`, JSON.stringify(request()));
  for (const line of out.trim().split("\n")) {
    const plan = JSON.parse(line);
    expect(plan).not.toBeNull();
    expect(plan[0]).toMatch(/^murage-browser-bot-1\.[0-9a-f]{8}\.scope$/u);
    expect(plan[1]).toBe("murage-browsers.slice");
    expect(plan[2]).toEqual(expect.arrayContaining([expect.stringMatching(/^MemoryMax=/u), expect.stringMatching(/^TasksMax=/u), expect.stringMatching(/^RuntimeMaxSec=/u)]));
  }
  // A bad request is refused before any scope is made.
  expect(() => python(`module.scope_plan({"mode":"browser-restore","bot":"../x"})`)).toThrow();
});

function forkingStep(base: string, detached: boolean) {
  const script = join(base, `forking-${detached ? "detached" : "attached"}.mjs`);
  writeFileSync(script, `import { spawn } from "node:child_process";
spawn(process.execPath, ["-e", "const fs=require('fs');setInterval(()=>fs.writeFileSync(process.env.HOME+'/alive',String(Date.now())),40)"], { detached: ${detached}, stdio: "ignore", env: process.env }).unref();
setTimeout(() => {}, 60000);
`);
  return script;
}
function expectTreeEnded() {
  const alive = join(home(), "alive");
  sleepMs(400);
  const first = existsSync(alive) ? readFileSync(alive, "utf8") : "";
  sleepMs(600);
  const second = existsSync(alive) ? readFileSync(alive, "utf8") : "";
  expect(second).toBe(first);
}

steps("#2 kills the step's whole tree at its deadline: a forked child dies with it", () => {
  seed();
  const base = mkdtempSync(join(tmpdir(), "restore-fork-"));
  try {
    expect(launch(request(), { script: forkingStep(base, false), wait: 1.5 })).toMatch(/^FAIL Refusal/);
    expectTreeEnded();
  } finally { removeTempDirSync(base); }
});

steps("#2 isolated: a forked child that left the step's session dies at the deadline too (pid namespace)", { skip: !canIsolate || !canStep }, () => {
  const base = isolatedFixture();
  seed();
  expect(launch(request(), { script: forkingStep(base, true), wait: 1.5, isolate: true })).toMatch(/^FAIL Refusal/);
  expectTreeEnded();
});

steps("#3 every browser host generation starts split, a host restart after idle exit without the server included", () => {
  seed();
  // The server's first start: split, generation G1 (no host yet).
  const first = done(launch(request()));
  expect(first.state).toBe("ready");
  // The host starts on G1 without splitting again.
  expect(hostStart(request())).toBe(first.generation);
  expect(generationFile()).toBe(`${first.generation} hosted\n`);
  expect(done(launch(request("browser-restore-mark", [first.generation, ORIGIN]))).state).toBe("marked");
  // The engine saves at its idle exit: the shop origin with new storage, a new origin, and every cookie.
  const state = { cookies: [{ name: "sid", value: "z", domain: "shop.example" }], origins: [{ origin: ORIGIN, localStorage: [{ name: "cart", value: "9" }], sessionStorage: [] }, { origin: "https://new.example", localStorage: [{ name: "k", value: "v" }], sessionStorage: [] }] };
  writeFileSync(newestEngineState(sessions(), SESSION)!, encryptEngineData(Buffer.from(JSON.stringify(state)), KEY));
  // The MCP pump restarts the host on the bot's next frame, the server not involved: a new split, generation G2.
  const second = hostStart(request());
  expect(second).toMatch(/^[a-f0-9]{32}$/u);
  expect(second).not.toBe(first.generation);
  const engine = JSON.parse(decryptEngineData(readFileSync(newestEngineState(sessions(), SESSION)!), KEY).toString("utf8"));
  expect(engine.origins).toEqual([]);
  expect(engine.cookies).toHaveLength(1);
  // The server's refresh reads G2's snapshot while the host runs: every origin is eligible again, the ones
  // restored (or given up on) in G1 included, with the storage the engine saved.
  const snapshot = done(launch(request(), { live: true }));
  expect(snapshot.generation).toBe(second);
  expect(Object.keys(snapshot.origins).sort()).toEqual([ORIGIN, OTHER, "https://new.example"].sort());
  expect(snapshot.origins[ORIGIN].localStorage).toEqual([{ name: "cart", value: "9" }]);
  // A running daemon with no host lock is never split under.
  const unchanged = sha(newestEngineState(sessions(), SESSION)!);
  expect(hostStart(request(), { alive: true })).toBe("None");
  expect(sha(newestEngineState(sessions(), SESSION)!)).toBe(unchanged);
});

steps("#4 a mark from an obsolete generation is answered stale and never written", () => {
  seed();
  const first = done(launch(request()));
  expect(hostStart(request())).toBe(first.generation);
  const second = hostStart(request());
  expect(second).not.toBe(first.generation);
  const before = sidecarOf();
  expect(done(launch(request("browser-restore-mark", [first.generation, ORIGIN])))).toEqual({ state: "stale" });
  expect(sidecarOf()).toEqual(before);
  expect(sidecarOf().visited).toEqual([]);
  expect(done(launch(request("browser-restore-mark", [second, ORIGIN])))).toEqual({ state: "marked" });
  expect(sidecarOf().visited).toEqual([ORIGIN]);
});

const realFs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
steps("#5 the step fails (no quiet success) when the store cannot be written", () => {
  seed();
  done(launch(request()));
  const rename = realFs.renameSync;
  realFs.renameSync = (() => { throw Object.assign(new Error("EIO: simulated"), { code: "EIO" }); }) as typeof realFs.renameSync;
  syncBuiltinESMExports();
  try {
    const env = { HOME: home(), AGENT_BROWSER_RESTORE: SESSION, AGENT_BROWSER_ENCRYPTION_KEY: KEY, AGENT_BROWSER_RESTORE_SAVE: "auto" };
    expect(() => runBrowserRestoreStep(["mark", ORIGIN], env)).toThrow();
    expect(() => markBrowserRestoreVisited(spec(), OTHER)).toThrow(/EIO/);
  } finally { realFs.renameSync = rename; syncBuiltinESMExports(); }
  expect(sidecarOf().visited).toEqual([]);
});

steps("#7 a repeat mark persists its new last-seen time", () => {
  seed();
  done(launch(request()));
  const now = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  try {
    expect(markBrowserRestoreVisited(spec(), ORIGIN)).toBe(true);
    expect(sidecarOf().origins[ORIGIN].seenAt).toBe(1_800_000_000_000);
    now.mockReturnValue(1_800_000_600_000);
    expect(markBrowserRestoreVisited(spec(), ORIGIN)).toBe(true);
    expect(sidecarOf().origins[ORIGIN].seenAt).toBe(1_800_000_600_000);
    expect(sidecarOf().visited).toEqual([ORIGIN]);
  } finally { now.mockRestore(); }
});

it("#6 the restore store's writes (the store and the split engine file) fsync their directory; it opts in alone", () => {
  seed();
  const open = realFs.openSync;
  const opened: string[] = [];
  realFs.openSync = ((path: import("node:fs").PathLike, ...rest: unknown[]) => { opened.push(String(path)); return (open as (...args: unknown[]) => number)(path, ...rest); }) as typeof realFs.openSync;
  syncBuiltinESMExports();
  try { expect(prepareBrowserRestore(spec(), () => {})!.origins).toBe(2); }
  finally { realFs.openSync = open; syncBuiltinESMExports(); }
  // Two writes (store, then engine file), each followed by its directory's sync.
  expect(opened.filter(path => path === sessions())).toHaveLength(2);
  const source = readFileSync(fileURLToPath(new URL("../browser-restore-store.ts", import.meta.url)), "utf8");
  expect(source.match(/syncDir: true/gu)).toHaveLength(2);
});

it("#3 a host start splits first, under the id's lock, whoever starts it (the server's open or the MCP pump)", () => {
  const out = python(`
req=json.loads(sys.argv[3])
order=[]; st={"up":False}
def spawn(r,l):
    order.append("spawn"); st["up"]=True
    return lambda w: None
module.ensure_session_host(req, ${JSON.stringify(root)}+"/bot-1", root=${JSON.stringify(root)}, alive=lambda h,s: st["up"], spawn=spawn, owner=os.getuid(), fence=lambda r: None, live=lambda: st["up"], **accepted(module.ensure_session_host, dict(split=lambda *a: order.append("split"))))
module.ensure_session_host(req, ${JSON.stringify(root)}+"/bot-1", root=${JSON.stringify(root)}, alive=lambda h,s: st["up"], spawn=spawn, owner=os.getuid(), fence=lambda r: None, live=lambda: st["up"], **accepted(module.ensure_session_host, dict(split=lambda *a: order.append("split"))))
print(json.dumps(order))`, JSON.stringify(request()));
  // The second call finds the host live: no split, no second host.
  expect(JSON.parse(out)).toEqual(["split", "spawn"]);
});
