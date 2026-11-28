// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.21 self-heal H4 (owner: ctxrev-selfheal, selfheal-1021.ts; consumer: server/memory/selfheal-1021-kill.test.ts). Loaded with --import into
// the REAL server so the test's kill -9 lands at a chosen point of the self-heal's progress write. It changes no result: it only stops the
// process where it stands. A write is the self-heal's when it goes to the repairs note (SELFHEAL_KILL_NOTE) or to any name beginning with
// the note's (its temps, whatever they are called) and carries a SELFHEAL_KILL_KEY entry that differs from the note's.
//   SELFHEAL_KILL_AT=before-commit  a slice's transaction has re-pointed a receipt (a statement beginning with SELFHEAL_KILL_WRITE changed a
//                                   row) and the process stands still at that transaction's COMMIT: nothing of the slice is durable
//   SELFHEAL_KILL_AT=half-written   the first half of that write's bytes reach the disk, then the process stands still (a torn file)
//   SELFHEAL_KILL_AT=before-rename  the write is whole; the process stands still at the rename of it onto the note
// It reports `SELFHEAL-KILL-POINT <point> <file>` on stdout and blocks the main thread: no handler, timer or exit hook can run before the
// SIGKILL. With no kill it exits 70 (the test fails). Every other write and rename runs unchanged.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";

const note = process.env.SELFHEAL_KILL_NOTE, key = process.env.SELFHEAL_KILL_KEY, at = process.env.SELFHEAL_KILL_AT, write = process.env.SELFHEAL_KILL_WRITE;
if (isMainThread && note && key && (at === "half-written" || at === "before-rename" || (at === "before-commit" && write))) {
  const { openSync, writeSync, writeFileSync, renameSync, closeSync, readFileSync, fsyncSync } = fs;
  const entryOf = text => { try { return JSON.stringify(JSON.parse(text)[key]); } catch { return undefined; } };
  const noteEntry = () => { try { return entryOf(readFileSync(note, "utf8")); } catch { return undefined; } };
  const theirs = path => typeof path === "string" && path.startsWith(note);
  const mine = text => { const next = entryOf(text); return next !== undefined && next !== noteEntry(); };
  const stand = (point, file) => {
    writeSync(1, `SELFHEAL-KILL-POINT ${point} ${file}\n`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120_000);
    process.exit(70);
  };
  const bytesOf = (data, encoding) => (typeof data === "string" ? Buffer.from(data, typeof encoding === "string" ? encoding : "utf8") : Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  if (at === "before-commit") {
    // node:sqlite runs each statement and the COMMIT on the main thread, in order: once the slice's own write changed a row, the next
    // COMMIT is that slice's
    const run = StatementSync.prototype.run, exec = DatabaseSync.prototype.exec;
    let wrote = false;
    StatementSync.prototype.run = function (...args) {
      const result = Reflect.apply(run, this, args);
      if (String(this.sourceSQL).startsWith(write) && Number(result.changes) > 0) wrote = true;
      return result;
    };
    DatabaseSync.prototype.exec = function (sql) {
      if (wrote && /^\s*COMMIT\b/i.test(String(sql))) stand("before-commit", "-");
      return Reflect.apply(exec, this, [sql]);
    };
  } else if (at === "half-written") {
    // either way the server writes a file: writeFileSync(path), or openSync(path) + writeSync(fd) (counted-fs.ts under the io meter)
    const open = new Map();
    const torn = (fd, file, bytes) => { writeSync(fd, bytes, 0, bytes.length >> 1); fsyncSync(fd); stand("half-written", file); };
    fs.writeFileSync = (path, data, options) => {
      if (!theirs(path) || !mine(bytesOf(data, typeof options === "string" ? options : options?.encoding).toString("utf8"))) return writeFileSync(path, data, options);
      torn(openSync(path, "w"), path, bytesOf(data, typeof options === "string" ? options : options?.encoding));
    };
    fs.openSync = (path, ...rest) => { const fd = openSync(path, ...rest); if (theirs(path)) open.set(fd, path); return fd; };
    fs.closeSync = fd => { open.delete(fd); return closeSync(fd); };
    fs.writeSync = (fd, data, ...rest) => {
      const file = open.get(fd);
      if (file === undefined || typeof data === "string" || !mine(bytesOf(data).toString("utf8"))) return writeSync(fd, data, ...rest);
      torn(fd, file, bytesOf(data));
    };
  } else {
    fs.renameSync = (from, to) => {
      let text; try { text = readFileSync(from, "utf8"); } catch { text = ""; }
      if (String(to) !== note || !mine(text)) return renameSync(from, to);
      stand("before-rename", String(from));
    };
  }
  syncBuiltinESMExports();
}
