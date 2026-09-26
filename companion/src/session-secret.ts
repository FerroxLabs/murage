// The one secret the companion keeps: the key renewal successors are derived
// from.
//
// Derived rather than random is what makes renewal idempotent. A phone that
// asks to renew and loses the response asks again, and must get the SAME
// successor back, or two responses arriving out of order leave it holding a
// value the server has already replaced. Storing the successor in the clear
// would do that too, and would put a live credential in devices.json. So
// devices.json holds the successor's hash, and this file holds the key that
// lets the server compute the plaintext again on demand.
//
// Its own file, not a field in devices.json: a devices.json restored from a
// backup must not carry the key its successors were derived under.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR, ensureDataDir, writeFileAtomic } from "./state.ts";

export const SESSION_SECRET_FILE = join(DATA_DIR, "session-secret");

const HEX64 = /^[a-f0-9]{64}$/;

/** Read the secret, creating it on first use.
 *
 * A MISSING or malformed file gets a fresh secret, written 0600 through the
 * same atomic write devices.json uses. A successor derived under the old key
 * can still be committed (its hash is in devices.json); it just cannot be
 * re-sent, and `renewSession` derives a new one instead.
 *
 * Any other read failure throws, and nothing is written. That file might be
 * perfectly good and merely unreadable for a moment, and overwriting it would
 * turn a transient fault into a permanent one. The caller fails closed. */
export function loadSessionSecret(): Buffer {
  try {
    const text = readFileSync(SESSION_SECRET_FILE, "utf8").trim();
    if (HEX64.test(text)) return Buffer.from(text, "hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  const secret = randomBytes(32);
  ensureDataDir();
  writeFileAtomic(SESSION_SECRET_FILE, `${secret.toString("hex")}\n`);
  return secret;
}
