// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The opaque Sentinel installation id (1.0.9, GAP-SENTINEL-109 sections 3.1, 7 and 10.1).
//
// One derivation, shared by the server (owner reads, delivery, health producers), the Electron host (descriptor,
// registration) and the Cloud unit generator, so every side names the same installation without a handshake. The id is
// a domain-separated SHA-256 over the canonical (realpath) data directory, cut to 32 lowercase hex characters: it
// matches HEALTH_TOKEN_PATTERN, carries no readable path, stays the same across restarts, updates and a restore into
// the same folder, and changes when the installation moves (a moved installation starts a new namespace and never
// inherits old cursors, page receipts or "Recovered" states).
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

export const SENTINEL_INSTALLATION_DOMAIN = "murage-sentinel-installation-v1";

function assertAbsoluteDir(dir) {
  if (typeof dir !== "string" || dir.length === 0 || dir.length > 1024 || dir.includes("\0")) throw new Error("SENTINEL_DATA_DIR_INVALID");
  if (!dir.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(dir) && !dir.startsWith("\\\\")) throw new Error("SENTINEL_DATA_DIR_INVALID");
}

/** The installation id for an already canonical, absolute data directory path (pure). Throws on anything else. */
export function sentinelInstallationIdOf(canonicalDataDir) {
  assertAbsoluteDir(canonicalDataDir);
  return createHash("sha256").update(`${SENTINEL_INSTALLATION_DOMAIN}\n${canonicalDataDir}`).digest("hex").slice(0, 32);
}

/**
 * The installation id for a data directory. An existing directory is resolved through realpath first; a path that does
 * not exist on this host yet (for example a Cloud unit generated ahead of provisioning) is used as given when absolute.
 * Returns null only for an invalid (empty, relative or malformed) path.
 */
export function sentinelInstallationId(dataDir) {
  let canonical = dataDir;
  try { canonical = realpathSync.native(dataDir); } catch { /* not present yet: use the absolute path as given */ }
  try { return sentinelInstallationIdOf(canonical); } catch { return null; }
}
