// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Off and Browser both leave the computer unmounted. Auto is not Off. */
export function browserIsThePlace(
  computer: "cloud" | "vm" | "local" | "browser" | "off" | undefined,
  browserMounted: boolean,
): boolean {
  return (computer === "off" || computer === "browser") && browserMounted;
}
