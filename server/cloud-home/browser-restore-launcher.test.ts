// SPDX-License-Identifier: AGPL-3.0-or-later
// The launcher's browser-restore and browser-restore-mark modes: strict request validation, path
// confinement, the bounded child, and (the cross-language fixture) that what the launcher's step writes is
// exactly what the server's own store reads and writes, because it is the server's own store.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { decryptEngineData, encryptEngineData, newestEngineState, prepareBrowserRestore } from "../browser-restore-store.ts";

const launcher = fileURLToPath(new URL("../../deploy/cloud-home/murage-turn-launch.py", import.meta.url));
const cli = fileURLToPath(new URL("../browser-restore-cli.ts", import.meta.url));
const KEY = "ab".repeat(32);
const SESSION = "fixture";
const INSTANCE = "i".repeat(22);
const ORIGIN = "https://shop.example";
const OTHER = "https://news.example:8443";

const harness = `import importlib.util,json,sys,os,io,types
spec=importlib.util.spec_from_file_location("restore_fixture",sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
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
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function home(bot = "bot-1") { return join(root, bot); }
function sessions(bot = "bot-1") { return join(home(bot), ".agent-browser", "sessions"); }
function seed(bot = "bot-1", origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }> = [{ origin: ORIGIN, localStorage: [{ name: "cart", value: "3" }] }, { origin: OTHER, localStorage: [{ name: "seen", value: "1" }] }], file = `${SESSION}-abc.json.enc`) {
  mkdirSync(sessions(bot), { recursive: true, mode: 0o700 });
  chmodSync(home(bot), 0o700);
  const state = { cookies: [{ name: "sid", value: "x", domain: "shop.example" }], origins: origins.map(item => ({ ...item, sessionStorage: [] })) };
  writeFileSync(join(sessions(bot), file), encryptEngineData(Buffer.from(JSON.stringify(state)), KEY), { mode: 0o600 });
}
/** Runs launch_browser_restore as the test user (no privilege change), with the real step script under this node. */
function launch(input: unknown, options: { alive?: boolean; script?: string; wait?: number; limit?: number } = {}) {
  const code = `
req=json.loads(sys.argv[3])
out=io.BytesIO()
account=types.SimpleNamespace(pw_uid=os.getuid(),pw_gid=os.getgid())
try:
    module.launch_browser_restore(req,root=${JSON.stringify(root)},account=account,fence=lambda r:None,alive=lambda h,s:${options.alive ? "True" : "False"},live=lambda *a:False,owner=os.getuid(),node=${JSON.stringify(process.execPath)},script=${JSON.stringify(options.script ?? cli)},drop=False,out=out,wait=${options.wait ?? 20},limit=${options.limit ?? 33554432})
    print("DONE",out.getvalue().decode())
