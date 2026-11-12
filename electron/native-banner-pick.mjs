// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Select an already configured adapter without probing it or opening an OS connection. */
export function pickNativeBanner({ platform, mac, linux, windows }) {
  if (platform === "darwin") return mac ?? null;
  if (platform === "linux") return linux ?? null;
  if (platform === "win32") return windows ?? null;
  return null;
}
