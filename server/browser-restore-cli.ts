// SPDX-License-Identifier: AGPL-3.0-or-later
// The Cloud launcher's browser-restore step, run AS the browser user in the bot's browser home
// (deploy/cloud-home/murage-turn-launch.py, modes browser-restore and browser-restore-mark).
//
// On a Cloud home the server cannot read /data/browser/<bot>, so the saved-session split
// (browser-restore-store.ts) runs here instead. It is the same code, not a copy: this file only
// reads its settings from the environment the launcher builds, checks that nothing it touches
// is a link, and prints the answer as one JSON line.
//
//   prepare <generation>   split the saved session (a new browser host is about to start);
//                          prints { state, generation, origins, cookies, logs }
//   snapshot <generation>  what the running host's engine run still has to put back, read only;
//                          prints { state, generation, origins, cookies, logs }
//   mark <origin>          record that this run visited <origin>; prints { state: "marked" }
//
// The launcher runs this in a mount namespace that holds only this bot's browser home, so nothing a
// link names can reach another bot's files, and checks the generation itself (the step only echoes it).
// Every failure, a store that cannot be written included, exits non-zero with a fixed phrase.
//
// The key arrives in AGENT_BROWSER_ENCRYPTION_KEY, never on the command line, and is never printed.
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { markBrowserRestoreVisited, originOf, prepareBrowserRestoreSnapshot, readBrowserRestoreSnapshot, type RestoreSpec } from "./browser-restore-store.ts";

const REFUSED = "Browser restore refused";
const SESSION_SHAPE = /^[A-Za-z0-9_-]{1,80}$/u;
const KEY_SHAPE = /^[a-f0-9]{64}$/u;
const GENERATION_SHAPE = /^[a-f0-9]{32}$/u;
/** What one step may read: each saved-session file, and all of them together (the launcher's scope bounds memory too). */
export const RESTORE_FILE_BYTES = 32 * 1024 * 1024;
export const RESTORE_TOTAL_BYTES = 48 * 1024 * 1024;

function refuse(): never { throw new Error(REFUSED); }

/** The session directory and everything this step reads or writes in it must be the browser home's own
 * plain directories and single-link regular files: a link planted there by the sandboxed browser is refused,
 * never followed to another bot's home. */
export function confineSessionFiles(home: string, session: string, limits = { fileBytes: RESTORE_FILE_BYTES, totalBytes: RESTORE_TOTAL_BYTES }): void {
  if (!home.startsWith("/") || realpathSync(home) !== home) refuse();
  let directory = home;
  for (const part of [".agent-browser", "sessions"]) {
    directory = join(directory, part);
    let info;
    try { info = lstatSync(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; refuse(); }
    if (!info.isDirectory() || info.isSymbolicLink()) refuse();
  }
  let total = 0;
  for (const name of readdirSync(directory)) {
    if (!name.startsWith(`${session}-`) && !name.startsWith(`${session}.`)) continue;
    const info = lstatSync(join(directory, name));
    if (!info.isFile() || info.nlink !== 1) refuse();
    // Oversize input is refused before anything is read (the store checks each read again).
    total += info.size;
    if (info.size > limits.fileBytes || total > limits.totalBytes) refuse();
  }
}

/** Runs one step. Returns the JSON line to print. Throws a fixed phrase on a refusal. */
export function runBrowserRestoreStep(argv: string[], env: NodeJS.ProcessEnv): string {
  const home = env.HOME;
  const session = env.AGENT_BROWSER_RESTORE;
  const key = env.AGENT_BROWSER_ENCRYPTION_KEY;
  if (!home || !session || !SESSION_SHAPE.test(session) || !key || !KEY_SHAPE.test(key) || env.AGENT_BROWSER_RESTORE_SAVE !== "auto") refuse();
  // Only these settings reach the store: nothing else in the environment names a path.
  const limits = { fileBytes: RESTORE_FILE_BYTES, totalBytes: RESTORE_TOTAL_BYTES };
  const spec: RestoreSpec = { env: { HOME: home, AGENT_BROWSER_RESTORE: session, AGENT_BROWSER_ENCRYPTION_KEY: key, AGENT_BROWSER_RESTORE_SAVE: "auto" }, limits };
  confineSessionFiles(home, session, limits);
  if (argv.length === 2 && (argv[0] === "prepare" || argv[0] === "snapshot") && GENERATION_SHAPE.test(argv[1]!)) {
    const logs: string[] = [];
    const snapshot = argv[0] === "prepare" ? prepareBrowserRestoreSnapshot(spec, line => { logs.push(line); }) : readBrowserRestoreSnapshot(spec);
    const generation = argv[1]!;
    return JSON.stringify(snapshot ? { state: "ready", generation, origins: snapshot.origins, cookies: snapshot.cookies, logs } : { state: "none", generation, logs });
  }
  if (argv.length === 2 && argv[0] === "mark" && originOf(argv[1]!) === argv[1]) {
    // No store to mark is a failure too: the relay only marks origins the store handed it.
    return markBrowserRestoreVisited(spec, argv[1]!) ? JSON.stringify({ state: "marked" }) : refuse();
  }
  return refuse();
}

if (process.argv[1] && /browser-restore-cli\.(?:js|ts)$/u.test(process.argv[1])) {
  try {
    process.stdout.write(`${runBrowserRestoreStep(process.argv.slice(2), process.env)}\n`);
  } catch {
    // A fixed phrase only: an error's message can quote a path or a file that holds sign-ins.
    process.stderr.write(`${REFUSED}\n`);
    process.exitCode = 1;
  }
}
