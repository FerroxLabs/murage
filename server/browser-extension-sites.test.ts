// SPDX-License-Identifier: AGPL-3.0-or-later
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowserExtensionSites, BrowserExtensionSitesError } from "./browser-extension-sites.ts";
import { BROWSER_EXTENSION_FILES, classifyDataDirEntry } from "./data-dir-inventory.ts";

let dir: string, file: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sites-")); file = join(dir, "browser-extension", "sites.json"); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("approved sites store", () => {
  it("keeps one rule per bot, profile and origin, and survives a reload", () => {
    const sites = new BrowserExtensionSites(file);
    expect(sites.get("bot1", "profA", "https://example.com")).toBeUndefined();
    sites.set("bot1", "profA", "https://example.com", "allow");
    sites.set("bot1", "profA", "https://evil.example", "never");
    sites.set("bot1", "profB", "https://example.com", "never");
    sites.set("bot2", "profA", "https://example.com", "ask");
    const again = new BrowserExtensionSites(file);
    expect(again.get("bot1", "profA", "https://example.com")).toMatchObject({ rule: "allow" });
    expect(again.get("bot1", "profB", "https://example.com")).toMatchObject({ rule: "never" });
    expect(again.get("bot2", "profA", "https://example.com")).toMatchObject({ rule: "ask" });
    expect(again.list("bot1", "profA").map(item => [item.origin, item.rule]).sort()).toEqual([["https://evil.example", "never"], ["https://example.com", "allow"]]);
    expect(again.list("bot3", "profA")).toEqual([]);
  });

  it("writes version 1, owner-only, atomically, with no leftover temp files", () => {
    const sites = new BrowserExtensionSites(file);
    sites.set("bot1", "profA", "https://example.com", "allow");
    expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(1);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, "browser-extension"))).toEqual(["sites.json"]);
  });

  it("normalises origins and refuses anything that is not a web origin", () => {
    const sites = new BrowserExtensionSites(file);
    sites.set("bot1", "profA", "https://Example.COM/some/path?x=1", "allow");
    expect(sites.get("bot1", "profA", "https://example.com")?.rule).toBe("allow");
    for (const bad of ["null", "javascript:alert(1)", "file:///etc/passwd", "chrome://settings", "", "example.com", "https://"]) {
      expect(() => sites.set("bot1", "profA", bad, "allow"), bad).toThrow(BrowserExtensionSitesError);
    }
  });

  it("refuses bad ids, unknown rules, and lowered on anything but ask", () => {
    const sites = new BrowserExtensionSites(file);
    expect(() => sites.set("../x", "profA", "https://a.example", "allow")).toThrow(BrowserExtensionSitesError);
    expect(() => sites.set("bot1", "a/b", "https://a.example", "allow")).toThrow(BrowserExtensionSitesError);
    expect(() => sites.set("bot1", "profA", "https://a.example", "yolo" as never)).toThrow(BrowserExtensionSitesError);
    expect(() => sites.set("bot1", "profA", "https://a.example", "allow", { lowered: true })).toThrow(BrowserExtensionSitesError);
    expect(() => sites.set("bot1", "profA", "https://a.example", "never", { lowered: true })).toThrow(BrowserExtensionSitesError);
    sites.set("bot1", "profA", "https://bank.example", "ask", { lowered: true });
    expect(sites.get("bot1", "profA", "https://bank.example")).toMatchObject({ rule: "ask", lowered: true });
    // Setting it again without the flag clears the lowering.
    sites.set("bot1", "profA", "https://bank.example", "ask");
    expect(sites.get("bot1", "profA", "https://bank.example")?.lowered).toBeUndefined();
  });

  it("treats __proto__ as an ordinary id and never pollutes", () => {
    const sites = new BrowserExtensionSites(file);
    sites.set("__proto__", "constructor", "https://a.example", "never");
    expect(({} as Record<string, unknown>).never).toBeUndefined();
    expect(new BrowserExtensionSites(file).get("__proto__", "constructor", "https://a.example")?.rule).toBe("never");
    expect(sites.get("toString", "constructor", "https://a.example")).toBeUndefined();
  });

  it("fails closed on an unknown version, bad shape, or an unsafe file, with a plain message", () => {
    sites_write({ version: 2, sites: {} });
    expect(() => new BrowserExtensionSites(file)).toThrow(/newer version of Murage/);
    sites_write({ version: 1, sites: "nope" });
    expect(() => new BrowserExtensionSites(file)).toThrow(BrowserExtensionSitesError);
    sites_write({ version: 1, sites: { bot1: { profA: { "https://a.example": { rule: "maybe" } } } } });
    expect(() => new BrowserExtensionSites(file)).toThrow(BrowserExtensionSitesError);
    writeFileSync(file, "{not json", { mode: 0o600 });
    expect(() => new BrowserExtensionSites(file)).toThrow(BrowserExtensionSitesError);
    if (process.platform !== "win32") {
      sites_write({ version: 1, sites: {} });
      chmodSync(file, 0o644);
      expect(() => new BrowserExtensionSites(file)).toThrow(BrowserExtensionSitesError);
    }
  });

  it("refuses a symlinked sites file", () => {
    if (process.platform === "win32") return;
    const real = join(dir, "elsewhere.json");
    sites_write({ version: 1, sites: {} }, real);
    new BrowserExtensionSites(file); // creates the folder
    rmSync(file, { force: true });
    symlinkSync(real, file);
    expect(() => new BrowserExtensionSites(file)).toThrow(BrowserExtensionSitesError);
  });

  it("is a reserved browser-extension file: left out of a backup and refused on restore", () => {
    expect(Object.keys(BROWSER_EXTENSION_FILES)).toContain("sites.json");
    expect(classifyDataDirEntry("browser-extension")?.backup).toBe("excluded");
  });
});

