/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * "Is the thing on the door port this deployment's browser door?"
 *
 * Setup used to accept any HTTP response on `127.0.0.1:<door>` as the door: a
 * 404 from an unrelated dev server, a 500 from a crashed one, a stale sidecar
 * from an older install. It adopted that listener, skipped starting its own,
 * and put `tailscale serve` in front of it.
 *
 * Now every `murage start` records a fresh random nonce, 0600, in the data
 * directory, and hands the same nonce to the sidecar it starts (only to the
 * sidecar; the harness never sees it). A probe sends a random challenge; the
 * door answers with HMAC-SHA256(nonce, challenge and version) and the
 * installer version that started it. The nonce itself never crosses the
 * socket, so the tailnet proxy in front of the door cannot leak it. A listener
 * that does not hold the nonce, holds one from an earlier start, or was
 * started by a different installer version does not match, and a mismatch
 * blocks adopting or fronting it. Nothing here ever stops a listener.
 *
 * The companion's half is `companion/src/door-identity.ts`;
 * `companion/test/door-identity.test.ts` checks the two against each other on
 * a real socket.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFile } from "./private-files.mjs";
import { doorAnswers } from "./tailscale.mjs";

export const DOOR_NONCE_FILE = "door-identity";
export const DOOR_CHALLENGE_HEADER = "x-murage-door-challenge";
export const DOOR_PROOF_HEADER = "x-murage-door-proof";
export const DOOR_VERSION_HEADER = "x-murage-door-version";

const HEX64 = /^[a-f0-9]{64}$/;
const VERSION = /^[\x21-\x7e]{1,64}$/;

/** @returns {string} 32 random bytes, hex */
export function createDoorNonce() {
  return randomBytes(32).toString("hex");
}

/**
 * A version string as it travels in a header: printable ASCII, no spaces.
 * @param {unknown} raw @returns {string}
 */
export function doorVersion(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  return VERSION.test(value) ? value : "unknown";
}

/**
 * The door's answer to a challenge. Identical in `companion/src/door-identity.ts`.
 * @param {string} nonce hex @param {string} challenge hex @param {string} version
 * @returns {string} hex
 */
export function doorProof(nonce, challenge, version) {
  return createHmac("sha256", Buffer.from(nonce, "hex")).update(`murage-door-identity/1\n${challenge}\n${version}`).digest("hex");
}

/**
 * Record this start's nonce in the data directory, 0600, atomically.
 * @param {string} dataDir @param {string} nonce
 * @returns {string} the file's path
 */
export function writeDoorNonce(dataDir, nonce) {
  if (!HEX64.test(nonce)) throw new Error("refusing to record a malformed door nonce");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, DOOR_NONCE_FILE);
  atomicWriteFile(path, `${nonce}\n`, { mode: 0o600 });
  return path;
}

/**
 * Whose nonce file counts. An ordinary account trusts only its own. Root may
 * be checking a deployment that runs as another account, so for root it is
 * the owner of the data directory itself. Null where there are no uids.
 * @param {string} dataDir
 * @param {{ euid?: number | null, lstat?: typeof lstatSync }} [opts]
 * @returns {number | null}
 */
export function deploymentOwner(dataDir, { euid = typeof process.geteuid === "function" ? process.geteuid() : null, lstat = lstatSync } = {}) {
  if (euid === null || euid !== 0) return euid;
  try {
    const st = lstat(dataDir);
    return st.isDirectory() && !st.isSymbolicLink() ? st.uid : 0;
  } catch {
    return 0;
  }
}

/**
 * Read the nonce the last `murage start` recorded. A file that is not a
 * private regular file owned by the deployment's account proves nothing, and
 * is reported rather than used.
 * @param {string} dataDir
 * @param {{ owner?: number | null }} [opts] the uid that must own it; null skips the check
 * @returns {{ nonce: string, error: null } | { nonce: null, error: string }}
 */
export function readDoorNonce(dataDir, { owner = typeof process.geteuid === "function" ? process.geteuid() : null } = {}) {
  const path = join(dataDir, DOOR_NONCE_FILE);
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code === "ENOENT") return { nonce: null, error: `no \`murage start\` has recorded a door identity in ${dataDir}` };
    if (code === "ELOOP") return { nonce: null, error: `${path} is a symlink, so it proves nothing` };
    return { nonce: null, error: `${path} could not be read (${code ?? "error"})` };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { nonce: null, error: `${path} is not a regular file` };
    if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
      return { nonce: null, error: `${path} is readable by other accounts, so it proves nothing` };
    }
    if (owner !== null && st.uid !== owner) return { nonce: null, error: `${path} does not belong to the account this deployment runs as` };
    const nonce = readFileSync(fd, "utf8").trim();
    if (!HEX64.test(nonce)) return { nonce: null, error: `${path} does not hold a door identity` };
    return { nonce, error: null };
  } finally {
    closeSync(fd);
  }
}

/**
 * Ask whatever answers on the door port to prove it is this deployment's door.
 *
 * `identity` is `match` only for a correct proof from the same installer
 * version; `ready` additionally needs a non-5xx answer. `unknown` means
 * nothing answered at all.
 * @param {object} opts
 * @param {number} opts.port
 * @param {string | null} opts.nonce the recorded (or setup's own) nonce
 * @param {string} [opts.nonceError] why there is no nonce, for the report
 * @param {string} opts.version this installer's version
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ answered: boolean, port: number, url: string, status?: number, identity: "match" | "mismatch" | "unknown", ready: boolean, doorVersion: string | null, reason?: string }>}
 */
export async function probeDoor(opts) {
  const challenge = randomBytes(32).toString("hex");
  const { headers, ...answer } = await doorAnswers({
    port: opts.port,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
    headers: { [DOOR_CHALLENGE_HEADER]: challenge },
  });
  if (!answer.answered) return { ...answer, identity: "unknown", ready: false, doorVersion: null };

  const read = (name) => {
    const value = headers && typeof headers.get === "function" ? headers.get(name) : null;
    return typeof value === "string" ? value.trim() : null;
  };
  const proof = read(DOOR_PROOF_HEADER);
  const claimed = read(DOOR_VERSION_HEADER);
  const mismatch = (reason) => ({ ...answer, identity: /** @type {const} */ ("mismatch"), ready: false, doorVersion: null, reason });

  if (!opts.nonce) return mismatch(opts.nonceError ?? "no door identity is recorded for this deployment");
  if (!proof || !claimed || !VERSION.test(claimed) || !HEX64.test(proof)) {
    return mismatch("it did not answer the identity challenge, so it is not a door this installer started");
  }
  const expected = Buffer.from(doorProof(opts.nonce, challenge, claimed), "hex");
  if (!timingSafeEqual(Buffer.from(proof, "hex"), expected)) {
    return mismatch("its identity proof does not match the door `murage start` last started here");
  }
  const want = doorVersion(opts.version);
  if (claimed !== want) {
    return mismatch(`it is a door started by installer ${claimed}, and this installer is ${want}; restart it with this version`);
  }
  const ready = typeof answer.status === "number" && answer.status < 500;
  return {
    ...answer,
    identity: "match",
    ready,
    doorVersion: claimed,
    ...(ready ? {} : { reason: `it answered HTTP ${answer.status}` }),
  };
}
