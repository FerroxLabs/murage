// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Cross-version fix (1.0.19 must not depend on deploy order): murage-control holds restore alerts until the control plane advertises them
// (deploy/cloud-home/murage-control EXTENDED_EVENT_TYPES). While they are held the owner must see it: /api/health opsAlertsWaiting and the restore
// status line; the spool is capped at HOME_EVENT_SPOOL_CAP and a dropped oldest alert is counted in eventSpoolFailures.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { HOME_EVENT_SPOOL_CAP, HOME_EVENT_STALE_TEMP_MS, clearStuckAt, firstStuckAt, heldHomeEvents, homeEventSpoolFailures, resetHomeEventSpoolFailuresForTest, spoolHomeEvent } from "../home-events.ts";
import { RESTORE_ALERT_WAITING_LINE, restoreOwnerRoute } from "../email/restore-owner-routes.ts";
import { RESTORE_ABORTED_LINE, RESTORE_STUCK_LINE } from "../email/restore-job.ts";

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "home-events-held-")); resetHomeEventSpoolFailuresForTest(); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const status = (state: string, held: () => number) => restoreOwnerRoute({ jobs: { state: () => state, bootWaitLine: () => null } as never, heldAlerts: held, closeForSwap: async () => true, restart: () => {} },
  { method: "GET", path: "/api/restore-job/status", body: undefined, surface: "desktop", botCredential: false });

it("a held stuck restore alert shows on the owner's restore status line, in plain words", async () => {
  spoolHomeEvent(dir, "restore.stuck", 1000);
  expect(heldHomeEvents(dir)).toBe(1);
  const answer = await status("unreadable", () => heldHomeEvents(dir));
  expect(answer?.body.line).toBe(`${RESTORE_STUCK_LINE} ${RESTORE_ALERT_WAITING_LINE}`);
  expect(answer?.body.alertWaiting).toBe(true);
  expect(RESTORE_ALERT_WAITING_LINE).not.toMatch(/[-–—]/);
  expect((await status("aborted", () => 2))?.body.line).toBe(`${RESTORE_ABORTED_LINE} ${RESTORE_ALERT_WAITING_LINE}`);
});

it("nothing is added once the spool is empty (the control plane took it), or when no restore is failed", async () => {
  expect((await status("unreadable", () => 0))?.body.line).toBe(RESTORE_STUCK_LINE);
  expect((await status("none", () => 3))?.body.line).toBeNull();
  expect(heldHomeEvents(undefined)).toBe(0);
});

it("the same alert (type and time) is one file; a full spool drops the oldest and counts it", () => {
  spoolHomeEvent(dir, "restore.aborted", 5); spoolHomeEvent(dir, "restore.aborted", 5);
  expect(heldHomeEvents(dir)).toBe(1);
  expect(homeEventSpoolFailures()).toBe(0);
  for (let at = 6; at <= 10; at++) spoolHomeEvent(dir, "restore.stuck", at);
  expect(HOME_EVENT_SPOOL_CAP).toBe(5);
  expect(readdirSync(dir).sort()).toEqual([6, 7, 8, 9, 10].map(at => `restore.stuck-${at}.json`).sort());
  expect(homeEventSpoolFailures()).toBe(1); // restore.aborted-5 was the oldest and was dropped, counted
  spoolHomeEvent(dir, "restore.stuck", 11);
  expect(readdirSync(dir).sort()).toEqual([7, 8, 9, 10, 11].map(at => `restore.stuck-${at}.json`).sort());
  expect(homeEventSpoolFailures()).toBe(2);
});

it("old temp files in the spool are removed on the next write; a young one (a write in progress) stays", () => {
  const old = (Date.now() - HOME_EVENT_STALE_TEMP_MS - 60_000) / 1000;
  for (const name of [".restore.stuck-1.json.tmp", ".restore.aborted-2.json.tmp", ".restore.stuck-3.json.tmp"]) { writeFileSync(join(dir, name), ""); utimesSync(join(dir, name), old, old); }
  writeFileSync(join(dir, ".restore.stuck-4.json.tmp"), "");
  spoolHomeEvent(dir, "restore.stuck", 9);
  expect(readdirSync(dir).sort()).toEqual([".restore.stuck-4.json.tmp", "restore.stuck-9.json"]);
  expect(heldHomeEvents(dir)).toBe(1); // temp files are never counted as held alerts
});

it("one stuck restore is one key across restarts: the time is the first sighting, kept in a file, and index.ts uses it", () => {
  const file = join(dir, "restore-stuck-at");
  for (let restart = 0; restart < 6; restart++) spoolHomeEvent(dir, "restore.stuck", firstStuckAt(file, 5_000 + restart * 60_000));
  expect(readdirSync(dir).filter(name => name.startsWith("restore.stuck-"))).toEqual(["restore.stuck-5000.json"]);
  expect(homeEventSpoolFailures()).toBe(0);
  expect(readFileSync(file, "utf8")).toBe("5000");
  clearStuckAt(file);
  expect(existsSync(file)).toBe(false);
  expect(firstStuckAt(file, 777)).toBe(777); // a new stuck restore after the old one cleared gets its own time
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const helper = readFileSync(new URL("../home-events.ts", import.meta.url), "utf8");
  expect(source).toContain("runRestoreBootRecovery(restoreJobs, () => noteRestoreStuck(HOME_EVENTS_DIR, stuckFile, true))");
  expect(source).toContain("if (!stuck) noteRestoreStuck(HOME_EVENTS_DIR, stuckFile, false);"); // the stamping moved into noteRestoreStuck, same expression
  expect(helper).toContain('reportHomeEvent("restore.stuck", marker.at');
  expect(source).not.toMatch(/"restore\.stuck", Date\.now\(\)/);
  expect(helper).not.toMatch(/"restore\.stuck", Date\.now\(\)/);
});