except Exception as error:
    print("FAIL",type(error).__name__,error)`;
  return python(code, JSON.stringify(input)).trim();
}
const done = (text: string) => { expect(text.startsWith("DONE ")).toBe(true); return JSON.parse(text.slice(5)); };
const spec = (bot = "bot-1") => ({ env: { HOME: home(bot), AGENT_BROWSER_RESTORE: SESSION, AGENT_BROWSER_ENCRYPTION_KEY: KEY, AGENT_BROWSER_RESTORE_SAVE: "auto" } }) as never;

it("accepts exactly the two request shapes the relay sends and nothing else", () => {
  expect(validates(request())).toBe(true);
  expect(validates(request("browser-restore-mark", [ORIGIN]))).toBe(true);
  expect(validates(request("browser-restore-mark", ["http://127.0.0.1:3000"]))).toBe(true);
  expect(validates(request("browser-restore-mark", ["http://[::1]:8080"]))).toBe(true);
  expect(validates(request("browser-restore", [], { AGENT_BROWSER_RESTORE: SESSION }))).toBe(true);
  // another mode, extra keys, a bad bot or instance
  expect(validates(request("browser"))).toBe(false);
  expect(validates(request("browser-restore", [], {}, { cwd: "/" }))).toBe(false);
  expect(validates({ ...request(), bot: "../x" })).toBe(false);
  expect(validates({ ...request(), bot: "a/b" })).toBe(false);
  expect(validates({ ...request(), bot: "x".repeat(65) })).toBe(false);
  expect(validates({ ...request(), instance: "short" })).toBe(false);
  const { instance: _instance, ...noInstance } = request(); expect(validates(noInstance)).toBe(false);
  // arguments: restore takes none, mark takes one origin
  expect(validates(request("browser-restore", [ORIGIN]))).toBe(false);
  expect(validates(request("browser-restore-mark", []))).toBe(false);
  expect(validates(request("browser-restore-mark", [ORIGIN, OTHER]))).toBe(false);
  expect(validates(request("browser-restore-mark", [5]))).toBe(false);
  expect(validates({ ...request("browser-restore-mark", [ORIGIN]), args: "https://shop.example" })).toBe(false);
});

it("refuses anything but a bare origin to mark", () => {
  for (const bad of ["https://shop.example/", "https://shop.example/path", "https://shop.example?x=1", "https://shop.example#f", "https://user@shop.example", "https://user:pw@shop.example", "ftp://shop.example", "javascript:1", "about:blank", "shop.example", "HTTPS://shop.example", "https://", "https://shop.example:0", "https://shop.example:70000", "https://shop.example:", "https://shop example", "https://shop.example\n", "https://shop.example\0", "https://-bad.example/", "--flag", "-x", "https://" + "a".repeat(300) + ".example", "https://[zz]", "https://[::1", "http://127.0.0.1:99999"]) {
    expect(validates(request("browser-restore-mark", [bad])), bad).toBe(false);
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
  const plan = JSON.parse(python(`print(json.dumps(module.validate_browser_restore_request(json.loads(sys.argv[3]),"/data/browser")))`, JSON.stringify(request("browser-restore-mark", [ORIGIN]))));
  expect(Object.keys(plan.env).sort()).toEqual(["AGENT_BROWSER_ENCRYPTION_KEY", "AGENT_BROWSER_RESTORE", "AGENT_BROWSER_RESTORE_SAVE", "HOME", "PATH"]);
  expect(plan.env.HOME).toBe("/data/browser/bot-1");
  expect(plan.user).toBe("murage-browser");
  expect(plan.argv).toEqual(["mark", ORIGIN]);
  expect(JSON.stringify(plan.argv)).not.toContain(KEY);
});

it("splits the saved session as the browser user would and hands the storage back, then marks a visit", () => {
  seed();
  const answer = done(launch(request()));
  expect(answer.state).toBe("ready");
  expect(Object.keys(answer.origins).sort()).toEqual([ORIGIN, OTHER].sort());
  expect(answer.origins[ORIGIN].localStorage).toEqual([{ name: "cart", value: "3" }]);
  expect(answer.cookies).toBe(1);
  expect(JSON.stringify(answer)).not.toContain(KEY);
  // the engine's state file now holds the cookies only; the storage is in the store beside it
  const engine = JSON.parse(decryptEngineData(readFileSync(newestEngineState(sessions(), SESSION)!), KEY).toString("utf8"));
  expect(engine.origins).toEqual([]); expect(engine.cookies).toHaveLength(1);
  const sidecarPath = join(sessions(), `${SESSION}.murage-storage.enc`);
  expect(existsSync(sidecarPath)).toBe(true);
  expect(done(launch(request("browser-restore-mark", [ORIGIN]))).state).toBe("marked");
  const sidecar = JSON.parse(decryptEngineData(readFileSync(sidecarPath), KEY).toString("utf8"));
  expect(sidecar.version).toBe(1); expect(sidecar.visited).toEqual([ORIGIN]);
  expect(Object.keys(sidecar.origins).sort()).toEqual([ORIGIN, OTHER].sort());
  expect(typeof sidecar.origins[ORIGIN].seenAt).toBe("number");
  // marking again changes nothing
  expect(done(launch(request("browser-restore-mark", [ORIGIN]))).state).toBe("marked");
  expect(JSON.parse(decryptEngineData(readFileSync(sidecarPath), KEY).toString("utf8")).visited).toEqual([ORIGIN]);
});

it("reads and writes the one store format both ways (the cross-language fixture)", () => {
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

it("reads the old `restored` list name and prunes by the same age and count rules", () => {
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

it("answers none and changes nothing when there is no home, no session files or a running session", () => {
  expect(done(launch(request()))).toEqual({ state: "none", logs: [] });
  expect(done(launch(request("browser-restore-mark", [ORIGIN])))).toEqual({ state: "none" });
  mkdirSync(home(), { mode: 0o700 }); chmodSync(home(), 0o700);
  expect(done(launch(request())).state).toBe("none");
  seed();
  const before = readFileSync(newestEngineState(sessions(), SESSION)!);
  expect(done(launch(request(), { alive: true }))).toEqual({ state: "none", logs: [] });
  expect(readFileSync(newestEngineState(sessions(), SESSION)!).equals(before)).toBe(true);
  expect(existsSync(join(sessions(), `${SESSION}.murage-storage.enc`))).toBe(false);
});

it("refuses a home or session directory that is a link, and a session file that is a link", () => {
  // home itself a link to another bot's directory
  seed("bot-2");
  symlinkSync(home("bot-2"), home("bot-1"));
  expect(launch(request())).toMatch(/^FAIL/);
  rmSync(home("bot-1"));
  // sessions directory a link
  mkdirSync(join(home("bot-1"), ".agent-browser"), { recursive: true, mode: 0o700 }); chmodSync(home("bot-1"), 0o700);
  symlinkSync(sessions("bot-2"), sessions("bot-1"));
  expect(launch(request())).toMatch(/^FAIL/);
  expect(launch(request("browser-restore-mark", [ORIGIN]))).toMatch(/^FAIL/);
  rmSync(sessions("bot-1"));
  // a state file that is a link out of the home
  mkdirSync(sessions("bot-1"), { recursive: true, mode: 0o700 });
  symlinkSync(newestEngineState(sessions("bot-2"), SESSION)!, join(sessions("bot-1"), `${SESSION}-evil.json.enc`));
  const before = readFileSync(newestEngineState(sessions("bot-2"), SESSION)!);
  expect(launch(request())).toMatch(/^FAIL/);
  expect(readFileSync(newestEngineState(sessions("bot-2"), SESSION)!).equals(before)).toBe(true);
  // home with the wrong mode
  rmSync(home("bot-1"), { recursive: true }); mkdirSync(sessions("bot-1"), { recursive: true }); chmodSync(home("bot-1"), 0o755);
  expect(launch(request())).toMatch(/^FAIL/);
});

it("refuses a browser directory that is not the root-owned 0711 one", () => {
  chmodSync(root, 0o755);
  seed();
  expect(launch(request())).toMatch(/^FAIL/);
});

it("bounds the step: a step that outlasts the deadline or prints too much fails closed", () => {
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

it("gives the step only its five environment names", () => {
  seed();
  const probe = join(root, "probe.mjs"); writeFileSync(probe, "process.stdout.write(JSON.stringify({ env: Object.keys(process.env).sort(), cwd: process.cwd(), argv: process.argv.slice(2) }));\n");
  const answer = done(launch(request("browser-restore-mark", [ORIGIN]), { script: probe }));
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
  expect(run(["other"])).toBe("Browser restore refused\n");
  expect(run([])).toBe("Browser restore refused\n");
});

it("is wired in: unscoped modes, dispatched, bundled, and pinned in the engine manifest", () => {
  const source = readFileSync(launcher, "utf8");
  expect(source).toMatch(/or mode in BROWSER_RESTORE_MODES:\n\s+return None/);
  expect(source).toMatch(/elif request\.get\("mode"\) in BROWSER_RESTORE_MODES:\n\s+launch_browser_restore\(request\)/);
  expect(readFileSync(fileURLToPath(new URL("../../scripts/bundle-server.mjs", import.meta.url)), "utf8")).toContain('"browser-restore-cli.ts"');
  const build = readFileSync(fileURLToPath(new URL("../../deploy/cloud-home/build-image.sh", import.meta.url)), "utf8");
  expect(build).toContain('manifest["browserRestore"]'); expect(build).toContain("/opt/murage/dist-server/browser-restore-cli.js");
  expect(python(`print(module.scope_plan({"mode":"browser-restore"}), module.scope_plan({"mode":"browser-restore-mark"}))`).trim()).toBe("None None");
});
