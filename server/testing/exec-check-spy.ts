// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A spy over node:child_process.execFile and spawn (execCli runs the check on spawn, to start a new session) that counts Rule 74d's consistency checks (the pinned form running
// the fixed /usr/bin/env or /bin/env helper, or the PowerShell probe) and can hold their answers, so a test sees how many checks ran and can change the
// environment generation while one is awaiting. Install it in a test file with:
//   vi.mock("node:child_process", async (original) => (await import("<path>/exec-check-spy.ts")).withExecCheckSpy(await original()));
// Every other execFile or spawn call passes through untouched.
import { promisify } from "node:util";

// Match engine-env.ts's pinned helper script at the existing child-process seam.
// The real absolute shell/helper still runs; no handed-PATH shadow is needed.
const CHECK_SCRIPT = "if [ -f /usr/bin/env ]; then /usr/bin/env -0; elif [ -f /bin/env ]; then /bin/env -0; else exit 1; fi && printf '\\0' && pwd";

export const execChecks: {
  /** checks started since the last reset */
  runs: number;
  /** cwd of each started check */
  cwds: string[];
  /** called as each check starts, with its 1-based count */
  onRun: ((n: number) => void) | null;
  /** while set, a check's answer waits for this promise */
  hold: Promise<void> | null;
} = { runs: 0, cwds: [], onRun: null, hold: null };

export function resetExecChecks(): void {
  execChecks.runs = 0;
  execChecks.cwds = [];
  execChecks.onRun = null;
  execChecks.hold = null;
}

/** A gate a test opens by hand. */
export function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

function isCheck(args: unknown[]): boolean {
  const argv = args[1];
  const last = Array.isArray(argv) ? argv[argv.length - 1] : undefined;
  return typeof last === "string" && (last === CHECK_SCRIPT || last.startsWith("$ErrorActionPreference='Stop'; $pairs="));
}

export function withExecCheckSpy<T extends Record<string, unknown>>(real: T): T {
  const original = real.execFile as (...args: unknown[]) => unknown;
  function execFile(this: unknown, ...args: unknown[]): unknown {
    if (isCheck(args)) {
      execChecks.runs += 1;
      const options = args[2] as { cwd?: unknown } | undefined;
      execChecks.cwds.push(typeof options?.cwd === "string" ? options.cwd : "");
      execChecks.onRun?.(execChecks.runs);
      const hold = execChecks.hold;
      const callback = args[args.length - 1];
      if (hold && typeof callback === "function") {
        args[args.length - 1] = (...result: unknown[]) => { void hold.then(() => (callback as (...r: unknown[]) => void)(...result)); };
      }
    }
    return original.apply(this, args);
  }
  const custom = (original as unknown as Record<symbol, unknown>)[promisify.custom];
  if (custom) Object.defineProperty(execFile, promisify.custom, { value: custom });
  const originalSpawn = real.spawn as (...args: unknown[]) => { emit: (event: string, ...rest: unknown[]) => boolean };
  function spawn(this: unknown, ...args: unknown[]): unknown {
    const child = originalSpawn.apply(this, args);
    if (isCheck(args)) {
      execChecks.runs += 1;
      const options = args[2] as { cwd?: unknown } | undefined;
      execChecks.cwds.push(typeof options?.cwd === "string" ? options.cwd : "");
      execChecks.onRun?.(execChecks.runs);
      const hold = execChecks.hold;
      if (hold) {
        // the check's answer is its close: hold that event until the gate opens
        const emit = child.emit.bind(child);
        child.emit = (event: string, ...rest: unknown[]) => {
          if (event !== "close") return emit(event, ...rest);
          void hold.then(() => emit(event, ...rest));
          return true;
        };
      }
    }
    return child;
  }
  const base = (real.default && typeof real.default === "object" ? real.default : real) as Record<string, unknown>;
  return { ...real, execFile, spawn, default: { ...base, execFile, spawn } };
}
