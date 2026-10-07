// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Adapted from OpenMausBot 95a94daa (#1840, Apache-2.0): run Claude Code's
// own updater when a turn failed because the CLI is too old for the model.
import type { ExecFileOptions } from "node:child_process";

import { describeSpawnFailure, execCli } from "./procs.ts";

type ExecCli = (
  cli: string,
  args: string[],
  options: ExecFileOptions,
  callback: (error: Error | null, stdout: string, stderr?: string) => void,
) => void;

const FALLBACK = "Run `claude update` in Terminal, then try again.";

function stderrOf(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  return typeof stderr === "string" ? stderr : Buffer.isBuffer(stderr) ? stderr.toString("utf8") : "";
}

function run(execute: ExecCli, cli: string, args: string[], options: ExecFileOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    execute(cli, args, options, (error, stdout, stderr) => {
      if (error) {
        if ((error as { stderr?: unknown }).stderr === undefined && stderr) Object.assign(error, { stderr });
        reject(error);
      } else resolve(stdout);
    });
  });
}

function updateFailure(error: unknown, cli: string): Error {
  const err = error instanceof Error ? error : new Error(String(error));
  const processError = err as NodeJS.ErrnoException & { killed?: boolean };
  if (processError.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return new Error(`Claude update printed too much output. ${FALLBACK}`);
  if (typeof processError.code === "string") return new Error(`${describeSpawnFailure(processError, cli).message}. ${FALLBACK}`);
  if (processError.killed) return new Error(`Claude update did not finish within 3 minutes. ${FALLBACK}`);
  const detail = (stderrOf(err).trim() || err.message).split("\n")[0].slice(0, 400);
  return new Error(`Claude update failed${detail ? `: ${detail}` : ""}. ${FALLBACK}`);
}

/** Run Claude Code's own updater, then read which version is now installed.
 * The caller owns the environment, so credentials are stripped before the
 * executable (a configured wrapper included) starts. */
export async function updateClaudeCli(cli: string, env: NodeJS.ProcessEnv, execute: ExecCli = execCli): Promise<{ version: string }> {
  try {
    await run(execute, cli, ["update"], { env, timeout: 180_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
  } catch (error) {
    throw updateFailure(error, cli);
  }
  try {
    const stdout = await run(execute, cli, ["--version"], { env, timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 });
    const version = stdout.trim().split("\n")[0];
    if (!version) throw new Error("Claude returned an empty version");
    return { version };
  } catch {
    throw new Error("Claude finished updating, but Murage could not read the installed version. Open Settings, Engines to check it.");
  }
}
