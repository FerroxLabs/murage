import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { firstRunJobsRoute, readOwnerPrefs, writeOwnerPrefs } from "./owner-prefs.ts";

const dirs: string[] = [];
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "owner-prefs-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const owner = { ok: true } as never;
const visitor = { ok: false } as never;

describe("D17 firstRunJobs in owner-prefs", () => {
  it("survives a 1.0.18-shaped write of todayView, and keeps every other key", () => {
    const dir = fresh();
    writeOwnerPrefs(dir, { firstRunJobs: { pending: ["day", "notes"] } });
    writeFileSync(join(dir, "owner-prefs.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, "owner-prefs.json"), "utf8")), futureKey: 7 }));
    writeOwnerPrefs(dir, { todayView: "detailed" });
    const disk = JSON.parse(readFileSync(join(dir, "owner-prefs.json"), "utf8"));
    expect(disk.firstRunJobs).toEqual({ pending: ["day", "notes"] });
    expect(disk.futureKey).toBe(7);
    expect(readOwnerPrefs(dir).firstRunJobs.pending).toEqual(["day", "notes"]);
  });
  it("reads malformed values as an empty queue and drops unknown ids", () => {
    const dir = fresh();
    writeFileSync(join(dir, "owner-prefs.json"), JSON.stringify({ firstRunJobs: { pending: ["day", "bogus", "day", 4] } }));
    expect(readOwnerPrefs(dir).firstRunJobs.pending).toEqual(["day"]);
    writeFileSync(join(dir, "owner-prefs.json"), JSON.stringify({ firstRunJobs: "x" }));
    expect(readOwnerPrefs(dir).firstRunJobs.pending).toEqual([]);
  });
});

describe("D17b /api/owner/first-run-jobs", () => {
  it("refuses non-owner surfaces and invalid ids", () => {
    const dir = fresh();
    expect(firstRunJobsRoute(dir, "GET", visitor).status).toBe(403);
    expect(firstRunJobsRoute(dir, "POST", visitor, { pending: ["day"] }).status).toBe(403);
    expect(firstRunJobsRoute(dir, "POST", owner, { pending: ["nope"] }).status).toBe(400);
    expect(firstRunJobsRoute(dir, "POST", owner, { pending: ["day", "day"] }).status).toBe(400);
    expect(firstRunJobsRoute(dir, "POST", owner, { pending: "day" }).status).toBe(400);
    expect(firstRunJobsRoute(dir, "POST", owner, { pending: ["day", "research"] })).toMatchObject({ status: 200, body: { pending: ["day", "research"] } });
    expect(firstRunJobsRoute(dir, "GET", owner).body).toEqual({ pending: ["day", "research"] });
  });
});
