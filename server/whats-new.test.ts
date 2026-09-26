// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What's new: shown once per version after an update, never on a brand-new
// install, remembered in the data dir so a reinstall of the renderer or a
// cleared browser cannot bring it back.
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { checkWhatsNew, handleWhatsNewApi, markWhatsNewSeen, readWhatsNew } from "./whats-new.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "murage-whats-new-"));
});
const fresh = async () => true;
const used = async () => false;
const file = () => join(dir, "whats-new.json");

describe("what's new seen logic", () => {
  it("shows once after an update from a version that never recorded anything", async () => {
    expect(await checkWhatsNew("0.1.59", used, dir)).toEqual({ version: "0.1.59", show: true });
    // shown but not dismissed yet: a reload before any answer shows it again
    expect(await checkWhatsNew("0.1.59", used, dir)).toEqual({ version: "0.1.59", show: true });
    markWhatsNewSeen("0.1.59", dir);
    expect(await checkWhatsNew("0.1.59", used, dir)).toEqual({ version: "0.1.59", show: false });
  });

  it("persists the dismissal in the data dir, owner-only", async () => {
    markWhatsNewSeen("0.1.59", dir);
    expect(JSON.parse(readFileSync(file(), "utf8")).seen).toEqual(["0.1.59"]);
    if (process.platform !== "win32") expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(readWhatsNew(dir).seen).toContain("0.1.59");
  });

  it("skips a brand-new install and marks the version seen", async () => {
    expect(await checkWhatsNew("0.1.59", fresh, dir)).toEqual({ version: "0.1.59", show: false });
    expect(readWhatsNew(dir)).toEqual({ seen: ["0.1.59"], lastVersion: "0.1.59" });
    // a later answer that the install is now in use does not bring it back
    expect(await checkWhatsNew("0.1.59", used, dir)).toEqual({ version: "0.1.59", show: false });
  });

  it("shows the next version's page to an install that started fresh on an earlier one", async () => {
    await checkWhatsNew("0.1.59", fresh, dir);
    let asked = false;
    const answer = await checkWhatsNew("0.1.60", async () => { asked = true; return true; }, dir);
    // a recorded earlier version is proof of an update; setup state is not consulted
    expect(answer).toEqual({ version: "0.1.60", show: true });
    expect(asked).toBe(false);
  });

  it("does not ask about setup once the version is already seen", async () => {
    markWhatsNewSeen("0.1.59", dir);
    let asked = false;
    await checkWhatsNew("0.1.59", async () => { asked = true; return false; }, dir);
    expect(asked).toBe(false);
  });

  it("treats a damaged record as nothing recorded, and repairs it on the next write", async () => {
    writeFileSync(file(), "{not json");
    expect(readWhatsNew(dir)).toEqual({ seen: [] });
    markWhatsNewSeen("0.1.59", dir);
    expect(readWhatsNew(dir).seen).toEqual(["0.1.59"]);
  });

  it("keeps the seen list bounded", () => {
    for (let n = 0; n < 80; n += 1) markWhatsNewSeen(`0.2.${n}`, dir);
    const seen = readWhatsNew(dir).seen;
    expect(seen.length).toBeLessThanOrEqual(50);
    expect(seen).toContain("0.2.79");
  });
});

describe("0.1.60's page", () => {
  it("a 0.1.59 install that saw its page sees 0.1.60's once", async () => {
    await checkWhatsNew("0.1.59", fresh, dir);
    markWhatsNewSeen("0.1.59", dir);
    expect(await checkWhatsNew("0.1.60", used, dir)).toEqual({ version: "0.1.60", show: true });
    markWhatsNewSeen("0.1.60", dir);
    expect(await checkWhatsNew("0.1.60", used, dir)).toEqual({ version: "0.1.60", show: false });
    expect(readWhatsNew(dir)).toEqual({ seen: ["0.1.59", "0.1.60"], lastVersion: "0.1.60" });
  });

  it("a 0.1.59 install that never closed its page still sees 0.1.60's once", async () => {
    expect(await checkWhatsNew("0.1.59", used, dir)).toEqual({ version: "0.1.59", show: true });
    expect(await checkWhatsNew("0.1.60", used, dir)).toEqual({ version: "0.1.60", show: true });
    markWhatsNewSeen("0.1.60", dir);
    expect(await checkWhatsNew("0.1.60", used, dir)).toEqual({ version: "0.1.60", show: false });
  });

  it("a brand-new 0.1.60 install is never shown it, before or after setup", async () => {
    expect(await checkWhatsNew("0.1.60", fresh, dir)).toEqual({ version: "0.1.60", show: false });
    expect(await checkWhatsNew("0.1.60", used, dir)).toEqual({ version: "0.1.60", show: false });
  });
});

describe("what's new route", () => {
  const request = (method: string, path: string, body?: unknown, version?: string) =>
    handleWhatsNewApi({ method, path, version, readBody: async () => body, isFreshInstall: used }, dir);

  it("answers GET with whether to show, and POST seen records it", async () => {
    expect(await request("GET", "/api/whats-new", undefined, "0.1.59")).toEqual({ status: 200, body: { version: "0.1.59", show: true } });
    expect(await request("POST", "/api/whats-new/seen", { version: "0.1.59" })).toEqual({ status: 200, body: { version: "0.1.59", show: false } });
    expect(await request("GET", "/api/whats-new", undefined, "0.1.59")).toEqual({ status: 200, body: { version: "0.1.59", show: false } });
  });

  it("refuses a missing or malformed version and unknown fields", async () => {
    expect((await request("GET", "/api/whats-new"))?.status).toBe(400);
    expect((await request("GET", "/api/whats-new", undefined, "../../etc"))?.status).toBe(400);
    expect((await request("POST", "/api/whats-new/seen", { version: "x".repeat(40) }))?.status).toBe(400);
    expect((await request("POST", "/api/whats-new/seen", { version: "0.1.59", extra: 1 }))?.status).toBe(400);
    expect((await request("POST", "/api/whats-new/seen", "0.1.59"))?.status).toBe(400);
    expect(existsSync(file())).toBe(false);
  });

  it("answers other methods with 405 and other paths with null", async () => {
    expect((await request("DELETE", "/api/whats-new"))?.status).toBe(405);
    expect(await request("GET", "/api/whats-new-other", undefined, "0.1.59")).toBeNull();
  });
});
