// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What's new: which release pages this install has already been shown.
//
// The renderer owns the pages and knows its own version; this file owns the
// memory, per install, in DATA_DIR/whats-new.json (owner-only, written through
// writeFileAtomic). A page is shown once after an update and never again for
// that version, whichever way it was closed. A brand-new install never sees
// one: the person is being walked through setup, and "here is what changed"
// means nothing to someone who has not seen the old version. Its version is
// marked seen instead, and `lastVersion` from then on is the proof that a
// later version is an update.
//
// Desktop only (the route is gated in index.ts): the page is for the person
// at the computer, not a paired phone.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";

const FILE = "whats-new.json";
const SEEN_MAX = 50;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.]{1,16})?$/;

export interface WhatsNewRecord {
  seen: string[];
  /** The last version that asked. Absent until 0.1.59 first runs. */
  lastVersion?: string;
}

export interface WhatsNewAnswer {
  version: string;
  show: boolean;
}

export function validWhatsNewVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 32 && VERSION.test(value);
}

/** The record, or an empty one when there is none or it cannot be read. This
 * is a courtesy screen, not state worth stopping startup over: a damaged file
 * at worst shows a page again, and the next write replaces it. */
export function readWhatsNew(dir: string = DATA_DIR): WhatsNewRecord {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, FILE), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { seen: [] };
    const raw = parsed as Record<string, unknown>;
    const seen = Array.isArray(raw.seen) ? raw.seen.filter(validWhatsNewVersion) : [];
    return validWhatsNewVersion(raw.lastVersion) ? { seen, lastVersion: raw.lastVersion } : { seen };
  } catch {
    return { seen: [] };
  }
}

function write(record: WhatsNewRecord, dir: string): void {
  const seen = [...new Set(record.seen)].slice(-SEEN_MAX);
  writeFileAtomic(join(dir, FILE), JSON.stringify({ ...record, seen }, null, 2) + "\n", { mode: 0o600 });
}

/** Record that this version's page was closed, however it was closed. */
export function markWhatsNewSeen(version: string, dir: string = DATA_DIR): WhatsNewAnswer {
  const record = readWhatsNew(dir);
  if (!record.seen.includes(version)) write({ ...record, seen: [...record.seen, version] }, dir);
  return { version, show: false };
}

/**
 * Should this version's page open now?
 *
 * `isFreshInstall` is asked only when nothing recorded says otherwise: an
 * install with no record may be brand new, or may be updating from a version
 * that predates this file, and only setup state can tell those apart.
 */
export async function checkWhatsNew(
  version: string,
  isFreshInstall: () => boolean | Promise<boolean>,
  dir: string = DATA_DIR,
): Promise<WhatsNewAnswer> {
  const record = readWhatsNew(dir);
  if (record.seen.includes(version)) return { version, show: false };
  if (record.lastVersion === undefined && await isFreshInstall()) {
    write({ seen: [...record.seen, version], lastVersion: version }, dir);
    return { version, show: false };
  }
  if (record.lastVersion !== version) write({ ...record, lastVersion: version }, dir);
  return { version, show: true };
}

type ApiAnswer = { status: number; body: unknown };

export async function handleWhatsNewApi(
  request: {
    method: string;
    path: string;
    /** `?version=` on a GET. */
    version?: string | null;
    readBody: () => Promise<unknown>;
    isFreshInstall: () => boolean | Promise<boolean>;
  },
  dir: string = DATA_DIR,
): Promise<ApiAnswer | null> {
  const { method, path } = request;
  if (path === "/api/whats-new" && method === "GET") {
    if (!validWhatsNewVersion(request.version)) return { status: 400, body: { error: "Send the app version, like ?version=0.1.59." } };
    return { status: 200, body: await checkWhatsNew(request.version, request.isFreshInstall, dir) };
  }
  if (path === "/api/whats-new/seen" && method === "POST") {
    let body: unknown;
    try {
      body = await request.readBody();
    } catch {
      return { status: 400, body: { error: "The request could not be read." } };
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return { status: 400, body: { error: "Send { version }." } };
    const { version, ...rest } = body as Record<string, unknown>;
    if (Object.keys(rest).length) return { status: 400, body: { error: `Unknown field: ${Object.keys(rest)[0]}` } };
    if (!validWhatsNewVersion(version)) return { status: 400, body: { error: "Send the app version, like 0.1.59." } };
    return { status: 200, body: markWhatsNewSeen(version, dir) };
  }
  if (path === "/api/whats-new" || path === "/api/whats-new/seen") return { status: 405, body: { error: "method not allowed" } };
  return null;
}
