// SPDX-License-Identifier: AGPL-3.0-or-later
// The saved browser session on a Cloud home (browser-restore-store.ts has the rules).
//
// The server cannot reach /data/browser/<bot> under the sudo launcher, so it asks the launcher to run
// the split as the browser user (modes browser-restore and browser-restore-mark, server/browser-restore-cli.ts)
// and gets the saved storage back over the request's stdout. The key travels in the request's settings
// like every browser request and is never logged.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { restoreSessionOf, type OriginStorage, type RestoreSession, type StorageEntry } from "../browser-restore-store.ts";
import type { CloudBrowserMode } from "./browser-process.ts";
import { spawnCloudBrowser } from "./browser-process.ts";

/** Test seam: how a launcher request is started. */
export type CloudBrowserLaunch = (args: string[], env: NodeJS.ProcessEnv, mode: CloudBrowserMode) => ChildProcessWithoutNullStreams | null;
/** The saved storage of a long-used profile, as JSON. */
const OUTPUT_CAP = 32 * 1024 * 1024;
const STEP_TIMEOUT_MS = 30_000;
const PREPARE_FAILED = "[browser] restore store could not be prepared; the engine restores the saved session as before";
const MARK_FAILED = "[browser] restore store could not note a visit; its saved copy is kept for the next run";

function runStep(args: string[], env: NodeJS.ProcessEnv, mode: CloudBrowserMode, launch: CloudBrowserLaunch): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const child = launch(args, env, mode);
    if (!child) { resolve(undefined); return; }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failed = false;
    const timer = setTimeout(() => { failed = true; child.kill("SIGKILL"); }, STEP_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > OUTPUT_CAP) { failed = true; child.kill("SIGKILL"); return; }
      chunks.push(chunk);
    });
    // The launcher's own words are fixed, but nothing it prints is logged here.
    child.stderr.on("data", () => {});
    child.once("error", () => { clearTimeout(timer); reject(new Error(PREPARE_FAILED)); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failed || code !== 0) reject(new Error(PREPARE_FAILED));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

function entriesOf(value: unknown): StorageEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is StorageEntry => !!item && typeof item.name === "string" && typeof item.value === "string")
    .map(({ name, value }) => ({ name, value }));
}

/** The launcher's saved storage, or undefined when this browser keeps none (or is not on a Cloud home).
 * Throws a fixed phrase when the launcher refuses or answers badly: the engine then restores as before. */
export async function prepareCloudBrowserRestore(
  env: NodeJS.ProcessEnv,
  log: (line: string) => void = line => console.log(line),
  launch: CloudBrowserLaunch = spawnCloudBrowser,
): Promise<RestoreSession | undefined> {
  const output = await runStep([], env, "browser-restore", launch);
  if (output === undefined) return undefined;
  let value: { state?: unknown; origins?: unknown; logs?: unknown };
  try { value = JSON.parse(output); } catch { throw new Error(PREPARE_FAILED); }
  if (!value || typeof value !== "object") throw new Error(PREPARE_FAILED);
  if (Array.isArray(value.logs)) for (const line of value.logs) if (typeof line === "string" && line.startsWith("[browser] ")) log(line.slice(0, 400));
  if (value.state !== "ready" || !value.origins || typeof value.origins !== "object" || Array.isArray(value.origins)) return undefined;
  const origins = new Map<string, OriginStorage>();
  for (const [origin, storage] of Object.entries(value.origins as Record<string, { localStorage?: unknown; sessionStorage?: unknown }>)) {
    origins.set(origin, { localStorage: entriesOf(storage?.localStorage), sessionStorage: entriesOf(storage?.sessionStorage) });
  }
  // Visits are noted in the store one after another, in the order they happened.
  let queue: Promise<unknown> = Promise.resolve();
  const visit = (origin: string) => {
    queue = queue.then(() => runStep([origin], env, "browser-restore-mark", launch)).catch(() => { log(MARK_FAILED); });
  };
  return restoreSessionOf(origins, visit);
}
