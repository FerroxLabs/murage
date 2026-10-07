import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { keepFuigoTurnLogs } from "./fuigo-turn-logs.ts";

const roots: string[] = [];
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "fuigo-logs-")); roots.push(dir); return dir; };
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const home = (name: string) => {
  const dir = scratch();
  mkdirSync(join(dir, "logs"));
  writeFileSync(join(dir, "logs", "fuigo.log"), name);
  writeFileSync(join(dir, "auth.json"), "SECRET");
  writeFileSync(join(dir, "config.toml"), "key");
  return dir;
};

describe("kept Fuigo turn logs", () => {
  it("moves only logs/, drops auth-like files inside it, and leaves the home to be removed", () => {
    const root = join(scratch(), "keep"), h = home("one");
    writeFileSync(join(h, "logs", "auth.json"), "SECRET");
    expect(keepFuigoTurnLogs(h, "turn-1", root)).toBe(true);
    expect(readdirSync(join(root, "turn-1"))).toEqual(["fuigo.log"]);
    expect(existsSync(join(h, "logs"))).toBe(false);
    expect(readdirSync(root)).toEqual(["turn-1"]);
  });
  it("keeps the newest 20", () => {
    const root = join(scratch(), "keep");
    for (let n = 0; n < 23; n++) {
      keepFuigoTurnLogs(home(`t${n}`), `turn-${n}`, root);
      const at = new Date(Date.now() - 100_000 + n * 1000);
      utimesSync(join(root, `turn-${n}`), at, at);
    }
    const left = readdirSync(root).sort();
    expect(left).toHaveLength(20);
    expect(left).not.toContain("turn-0");
    expect(left).toContain("turn-22");
  });
  it("is quiet when there is no logs dir and sanitizes the turn id", () => {
    const root = join(scratch(), "keep");
    expect(keepFuigoTurnLogs(scratch(), "t", root)).toBe(false);
    expect(keepFuigoTurnLogs(home("x"), "../evil", root)).toBe(true);
    expect(readdirSync(root)).toEqual(["___evil"]);
  });
  it("never follows a symlink: a link to an outside dir keeps its files and is not copied", () => {
    const root = join(scratch(), "keep"), h = home("one"), outside = scratch();
    writeFileSync(join(outside, "auth.json"), "OUTSIDE");
    writeFileSync(join(outside, "notes.log"), "OUTSIDE-LOG");
    symlinkSync(outside, join(h, "logs", "linked"));
    symlinkSync(join(outside, "notes.log"), join(h, "logs", "alias.log"));
    expect(keepFuigoTurnLogs(h, "turn-1", root)).toBe(true);
    expect(readdirSync(join(root, "turn-1"))).toEqual(["fuigo.log"]);
    expect(readFileSync(join(outside, "auth.json"), "utf8")).toBe("OUTSIDE");
    expect(readFileSync(join(outside, "notes.log"), "utf8")).toBe("OUTSIDE-LOG");
  });
  it("a logs dir that is itself a symlink is dropped without touching its target", () => {
    const root = join(scratch(), "keep"), h = scratch(), outside = scratch();
    writeFileSync(join(outside, "auth.json"), "OUTSIDE");
    symlinkSync(outside, join(h, "logs"));
    expect(keepFuigoTurnLogs(h, "turn-1", root)).toBe(false);
    expect(readFileSync(join(outside, "auth.json"), "utf8")).toBe("OUTSIDE");
  });
  it("retention never follows a symlink planted in the keep root", () => {
    const root = join(scratch(), "keep"), outside = scratch();
    mkdirSync(root, { recursive: true });
    writeFileSync(join(outside, "auth.json"), "OUTSIDE");
    symlinkSync(outside, join(root, "old"));
    utimesSync(root, new Date(), new Date());
    for (let n = 0; n < 3; n++) keepFuigoTurnLogs(home(`t${n}`), `turn-${n}`, root, 1);
    expect(readFileSync(join(outside, "auth.json"), "utf8")).toBe("OUTSIDE");
  });
});
