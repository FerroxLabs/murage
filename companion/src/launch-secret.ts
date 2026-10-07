// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The child's half of electron/launch-secret.mjs (0.1.62 audit P1, S1b review
// R8): take a per-launch secret from the private pipe its parent named, once,
// and leave nothing in the environment for a child of ours to inherit. The
// secret never travels in the environment, an argument or a file.
//
// `<name>_VIA` is `stdin` (child_process.spawn, one line then EOF) or `parent`
// (Electron utilityProcess parentPort message). A plain `<name>` is still
// honoured for a development launch with no `_VIA`. All of them are removed
// from `env` either way. A parent that never delivers leaves no secret: the
// door stays shut.
import type { Readable } from "node:stream";

export const LAUNCH_SECRET_MESSAGE = "murage:launch-secret";
const DEFAULT_WAIT_MS = 15_000;

type ParentPort = { on(event: "message", listener: (event: { data?: unknown }) => void): void };
export type LaunchSecretIo = { stdin?: Readable; parentPort?: ParentPort; waitMs?: number };

function fromStdin(stdin: Readable, waitMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    let buffered = "";
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { stdin.destroy(); } catch { /* already closed */ }
      resolve(value?.trim() || undefined);
    };
    const timer = setTimeout(() => finish(undefined), waitMs);
    timer.unref?.();
    stdin.setEncoding?.("utf8");
    stdin.on("data", (chunk) => {
      buffered += String(chunk);
      const end = buffered.indexOf("\n");
      if (end >= 0) finish(buffered.slice(0, end));
    });
    stdin.on("end", () => finish(buffered));
    stdin.on("error", () => finish(undefined));
    stdin.on("close", () => finish(buffered));
  });
}

/** Parent-port messages that arrive before the process's own handler is
 * installed (the launch secret is awaited first, and the main process sends
 * its other startup state right behind it). Held, then replayed once. */
const early: Array<{ data?: unknown }> = [];
let earlyReleased = false;
const EARLY_LIMIT = 256;

/** Hand the held messages to the real handler, in order, and stop holding. */
export function replayEarlyParentMessages(handler: (event: { data?: unknown }) => void): void {
  earlyReleased = true;
  for (const event of early.splice(0)) handler(event);
}

function fromParent(port: ParentPort, name: string, waitMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value?.trim() || undefined);
    };
    const timer = setTimeout(() => finish(undefined), waitMs);
    timer.unref?.();
    port.on("message", (event) => {
      const message = event?.data as { type?: unknown; name?: unknown; value?: unknown } | undefined;
      if (!settled && message && message.type === LAUNCH_SECRET_MESSAGE && message.name === name) {
        finish(typeof message.value === "string" ? message.value : undefined);
        return;
      }
      if (message?.type === LAUNCH_SECRET_MESSAGE) return;
      if (!earlyReleased && early.length < EARLY_LIMIT) early.push(event);
    });
  });
}

export function takeLaunchSecret(name: string, env: NodeJS.ProcessEnv = process.env, io: LaunchSecretIo = {}): Promise<string | undefined> {
  const viaName = `${name}_VIA`;
  const via = env[viaName];
  const direct = env[name];
  delete env[viaName];
  delete env[name];
  // A leftover from the old file handoff must never be followed.
  delete env[`${name}_FILE`];
  const waitMs = io.waitMs ?? DEFAULT_WAIT_MS;
  if (via === "stdin") return fromStdin(io.stdin ?? process.stdin, waitMs);
  if (via === "parent") {
    const port = io.parentPort ?? (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
    return port ? fromParent(port, name, waitMs) : Promise.resolve(undefined);
  }
  return Promise.resolve(direct || undefined);
}
