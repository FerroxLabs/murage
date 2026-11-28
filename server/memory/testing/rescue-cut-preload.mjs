// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test-only preload (node --import) for the rescue-copy stop witnesses (startmem-open-1022.test.ts): the real server starts, and the
// process is killed (SIGKILL, a power cut as the data folder sees it) right BEFORE one file-system step of the rescue copy runs.
// RESCUE_CUT="marker:<n>" stops before the n-th publish of memory-rescue.json (its rename from .next); RESCUE_CUT="folder:<n>" stops
// before the n-th rename or removal of a path inside a rescue folder or its scratch (any path naming "-rescue-"). Every such step is
// appended to RESCUE_CUT_LOG (when set), so a witness can see how many steps a start took.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const [kind, at] = String(process.env.RESCUE_CUT ?? "").split(":");
const target = Number(at);
const log = process.env.RESCUE_CUT_LOG;
const seen = { marker: 0, folder: 0 };
// RESCUE_CUT="after-marker:<n>": stop before the first rescue-folder step after the n-th marker publish
let afterMarker = 0, armed = false;
for (const op of ["renameSync", "rmSync"]) {
  const real = fs[op];
  fs[op] = function (...args) {
    const from = String(args[0]);
    const which = op === "renameSync" && from.endsWith("memory-rescue.json.next") ? "marker" : from.includes("-rescue-") ? "folder" : null;
    if (which === "marker") markerJustMoved = /"state":"complete"/.test(real0(from)) ? "complete" : "any";
    if (which) {
      seen[which] += 1;
      if (which === "marker") { afterMarker = seen.marker; armed = true; }
      if (which === "folder" && kind === "after-marker" && armed && afterMarker === target) process.kill(process.pid, "SIGKILL");
      if (which === "folder") armed = false;
      const to = op === "renameSync" ? String(args[1]) : "";
      note(`${which}:${seen[which]} ${op} ${from.slice(from.lastIndexOf("-rescue-"))} ${to.includes("-rescue-") ? to.slice(to.lastIndexOf("-rescue-")) : "-"}\n`);
      if (which === kind && seen[which] === target) process.kill(process.pid, "SIGKILL");
    }
    return real.apply(this, args);
  };
}
// the flushes, by path: a witness checks that what a marker names kept was flushed before the marker moved
const paths = new Map();
let inside = false;
const note = line => { if (!log || inside) return; inside = true; try { fs.appendFileSync(log, line); } finally { inside = false; } };
const realOpen = fs.openSync, realClose = fs.closeSync, realFsync = fs.fsyncSync;
fs.openSync = function (...args) { const fd = realOpen.apply(this, args); if (!inside) paths.set(fd, String(args[0])); return fd; };
fs.closeSync = function (fd) { paths.delete(fd); return realClose.call(this, fd); };
// RESCUE_FSYNC_EIO=folder: the flush of the rescue folder itself (not its scratch) fails with EIO, as a failing disk reports it;
// RESCUE_FSYNC_EIO=data: the flush of the data folder (behind every marker write) fails so
const eio = process.env.RESCUE_FSYNC_EIO ?? "";
const real0 = path => { try { return fs.readFileSync(path, "utf8"); } catch { return ""; } };
const dataDir = process.env.MURAGE_DATA_DIR ?? "";
let markerJustMoved = ""; // only the data folder flush right after a marker publish fails (other writers' flushes are left alone)
// folders made for a rescue copy, and every folder flush by its full path (a witness checks the parent's flush order)
const realMkdir = fs.mkdirSync;
fs.mkdirSync = function (...args) { const path = String(args[0]); if (path.includes("-rescue-")) note(`mkdir ${path.slice(path.lastIndexOf("-rescue-"))}\n`); return realMkdir.apply(this, args); };
syncBuiltinESMExports();
fs.fsyncSync = function (fd) {
  const any = paths.get(fd);
  if (any && !any.includes("-rescue-") && any !== dataDir) { try { if (fs.statSync(any).isDirectory()) note(`fsync-dir ${any}\n`); } catch { /* gone */ } }
  const path = paths.get(fd);
  if (path && path.includes("-rescue-")) note(`fsync ${path.slice(path.lastIndexOf("-rescue-"))}\n`);
  const markerFlush = path === dataDir ? markerJustMoved : "";
  if (path === dataDir) markerJustMoved = "";
  // RESCUE_FSYNC_EIO=data-complete: only the flush behind the marker that says the copy is complete fails
  if (path && ((eio === "folder" && /-rescue-[^/.]+$/.test(path)) || (eio === "data" && dataDir && markerFlush) || (eio === "data-complete" && markerFlush === "complete")))
    throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO", errno: -5, syscall: "fsync" });
  return realFsync.call(this, fd);
};
syncBuiltinESMExports();
