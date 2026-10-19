// SPDX-License-Identifier: AGPL-3.0-or-later
import { cloudHomeCopy } from "./copy.ts";

/** A home never falls back to desktop authorization after construction fails. */
export function constructCloudAuth<T>(role: string | undefined, build: () => T): T | undefined {
  if (role !== "home") return undefined;
  try {
    const auth = build();
    if (typeof auth !== "function") throw new Error();
    return auth;
  } catch { throw new Error(cloudHomeCopy.bootAuthFailed); }
}
