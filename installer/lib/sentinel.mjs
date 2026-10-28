/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * Health checks (Sentinel, 1.0.9) on a self-hosted box. GAP-SENTINEL-109 section 10.1, headless/self-host row: the
 * installation supervisor starts the independent watch supervisor. Here that supervisor is `murage start`, which already
 * owns the harness and the companion sidecar, so it starts one more child, detached so it outlives a crash of the
 * harness (only an explicit stop ends it):
 *
 *   <pinned node> <payload>/sentinel/cli.js <outputRoot>/descriptor.json --watch
 *
 * Before that it writes this installation's descriptor through the payload's own bundled boundary
 * (<payload>/health/host-boundary.js, the same validation the desktop host and the scanner use): the opaque installation
 * id of the canonical data directory, the scanner's input root `<DATA_DIR>/health`, the owner-only output root
 * (`$XDG_STATE_HOME/MurageSentinel/<id>`, outside the data), and the executable identity (this node, the entry and its
 * sha256). Every start writes the next revision: a watcher left running by an earlier start sees the revision move on
 * and retires by itself (server/sentinel/supervisor.ts), so one watcher stays however often the harness restarts. The
 * scanner child gets a short environment allowlist and scrubs its own environment again.
 *
 * Health is coverage only: a payload without the scanner, a data directory that is not there yet, or a refused output
 * root is one warning line, and the harness starts as usual. The scanner exiting never takes the harness down, and the
 * harness exiting never takes the scanner down. Nothing
 * is registered with the OS here, so quitting or removing the deployment leaves nothing behind to unregister; the output
 * root (issue history) is kept until the operator removes it.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** The only variables the scanner child receives (it scrubs to its own allowlist again). */
export const SENTINEL_ENV_KEYS = Object.freeze(["HOME", "XDG_STATE_HOME", "TMPDIR", "LANG", "TZ"]);

/**
 * The scanner entry and producer boundary bundled next to the server entry, or null when this payload has none (an
 * older payload, or a TypeScript entry run from a checkout).
 * @param {string} serverEntry
 * @returns {{ entry: string, boundary: string } | null}
 */
export function sentinelPayload(serverEntry, exists = existsSync) {
  if (typeof serverEntry !== "string" || !serverEntry.endsWith(".js")) return null;
  const root = dirname(serverEntry);
  const entry = join(root, "sentinel", "cli.js");
  const boundary = join(root, "health", "host-boundary.js");
  return exists(entry) && exists(boundary) ? { entry, boundary } : null;
}

/**
 * Writes (or keeps) this installation's descriptor. Never throws.
 * @returns {Promise<{ ok: true, descriptorPath: string, installationId: string, outputRoot: string, revision: number, written: boolean } | { ok: false, reason: string }>}
 */
export async function prepareSentinel({ payload, dataDir, env = process.env, home, platform = process.platform, execPath = process.execPath, loadBoundary, readBytes = readFileSync }) {
  try {
    let b;
    try { b = loadBoundary ? await loadBoundary(payload.boundary) : await import(pathToFileURL(payload.boundary).href); } catch { return { ok: false, reason: "boundary" }; }
    let installationRoot;
    try { installationRoot = realpathSync.native(dataDir); } catch { return { ok: false, reason: "data-dir" }; }
    const installationId = b.sentinelInstallationId(installationRoot);
    if (!installationId) return { ok: false, reason: "data-dir" };
    const outputRoot = b.defaultOutputRoot(installationId, { platform, env, ...(home ? { home } : {}) });
    if (!outputRoot) return { ok: false, reason: "output-root" };
    // A fresh service account may have no XDG state folder yet; the XDG spec says to create it 0700.
    if (platform === "linux") { try { mkdirSync(dirname(dirname(outputRoot)), { recursive: true, mode: 0o700 }); } catch { /* ensureOutputRoot reports it */ } }
    const root = b.ensureOutputRoot(outputRoot, { platform });
    if (!root.ok) return { ok: false, reason: `output-root-${root.reason}` };
    let sha256;
    try { sha256 = createHash("sha256").update(readBytes(payload.entry)).digest("hex"); } catch { return { ok: false, reason: "entry" }; }
    const descriptorPath = join(outputRoot, b.DESCRIPTOR_FILE);
    const inputRoot = join(installationRoot, b.HEALTH_DIR);
    const executable = { path: execPath, entry: payload.entry, sha256 };
    const loaded = b.loadDescriptor(descriptorPath, { platform });
    const current = loaded.ok && loaded.value.installationId === installationId && loaded.value.installationRoot === installationRoot ? loaded.value : null;
    const next = {
      version: b.DESCRIPTOR_VERSION, installationId, installationRoot, inputRoot, outputRoot,
      sources: b.sourcePaths(inputRoot, platform), executable, scheduleRevision: (current?.scheduleRevision ?? 0) + 1,
    };
    const valid = b.validateDescriptor(next, platform);
    if (!valid.ok) return { ok: false, reason: `descriptor-${valid.reason}` };
    const written = b.writeDescriptor(next, { platform });
    if (!written.ok) return { ok: false, reason: `descriptor-write-${written.reason}` };
    return { ok: true, descriptorPath, installationId, outputRoot, revision: next.scheduleRevision, written: true };
  } catch {
    return { ok: false, reason: "internal" };
  }
}

/**
 * The watch supervisor's command line and environment (absolute paths only, no shell).
 * @returns {{ command: string, args: string[], env: Record<string, string> }}
 */
export function sentinelWatchSpec({ execPath = process.execPath, entry, descriptorPath, env = process.env }) {
  /** @type {Record<string, string>} */
  const childEnv = {};
  for (const key of SENTINEL_ENV_KEYS) if (typeof env[key] === "string" && env[key].length <= 4096 && !env[key].includes("\0")) childEnv[key] = env[key];
  return { command: execPath, args: [entry, descriptorPath, "--watch"], env: childEnv };
}
