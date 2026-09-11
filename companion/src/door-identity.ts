/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 *
 * The browser door's answer to "are you this deployment's door?".
 *
 * On a headless box, `murage start` records a random nonce in its data
 * directory and hands the same value to this process as `MURAGE_DOOR_NONCE`.
 * `murage setup` and `murage status` then send a random challenge on any
 * request to the door, and only a door holding that nonce can answer it with
 * the right HMAC. Before this, anything that answered HTTP on the door port —
 * an unrelated server, a crashed one, a stale sidecar from an older install —
 * was taken for the door and put behind `tailscale serve`.
 *
 * The nonce is taken out of the environment at startup, like the companion
 * token, so no child process (the Tailscale CLI probes included) inherits it.
 * It never goes on the wire: the answer is a proof over the challenge, so the
 * tailnet proxy in front of the door cannot leak it. With no nonce — a desktop
 * sidecar never has one — nothing here does anything.
 *
 * The installer's half is `installer/lib/door-identity.mjs`, and
 * `companion/test/door-identity.test.ts` checks the two against each other.
 */
import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const DOOR_CHALLENGE_HEADER = "x-murage-door-challenge";
export const DOOR_PROOF_HEADER = "x-murage-door-proof";
export const DOOR_VERSION_HEADER = "x-murage-door-version";

const HEX64 = /^[a-f0-9]{64}$/;
const VERSION = /^[\x21-\x7e]{1,64}$/;

export interface DoorIdentity {
  readonly nonce: string;
  readonly version: string;
}

/** The door's answer to a challenge. Identical in the installer. */
export function doorProof(nonce: string, challenge: string, version: string): string {
  return createHmac("sha256", Buffer.from(nonce, "hex")).update(`murage-door-identity/1\n${challenge}\n${version}`).digest("hex");
}

/** Read the identity the installer handed over, and remove it from `env`
 * whether or not it was usable. */
export function takeDoorIdentity(env: NodeJS.ProcessEnv): DoorIdentity | null {
  const nonce = (env.MURAGE_DOOR_NONCE ?? "").trim();
  const version = (env.MURAGE_DOOR_VERSION ?? "").trim();
  delete env.MURAGE_DOOR_NONCE;
  delete env.MURAGE_DOOR_VERSION;
  if (!HEX64.test(nonce)) return null;
  return { nonce, version: VERSION.test(version) ? version : "unknown" };
}

/** Add the identity headers to this response when the request carries one
 * well-formed challenge. Called before the door's own routing, so a page, a
 * sign-in 401 and a 404 all carry it; the headers merge with whatever the
 * handler later passes to `writeHead`. */
export function answerDoorChallenge(req: IncomingMessage, res: ServerResponse, identity: DoorIdentity | null): void {
  if (!identity) return;
  const challenge = req.headers[DOOR_CHALLENGE_HEADER];
  if (typeof challenge !== "string" || !HEX64.test(challenge)) return;
  res.setHeader(DOOR_VERSION_HEADER, identity.version);
  res.setHeader(DOOR_PROOF_HEADER, doorProof(identity.nonce, challenge, identity.version));
}
