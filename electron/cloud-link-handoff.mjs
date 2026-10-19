// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Windows and Linux cold start by a murage://door link. The OS starts Murage with the link (and its one-time ticket) on the
// command line, where any process of this user can read it for as long as Murage runs. So that first process only carries the
// link across: at ready it seals the link with safeStorage into cloud-homes/door-handoff.bin (0600), lets go of the
// single-instance lock and relaunches itself WITHOUT the link, then exits. The relaunched process reads the stash at ready,
// deletes it, and queues the link like any other. The ticket is on a command line for about a second.
//
// connect-cloud and open-cloud carry no secret and never use this. macOS gets links through open-url, never argv.
// Nothing here logs.
import fs from "node:fs/promises";
import path from "node:path";

import { doorLinkFromDeepLink } from "./cloud-door-link.mjs";

export const HANDOFF_FILE = "door-handoff.bin";
/** A stash older than this is from a crashed handoff, not this launch: deleted unread. */
export const HANDOFF_MAX_AGE_MS = 2 * 60_000;

const isMurageArg = (value) => typeof value === "string" && /^murage:\/\//i.test(value.trim());

/** The arguments to relaunch with: every murage:// argument removed, everything else kept in order. */
export function argvWithoutLink(args) {
  return Array.isArray(args) ? args.filter((value) => !isMurageArg(value)) : [];
}

/** Whether this cold start should hand its door link over (Windows and Linux only; a door link, never the other kinds). */
export function needsDoorHandoff({ platform = process.platform, link }) {
  return (platform === "win32" || platform === "linux") && link?.kind === "door";
}

/** Seal `url` (a murage://door link) into <directory>/door-handoff.bin, owner-only. Throws when it cannot be sealed. */
export async function stashDoorLink({ safeStorage, directory, url, now = Date.now, fsImpl = fs }) {
  if (doorLinkFromDeepLink(url)?.kind !== "door") throw new TypeError("not a door link");
  if (!safeStorage?.isEncryptionAvailable?.()) throw new Error("no sealed storage");
  const target = path.join(directory, HANDOFF_FILE), temporary = `${target}.${process.pid}.tmp`;
  const sealed = safeStorage.encryptString(JSON.stringify({ url, at: now() }));
  await fsImpl.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsImpl.writeFile(temporary, sealed, { mode: 0o600 });
  await fsImpl.rename(temporary, target);
  await fsImpl.chmod(target, 0o600).catch(() => {});
}

/** The stashed door link (and the file deleted), or null. The file is deleted whatever it held. Never throws. */
export async function takeStashedDoorLink({ safeStorage, directory, now = Date.now, fsImpl = fs }) {
  const target = path.join(directory, HANDOFF_FILE);
  let sealed;
  try { sealed = await fsImpl.readFile(target); } catch { return null; }
  await fsImpl.rm(target, { force: true }).catch(() => {});
  try {
    const value = JSON.parse(safeStorage.decryptString(sealed));
    if (!value || typeof value.url !== "string" || !Number.isSafeInteger(value.at)) return null;
    const age = now() - value.at;
    if (age < 0 || age > HANDOFF_MAX_AGE_MS) return null;
    const link = doorLinkFromDeepLink(value.url);
    return link?.kind === "door" ? link : null;
  } catch { return null; }
}

/**
 * The first process's whole job when a door link started it: seal, release the lock, relaunch without the link, exit.
 * Returns true when it handed over (the caller stops starting up), false when it could not (the caller keeps the link in
 * this process instead, so the person still connects).
 */
export async function handOffDoorLink({ app, safeStorage, directory, url, argv = process.argv, relaunch, blocked = () => null }) {
  if (blocked()) return false;
  try { await stashDoorLink({ safeStorage, directory, url }); } catch { return false; }
  try {
    app.releaseSingleInstanceLock?.();
    relaunch(argvWithoutLink(argv.slice(1)));
    app.exit(0);
    return true;
  } catch {
    await fs.rm(path.join(directory, HANDOFF_FILE), { force: true }).catch(() => {});
    return false;
  }
}
