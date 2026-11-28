import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR, loadConfig, saveConfig } from "./config.ts";
import { projectWebReadPermission, projectWebSearchPermission } from "./installation-state-snapshot.ts";

const file = join(DATA_DIR, "config.json");
const stored = () => JSON.parse(readFileSync(file, "utf8")) as { webSearch?: Record<string, unknown>; webRead?: Record<string, unknown> };
describe("page reading is stored once, where v1.0.20 can still read it", () => {
  beforeEach(() => { mkdirSync(DATA_DIR, { recursive: true }); rmSync(file, { force: true }); });
  afterEach(() => { rmSync(file, { force: true }); });
  it("a webSearch.readEnabled save lands in webRead.enabled and never in the strict webSearch section", () => {
    saveConfig({ webSearch: { provider: "engine", readEnabled: false } });
    expect(stored().webSearch).toEqual({ provider: "engine" });
    expect(stored().webRead).toEqual({ enabled: false });
    expect(loadConfig().webRead?.enabled).toBe(false);
    saveConfig({ webSearch: { readEnabled: true } });
    expect(stored().webSearch).toEqual({ provider: "engine" });
    expect(stored().webRead).toEqual({ enabled: true });
  });
  it("a file a dev build wrote (webSearch.readEnabled false) still reads as Off and the next save rewrites it v1.0.20-safe", () => {
    writeFileSync(file, JSON.stringify({ webSearch: { provider: "engine", readEnabled: false } }));
    expect(loadConfig().webRead?.enabled).toBe(false);
    expect("readEnabled" in (loadConfig().webSearch ?? {})).toBe(false);
    saveConfig({ language: "en" });
    expect(stored().webSearch).toEqual({ provider: "engine" });
    expect(stored().webRead).toEqual({ enabled: false });
  });
  it("an unrelated Web search save does not undo the Tools page switch", () => {
    saveConfig({ webRead: { enabled: false } });
    saveConfig({ webSearch: { provider: "tavily" } });
    expect(stored().webRead).toEqual({ enabled: false });
  });
});
describe("backup and restore carry the page-reading switch without the strict-section key", () => {
  it("projects webRead.enabled and keeps only provider off in webSearch", () => {
    expect(projectWebSearchPermission({ provider: "off", readEnabled: true }, "INVALID_RESTORE_CONFIG")).toEqual({ provider: "off" });
    expect(projectWebSearchPermission({ provider: "engine", readEnabled: false }, "INVALID_RESTORE_CONFIG")).toBeUndefined();
    expect(projectWebReadPermission({ provider: "engine", readEnabled: false }, undefined, "INVALID_RESTORE_CONFIG")).toEqual({ enabled: false });
    expect(projectWebReadPermission(undefined, { enabled: false }, "INVALID_RESTORE_CONFIG")).toEqual({ enabled: false });
    expect(projectWebReadPermission({ readEnabled: true }, { enabled: true }, "INVALID_RESTORE_CONFIG")).toEqual({ enabled: true });
    expect(projectWebReadPermission({ readEnabled: true }, { enabled: false }, "INVALID_RESTORE_CONFIG")).toEqual({ enabled: false });
    expect(projectWebReadPermission(undefined, undefined, "INVALID_RESTORE_CONFIG")).toBeUndefined();
  });
});
describe("a leftover webSearch.readEnabled Off is never undone by a stored webRead On", () => {
  beforeEach(() => { mkdirSync(DATA_DIR, { recursive: true }); rmSync(file, { force: true }); });
  afterEach(() => { rmSync(file, { force: true }); });
  it("reads as Off on load and stays Off through an unrelated save, the way backup and restore treat the same file", () => {
    writeFileSync(file, JSON.stringify({ webSearch: { provider: "engine", readEnabled: false }, webRead: { enabled: true } }));
    expect(loadConfig().webRead?.enabled).toBe(false);
    saveConfig({ language: "en" });
    expect(stored().webSearch).toEqual({ provider: "engine" });
    expect(stored().webRead).toEqual({ enabled: false });
    expect(projectWebReadPermission({ readEnabled: false }, { enabled: true }, "INVALID_RESTORE_CONFIG")).toEqual({ enabled: false });
  });
  it("a save that turns reading back On wins over the leftover", () => {
    writeFileSync(file, JSON.stringify({ webSearch: { provider: "engine", readEnabled: false } }));
    saveConfig({ webRead: { enabled: true } });
    expect(stored().webSearch).toEqual({ provider: "engine" });
    expect(stored().webRead).toEqual({ enabled: true });
    expect(loadConfig().webRead?.enabled).toBe(true);
  });
});
