// One foreground-owned Murage source server for channel qualification.
//
// Every run gets its own HOME/data/static/temp roots under the OS temp dir,
// a random desktop proof, a free loopback port pair and the repository's fake
// Claude engine (so no paid model is reachable). Restart keeps the same data
// directory, which is the "normal same-data process restart" under test.
// Cleanup stops only the exact child this harness spawned and removes only its
// own root; evidence stays in a separate directory the caller chose.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, openSync, closeSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTempDir, waitForExit } from "../server/testing/cleanup.ts";
import { freePortBlock } from "../server/testing/ports.ts";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const FIXTURE_ENGINE = { instanceId: "fixtureClaude", model: "claude-sonnet-5" };

export interface HarnessOptions {
  label: string;
  evidenceDir: string;
  /** Rehearsal-only module substitution; a live run passes none. */
  preload?: string;
  ipc?: boolean;
  /** Live runs only: own process group, so terminal Ctrl-C reaches the runner (which revokes) and not the server. */
  detached?: boolean;
  /** Non-secret fixture environment, evaluated at every boot. */
  env?: () => Record<string, string>;
  /** Secrets delivered at every boot, the way the desktop shell does. Never logged. */
  secretEnv?: () => Record<string, string>;
}

export interface Exit { exitCode: number | null; signal: string | null }

export interface Harness {
  readonly root: string;
  readonly data: string;
  readonly url: string;
  readonly boots: number;
  child(): ChildProcess | undefined;
  boot(): Promise<void>;
  stop(): Promise<Exit>;
  restart(): Promise<Exit>;
  close(): Promise<Exit | null>;
  request(method: string, path: string, body?: unknown, owner?: boolean): Promise<{ status: number; body: any }>;
  record(step: string, data?: unknown): void;
  onMessage(listener: (value: unknown) => void): void;
}

