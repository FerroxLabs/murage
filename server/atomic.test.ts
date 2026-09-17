import { createRequire, syncBuiltinESMExports } from "node:module";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renameWithRetry, writeFileAtomic } from "./atomic.ts";

// The builtin module object itself: replacing renameSync here and re-syncing
// the ESM facade is what atomic.ts's named import observes (the same technique
// server/testing/safe-wipe.mjs uses for its guard).
const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");

describe("writeFileAtomic", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "murage-atomic-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the file", () => {
    const p = join(dir, "x.json");
    writeFileAtomic(p, '{"a":1}');
    expect(readFileSync(p, "utf8")).toBe('{"a":1}');
  });

  it("replaces existing contents in full", () => {
    const p = join(dir, "x.json");
    writeFileAtomic(p, "old-and-longer");
    writeFileAtomic(p, "new");
    expect(readFileSync(p, "utf8")).toBe("new");
  });

  it("leaves no temp files behind", () => {
    const p = join(dir, "x.json");
    writeFileAtomic(p, "a");
    writeFileAtomic(p, "b");
    expect(readdirSync(dir)).toEqual(["x.json"]);
  });

  it("preserves unicode across the write", () => {
    const p = join(dir, "u.json");
    const s = JSON.stringify({ msg: "café — 日本語 — 🚀" });
    writeFileAtomic(p, s);
    expect(readFileSync(p, "utf8")).toBe(s);
    expect(existsSync(p)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("applies the requested mode when replacing a file", () => {
    const p = join(dir, "secret.json");
    writeFileAtomic(p, "old");
    chmodSync(p, 0o644);

    writeFileAtomic(p, "new", { mode: 0o600 });

    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it("cleans up the temporary file when replacement fails", () => {
    const p = join(dir, "target");
    mkdirSync(p);
    expect(() => writeFileAtomic(p, "cannot replace a directory")).toThrow();
    expect(readdirSync(dir)).toEqual(["target"]);
  });
});

describe("renameWithRetry", () => {
  const refusing = (times: number, code: string) => {
    let calls = 0;
    return {
      get calls() {
        return calls;
      },
      rename: () => {
        calls += 1;
        if (calls <= times) throw Object.assign(new Error(`${code}: simulated`), { code });
      },
    };
  };

  it("survives a transient Windows EPERM instead of failing the save", () => {
    const stub = refusing(3, "EPERM");
    const slept: number[] = [];
    expect(() => renameWithRetry("a.tmp", "a", stub.rename, "win32", (ms) => slept.push(ms))).not.toThrow();
    expect(stub.calls).toBe(4);
    expect(slept).toEqual([5, 10, 20]);
  });

  it("retries EACCES and EBUSY the same way on Windows", () => {
    for (const code of ["EACCES", "EBUSY"]) {
      const stub = refusing(1, code);
      expect(() => renameWithRetry("a.tmp", "a", stub.rename, "win32", () => {})).not.toThrow();
      expect(stub.calls).toBe(2);
    }
  });

  it("gives up after a bounded schedule and surfaces the original error", () => {
    const stub = refusing(Number.MAX_SAFE_INTEGER, "EPERM");
    const slept: number[] = [];
    expect(() => renameWithRetry("a.tmp", "a", stub.rename, "win32", (ms) => slept.push(ms))).toThrow(/EPERM: simulated/);
    expect(stub.calls).toBe(6);
    expect(slept).toEqual([5, 10, 20, 40, 80]);
  });

  it("does not retry an error that will never clear", () => {
    for (const code of ["ENOENT", "EXDEV", "EISDIR"]) {
      const stub = refusing(Number.MAX_SAFE_INTEGER, code);
      const sleep = vi.fn();
      expect(() => renameWithRetry("a.tmp", "a", stub.rename, "win32", sleep)).toThrow(new RegExp(code));
      expect(stub.calls).toBe(1);
      expect(sleep).not.toHaveBeenCalled();
    }
    const uncoded = vi.fn(() => {
      throw new Error("no code");
    });
    expect(() => renameWithRetry("a.tmp", "a", uncoded, "win32", () => {})).toThrow("no code");
    expect(uncoded).toHaveBeenCalledTimes(1);
  });

  it("never pauses off Windows, where these codes are real permission errors", () => {
    for (const platform of ["darwin", "linux"] as const) {
      for (const code of ["EPERM", "EACCES", "EBUSY"]) {
        const stub = refusing(1, code);
        const sleep = vi.fn();
        expect(() => renameWithRetry("a.tmp", "a", stub.rename, platform, sleep)).toThrow(new RegExp(code));
        expect(stub.calls).toBe(1);
        expect(sleep).not.toHaveBeenCalled();
      }
    }
  });
});

describe("writeFileAtomic when the replacement is refused", () => {
  let dir: string;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const realRename = fs.renameSync;
  const asPlatform = (value: NodeJS.Platform) => Object.defineProperty(process, "platform", { ...platform, value });
  const withRename = (rename: typeof fs.renameSync) => {
    fs.renameSync = rename;
    syncBuiltinESMExports();
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "murage-atomic-refused-"));
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", platform);
    withRename(realRename);
    rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")(
    "keeps the old bytes, removes its temp file and keeps the sensitive mode when Windows never releases the target",
    () => {
      const p = join(dir, "secret.json");
      writeFileAtomic(p, "old", { mode: 0o600 });
      const refused = vi.fn(() => {
        throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
      });
      withRename(refused);
      asPlatform("win32");
      expect(() => writeFileAtomic(p, "new", { mode: 0o600 })).toThrow(/EPERM/);
      Object.defineProperty(process, "platform", platform);
      withRename(realRename);
      expect(refused).toHaveBeenCalledTimes(6);
      expect(readFileSync(p, "utf8")).toBe("old");
      expect(readdirSync(dir)).toEqual(["secret.json"]);
      expect(statSync(p).mode & 0o777).toBe(0o600);

      // The same refusal off Windows is reported at once, not waited out.
      withRename(refused);
      refused.mockClear();
      asPlatform("darwin");
      expect(() => writeFileAtomic(p, "new", { mode: 0o600 })).toThrow(/EPERM/);
      expect(refused).toHaveBeenCalledTimes(1);
      withRename(realRename);
      expect(readFileSync(p, "utf8")).toBe("old");
      expect(readdirSync(dir)).toEqual(["secret.json"]);

      // A refusal that clears inside the schedule lands the new bytes.
      let refusals = 2;
      const clearing = vi.fn((from: import("node:fs").PathLike, to: import("node:fs").PathLike) => {
        if (refusals-- > 0) throw Object.assign(new Error("EBUSY: resource busy or locked, rename"), { code: "EBUSY" });
        realRename(from, to);
      });
      withRename(clearing);
      asPlatform("win32");
      writeFileAtomic(p, "new", { mode: 0o600 });
      Object.defineProperty(process, "platform", platform);
      withRename(realRename);
      expect(clearing).toHaveBeenCalledTimes(3);
      expect(readFileSync(p, "utf8")).toBe("new");
      expect(readdirSync(dir)).toEqual(["secret.json"]);
      expect(statSync(p).mode & 0o777).toBe(0o600);
    },
  );
});
