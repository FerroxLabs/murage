import { cloudHomeCopy } from "./copy.ts";
// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Writable } from "node:stream";
import { TURN_LAUNCHER } from "./turn-process.ts";
import { ensureServerInstancePublished, SERVER_INSTANCE, STALE_INSTANCE_EXIT } from "./server-instance.ts";
import { CANARY_BROWSER_ID, isReservedBotId } from "../../shared/bot-identity.ts";

export const CLOUD_BROWSER_BOT = "MURAGE_CLOUD_BROWSER_BOT";
let admit: ((bot: string) => boolean) | undefined;
export function setCloudBrowserAdmission(check: (bot: string) => boolean): void { admit = check; }
const BROWSER_SETTINGS = ["AGENT_BROWSER_SESSION", "AGENT_BROWSER_ENCRYPTION_KEY", "AGENT_BROWSER_RESTORE_SAVE", "AGENT_BROWSER_RESTORE"];
/** The launcher modes a bot's browser request can take. The two restore modes run the saved-session split and its
 * visit mark as the browser user (server/browser-restore-cli.ts); the others run the browser. */
export type CloudBrowserMode = "browser" | "browser-restore" | "browser-restore-mark";
function browserRequest(bot: string, args: string[], env: NodeJS.ProcessEnv, mode: CloudBrowserMode = "browser") {
  const settings: Record<string, string> = {};
  for (const key of BROWSER_SETTINGS) {
    if (env[key] !== undefined) settings[key] = env[key]!;
  }
  return { mode, bot, args, settings, instance: SERVER_INSTANCE };
}
/** A bot's browser request. The reserved namespace belongs to the system (the UI canary), so a bot can never name it. */
export function cloudBrowserRequest(args: string[], env: NodeJS.ProcessEnv, mode: CloudBrowserMode = "browser") {
  const bot = env[CLOUD_BROWSER_BOT];
  if (!bot || !/^[\w-]+$/.test(bot) || isReservedBotId(bot)) throw new Error(cloudHomeCopy.invalidCloudBrowserIdentity);
  return browserRequest(bot, args, env, mode);
}
function spawnLauncher(request: object): ChildProcessWithoutNullStreams {
  // Before any browser launch the current instance must be readable by the launcher (no-op after the first success).
  ensureServerInstancePublished();
  const child = spawn("/usr/bin/sudo", ["-n", "-C", "4", "--", TURN_LAUNCHER], {
    env: { PATH: "/usr/bin:/bin" }, shell: false, stdio: ["pipe", "pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  const pipe = child.stdio[3] as Writable;
  pipe.on("error", () => {});
  pipe.end(JSON.stringify(request));
  return child;
}
export function spawnCloudBrowser(args: string[], env: NodeJS.ProcessEnv, mode: CloudBrowserMode = "browser"): ChildProcessWithoutNullStreams | null {
  if (process.env.MURAGE_CLOUD_ROLE !== "home") return null;
  const request = cloudBrowserRequest(args, env, mode);
  if (admit && !admit(request.bot)) throw new Error(cloudHomeCopy.profileCleanupPending);
  const child = spawnLauncher(request);
  child.once("close", code => { noteBrowserRefusal(code); });
  return child;
}
/** The UI canary's browser. The identity is fixed here and CLOUD_BROWSER_BOT in `env` is ignored, so the canary can never name a bot. */
export function canaryBrowserRequest(args: string[], env: NodeJS.ProcessEnv) { return browserRequest(CANARY_BROWSER_ID, args, env); }
export function spawnCanaryBrowser(args: string[], env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams | null {
  if (process.env.MURAGE_CLOUD_ROLE !== "home") return null;
  return spawnLauncher(canaryBrowserRequest(args, env));
}
/** A launch the root launcher refused because a newer server process took over (exit 76). A plain, retryable failure. */
export function browserLaunchFailure(code: number | null): Error | null {
  return code === STALE_INSTANCE_EXIT ? new Error(cloudHomeCopy.cloudBrowserLaunchSuperseded) : null;
}
/** One plain stderr line (journald) per refusal, at most one a minute however many launches are refused. No ids, tokens or output. */
export const BROWSER_REFUSAL_LOG_INTERVAL_MS = 60_000;
let lastRefusalLogAt = -Infinity;
export function noteBrowserRefusal(code: number | null, log: (line: string) => void = line => console.error(line), now: number = Date.now()): boolean {
  if (code !== STALE_INSTANCE_EXIT || now - lastRefusalLogAt < BROWSER_REFUSAL_LOG_INTERVAL_MS) return false;
  lastRefusalLogAt = now;
  log("[browser] launch refused: server restarted");
  return true;
}
export function resetBrowserRefusalLogForTests(): void { lastRefusalLogAt = -Infinity; }
/** The root launcher exits 75 when another launch or cleanup of the same id holds its lock: not clean, retry. */
export const CLEANUP_BUSY_EXIT = 75;
function runCleanup(bot: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/sudo", ["-n", "-C", "4", "--", TURN_LAUNCHER], {
      env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "ignore", "ignore", "pipe"],
    });
    const pipe = child.stdio[3] as Writable;
    pipe.on("error", () => {}); pipe.end(JSON.stringify({ mode: "browser-cleanup", bot }));
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(Object.assign(new Error(cloudHomeCopy.cloudBrowserCleanupFailed), { busy: code === CLEANUP_BUSY_EXIT })); });
  });
}
export async function cleanupCloudBrowser(bot: string): Promise<void> {
  if (!/^[\w-]+$/.test(bot) || isReservedBotId(bot)) throw new Error(cloudHomeCopy.invalidCloudBrowserIdentity);
  await runCleanup(bot);
}
/** Stops and erases the UI canary's browser (scopes killed, listed, profile erased). */
export function cleanupCanaryBrowser(): Promise<void> { return runCleanup(CANARY_BROWSER_ID); }
