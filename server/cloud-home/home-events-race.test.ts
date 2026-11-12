// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Astra J5b r2: the sweep race (M3), the pinned ten minute minimum, and the real recovery branch that clears the stuck marker.
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOME_EVENT_STALE_TEMP_MS, homeEventTempName, noteRestoreStuck, spoolHomeEvent, sweepStaleHomeEventTemps } from "../home-events.ts";

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "home-events-race-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const temp = () => join(dir, ".restore.stuck-7.json.tmp");
const oldTemp = (ageS = 700) => { writeFileSync(temp(), ""); const t = Date.now() / 1000 - ageS; utimesSync(temp(), t, t); };

describe("the stale temp sweep", () => {
  it("pins the minimum age at ten minutes by literal", () => {
    expect(HOME_EVENT_STALE_TEMP_MS).toBe(600_000);
    writeFileSync(temp(), "");
    const base = statSync(temp()).mtimeMs;
    expect(sweepStaleHomeEventTemps(dir, base + 599_000)).toBe(0);
    expect(existsSync(temp())).toBe(true);
    expect(sweepStaleHomeEventTemps(dir, base + 601_000)).toBe(1);
    expect(existsSync(temp())).toBe(false);
  });
  it("removes an old untouched temp", () => { oldTemp(); expect(sweepStaleHomeEventTemps(dir)).toBe(1); });
  it("does not remove a temp reopened at the same name after the first look", () => {
    oldTemp();
    expect(sweepStaleHomeEventTemps(dir, Date.now(), path => { unlinkSync(path); writeFileSync(path, "fresh"); })).toBe(0);
    expect(readFileSync(temp(), "utf8")).toBe("fresh");
  });
  it("does not remove a replacement with another identity even when it looks old", () => {
    oldTemp();
    expect(sweepStaleHomeEventTemps(dir, Date.now(), path => {
      const other = join(dir, "other"); writeFileSync(other, "other"); const t = Date.now() / 1000 - 700; utimesSync(other, t, t); renameSync(other, path);
    })).toBe(0);
    expect(readFileSync(temp(), "utf8")).toBe("other");
  });
  it("does not remove the same file written afresh after the first look", () => {
    oldTemp();
    expect(sweepStaleHomeEventTemps(dir, Date.now(), path => writeFileSync(path, "again"))).toBe(0);
    expect(readFileSync(temp(), "utf8")).toBe("again");
  });
  it("never reuses a temp name", () => {
    const names = new Set([homeEventTempName("restore.stuck-7.json"), homeEventTempName("restore.stuck-7.json"), homeEventTempName("restore.stuck-7.json")]);
    expect(names.size).toBe(3);
    for (const name of names) expect(name).toMatch(new RegExp(`^\\.restore\\.stuck-7\\.json\\.${process.pid}-[0-9a-f]{12}\\.tmp$`));
    expect(spoolHomeEvent(dir, "restore.stuck", 7)).toBe("restore.stuck-7.json");
  });
});

describe("boot recovery of a stuck restore", () => {
  it("raises the alert under the first sighting time while stuck, and clears the marker once it is no longer stuck", () => {
    const marker = join(dir, "restore-stuck-at"), spool = join(dir, "spool");
    noteRestoreStuck(spool, marker, true);
    expect(existsSync(marker)).toBe(true);
    noteRestoreStuck(spool, marker, false);
    expect(existsSync(marker)).toBe(false);
  });
  it("is what server/index.ts calls with the verdict of restoreJobs.recover()", () => {
    const source = readFileSync(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
    expect(source).toContain("runRestoreBootRecovery(restoreJobs, () => noteRestoreStuck(HOME_EVENTS_DIR, stuckFile, true))");
  expect(source).toContain("if (!stuck) noteRestoreStuck(HOME_EVENTS_DIR, stuckFile, false);");
    expect(source).not.toMatch(/clearStuckAt\(stuckFile\)/);
  });
});
