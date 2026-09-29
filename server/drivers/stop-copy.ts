// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Stop and failure lines are read by the owner in the chat: a wait reads
// "3 minutes", never "180000ms" or "180 s", and an engine that ended reads
// "closed (exit code 1)", never a protocol step or an internal name.

/** Seconds below two minutes, whole minutes from there, hours from two hours. */
export function plainDuration(ms: number): string {
  const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? "" : "s"}`;
  if (ms >= 2 * 60 * 60_000) return unit(Math.round(ms / (60 * 60_000)), "hour");
  if (ms >= 2 * 60_000) return unit(Math.round(ms / 60_000), "minute");
  return unit(Math.max(1, Math.round(ms / 1000)), "second");
}

/** An engine process that ended before its reply: its exit code and signal
 * as the owner reads them, and the last words it wrote when there are any. */
export function engineClosedLine(engine: string, code: number | null | undefined, signal?: string | null, lastWords?: string): string {
  const how = [code !== null && code !== undefined ? `exit code ${code}` : "", signal ? `signal ${signal}` : ""].filter(Boolean).join(", ");
  return `${engine} closed${how ? ` (${how})` : ""} before it finished its reply${lastWords ? `: ${lastWords}` : ""}`;
}
