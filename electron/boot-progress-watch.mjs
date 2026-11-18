// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.20 startup-all: the shell's side of the start-up note every step before listen writes (server/boot-progress.ts). The boot probe
// (server-boot-probe.mjs `bootProgressFresh`) keeps waiting past its 5-minute budget while this reads true: the note is the child that is
// starting NOW (its pid) and it moved within the last minute. A note of an earlier launch never counts, and a child that stopped moving
// (a dead heartbeat means a dead process) gets no more time. The wait is still bounded by the probe's absolute limit.
import { readFileSync } from "node:fs";
import path from "node:path";

export const BOOT_PROGRESS_FILE = "boot-progress.json";
/** How long the note may sit unchanged and still count as the start moving (the server rewrites it every 2 s). */
export const BOOT_PROGRESS_FRESH_MS = 60_000;

/** The note, validated, or null; with `pid`, only that child's. */
export function readBootProgress(dataDir, { pid } = {}) {
  let raw;
  try { raw = JSON.parse(readFileSync(path.join(dataDir, BOOT_PROGRESS_FILE), "utf8")); } catch { return null; }
  if (!raw || typeof raw !== "object" || raw.v !== 1 || raw.state !== "starting") return null;
  if (pid !== undefined && raw.pid !== pid) return null;
  const num = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
  return { pid: raw.pid, step: typeof raw.step === "string" ? raw.step.slice(0, 48) : undefined, seq: num(raw.seq), updatedAt: num(raw.updatedAt), startedAt: num(raw.startedAt) };
}

/** Looks at the note every `intervalMs` while the child boots. `fresh()` is true while the current child's note keeps moving, measured on
 * THIS clock (a child with a wrong clock still counts); `stop()` ends it. */
export function watchBootProgress({ dataDir, pid, intervalMs = 400, read = readBootProgress, setTimer = setInterval, clearTimer = clearInterval, now = Date.now, freshMs = BOOT_PROGRESS_FRESH_MS }) {
  let seen = "", movedAt = null, current = null;
  const tick = () => {
    const status = read(dataDir, { pid: typeof pid === "function" ? pid() : pid });
    current = status;
    if (!status) return;
    const life = JSON.stringify([status.pid, status.updatedAt, status.seq, status.step]);
    if (life !== seen) { seen = life; movedAt = now(); }
  };
  const timer = setTimer(tick, intervalMs);
  timer?.unref?.();
  return { tick, status: () => current, fresh: () => current !== null && movedAt !== null && now() - movedAt <= freshMs, stop: () => clearTimer(timer) };
}
