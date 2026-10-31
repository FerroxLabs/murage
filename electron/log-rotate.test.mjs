// The server log stays a size an owner can open and send, and moving it never
// costs a line, never stops a launch and works with the file open on Windows.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SERVER_LOG_MAX_BYTES, oldLogPath, openLogStream, rotateLogAtLaunch } from "./log-rotate.mjs";

let dir;
let log;
let old;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-rotate-"));
  log = path.join(dir, "server.log");
  old = oldLogPath(log);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const refusing = (code) => ({
  lstatSync: fs.lstatSync,
  renameSync: () => { throw Object.assign(new Error(code), { code }); },
});

describe("rotateLogAtLaunch", () => {
  it("names one old copy beside the log", () => {
    expect(path.basename(old)).toBe("server.log.1");
    expect(SERVER_LOG_MAX_BYTES).toBe(50 * 1024 * 1024);
  });

  it("moves an oversized log to the old copy, whole", () => {
    fs.writeFileSync(log, "x".repeat(11));
    expect(rotateLogAtLaunch(log, { maxBytes: 10 })).toBe(true);
    expect(fs.existsSync(log)).toBe(false);
    expect(fs.readFileSync(old, "utf8")).toBe("x".repeat(11));
  });

  it("leaves a log at or under the cap where it is", () => {
    fs.writeFileSync(log, "x".repeat(10));
    expect(rotateLogAtLaunch(log, { maxBytes: 10 })).toBe(false);
    expect(fs.readFileSync(log, "utf8")).toBe("x".repeat(10));
    expect(fs.existsSync(old)).toBe(false);
  });

  it("keeps one old copy: the newer log takes its place", () => {
    fs.writeFileSync(old, "older run");
    fs.writeFileSync(log, "newer run, oversized");
    expect(rotateLogAtLaunch(log, { maxBytes: 5 })).toBe(true);
    expect(fs.readFileSync(old, "utf8")).toBe("newer run, oversized");
    expect(fs.readdirSync(dir).sort()).toEqual(["server.log.1"]);
  });

  it.each(["EPERM", "EBUSY", "EACCES", "EXDEV"])("keeps both files and carries on when the rename is refused with %s", (code) => {
    fs.writeFileSync(old, "older run");
    fs.writeFileSync(log, "the log being read");
    expect(rotateLogAtLaunch(log, { maxBytes: 1, fileSystem: refusing(code) })).toBe(false);
    expect(fs.readFileSync(log, "utf8")).toBe("the log being read");
    expect(fs.readFileSync(old, "utf8")).toBe("older run");
  });

  it("never throws when there is no log yet, or the log folder is gone", () => {
    expect(rotateLogAtLaunch(log)).toBe(false);
    expect(rotateLogAtLaunch(path.join(dir, "missing", "server.log"))).toBe(false);
  });

  it("leaves anything that is not a plain file alone", () => {
    fs.mkdirSync(log);
    expect(rotateLogAtLaunch(log, { maxBytes: -1 })).toBe(false);
    expect(fs.statSync(log).isDirectory()).toBe(true);
  });

  it("keeps a refused old copy as it is when the old copy is a folder", () => {
    fs.mkdirSync(old);
    fs.writeFileSync(log, "still here");
    expect(rotateLogAtLaunch(log, { maxBytes: 1 })).toBe(false);
    expect(fs.readFileSync(log, "utf8")).toBe("still here");
  });

  it("loses no line with the log open for reading and writing, on every OS", async () => {
    fs.writeFileSync(log, "first line\n");
    const reader = fs.openSync(log, "r");
    const writer = fs.openSync(log, "a");
    try {
      const moved = rotateLogAtLaunch(log, { maxBytes: 1 });
      fs.writeSync(writer, "written after the launch\n");
      const buffer = Buffer.alloc(64);
      const read = fs.readSync(reader, buffer, 0, 64, 0);
      expect(buffer.subarray(0, read).toString()).toContain("first line");
      const where = moved ? old : log;
      expect(fs.readFileSync(where, "utf8")).toBe("first line\nwritten after the launch\n");
    } finally {
      fs.closeSync(reader);
      fs.closeSync(writer);
    }
  });

  it("leaves a reader of the old copy with what it opened, or leaves the file alone", () => {
    fs.writeFileSync(old, "being read\n");
    fs.writeFileSync(log, "next oversized run\n");
    const reader = fs.openSync(old, "r");
    try {
      rotateLogAtLaunch(log, { maxBytes: 1 });
      const buffer = Buffer.alloc(32);
      const read = fs.readSync(reader, buffer, 0, 32, 0);
      expect(buffer.subarray(0, read).toString()).toBe("being read\n");
    } finally {
      fs.closeSync(reader);
    }
  });
});

describe("openLogStream", () => {
  it("reports a log it cannot open instead of taking the app down", async () => {
    fs.mkdirSync(log);
    const lost = await new Promise((resolve) => { openLogStream(log, resolve); });
    expect(lost.destroyed).toBe(true);
  });

  it("appends after the file was moved, starting a fresh log", async () => {
    fs.writeFileSync(log, "x".repeat(20));
    expect(rotateLogAtLaunch(log, { maxBytes: 10 })).toBe(true);
    const onLost = vi.fn();
    const stream = openLogStream(log, onLost);
    await new Promise((resolve) => stream.end("fresh line\n", resolve));
    expect(onLost).not.toHaveBeenCalled();
    expect(fs.readFileSync(log, "utf8")).toBe("fresh line\n");
  });
});

describe("the desktop wiring", () => {
  const main = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "main.mjs"), "utf8");
  it("moves the log after the single-instance lock, so a second launch never touches a running log", () => {
    const lock = main.indexOf("app.requestSingleInstanceLock()");
    const rotate = main.indexOf("rotateLogAtLaunch(path.join(LOG_DIR");
    expect(lock).toBeGreaterThan(-1);
    expect(rotate).toBeGreaterThan(lock);
  });
  it("opens the log through the stream that hears its errors", () => {
    expect(main).toContain("openLogStream(path.join(LOG_DIR");
    expect(main).not.toContain("fs.createWriteStream(path.join(LOG_DIR");
  });
});