export async function createHarness(options: HarnessOptions): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), `murage-channel-live-${options.label}-`));
  const data = join(root, "data"), staticDir = join(root, "static"), temp = join(root, "tmp");
  for (const dir of [data, join(staticDir, "assets"), temp]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Channel qualification</title>");
  writeFileSync(join(staticDir, "assets", "qualification.css"), "body{}");
  writeFileSync(join(data, "config.json"), JSON.stringify({ engineDiscovery: "explicit", instances: {
    ghost: { driver: "fixture-unavailable" },
    fixtureClaude: { driver: "claudeAgent", config: { cli: join(ROOT, "server", "testing", "fake-claude-cli.ts") } },
  } }), { mode: 0o600 });
  mkdirSync(options.evidenceDir, { recursive: true, mode: 0o700 });
  const port = await freePortBlock([0, 1]);
  const url = `http://127.0.0.1:${port}`;
  const secret = randomBytes(32).toString("hex");
  const desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": secret };
  const stepsFile = join(options.evidenceDir, "steps.jsonl");
  const listeners: Array<(value: unknown) => void> = [];
  let child: ChildProcess | undefined;
  let boots = 0;
  let closed = false;

  const record = (step: string, value?: unknown) => {
    appendFileSync(stepsFile, JSON.stringify({ at: new Date().toISOString(), step, ...(value === undefined ? {} : { data: value }) }) + "\n", { mode: 0o600 });
  };

  const request = async (method: string, path: string, body?: unknown, owner = true) => {
    const response = await fetch(url + path, { method, headers: { ...(owner ? desktop : {}), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
    const text = await response.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { unparsed: text.slice(0, 200) }; }
    return { status: response.status, body: parsed as any };
  };

  const boot = async () => {
    if (closed) throw new Error("harness is closed");
    if (child && child.exitCode === null && child.signalCode === null) throw new Error("harness child is still running");
    boots += 1;
    const env: NodeJS.ProcessEnv = {
      HOME: root, USERPROFILE: root, APPDATA: join(root, "AppData", "Roaming"), LOCALAPPDATA: join(root, "AppData", "Local"),
      XDG_CONFIG_HOME: join(root, ".config"), XDG_CACHE_HOME: join(root, ".cache"), XDG_DATA_HOME: join(root, ".local", "share"),
      TEMP: temp, TMP: temp, TMPDIR: temp, HERMES_HOME: join(root, ".hermes"),
      MURAGE_DATA_DIR: data, MURAGE_STATIC_DIR: staticDir, MURAGE_PORT: String(port), MURAGE_WEBHOOK_PORT: String(port + 1),
      MURAGE_DEV_DESKTOP_SECRET: secret, MURAGE_ALLOW_DEV_DESKTOP_SECRET: "1", PATH: process.env.PATH,
      FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_DUMP: join(root, "fake-claude-last-turn.json"),
      ...options.env?.(), ...options.secretEnv?.(),
    };
    for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "TZ"]) if (process.env[key]) env[key] = process.env[key];
    const log = openSync(join(options.evidenceDir, `server-boot-${boots}.log`), "a", 0o600);
    try {
      child = spawn(process.execPath, ["--experimental-strip-types", ...(options.preload ? ["--import", options.preload] : []), join(ROOT, "server", "index.ts")],
        { cwd: ROOT, env, stdio: ["ignore", log, log, ...(options.ipc ? ["ipc" as const] : [])], ...(options.detached ? { detached: true } : {}) });
    } finally { closeSync(log); }
    child.on("message", value => { for (const listener of listeners) listener(value); });
    record("boot", { boot: boots, pid: child.pid, url, preload: Boolean(options.preload) });
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`server exited before ready (boot ${boots}); see server-boot-${boots}.log`);
      try { if ((await request("GET", "/api/health", undefined, false)).status === 200) break; } catch { /* starting */ }
      if (Date.now() > deadline) throw new Error(`server not ready in 30s (boot ${boots})`);
      await sleep(150);
    }
  };

  const stop = async (): Promise<Exit> => {
    const current = child;
    if (!current) return { exitCode: null, signal: null };
    await waitForExit(current, { signal: "SIGTERM", graceMs: 10_000 });
    const exit = { exitCode: current.exitCode, signal: current.signalCode };
    record("stop", { pid: current.pid, ...exit });
    return exit;
  };

  return {
    root, data, url,
    get boots() { return boots; },
    child: () => child,
    boot, stop,
    async restart() { const exit = await stop(); await boot(); return exit; },
    async close() {
      if (closed) return null;
      const exit = child ? await stop() : null;
      await removeTempDir(root);
      let rootRemoved = false;
      try { lstatSync(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") rootRemoved = true; else throw error; }
      record("cleanup", { rootRemoved, ...(rootRemoved ? {} : { retainedRoot: root }), exit });
      if (!rootRemoved) throw new Error(`Cleanup retained fixture root: ${root}`);
      closed = true;
      return exit;
    },
    request, record,
    onMessage(listener) { listeners.push(listener); },
  };
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function waitFor<T>(label: string, probe: () => Promise<T> | T, accept: (value: T) => boolean, timeoutMs = 20_000, intervalMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  for (;;) {
    last = await probe();
    if (accept(last)) return last;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}; last value ${JSON.stringify(last)?.slice(0, 600)}`);
    await sleep(intervalMs);
  }
}

/** A fresh installation has no Chief; the qualification makes its fictional bot one, explicitly. */
export async function promoteFixtureChief(harness: Harness, name: string): Promise<{ id: string }> {
  const bots = await harness.request("GET", "/api/bots");
  const candidate = bots.body?.bots?.[0];
  if (!candidate?.id) throw new Error("fixture has no bot to promote");
  const promoted = await harness.request("PATCH", `/api/bots/${candidate.id}`, { name, chiefOfStaff: true, chiefScope: "workspace", computer: "off", modelSelection: FIXTURE_ENGINE });
  if (promoted.status !== 200) throw new Error(`Chief promotion refused: ${promoted.status} ${JSON.stringify(promoted.body)}`);
  harness.record("chief-promoted", { botId: candidate.id });
  return { id: candidate.id };
}
