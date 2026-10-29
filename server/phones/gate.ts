// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { IncomingHttpHeaders } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { initializePhones } from "./registry.ts";
import { askTombstonePathFor, readAskTombstone, reportUnreadableTombstone, tombstonePathFor } from "./revocation-tombstone.ts";

/** The device id shape the companion door stamps (companion/src/push-revocations.ts DEVICE_ID). */
const DEVICE_ID = /^[A-Za-z0-9_-]{1,128}$/;

const single = (value: string | string[] | undefined): string | undefined => typeof value === "string" ? value : undefined;

/**
 * The phone's native runner, proved by the door's phone envelope (companion/src/phone-door.ts phoneForwardHeaders):
 * the door token (doorAuthorized), scope exactly "jobs", and a device id of the door's shape. Anything else, the desktop
 * secret, an owner-phone session, a bare door token, a scope without a device, is null.
 */
export function phoneCaller(headers: IncomingHttpHeaders, doorAuthorized: (h: IncomingHttpHeaders) => boolean): { deviceId: string } | null {
  if (!doorAuthorized(headers)) return null;
  if (single(headers["x-murage-phone-scope"]) !== "jobs") return null;
  const deviceId = single(headers["x-murage-phone-device"]);
  if (deviceId === undefined || !DEVICE_ID.test(deviceId)) return null;
  return { deviceId };
}

/** The generation the door stamps on an ask forward: a non-negative integer within Number.MAX_SAFE_INTEGER, written as plain digits. */
const GENERATION = /^(0|[1-9][0-9]{0,15})$/;

/**
 * The phone's share-and-ask caller, proved by the door's ask envelope (companion/src/phone-door.ts): the door token, scope exactly
 * "ask", a device id of the door's shape and the ask credential generation. Anything else (a jobs-scope envelope, a missing or
 * malformed generation) is null. Whether that generation is still honoured is phoneTarget's clause (1).
 */
export function phoneAskCaller(headers: IncomingHttpHeaders, doorAuthorized: (h: IncomingHttpHeaders) => boolean): { deviceId: string; generation: number } | null {
  if (!doorAuthorized(headers)) return null;
  if (single(headers["x-murage-phone-scope"]) !== "ask") return null;
  const deviceId = single(headers["x-murage-phone-device"]);
  if (deviceId === undefined || !DEVICE_ID.test(deviceId)) return null;
  const raw = single(headers["x-murage-phone-ask-gen"]);
  if (raw === undefined || !GENERATION.test(raw)) return null;
  const generation = Number(raw);
  if (!Number.isSafeInteger(generation)) return null;
  return { deviceId, generation };
}

/** Creates the phone tables on messages.db, only with the phoneTools flag exactly true. Flag off: the database is not touched. */
export function ensurePhonesTables(db: () => DatabaseSync, features: Record<string, unknown> | undefined): boolean {
  if (features?.phoneTools !== true) return false;
  // An unreadable revocation tombstone (either file): phones stay off (fail closed) and the file is kept exactly as it is, because after a downgrade it
  // is the only copy of the revocations.
  try { initializePhones(db()); } catch (error) {
    const path = tombstonePathFor(db());
    if (path === null) throw error;
    reportUnreadableTombstone(path, error, "phones taken off this computer");
    return false;
  }
  const askPath = askTombstonePathFor(db());
  if (askPath !== null) {
    try { readAskTombstone(askPath); } catch (error) {
      reportUnreadableTombstone(askPath, error, "phones whose share and ask access was turned off");
      return false;
    }
  }
  return true;
}
