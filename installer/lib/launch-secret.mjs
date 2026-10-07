// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Hands a per-launch secret to a child process over a private pipe, never the
// environment, an argument or a file (0.1.62 audit P1, S1b review R8).
//
// A child's initial environment stays readable at /proc/<pid>/environ on
// Linux for the child's whole life, and its arguments at /proc/<pid>/cmdline.
// A temp file, even a 0600 one in a 0700 folder, can be read by a same-user
// bot that polls for it before the child deletes it. A pipe has no name on
// disk: only the two ends hold it.
//
// Two transports, one per kind of child:
//   stdin   child_process.spawn with stdio[0] = "pipe": the secret is written
//           to the child's stdin and the pipe is closed.
//   parent  Electron utilityProcess.fork, which has no stdin: the secret goes
//           over the private parentPort, which exists only between main and
//           that child.
// The only thing left in the child's environment is `<NAME>_VIA`, which names
// the transport and is not a secret. The child half is server/launch-secret.ts
// (and companion/src/launch-secret.ts). installer/lib/launch-secret.mjs is the
// same writer for the headless installer.

export const LAUNCH_SECRET_MESSAGE = "murage:launch-secret";

/** The environment entry that tells the child where to read `name` from. */
export function launchSecretVia(name, transport) {
  if (transport !== "stdin" && transport !== "parent") throw new Error("unknown launch secret transport");
  return { [`${name}_VIA`]: transport };
}

/** Write `value` to a spawned child's stdin and close it. The child must have
 * been spawned with stdio[0] = "pipe". A child that already died only costs a
 * swallowed EPIPE, never a crash or a leaked value. */
export function feedLaunchSecretStdin(child, value) {
  const stdin = child?.stdin;
  if (!stdin) throw new Error("the child has no stdin pipe to carry its launch secret");
  stdin.on("error", () => { /* the child exited before reading */ });
  stdin.end(`${value}\n`);
}

/** Send `value` to an Electron utility process over its private parent port. */
export function sendLaunchSecretParent(proc, name, value) {
  proc.postMessage({ type: LAUNCH_SECRET_MESSAGE, name, value });
}
