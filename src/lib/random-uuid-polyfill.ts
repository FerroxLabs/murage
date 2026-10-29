// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
// Imported first by main.tsx, before any module that might create an ID.
//
// Browsers expose crypto.randomUUID only in secure contexts, so the phone page
// served over plain http on a private name (a tailnet host) has no such
// method, and every component that calls it would throw. getRandomValues is
// exposed everywhere, so the same RFC 4122 version 4 ID is built from it.
// Never Math.random: these IDs deduplicate sends and claim leases.

type RandomSource = Pick<Crypto, "getRandomValues">;

export function uuidV4From(source: RandomSource): string {
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Adds randomUUID to `target` only when it is missing. Returns whether it did. */
export function installRandomUUID(target: Crypto | undefined = globalThis.crypto): boolean {
  if (!target || typeof target.randomUUID === "function") return false;
  if (typeof target.getRandomValues !== "function") return false;
  const source: RandomSource = target;
  Object.defineProperty(target, "randomUUID", {
    configurable: true,
    writable: true,
    value: function randomUUID(): `${string}-${string}-${string}-${string}-${string}` {
      return uuidV4From(source) as `${string}-${string}-${string}-${string}-${string}`;
    },
  });
  return true;
}

installRandomUUID();