function sites_write(value: unknown, target = file) {
  mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(target, JSON.stringify(value), { mode: 0o600 });
}

describe("Opus gate: owner-facing messages are locale keys", () => {
  it("every store error carries a key whose English is the message", () => {
    const en = JSON.parse(readFileSync(new URL("../src/locales/en.json", import.meta.url), "utf8")) as Record<string, string>;
    const sites = new BrowserExtensionSites(file);
    const seen: BrowserExtensionSitesError[] = [];
    const grab = (fn: () => unknown) => { try { fn(); } catch (error) { if (error instanceof BrowserExtensionSitesError) seen.push(error); else throw error; } };
    grab(() => sites.set("bot1", "profA", "not a url", "allow"));
    grab(() => sites.set("bot1", "profA", "ftp://x.example", "allow"));
    grab(() => sites.set("bad id!", "profA", "https://x.example", "allow"));
    grab(() => sites.set("bot1", "bad id!", "https://x.example", "allow"));
    grab(() => sites.set("bot1", "profA", "https://x.example", "nope" as never));
    grab(() => sites.set("bot1", "profA", "https://x.example", "allow", { lowered: true }));
    grab(() => sites.migrateFromBindings({ version: 2, bindings: [] }));
    grab(() => sites.migrateFromBindings({ bindings: [] }));
    writeFileSync(file, JSON.stringify({ version: 9, sites: {} }), { mode: 0o600 });
    grab(() => new BrowserExtensionSites(file));
    writeFileSync(file, "{", { mode: 0o600 });
    grab(() => new BrowserExtensionSites(file));
    expect(seen.length).toBe(10);
    for (const error of seen) {
      expect(error.key, error.code).toMatch(/^browserExt\.sites\./);
      expect(en[error.key], error.key).toBe(error.message);
    }
    expect(new Set(seen.map(error => error.key)).size).toBeGreaterThanOrEqual(9);
  });
});
