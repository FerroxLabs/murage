// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Client for the root launcher's unscoped bot-state modes (CLOUD-ENGINES-DESIGN.md r9, "launcher
// modes"). Every call is made exactly like a turn: `sudo -n -C 4 -- murage-turn-launch` with the JSON
// request on fd 3. The server learns names and timestamps only, never a secret.
//
// Why the guards are in-memory sets and not synchronous launcher calls: spawnSync cannot write to fd 3
// and a request file is not allowed (no files), so the launcher can only be asked asynchronously. The
// async calls record what they learn here, and `installCloudBotGuards` gives the Store synchronous
// hooks that read those sets. Deletion awaits `releaseCloudBotState` before `store.deleteBot`, so the
// Store hook is a belt that refuses a deletion nobody released.
//
// Active only on a Cloud home (MURAGE_CLOUD_ROLE=home); elsewhere every function is a no-op.
import { spawn, type ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";
import { cloudHomeCopy } from "./copy.ts";
import { TURN_LAUNCHER } from "./turn-process.ts";

/** `source`: which store answered, the home-wide one or the bot's own (null when the launcher does not say). */
export interface BotStateEngine { mode: "apikey" | "oauth-token" | "chatgpt" | "oauth" | null; signedIn: boolean; expiresAt: number | null; source?: "home" | "bot" | null }
export interface BotStateQuery { tombstoned: boolean; engines: Record<string, BotStateEngine> }
/** Test seam: how a launcher request is run. */
export type CloudLauncherSpawn = (request: Record<string, unknown>) => ChildProcess;

const BOT_ID = /^[\w-]{1,64}$/;
const MODES = new Set(["apikey", "oauth-token", "chatgpt", "oauth"]);
const OUTPUT_CAP = 64 * 1024;
const CALL_TIMEOUT_MS = 30_000;
const tombstoned = new Set<string>();
const released = new Set<string>();

const onHome = (): boolean => process.env.MURAGE_CLOUD_ROLE === "home";

/** `sudo -n -C 4 -- murage-turn-launch` with the request on FD 3, like every launcher call. */
export function spawnCloudLauncher(request: Record<string, unknown>): ChildProcess {
  const child = spawn("/usr/bin/sudo", ["-n", "-C", "4", "--", TURN_LAUNCHER], {
    env: { PATH: "/usr/bin:/bin" }, cwd: "/", detached: true, stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  const channel = child.stdio[3] as Writable;
  channel.on("error", () => {});
  channel.end(JSON.stringify(request));
  return child;
}

interface LauncherResult { code: number | null; stdout: string; stderr: string }
function runLauncher(request: Record<string, unknown>, launch: CloudLauncherSpawn): Promise<LauncherResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try { child = launch(request); } catch (error) { reject(error); return; }
    // Each stream keeps at most OUTPUT_CAP bytes; anything past that is dropped (a truncated answer
    // then fails to parse and reads as "unreadable", never as a partial state).
    const out = { stdout: [] as Buffer[], stderr: [] as Buffer[], stdoutBytes: 0, stderrBytes: 0 };
    const keep = (stream: "stdout" | "stderr") => (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const counter = stream === "stdout" ? "stdoutBytes" : "stderrBytes";
      const room = OUTPUT_CAP - out[counter];
      if (room <= 0) return;
      const part = bytes.length > room ? bytes.subarray(0, room) : bytes;
      out[stream].push(part);
      out[counter] += part.length;
    };
    let done = false;
    const finish = (fn: () => void) => { if (done) return; done = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => {
      finish(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } reject(new Error(cloudHomeCopy.cloudBotStateUnreadable)); });
    }, CALL_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on("data", keep("stdout"));
    child.stderr?.on("data", keep("stderr"));
    child.on("error", error => finish(() => reject(error)));
    child.on("close", code => finish(() => resolve({ code, stdout: Buffer.concat(out.stdout).toString("utf8"), stderr: Buffer.concat(out.stderr).toString("utf8") })));
  });
}
const firstLine = (text: string): string => text.split("\n").map(line => line.trim()).find(Boolean) ?? "";

function parseQuery(stdout: string): BotStateQuery {
  const raw = JSON.parse(stdout) as { tombstoned?: unknown; engines?: unknown };
  const engines: Record<string, BotStateEngine> = {};
  if (raw.engines && typeof raw.engines === "object") {
    for (const [name, value] of Object.entries(raw.engines as Record<string, Record<string, unknown>>)) {
      // An entry that is not an object says nothing about the engine: it is left out.
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const mode = typeof value?.mode === "string" && MODES.has(value.mode) ? value.mode as BotStateEngine["mode"] : null;
      const source = value?.source === "home" || value?.source === "bot" ? value.source : null;
      engines[name] = { mode, signedIn: value?.signedIn === true, expiresAt: typeof value?.expiresAt === "number" ? value.expiresAt : null, source };
    }
  }
  return { tombstoned: raw.tombstoned === true, engines };
}

