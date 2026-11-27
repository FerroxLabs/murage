// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.20 startup-all: the shell's side of the start-up note every step before listen writes (server/boot-progress.ts). The boot probe
// (server-boot-probe.mjs `bootProgressFresh`) keeps waiting past its 5-minute budget while this reads true: the note is the child that is
// starting NOW (its pid), it moved within the last minute AND a real step advanced within the last 5 minutes. A note of an earlier launch
// never counts, and a child that stopped moving (a dead heartbeat means a dead process) gets no more time. The wait is still bounded by
// the probe's absolute limit.
// 1.0.20 bootwait (hunt-fable-1119 FINDINGS-2 #2): the heartbeat is a worker thread that rewrites the note (a new updatedAt) every 2 s
// whatever the server thread is doing, so a rewrite proves the child alive, never that it gets anywhere. Only a change of step name or
// sequence number (server/boot-progress.ts setBootStep) counts as progress; alive but held in one step for 5 minutes ends the wait, and
// the shell shows the recovery window as 1.0.19 did at its 5-minute limit.
import { readFileSync } from "node:fs";
import path from "node:path";

export const BOOT_PROGRESS_FILE = "boot-progress.json";
/** How long the note may sit unchanged and still count as the start moving (the server rewrites it every 2 s). */
export const BOOT_PROGRESS_FRESH_MS = 60_000;
/** How long the child may stay in one step (alive, heartbeat beating) and still count as getting somewhere: the shell's 5-minute budget. */
export const BOOT_STEP_STALL_MS = 5 * 60_000;

/** The note, validated, or null; with `pid`, only that child's. */
export function readBootProgress(dataDir, { pid } = {}) {
  let raw;
  try { raw = JSON.parse(readFileSync(path.join(dataDir, BOOT_PROGRESS_FILE), "utf8")); } catch { return null; }
  if (!raw || typeof raw !== "object" || raw.v !== 1 || raw.state !== "starting") return null;
  if (pid !== undefined && raw.pid !== pid) return null;
  const num = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
  return { pid: raw.pid, step: typeof raw.step === "string" ? raw.step.slice(0, 48) : undefined, seq: num(raw.seq), updatedAt: num(raw.updatedAt), startedAt: num(raw.startedAt) };
}

/** Looks at the note every `intervalMs` while the child boots. `fresh()` is true while the current child's note keeps moving (alive) and
 * its step advanced within `stepStallMs` (getting somewhere), both measured on THIS clock (a child with a wrong clock still counts); the
 * first sight of a child's note counts as its step starting. `stop()` ends it. `onReading(status, { sinceMs })` gets every look (null when
 * there is no note of this child's) and the time since the watch began: the start screen names the step from it (1.0.21 N2 bootprog,
 * boot-step-words.mjs); it never changes what `fresh()` says. */
export function watchBootProgress({ dataDir, pid, intervalMs = 400, read = readBootProgress, setTimer = setInterval, clearTimer = clearInterval, now = Date.now, freshMs = BOOT_PROGRESS_FRESH_MS, stepStallMs = BOOT_STEP_STALL_MS, onReading = () => {} }) {
  let seen = "", movedAt = null, stepSeen = "", steppedAt = null, current = null;
  const startedAt = now();
  const tick = () => {
    const status = read(dataDir, { pid: typeof pid === "function" ? pid() : pid });
    current = status;
    try { onReading(status, { sinceMs: now() - startedAt }); } catch { /* a screen glitch never changes the wait */ }
    if (!status) return;
    const life = JSON.stringify([status.pid, status.updatedAt, status.seq, status.step]);
    if (life !== seen) { seen = life; movedAt = now(); }
    // not updatedAt: the heartbeat moves that every 2 s on its own
    const stepKey = JSON.stringify([status.pid, status.seq, status.step]);
    if (stepKey !== stepSeen) { stepSeen = stepKey; steppedAt = now(); }
  };
  const timer = setTimer(tick, intervalMs);
  timer?.unref?.();
  const alive = () => current !== null && movedAt !== null && now() - movedAt <= freshMs;
  const advancing = () => current !== null && steppedAt !== null && now() - steppedAt < stepStallMs;
  return { tick, status: () => current, fresh: () => alive() && advancing(), stop: () => clearTimer(timer) };
}
