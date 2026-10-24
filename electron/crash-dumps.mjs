// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Local crash dumps. When a window or the app itself crashes, Crashpad writes a
// minidump into app.getPath("crashDumps") so we can see why. Dumps stay on this
// computer: the reporter is started with uploads off and no server address, and
// cloud-links-guards.node-test.mjs fails the build if that ever changes. A dump
// can hold memory contents, so the diagnostics export copies one only when the
// person asks for it (see includeCrashDumpOnRequest). Dependencies are injected
// so everything here is unit-testable without Electron.
import fs from "node:fs";
import path from "node:path";

export const CRASH_DUMP_KEEP = 10;
export const CRASH_DUMP_MAX_BYTES = 200 * 1024 * 1024;
// Crashpad names a report by its UUID. Anything else is not ours to name or remove.
const DUMP_NAME = /^[A-Za-z0-9._-]{1,128}\.dmp$/;
// Crashpad keeps reports in new/, pending/ and completed/ under the dump folder.
const MAX_DEPTH = 2;

export function isCrashDumpName(name) {
  return typeof name === "string" && DUMP_NAME.test(name);
}

/** Start Crashpad for local dumps only. Electron requires this in the main
 * process before app "ready"; it then covers renderer and child processes too. */
export function startLocalCrashReporter(crashReporter) {
  try {
    crashReporter.start({ uploadToServer: false, submitURL: "", compress: true });
    return true;
  } catch {
    // A missing crash reporter must never stop the app from starting.
    return false;
  }
}

/** Regular .dmp files under the dump folder, newest first. Symlinks and
 * hard-linked files are skipped: they are not dumps Crashpad wrote for us. */
export function listCrashDumps(directory, fsImpl = fs) {
  const dumps = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (depth < MAX_DEPTH) walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !isCrashDumpName(entry.name)) continue;
      try {
        const stats = fsImpl.lstatSync(full);
        if (!stats.isFile() || stats.nlink !== 1) continue;
        dumps.push({ name: entry.name, path: full, size: stats.size, mtimeMs: stats.mtimeMs });
      } catch { /* vanished while listing */ }
    }
  };
  if (typeof directory === "string" && directory) walk(directory, 0);
  return dumps.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? 1 : -1));
}

/** Keep the newest `keep` dumps within `maxBytes` in total and remove the rest,
 * with Crashpad's matching .meta file. The newest dump is always kept, so the
 * crash we most likely need survives even when it alone is large. */
export function pruneCrashDumps(directory, { keep = CRASH_DUMP_KEEP, maxBytes = CRASH_DUMP_MAX_BYTES, fsImpl = fs } = {}) {
  const dumps = listCrashDumps(directory, fsImpl);
  const kept = [];
  const removed = [];
  let total = 0;
  for (const dump of dumps) {
    if (kept.length === 0 || (kept.length < keep && total + dump.size <= maxBytes)) {
      kept.push(dump);
      total += dump.size;
      continue;
    }
    try {
      fsImpl.unlinkSync(dump.path);
      removed.push(dump);
    } catch { continue; }
    try { fsImpl.unlinkSync(dump.path.replace(/\.dmp$/, ".meta")); } catch { /* none */ }
  }
  return { kept, removed };
}

/** The newest dump written at or after `sinceMs` that no earlier crash line has
 * claimed. A small allowance covers coarse file-system clocks. */
export function freshCrashDump(directory, { sinceMs, claimed = new Set(), fsImpl = fs, allowanceMs = 5_000 } = {}) {
  for (const dump of listCrashDumps(directory, fsImpl)) {
    if (claimed.has(dump.name)) continue;
    if (Number.isFinite(sinceMs) && dump.mtimeMs < sinceMs - allowanceMs) return null;
    return dump;
  }
  return null;
}

/** Dump names that already appear in the crash log, so a dump is named once. */
export function crashDumpNamesInLog(text) {
  const names = new Set();
  for (const match of String(text ?? "").matchAll(/\bdump=([A-Za-z0-9._-]{1,128}\.dmp)\b/g)) names.add(match[1]);
  return names;
}

/** Waits briefly for Crashpad to finish a dump after a process is gone, then
 * writes one crash line that names it (or says there is none). Pending lines
 * are written at once on flush(), so an app exit never drops them. */
export function createCrashDumpLinker({
  directory,
  write,
  claimed = new Set(),
  now = Date.now,
  schedule = (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; },
  cancel = (timer) => clearTimeout(timer),
  fsImpl = fs,
  checksMs = [1_500, 4_000],
}) {
  const pending = new Set();
  const find = (sinceMs) => {
    const dump = freshCrashDump(directory(), { sinceMs, claimed, fsImpl });
    if (dump) claimed.add(dump.name);
    return dump?.name ?? null;
  };
  const settle = (entry, dumpName) => {
    if (!pending.delete(entry)) return;
    for (const timer of entry.timers) cancel(timer);
    write({ ...entry.event, dump: dumpName ?? "none" });
  };
  const record = (event) => {
    const sinceMs = now();
    const immediate = find(sinceMs);
    const entry = { event, sinceMs, timers: [] };
    pending.add(entry);
    if (immediate) return settle(entry, immediate);
    checksMs.forEach((ms, index) => {
      entry.timers.push(schedule(() => {
        const name = find(sinceMs);
        if (name || index === checksMs.length - 1) settle(entry, name);
      }, ms));
    });
  };
  const flush = () => { for (const entry of [...pending]) settle(entry, find(entry.sinceMs)); };
  return { record, flush };
}

/** A dump from an earlier run that no crash line names: the app itself closed
 * before it could write one. Returns the names, oldest first, for one line each. */
export function unnamedCrashDumps(directory, claimed, fsImpl = fs) {
  return listCrashDumps(directory, fsImpl).filter((dump) => !claimed.has(dump.name)).reverse().map((dump) => dump.name);
}

export const CRASH_DUMP_QUESTION = {
  message: "Add the latest crash file to your report?",
  detail: "A crash file shows us why Murage closed. It can hold parts of what was open at the time, such as messages, so it is only added when you choose it. It is saved next to your report and goes nowhere else unless you send it.",
  buttons: ["Leave it out", "Add crash file"],
};

/** After a diagnostics report is saved, offer the newest dump. Nothing is
 * copied unless ask() resolves to true. The copy sits beside the report, is
 * never overwritten onto an existing file, and is private to the user. */
export async function includeCrashDumpOnRequest({ reportPath, directory, ask, fsImpl = fs, platform = process.platform }) {
  if (typeof reportPath !== "string" || !reportPath) return null;
  const [latest] = listCrashDumps(directory, fsImpl);
  if (!latest) return null;
  if ((await ask(CRASH_DUMP_QUESTION)) !== true) return null;
  const target = path.join(path.dirname(reportPath), `${path.basename(reportPath).replace(/\.txt$/i, "")}-crash.dmp`);
  fsImpl.copyFileSync(latest.path, target, fs.constants.COPYFILE_EXCL);
  if (platform !== "win32") fsImpl.chmodSync(target, 0o600);
  return target;
}
