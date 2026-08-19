// The one transparent stdio bridge behind both MCP entry points
// (container-mcp.ts for the Local VM, vps-container-mcp.ts for the BYO VPS).
// It defines no tools and parses no MCP messages: bytes in, bytes out.
//
// Two behaviors live here so neither entry point can drift:
//   1. Exit without truncation. `process.exit()` in a close/error handler
//      discards whatever is still buffered on stdout — a final MCP result
//      would be cut mid-frame. The bridge sets exitCode and unpipes instead,
//      letting stdio drain before the process ends on its own.
//   2. A dead-transport watchdog (opt-in via `liveness`). docker's ssh
//      connection helper accepts no ConnectTimeout/ServerAlive options, so a
//      VPS dropping mid-turn leaves the exec silently wedged until the OS
//      gives up — the harness sees a hung tool call, not an error.
import { spawn } from "node:child_process";

import { augmentedPath } from "./env-path.ts";

// 45s of TOTAL silence before the bridge even probes. An MCP session is
// legitimately quiet between tool calls and a slow screenshot can take tens
// of seconds, so silence alone never kills anything — it only triggers a
// liveness probe, and only a probe that FAILS ends the bridge. Any byte on
// stdin/stdout/stderr resets the window.
export const BRIDGE_INACTIVITY_MS = 45_000;
const PROBE_TIMEOUT_MS = 10_000;

export interface BridgeLiveness {
  command: string;
  args: string[];
}

/** Run the liveness command; alive means "exited 0 within the timeout". The
 * probe is its own short-lived process, so it cannot inherit the wedged
 * connection it is diagnosing. */
export function runLivenessProbe(probe: BridgeLiveness, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(probe.command, probe.args, {
      shell: false,
      env: { ...process.env, PATH: augmentedPath() },
      stdio: ["ignore", "ignore", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

export interface WatchdogHandle {
  /** Any traffic in either direction — resets the inactivity window. */
  touch: () => void;
  stop: () => void;
}

/** Inactivity → probe → (only then) declare dead. Traffic arriving while a
 * probe is in flight vetoes even a failed probe: bytes are better evidence
 * of life than a health command racing a congested link. */
export function createInactivityWatchdog(options: {
  inactivityMs: number;
  probe: () => Promise<boolean>;
  onDead: () => void;
}): WatchdogHandle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let probing = false;
  let touchedWhileProbing = false;

  const arm = () => {
    if (stopped) return;
    timer = setTimeout(fire, options.inactivityMs);
    timer.unref?.();
  };
  const settleProbe = (alive: boolean) => {
    probing = false;
    if (stopped) return;
    if (alive || touchedWhileProbing) {
      arm();
      return;
    }
    options.onDead();
  };
  const fire = () => {
    probing = true;
    touchedWhileProbing = false;
    void options.probe().then(settleProbe, () => settleProbe(false));
  };

  arm();
  return {
    touch() {
      if (stopped) return;
      if (probing) {
        touchedWhileProbing = true;
        return;
      }
      if (timer) clearTimeout(timer);
      arm();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export interface BridgeOptions {
  command: string;
  args: string[];
  /** Names the far end in stderr messages, e.g. "Cua Driver". */
  label: string;
  /** Enables the dead-transport watchdog. Omitted for the Local VM, whose
   * runtime CLI talks to a local daemon and fails fast on its own. */
  liveness?: BridgeLiveness;
}

export function runMcpBridge(options: BridgeOptions): void {
  const child = spawn(options.command, options.args, {
    shell: false,
    env: { ...process.env, PATH: augmentedPath() },
    stdio: ["pipe", "pipe", "pipe"],
  });

  // docker may exit before it drains stdin; pipe() leaves this error unhandled.
  child.stdin.on("error", () => {});
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);

  const detach = () => {
    process.stdin.unpipe(child.stdin);
    process.stdin.pause();
  };

  let watchdog: WatchdogHandle | null = null;
  if (options.liveness) {
    const liveness = options.liveness;
    watchdog = createInactivityWatchdog({
      inactivityMs: BRIDGE_INACTIVITY_MS,
      probe: () => runLivenessProbe(liveness),
      onDead: () => {
        process.stderr.write(
          `${options.label} transport went silent and stopped answering liveness probes; ending the bridge\n`,
        );
        process.exitCode = 1;
        detach();
        child.kill("SIGKILL");
        // A docker wedged on a dead ssh connection may never deliver close.
        // Nothing can be buffered on stdout after 45 quiet seconds, so this
        // hard exit — unlike the close-handler one this file exists to avoid —
        // cannot truncate anything.
        const failsafe = setTimeout(() => process.exit(1), 2_000);
        failsafe.unref?.();
      },
    });
    const touch = () => watchdog?.touch();
    process.stdin.on("data", touch);
    child.stdout.on("data", touch);
    child.stderr.on("data", touch);
  }

  child.on("error", (error) => {
    process.stderr.write(`could not connect to ${options.label}: ${error.message}\n`);
    process.exitCode = 1;
    watchdog?.stop();
    detach();
  });
  child.on("close", (code, signal) => {
    if (signal) process.stderr.write(`${options.label} connection ended with ${signal}\n`);
    // Let stdout and stderr drain before the bridge exits.
    process.exitCode = process.exitCode ?? code ?? 1;
    watchdog?.stop();
    detach();
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => child.kill(signal));
  }
}
