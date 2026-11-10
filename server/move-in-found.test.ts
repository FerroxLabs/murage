import { describe, expect, it } from "vitest";

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findMoveIn, forgetGrokCount, grokCountForSetup, readGrokExports, realMoveInFs, type MoveInFs } from "./move-in-found.ts";

const EXPORT = JSON.stringify({ name: "Helper", instructions: "Help.", skills: [], routines: [] });

function fixtureFs(files: Record<string, string>, opened: string[] = []): MoveInFs {
  return {
    home: () => "/home/fixture",
    list: (dir) => {
      if (dir !== "/home/fixture/Downloads") throw new Error(`listed ${dir}`);
      return Object.keys(files);
    },
    size: (path) => files[path.split("/").pop()!]?.length ?? null,
    read: (path) => {
      opened.push(path);
      return files[path.split("/").pop()!]!;
    },
  };
}

describe("F1 and F2 the finder", () => {
  it("returns a label and a count, never a path, and opens only grok export files in Downloads", async () => {
    const opened: string[] = [];
    const fs = fixtureFs({ "grok-bot-export.json": EXPORT, "sand-secrets.json": "{}", "cookies.json": "{}", "notes.txt": "x", "Grok Helper.json": EXPORT }, opened);
    const found = await findMoveIn(fs);
    expect(Object.keys(found.grok).sort()).toEqual(["count", "label"]);
    expect(JSON.stringify(found)).not.toContain("/home");
    expect(opened.map((path) => path.split("/").pop()).sort()).toEqual(["Grok Helper.json", "grok-bot-export.json"]);
    expect(readGrokExports(fixtureFs({ "sand-secrets.json": "{}" })).length).toBe(0);
  });
});

describe("F2b names that say chat, cookie or secret are never opened", () => {
  it("skips them before reading, whatever they hold", () => {
    const opened: string[] = [];
    const fs = fixtureFs({ "grok-chat.json": EXPORT, "grok-conversations.json": EXPORT, "grok-cookies.json": EXPORT, "grok-secrets.json": EXPORT, "grok-bot-export.json": EXPORT }, opened);
    expect(readGrokExports(fs).length).toBe(1);
    expect(opened.map((path) => path.split("/").pop())).toEqual(["grok-bot-export.json"]);
  });
  it("the real reader skips a link and does not follow it", () => {
    const root = mkdtempSync(join(tmpdir(), "move-in-"));
    try {
      writeFileSync(join(root, "outside.json"), EXPORT);
      mkdirSync(join(root, "Downloads"));
      symlinkSync(join(root, "outside.json"), join(root, "Downloads", "grok-export.json"));
      writeFileSync(join(root, "Downloads", "grok-bot-real.json"), EXPORT);
      const real: MoveInFs = { ...realMoveInFs, home: () => root };
      expect(readGrokExports(real)).toEqual([EXPORT]);
      expect(() => realMoveInFs.read(join(root, "Downloads", "grok-export.json"))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("F2c only bot-export names, and never through a linked Downloads", () => {
  it("skips names that are not exports, and a Downloads that is not a real directory", () => {
    const opened: string[] = [];
    const fs = fixtureFs({ "grok-config.json": EXPORT, "grok-settings.json": EXPORT, "grok-bot-export (1).json": EXPORT }, opened);
    expect(readGrokExports(fs).length).toBe(1);
    expect(opened.map((path) => path.split("/").pop())).toEqual(["grok-bot-export (1).json"]);
    expect(readGrokExports({ ...fixtureFs({ "grok-bot-export.json": EXPORT }), realDir: () => false })).toEqual([]);
  });
});

describe("F3 a throwing finder", () => {
  it("is a count of 0", async () => {
    const broken: MoveInFs = { home: () => { throw new Error("no home"); }, list: () => [], size: () => 0, read: () => "" };
    expect((await findMoveIn(broken)).grok.count).toBe(0);
    forgetGrokCount();
    expect(await grokCountForSetup(broken)).toBe(0);
  });
});
