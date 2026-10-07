// SPDX-License-Identifier: AGPL-3.0-or-later
// F10: a version 1 state.json becomes approved-sites rows and one-task grants (spec section 8).
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowserExtensionSites, BrowserExtensionSitesError } from "./browser-extension-sites.ts";

let dir: string, file: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sites-migration-")); file = join(dir, "browser-extension", "sites.json"); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const binding = (over: Record<string, unknown> = {}, sites: Record<string, string> = {}, extra: Record<string, unknown> = {}) => ({
  context: { workspaceId: "ws", botId: "bot1", profileId: "profA", bindingId: "bind1", generation: 3, ...over }, state: "active", sites, ...extra,
});
const v1 = (...bindings: unknown[]) => ({ version: 1, bindings });

describe("migration from a version 1 state.json", () => {
  it("promotes never, returns allow as one-task grants, drops ask", () => {
    const sites = new BrowserExtensionSites(file);
    const result = sites.migrateFromBindings(v1(binding({}, { "https://bad.example": "never", "https://news.example": "allow", "https://meh.example": "ask" })));
    expect(sites.get("bot1", "profA", "https://bad.example")).toMatchObject({ rule: "never" });
    // Allow is NOT promoted to Allow always, and ask is dropped (Ask is the default).
    expect(sites.get("bot1", "profA", "https://news.example")).toBeUndefined();
    expect(sites.get("bot1", "profA", "https://meh.example")).toBeUndefined();
    expect(result.grants).toEqual([{ botId: "bot1", profileId: "profA", bindingId: "bind1", origin: "https://news.example", level: 1 }]);
    expect(result.promoted).toBe(1);
    expect(result.dropped).toBe(1);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ version: 1 });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("keeps each binding's rows on its own bot and profile", () => {
    const sites = new BrowserExtensionSites(file);
    sites.migrateFromBindings(v1(
      binding({}, { "https://a.example": "never" }),
      binding({ botId: "bot2", profileId: "profB", bindingId: "bind2" }, { "https://b.example": "never", "https://c.example": "allow" }),
    ));
    expect(sites.get("bot1", "profA", "https://a.example")?.rule).toBe("never");
    expect(sites.get("bot1", "profA", "https://b.example")).toBeUndefined();
    expect(sites.get("bot2", "profB", "https://b.example")?.rule).toBe("never");
  });

  it("a never on one binding beats an allow on another for the same bot and profile", () => {
    const sites = new BrowserExtensionSites(file);
    const result = sites.migrateFromBindings(v1(
      binding({}, { "https://x.example": "allow" }),
      binding({ bindingId: "bind2" }, { "https://x.example": "never" }),
    ));
    expect(sites.get("bot1", "profA", "https://x.example")?.rule).toBe("never");
    expect(result.grants).toEqual([]);
  });

  it("a stopped or retired task gets no grant: Stop is final", () => {
    const sites = new BrowserExtensionSites(file);
    const result = sites.migrateFromBindings(v1(
      binding({}, { "https://x.example": "allow" }, { state: "stopped" }),
      binding({ bindingId: "bind2" }, { "https://y.example": "allow" }, { retired: true }),
      binding({ bindingId: "bind3" }, { "https://z.example": "allow" }, { state: "paused" }),
    ));
    expect(result.grants.map(item => item.origin)).toEqual(["https://z.example"]);
  });

  it("never overwrites a stricter owner choice and is safe to run twice", () => {
    const sites = new BrowserExtensionSites(file);
    sites.set("bot1", "profA", "https://x.example", "never");
    const state = v1(binding({}, { "https://x.example": "ask", "https://y.example": "never" }));
    const first = sites.migrateFromBindings(state);
    const second = sites.migrateFromBindings(state);
    expect(sites.get("bot1", "profA", "https://x.example")?.rule).toBe("never");
    expect(sites.list("bot1", "profA")).toHaveLength(2);
    expect(second.grants).toEqual(first.grants);
  });

  it("skips origins it cannot read instead of failing the migration", () => {
    const sites = new BrowserExtensionSites(file);
    const result = sites.migrateFromBindings(v1(binding({}, { "not an origin": "never", "https://ok.example": "never" })));
    expect(sites.list("bot1", "profA").map(item => item.origin)).toEqual(["https://ok.example"]);
    expect(result.promoted).toBe(1);
  });

  it("fails closed on an unknown version, with a plain message and no write", () => {
    const sites = new BrowserExtensionSites(file);
    for (const state of [{ version: 2, bindings: [] }, { version: 0, bindings: [] }, { bindings: [] }, null, "x", { version: 1, bindings: "nope" }]) {
      expect(() => sites.migrateFromBindings(state)).toThrow(BrowserExtensionSitesError);
    }
    expect(() => sites.migrateFromBindings({ version: 2, bindings: [] })).toThrow(/newer version of Murage/);
    expect(() => readFileSync(file)).toThrow();
  });
});
