// q1022-disk item 4: server.log is bounded while Murage keeps running, not only
// at the next launch. The writer under test is the one electron/main.mjs slog()
// writes every line through (main.mjs:1974; the last test runs slog itself). On the pre-fix tree slog wrote to a
// plain openLogStream, which is what the fallback below reproduces, so the base
// run reaches the size assertion.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { afterEach, beforeEach, expect, it } from "vitest";

import * as rotate from "./log-rotate.mjs";

let dir;
let log;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-running-"));
  log = path.join(dir, "server.log");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const runningWriter = (opts) => rotate.createServerLog
  ? rotate.createServerLog(log, opts)
  : rotate.openLogStream(log, () => {});
const flush = (w) => new Promise((r) => setTimeout(r, 50, w));
const line = (i) => `[2026-11-25T00:00:00.000Z] io-budget over budget line ${String(i).padStart(6, "0")} ${"x".repeat(60)}\n`;

it("Q22DISK-LOG rotates by size during one run and keeps the newest lines", async () => {
  const maxBytes = 16 * 1024;
  const w = runningWriter({ maxBytes });
  const n = 2000; // ~180 KB, about 11x the bound
  for (let i = 0; i < n; i += 1) w.write(line(i));
  await flush();
  const size = fs.statSync(log).size;
  expect(size, "Q22DISK-LOG live server.log size").toBeLessThanOrEqual(maxBytes + line(0).length);
  const current = fs.readFileSync(log, "utf8");
  const old = fs.readFileSync(rotate.oldLogPath(log), "utf8");
  expect(current.endsWith(line(n - 1))).toBe(true);
  // The two files hold one contiguous tail: no line between the copy and the live file is lost.
  const nums = (old + current).trim().split("\n").map((l) => Number(l.match(/line (\d+)/)[1]));
  for (let k = 1; k < nums.length; k += 1) expect(nums[k]).toBe(nums[k - 1] + 1);
});

it("Q22DISK-LOG a refused move keeps appending, loses nothing and retries", async () => {
  let refuse = true;
  const fileSystem = { ...fs, lstatSync: fs.lstatSync, createWriteStream: fs.createWriteStream,
    renameSync: (a, b) => { if (refuse) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" }); fs.renameSync(a, b); } };
  // the pre-fix tree's running writer (openLogStream, never moved) stands in on that tree, as in the test above
  const w = rotate.createServerLog ? rotate.createServerLog(log, { maxBytes: 4096, retryBytes: 1024, fileSystem }) : rotate.openLogStream(log, () => {}, fileSystem);
  for (let i = 0; i < 100; i += 1) w.write(line(i));
  await flush();
  expect(fs.readFileSync(log, "utf8").split("\n").filter(Boolean)).toHaveLength(100);
  refuse = false;
  for (let i = 100; i < 120; i += 1) w.write(line(i));
  await flush();
  expect(fs.existsSync(rotate.oldLogPath(log)), "Q22DISK-LOG moved once the refusal cleared").toBe(true);
  const all = fs.readFileSync(rotate.oldLogPath(log), "utf8") + fs.readFileSync(log, "utf8");
  expect(all.split("\n").filter(Boolean)).toHaveLength(120);
});

// Behaviour, not source text: main.mjs's own slog() is run (vm, as backup-closed-controller.test.mjs runs main.mjs code)
// with the real log-rotate exports, and written past the shipped 50 MB bound through it.
const mainSource = fs.readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
const slogStart = mainSource.indexOf("function slog(line) {");
const slogSource = mainSource.slice(slogStart, mainSource.indexOf("\n}\n", slogStart) + 3);

it("Q22DISK-LOG main.mjs slog keeps the running server.log within 50 MB", async () => {
  expect(slogStart).toBeGreaterThan(-1);
  const scope = { fs, path, Date, LOG_DIR: dir, logStream: null, createServerLog: rotate.createServerLog, openLogStream: rotate.openLogStream };
  const slog = vm.runInNewContext(`(${slogSource})`, scope);
  const chunk = "y".repeat(1024 * 1024);
  let written = 0;
  for (let i = 0; i < 56; i += 1) { const text = `io-budget over budget ${i} ${chunk}`; slog(text); written += text.length + 28; /* "[<ISO time>] " and the line break */ }
  // wait until every byte has landed in the live file or its old copy (an asynchronous stream may still be writing)
  const landed = () => [log, rotate.oldLogPath(log)].reduce((sum, file) => sum + (fs.existsSync(file) ? fs.statSync(file).size : 0), 0);
  for (const until = Date.now() + 20_000; landed() < written && Date.now() < until;) await flush();
  expect(landed()).toBe(written);
  expect(fs.statSync(log).size, "Q22DISK-LOG live server.log size through main.mjs slog").toBeLessThanOrEqual(rotate.SERVER_LOG_MAX_BYTES + chunk.length + 64);
  expect(fs.readFileSync(log, "utf8").trimEnd().endsWith(chunk)).toBe(true);
});
