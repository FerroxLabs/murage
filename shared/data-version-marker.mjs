// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Which Murage last wrote this data folder, at the newest: DATA_DIR/data-version.json, { "v": 1, "newest": "1.0.20" }.
// Producer: the server's database open (server/database.ts), once the memory tables were accepted; it only ever raises the version.
// Consumer: the desktop shell (electron/main.mjs showNewerDataScreen), when a start stopped on data a newer Murage saved: it names the
// version to install. Builds before 1.0.20 neither write nor read it; for data they saved the screen says "the latest version".
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const DATA_VERSION_FILE = "data-version.json";
/** Where every Murage release can be downloaded. */
export const MURAGE_DOWNLOAD_URL = "https://murage.ai/download";
/** The start refusals that mean "a newer Murage saved this data": the shell answers them with the newer-data screen, never the restore page. */
export const NEWER_DATA_CODES = Object.freeze(["MEMORY_SCHEMA_NEWER", "MEMORY_SCHEMA_UNSUPPORTED"]);
export function isNewerDataRefusal(code) { return NEWER_DATA_CODES.includes(code); }

const RELEASE = /^(\d{1,4})\.(\d{1,4})\.(\d{1,6})$/;
/** A release version ("1.0.20"), or null: source runs ("dev"), pre-releases and anything else are never recorded or named. */
export function releaseVersion(value) { return typeof value === "string" && RELEASE.test(value.trim()) ? value.trim() : null; }
/** <0, 0 or >0 as release `a` is older than, the same as or newer than `b`. */
export function compareReleaseVersions(a, b) {
  const x = RELEASE.exec(a).slice(1).map(Number), y = RELEASE.exec(b).slice(1).map(Number);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** The newest version the marker records, or null when there is none or it cannot be read. */
export function readDataVersion(dataDir) {
  try {
    const raw = JSON.parse(readFileSync(path.join(dataDir, DATA_VERSION_FILE), "utf8"));
    return raw && typeof raw === "object" && raw.v === 1 ? releaseVersion(raw.newest) : null;
  } catch { return null; }
}

/** The version the newer-data screen names: the recorded one when it is newer than the running build, else null ("the latest version"). */
export function newerDataVersion(recorded, running) {
  const newest = releaseVersion(recorded), current = releaseVersion(running);
  if (!newest) return null;
  return !current || compareReleaseVersions(newest, current) > 0 ? newest : null;
}

/** Raise the marker to `version` (a release; anything else is ignored). An older build never lowers it. True when the file was written. */
export function noteDataVersion(dataDir, version) {
  const current = releaseVersion(version);
  if (!current) return false;
  const recorded = readDataVersion(dataDir);
  if (recorded && compareReleaseVersions(recorded, current) >= 0) return false;
  const file = path.join(dataDir, DATA_VERSION_FILE), temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify({ v: 1, newest: current })}\n`, { mode: 0o600 });
    renameSync(temp, file);
    return true;
  } catch {
    try { rmSync(temp, { force: true }); } catch { /* nothing left to remove */ }
    return false;
  }
}