/** What the launcher knows: whether the bot is tombstoned and each engine's sign-in mode. With no `bot`
 * only the engine-wide stores are reported. Any launcher failure throws; callers decide whether that matters. */
export async function queryCloudBotState(bot?: string, launch: CloudLauncherSpawn = spawnCloudLauncher): Promise<BotStateQuery> {
  if (!onHome()) return { tombstoned: false, engines: {} };
  if (bot !== undefined && !BOT_ID.test(bot)) throw new Error(cloudHomeCopy.cloudBotStateUnreadable);
  const result = await runLauncher({ mode: "bot-state-query", ...(bot ? { bot } : {}) }, launch);
  if (result.code !== 0) throw new Error(firstLine(result.stderr) || cloudHomeCopy.cloudBotStateUnreadable);
  let parsed: BotStateQuery;
  try { parsed = parseQuery(result.stdout); } catch { throw new Error(cloudHomeCopy.cloudBotStateUnreadable); }
  if (bot && parsed.tombstoned) tombstoned.add(bot);
  return parsed;
}

/** Ask the launcher to erase a deleted bot's state and tombstone its id. Exit 0 is the only success; any
 * other exit means "not released" and throws the launcher's first stderr line (for example
 * `Cloud bot state is in use`), so the bot stays. */
export async function releaseCloudBotState(bot: string, launch: CloudLauncherSpawn = spawnCloudLauncher): Promise<void> {
  if (!onHome()) return;
  if (!BOT_ID.test(bot)) throw new Error(cloudHomeCopy.cloudBotStateReleaseFailed);
  const result = await runLauncher({ mode: "bot-state-release", bot }, launch);
  if (result.code !== 0) throw new Error(firstLine(result.stderr) || cloudHomeCopy.cloudBotStateReleaseFailed);
  released.add(bot);
  tombstoned.add(bot);
}

/** Bot ids are never reused: refuse an id the launcher has tombstoned (creation and import paths). */
export async function assertCloudBotIdNotTombstoned(id: string, launch: CloudLauncherSpawn = spawnCloudLauncher): Promise<void> {
  if (!onHome()) return;
  if ((await queryCloudBotState(id, launch)).tombstoned) throw new Error(cloudHomeCopy.cloudBotIdTombstoned);
}

/** The launcher's line for a refused release, as the owner should read it. */
export function cloudBotStateRefusalCopy(error: unknown): string {
  const line = error instanceof Error ? error.message : "";
  if (line === "Cloud bot state is in use") return cloudHomeCopy.cloudBotStateInUse;
  if (line === "Cloud bot state is being released") return cloudHomeCopy.cloudBotStateBeingReleased;
  return line.startsWith("Cloud ") ? line : cloudHomeCopy.cloudBotStateReleaseFailed;
}

/** Claude's C-mode token is renewed from 30 days before it expires (CLOUD-ENGINES-DESIGN.md R3.1). */
export const CLAUDE_RENEW_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** `expiresAt` as epoch milliseconds; a value below 1e12 is read as epoch seconds. */
const epochMs = (value: number): number => value < 1e12 ? value * 1000 : value;

/** Whether the owner should renew the Claude sign-in of this Cloud home: an enrolled token
 * (`oauth-token`) that expires within 30 days, or one the CLI no longer accepts (`authenticated`
 * false, the authentication-error path). Never throws: a launcher that cannot answer means no flag. */
export async function cloudClaudeRenewalDue(authenticated: boolean, options: { now?: number; launch?: CloudLauncherSpawn } = {}): Promise<boolean> {
  if (!onHome()) return false;
  try {
    const claude = (await queryCloudBotState(undefined, options.launch)).engines.claudeAgent;
    if (claude?.mode !== "oauth-token") return false;
    if (!authenticated) return true;
    return claude.expiresAt !== null && epochMs(claude.expiresAt) - (options.now ?? Date.now()) <= CLAUDE_RENEW_WINDOW_MS;
  } catch {
    return false;
  }
}

/** Synchronous Store hooks backed by what the async calls learned (see the file header). */
export function installCloudBotGuards(store: { botIdGuard?: (id: string) => void; releaseBotState?: (id: string) => void }): void {
  if (!onHome()) return;
  store.botIdGuard = id => { if (tombstoned.has(id)) throw new Error(cloudHomeCopy.cloudBotIdTombstoned); };
  store.releaseBotState = id => { if (!released.has(id)) throw new Error(cloudHomeCopy.cloudBotStateNotReleased); };
}

/** Test helper: forget what the module learned. */
export function resetCloudBotStateForTests(): void { tombstoned.clear(); released.clear(); }
