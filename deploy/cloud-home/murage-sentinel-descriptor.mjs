#!/usr/local/bin/node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Writes the Cloud home's Sentinel descriptor (1.0.9, GAP-SENTINEL-109 sections 3.1 and 10.3). Run by
// murage-sentinel.service as ExecStartPre, inside the same sandbox as the scanner, as the same non-root account.
//
// The scanner's view of the home is the projection murage-sentinel.service sets up: the installation root is its own
// runtime folder /run/murage-sentinel/home, whose only child is the read-only bind of /data/home/health. The id is the
// one every producer of /data/home uses (shared/sentinel-installation.mjs over "/data/home"); the output root is the
// unit's persistent StateDirectory. The file is replaced only when its bytes change, owner-only, atomically.
// Standalone on purpose: it imports nothing from the repository, so it runs from /usr/local/libexec.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";

export const CLOUD_DATA_DIR = "/data/home";
export const CLOUD_INSTALLATION_ROOT = "/run/murage-sentinel/home";
/** MURAGE_SENTINEL_STATE_DIR as murage-sentinel.service and the home server set it (paths.ts defaultOutputRoot rule). */
export const CLOUD_STATE_DIR = "/var/lib/murage-sentinel";
export const cloudStateRoot = (env = process.env) => {
  const explicit = env.MURAGE_SENTINEL_STATE_DIR;
  const base = explicit && isAbsolute(explicit) && normalize(explicit) === explicit && !explicit.endsWith("/") ? explicit : CLOUD_STATE_DIR;
  return join(base, "MurageSentinel");
};
export const CLOUD_NODE = "/usr/local/bin/node";
export const CLOUD_ENTRY = "/opt/murage/dist-server/sentinel/cli.js";
/** Bump when the projection or executable changes shape (the scanner compares it with its registration). */
export const CLOUD_SCHEDULE_REVISION = 1;
// The same derivation as shared/sentinel-installation.mjs sentinelInstallationIdOf (domain line, then the path), copied
// because this file stays standalone; sentinel-units.test.ts proves they agree.
const DOMAIN = "murage-sentinel-installation-v1";
const SOURCES = Object.freeze({
  serverCurrent: "server.current.ndjson", serverPrevious: "server.previous.ndjson",
  desktopCurrent: "desktop.current.ndjson", desktopPrevious: "desktop.previous.ndjson",
  dbStatsManifest: "db-stats-current.json", backupStatus: "backup-status.json",
});

export const cloudInstallationId = (dataDir = CLOUD_DATA_DIR) => createHash("sha256").update(`${DOMAIN}\n${dataDir}`).digest("hex").slice(0, 32);

/** The descriptor object (shape: server/sentinel/paths.ts SentinelDescriptor). `sources` must list HEALTH_FILES in order. */
export function cloudDescriptor({ entryBytes, sources = SOURCES, env = process.env } = {}) {
  const installationId = cloudInstallationId();
  const inputRoot = join(CLOUD_INSTALLATION_ROOT, "health");
  return {
    version: 1, installationId, installationRoot: CLOUD_INSTALLATION_ROOT, inputRoot, outputRoot: join(cloudStateRoot(env), installationId),
    sources: Object.fromEntries(Object.entries(sources).map(([role, name]) => [role, join(inputRoot, name)])),
    executable: { path: CLOUD_NODE, entry: CLOUD_ENTRY, sha256: entryBytes ? createHash("sha256").update(entryBytes).digest("hex") : null },
    scheduleRevision: CLOUD_SCHEDULE_REVISION,
  };
}

/** Writes <outputRoot>/descriptor.json when it differs. Answers "written" or "unchanged". */
export function writeCloudDescriptor({ entry = CLOUD_ENTRY, read = readFileSync } = {}) {
  const descriptor = cloudDescriptor({ entryBytes: read(entry) });
  const text = `${JSON.stringify(descriptor)}\n`;
  const target = join(descriptor.outputRoot, "descriptor.json");
  let current = null;
  try { current = read(target, "utf8"); } catch { current = null; }
  if (current === text) return "unchanged";
  const temp = join(descriptor.outputRoot, `.tmp-${randomBytes(8).toString("hex")}.json`);
  writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
  chmodSync(temp, 0o600);
  renameSync(temp, target);
  return "written";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { writeCloudDescriptor(); } catch { process.stderr.write("Sentinel descriptor not written\n"); process.exitCode = 1; }
}
