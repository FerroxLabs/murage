import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { classifyDataDirEntry, DATA_DIR_RESTORABLE } from "../server/data-dir-inventory.ts";
import { getInstallId, mintLabel } from "./install-id.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("the install id in the token mint label", () => {
  it("is generated once and is the same after a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "install-id-"));
    const first = getInstallId(dir);
    expect(first).toMatch(UUID);
    expect(getInstallId(dir)).toBe(first);
    expect(JSON.parse(readFileSync(join(dir, "install-id.json"), "utf8")).installId).toBe(first);
  });

  it("replaces a damaged file with a fresh id rather than failing", () => {
    const dir = mkdtempSync(join(tmpdir(), "install-id-"));
    writeFileSync(join(dir, "install-id.json"), "{not json");
    expect(getInstallId(dir)).toMatch(UUID);
  });

  it("differs between installs", () => {
    expect(getInstallId(mkdtempSync(join(tmpdir(), "a-")))).not.toBe(getInstallId(mkdtempSync(join(tmpdir(), "b-"))));
  });

  it("is in the label as murage-<uuid>, with no hostname or username", () => {
    const dir = mkdtempSync(join(tmpdir(), "install-id-"));
    const id = getInstallId(dir);
    const label = mintLabel(dir);
    expect(label).toBe(`murage-${id}`);
    expect(label.toLowerCase()).not.toContain(hostname().toLowerCase());
    expect(label.toLowerCase()).not.toContain(userInfo().username.toLowerCase());
  });

  it("still gives a plain label when the directory cannot be used", () => {
    expect(mintLabel("/nonexistent/readonly/dir")).toMatch(/^murage-[0-9a-f-]{36}$/);
  });
});

describe("where the id lives", () => {
  it("is listed in the data-dir inventory and carried by a backup and restore", () => {
    expect(classifyDataDirEntry("install-id.json")).toMatchObject({ backup: "owner-file" });
    expect(classifyDataDirEntry("install-id.json")?.why).toMatch(/restore/i);
    expect(DATA_DIR_RESTORABLE).toContain("install-id.json");
  });

  it("is the same after the data folder is restored somewhere else", () => {
    const original = mkdtempSync(join(tmpdir(), "install-id-"));
    const restored = mkdtempSync(join(tmpdir(), "install-id-restored-"));
    const id = getInstallId(original);
    for (const name of DATA_DIR_RESTORABLE) {
      try { cpSync(join(original, name), join(restored, name), { recursive: true }); } catch { /* not present */ }
    }
    expect(getInstallId(restored)).toBe(id);
  });

  it("is random, not derived from the machine, the user or an address", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "install-id.mjs"), "utf8");
    expect(source).not.toMatch(/hostname|userInfo|networkInterfaces|machine-?id|serial|MAC|process\.env\.(USER|LOGNAME)/);
    expect(source).toMatch(/randomUUID/);
  });

  it("carries no email in the label either", () => {
    expect(mintLabel(mkdtempSync(join(tmpdir(), "install-id-")))).not.toMatch(/@|\./);
  });

  it("is what the desktop sends as the mint label", () => {
    const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "main.mjs"), "utf8");
    expect(main).toMatch(/mintLabel\(desktopDataDir\)[\s\S]{0,400}\.\.\.\(label \? \{ label \} : \{\}\)/);
  });
});
