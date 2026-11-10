// SPDX-License-Identifier: AGPL-3.0-or-later
// Why the packaged server could not hand out the app page. When neither the requested file nor the SPA fallback
// (index.html) can be read, the server's last answer is {"error":"no route"}. That used to leave nothing in
// server.log. These helpers turn the read error into one plain line (a reason and a path, never file contents) and
// say it once per reason per interval, so a window that keeps reloading cannot fill the log.

import { existsSync } from "node:fs";
import { join } from "node:path";

export type StaticUiReasonKind = "missing" | "permission" | "locked" | "unreadable";

/** The reason a read failed, from the error's code. ENOENT/ENOTDIR: the files are not there (an update may still be copying them). EACCES/EPERM: something refuses the read (antivirus, permissions). EBUSY and friends: another program holds the file. */
export function staticUiReason(error: unknown): { kind: StaticUiReasonKind; code: string } {
  const code = typeof (error as { code?: unknown } | null)?.code === "string" ? String((error as { code: string }).code) : "";
  if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing", code };
  if (code === "EACCES" || code === "EPERM") return { kind: "permission", code };
  if (code === "EBUSY" || code === "ETXTBSY" || code === "EMFILE" || code === "ENFILE" || code === "EAGAIN") return { kind: "locked", code };
  return { kind: "unreadable", code: code || "unknown" };
}

const HINT: Record<StaticUiReasonKind, string> = {
  missing: "the app files are not there yet; an update may still be installing",
  permission: "the read was refused; an antivirus scan or file permissions may be involved",
  locked: "another program holds the file; an update or a scan may be running",
  unreadable: "the read failed",
};

export interface StaticRootState {
  rootExists: boolean;
  indexExists: boolean;
}

export function staticRootState(root: string, fs: { existsSync(p: string): boolean } = { existsSync }): StaticRootState {
  let rootExists = false;
  let indexExists = false;
  try { rootExists = fs.existsSync(root); } catch { /* unknown counts as absent */ }
  try { indexExists = fs.existsSync(join(root, "index.html")); } catch { /* same */ }
  return { rootExists, indexExists };
}

/** The line for a request that found no readable app page. */
export function describeStaticUiFailure(root: string, error: unknown, state: StaticRootState): string {
  const { kind, code } = staticUiReason(error);
  const where = !state.rootExists ? "the ui folder is missing" : state.indexExists ? "index.html exists but could not be read" : "the ui folder exists but index.html is missing";
  return `static ui: cannot serve the app page (${kind} ${code}); ${where}; ${HINT[kind]}; root ${root}`;
}

/** The line written once at boot: is the folder the window will be served from really there. */
export function describeStaticRootAtBoot(root: string, state: StaticRootState): string {
  if (state.rootExists && state.indexExists) return `static ui: serving the app from ${root}`;
  return `static ui: ${!state.rootExists ? "the ui folder is missing" : "index.html is missing from the ui folder"} at boot; ${HINT.missing}; root ${root}`;
}

/** A logger that says each distinct line once per `everyMs`. */
export function createStaticUiLogger(log: (line: string) => void, now: () => number = Date.now, everyMs = 30_000): (line: string) => void {
  const last = new Map<string, number>();
  return (line: string) => {
    const at = now();
    const before = last.get(line);
    if (before !== undefined && at - before < everyMs) return;
    last.set(line, at);
    if (last.size > 50) last.clear();
    log(line);
  };
}

/** Boot check + failure line for the packaged server, bound to one root. */
export function createStaticUiDiagnostics(root: string, log: (line: string) => void = (line) => console.log(line), now: () => number = Date.now, fs: { existsSync(p: string): boolean } = { existsSync }) {
  const say = createStaticUiLogger(log, now);
  return {
    boot: () => { try { log(describeStaticRootAtBoot(root, staticRootState(root, fs))); } catch { /* a diagnostic never stops the server */ } },
    unreadable: (error: unknown) => { try { say(describeStaticUiFailure(root, error, staticRootState(root, fs))); } catch { /* same */ } },
  };
}
