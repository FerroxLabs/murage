// A computer your bots can use, running on this machine in a container.
//
// The cloud box needs a paid plan, and the "This Mac" path points an agent
// at the desktop the human is using. A container sits between them: free,
// disposable, and isolated from the user's files — and it runs the same
// X11 desktop our computer tools already speak (xdotool + scrot), so the
// tool layer doesn't change, only where the commands run.
//
// This module is deliberately read-only. It reports what is installed and
// never installs anything on someone's machine.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { augmentedPath } from "./env-path.ts";

const run = promisify(execFile);

/** The desktop image. Anthropic's computer-use demo image is the one whose
 * toolchain matches our shell exactly — it ships xdotool, scrot and
 * imagemagick — and it is MIT, with an arm64 build as well as x86. */
export const IMAGE = "ghcr.io/anthropics/anthropic-quickstarts:computer-use-demo-latest";
export const CONTAINER = "openmausbot-computer";

/** Runtimes we can drive, best-known first. Docker is listed because most
 * people already have it, NOT because we recommend installing it: its
 * licence requires payment above 250 employees or $10M revenue, and for
 * every government user. We adapt to whatever is already there. */
const RUNTIMES = ["docker", "podman", "container"] as const;
export type Runtime = (typeof RUNTIMES)[number];

async function sh(cmd: string, args: string[], timeout = 8000) {
  return run(cmd, args, { timeout, env: { ...process.env, PATH: augmentedPath() } });
}

async function installed(cmd: string): Promise<boolean> {
  try {
    await sh(process.platform === "win32" ? "where.exe" : "/usr/bin/which", [cmd], 4000);
    return true;
  } catch {
    return false;
  }
}

export interface ContainerComputerStatus {
  /** the runtime we will use, or null when none is installed */
  runtime: Runtime | null;
  /** everything we found, so the UI can say which one it picked */
  available: Runtime[];
  /** installed is not the same as running */
  daemonUp: boolean;
  image: boolean;
  container: "running" | "stopped" | "missing";
  image_ref: string;
  container_name: string;
}

export async function containerComputerStatus(): Promise<ContainerComputerStatus> {
  const available: Runtime[] = [];
  for (const r of RUNTIMES) if (await installed(r)) available.push(r);
  const runtime = available[0] ?? null;
  const status: ContainerComputerStatus = {
    runtime,
    available,
    daemonUp: false,
    image: false,
    container: "missing",
    image_ref: IMAGE,
    container_name: CONTAINER,
  };
  if (!runtime) return status;

  // Docker Desktop can be installed with its VM stopped, which fails every
  // later command in a way that reads as "broken" rather than "not started"
  try {
    await sh(runtime, ["info", "--format", "{{.ServerVersion}}"], 10_000);
    status.daemonUp = true;
  } catch {
    return status;
  }

  try {
    await sh(runtime, ["image", "inspect", IMAGE]);
    status.image = true;
  } catch {
    /* not pulled yet */
  }

  try {
    const { stdout } = await sh(runtime, ["inspect", "-f", "{{.State.Running}}", CONTAINER]);
    status.container = stdout.trim() === "true" ? "running" : "stopped";
  } catch {
    /* no such container */
  }
  return status;
}

/** The commands the user is shown, built from the same constants the check
 * above uses — so the instructions can't drift from what we look for. */
export function setupCommands(runtime: Runtime | null) {
  const rt = runtime ?? "docker";
  return {
    pull: `${rt} pull ${IMAGE}`,
    // 6080 is the desktop in a browser, 5900 for a native VNC viewer
    run: `${rt} run -d --name ${CONTAINER} -p 6080:6080 -p 5900:5900 ${IMAGE}`,
    start: `${rt} start ${CONTAINER}`,
    stop: `${rt} stop ${CONTAINER}`,
    remove: `${rt} rm -f ${CONTAINER}`,
    view: "http://localhost:6080/vnc.html",
  };
}
