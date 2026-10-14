import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { bumpGeneration, clearMountIncomplete, markMountIncomplete, markMountReady, mountIncomplete, readGeneration, CACHE_MAX_AGE_MS, CACHE_MAX_FILES, privateCacheDir, pruneCacheDir, purgeCacheDir, readCacheEntry, writeCacheEntry } from "./connector-cache.ts";
import { forgetWindowsCacheChecks, handOverInitialTools, purgeToolsCache, usableToolsCacheDir } from "./connector-cache-harness.ts";

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "murage-cache-unit-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); forgetWindowsCacheChecks(); });

describe("connector tool-list cache", () => {
  it("Windows never trusts a folder the harness did not verify (nothing is cached), and trusts one it did", () => {
    const dir = temp();
    expect(privateCacheDir({ dir, windowsVerified: false }, true, "win32")).toBeNull();
    expect(privateCacheDir({ dir, windowsVerified: true }, true, "win32")).toBe(dir);
    expect(privateCacheDir({ dir: undefined, windowsVerified: true }, true, "win32")).toBeNull();
  });

  it("the harness verifies the Windows folder with the native helper, rebuilds a broad one once, and turns persistence off when privacy cannot be established", () => {
    const dir = temp();
    // A shared or migrated folder: the helper refuses it, it is removed (its content can be fetched again) and made private.
    let attempts = 0;
    writeFileSync(join(dir, "old.json"), "{}");
    const rebuilt = usableToolsCacheDir(dir, { platform: "win32", makePrivate: () => { attempts += 1; if (attempts === 1) throw new Error("broad ACL"); } });
    expect(rebuilt).toEqual({ dir, windowsPrivate: true });
    expect(attempts).toBe(2);
    expect(existsSync(join(dir, "old.json"))).toBe(false);
    // Privacy that cannot be established: no folder is handed to the bridge.
    forgetWindowsCacheChecks();
    expect(usableToolsCacheDir(dir, { platform: "win32", makePrivate: () => { throw new Error("helper missing"); } })).toBeNull();
    // The answer is remembered for a few minutes, then asked again.
    const now = Date.now();
    forgetWindowsCacheChecks();
    let asked = 0;
    const make = () => { asked += 1; };
    usableToolsCacheDir(dir, { platform: "win32", makePrivate: make, now });
    usableToolsCacheDir(dir, { platform: "win32", makePrivate: make, now: now + 1_000 });
    expect(asked).toBe(1);
    usableToolsCacheDir(dir, { platform: "win32", makePrivate: make, now: now + 10 * 60_000 });
    expect(asked).toBe(2);
  });

  it.skipIf(process.platform === "win32")("POSIX folders are made owner-only; a symlinked folder is refused", () => {
    const dir = temp();
    chmodSync(dir, 0o777);
    expect(usableToolsCacheDir(dir)).toEqual({ dir, windowsPrivate: false });
    expect(statSync(dir).mode & 0o077).toBe(0);
    const link = join(temp(), "link");
    symlinkSync(dir, link);
    expect(usableToolsCacheDir(link)).toBeNull();
  });

  it("reads back only what has not expired, and deletes what has", () => {
    const dir = temp();
    expect(writeCacheEntry(dir, "a.json", JSON.stringify({ ok: 1 }))).toBe(true);
    expect(readCacheEntry(dir, "a.json")).toEqual({ ok: 1 });
    const old = new Date(Date.now() - CACHE_MAX_AGE_MS - 60_000);
    utimesSync(join(dir, "a.json"), old, old);
    expect(readCacheEntry(dir, "a.json")).toBeNull();
    expect(existsSync(join(dir, "a.json"))).toBe(false);
  });

  it("prunes expired entries, old temp files and the oldest beyond the cap, and is throttled between calls", () => {
    const dir = temp();
    const now = Date.now();
    const old = new Date(now - CACHE_MAX_AGE_MS - 60_000);
    writeFileSync(join(dir, "expired.json"), "{}"); utimesSync(join(dir, "expired.json"), old, old);
    writeFileSync(join(dir, "left.tmp"), "x"); utimesSync(join(dir, "left.tmp"), new Date(now - 2 * 3600_000), new Date(now - 2 * 3600_000));
    for (let i = 0; i < CACHE_MAX_FILES + 5; i++) writeFileSync(join(dir, `f${String(i).padStart(3, "0")}.json`), "{}");
    pruneCacheDir(dir, now, true);
    const left = readdirSync(dir);
    expect(left).not.toContain("expired.json");
    expect(left).not.toContain("left.tmp");
    expect(left.length).toBe(CACHE_MAX_FILES);
    writeFileSync(join(dir, "new-expired.json"), "{}"); utimesSync(join(dir, "new-expired.json"), old, old);
    pruneCacheDir(dir, now + 1_000); // throttled
    expect(existsSync(join(dir, "new-expired.json"))).toBe(true);
    pruneCacheDir(dir, now + 11 * 60_000); // due again
    expect(existsSync(join(dir, "new-expired.json"))).toBe(false);
  });

  it("purges every entry on disconnect and leaves the folder", () => {
    const dir = temp();
    writeCacheEntry(dir, "a.json", "{}"); writeCacheEntry(dir, "b.json", "{}");
    expect(purgeToolsCache(dir)).toBe(2);
    expect(readdirSync(dir)).toEqual(["generation.gen"]); // the fence outlives the purge it announces
    expect(readGeneration(dir)).toMatch(/^[a-f0-9-]{36}$/);
    const before = readGeneration(dir);
    purgeToolsCache(dir);
    expect(readGeneration(dir)).not.toBe(before);
    expect(bumpGeneration(join(dir, "missing"))).toBe("");
    expect(purgeCacheDir(join(dir, "missing"))).toBe(0);
    expect(purgeToolsCache(null)).toBe(0);
  });

  it("hands a list far over the old cap to the bridge whole, as a private file named by identity and revision", () => {
    const dir = temp();
    const tools = Array.from({ length: 40 }, (_, i) => ({ name: `T${i}`, description: "d".repeat(1_000) }));
    const scope = { identity: "a".repeat(32), revision: "rev-1" };
    expect(JSON.stringify(tools).length).toBeGreaterThan(24_000);
    expect(handOverInitialTools({ dir, windowsPrivate: false }, scope, tools)).toBe("@file");
    expect(readCacheEntry(dir, `initial-${scope.identity}-${scope.revision}.json`)).toEqual({ revision: "rev-1", tools });
    expect(handOverInitialTools(null, scope, tools)).toBeNull();
  });

  it("a stand-in marker recycles nothing until the real list is confirmed under the CURRENT connection generation", () => {
    const dir = temp();
    const ref = { cache: { dir, windowsVerified: true }, identity: "a".repeat(32), revision: "rev-1", thread: "t" };
    markMountReady(ref, ""); // no marker: nothing is filed by a ready note
    expect(mountIncomplete(ref)).toBe(false);
    markMountIncomplete(ref);
    expect(mountIncomplete(ref)).toBe(false); // discovery still failing: keep the warm engine
    markMountIncomplete(ref); // every fallback re-files it; it still never recycles on its own
    expect(mountIncomplete(ref)).toBe(false);
    const generation = bumpGeneration(dir);
    markMountReady(ref, generation);
    expect(mountIncomplete(ref)).toBe(true);
    bumpGeneration(dir); // a disconnect after the probe: the list it confirmed is gone
    expect(mountIncomplete(ref)).toBe(false);
    clearMountIncomplete(ref);
  });
});
