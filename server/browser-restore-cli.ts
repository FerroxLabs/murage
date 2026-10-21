// SPDX-License-Identifier: AGPL-3.0-or-later
// The Cloud launcher's browser-restore step, run AS the browser user in the bot's browser home
// (deploy/cloud-home/murage-turn-launch.py, modes browser-restore and browser-restore-mark).
//
// On a Cloud home the server cannot read /data/browser/<bot>, so the saved-session split
// (browser-restore-store.ts) runs here instead. It is the same code, not a copy: this file only
// reads its settings from the environment the launcher builds, checks that nothing it touches
// is a link, and prints the answer as one JSON line.
//
//   prepare        split the saved session; prints { state, origins, cookies, logs }
//   mark <origin>  record that this run visited <origin>; prints { state }
//
// The key arrives in AGENT_BROWSER_ENCRYPTION_KEY, never on the command line, and is never printed.
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { markBrowserRestoreVisited, originOf, prepareBrowserRestoreSnapshot, type RestoreSpec } from "./browser-restore-store.ts";

const REFUSED = "Browser restore refused";
const SESSION_SHAPE = /^[A-Za-z0-9_-]{1,80}$/u;
const KEY_SHAPE = /^[a-f0-9]{64}$/u;

function refuse(): never { throw new Error(REFUSED); }

/** The session directory and everything this step reads or writes in it must be the browser home's own
 * plain directories and single-link regular files: a link planted there by the sandboxed browser is refused,
 * never followed to another bot's home. */
export function confineSessionFiles(home: string, session: string): void {
  if (!home.startsWith("/") || realpathSync(home) !== home) refuse();
  let directory = home;
  for (const part of [".agent-browser", "sessions"]) {
    directory = join(directory, part);
    let info;
    try { info = lstatSync(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; refuse(); }
    if (!info.isDirectory() || info.isSymbolicLink()) refuse();
  }
  for (const name of readdirSync(directory)) {
    if (!name.startsWith(`${session}-`) && !name.startsWith(`${session}.`)) continue;
    const info = lstatSync(join(directory, name));
    if (!info.isFile() || info.nlink !== 1) refuse();
  }
}

/** Runs one step. Returns the JSON line to print. Throws a fixed phrase on a refusal. */
export function runBrowserRestoreStep(argv: string[], env: NodeJS.ProcessEnv): string {
  const home = env.HOME;
  const session = env.AGENT_BROWSER_RESTORE;
  const key = env.AGENT_BROWSER_ENCRYPTION_KEY;
  if (!home || !session || !SESSION_SHAPE.test(session) || !key || !KEY_SHAPE.test(key) || env.AGENT_BROWSER_RESTORE_SAVE !== "auto") refuse();
  // Only these settings reach the store: nothing else in the environment names a path.
  const spec: RestoreSpec = { env: { HOME: home, AGENT_BROWSER_RESTORE: session, AGENT_BROWSER_ENCRYPTION_KEY: key, AGENT_BROWSER_RESTORE_SAVE: "auto" } };
  confineSessionFiles(home, session);
  if (argv.length === 1 && argv[0] === "prepare") {
    const logs: string[] = [];
    const snapshot = prepareBrowserRestoreSnapshot(spec, line => { logs.push(line); });
    return JSON.stringify(snapshot ? { state: "ready", origins: snapshot.origins, cookies: snapshot.cookies, logs } : { state: "none", logs });
  }
  if (argv.length === 2 && argv[0] === "mark" && originOf(argv[1]!) === argv[1]) {
    return JSON.stringify({ state: markBrowserRestoreVisited(spec, argv[1]!, () => {}) ? "marked" : "none" });
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
