// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A wait as the chat says it. Stop and failure lines are read by the owner,
// so they carry "3 minutes", never "180000ms" or "180 s".

/** Seconds below two minutes, whole minutes from there, hours from two hours. */
export function plainDuration(ms: number): string {
  const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? "" : "s"}`;
  if (ms >= 2 * 60 * 60_000) return unit(Math.round(ms / (60 * 60_000)), "hour");
  if (ms >= 2 * 60_000) return unit(Math.round(ms / 60_000), "minute");
  return unit(Math.max(1, Math.round(ms / 1000)), "second");
}
