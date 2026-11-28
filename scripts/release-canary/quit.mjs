// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { pathToFileURL } from "node:url";

function stamp(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size) };
}

export function markLog(log) {
  const fd = openSync(log, "r");
  try { return stamp(fstatSync(fd, { bigint: true })); }
  finally { closeSync(fd); }
}

function readLog(log, mark, allowNewFile) {
  const fd = openSync(log, "r");
  try {
    const current = stamp(fstatSync(fd, { bigint: true }));
    const same = current.dev === mark.dev && current.ino === mark.ino;
    if (!same && !allowNewFile) throw Error("NO_GRACEFUL_QUIT log boundary lost");
    const offset = same ? mark.size : 0;
    const length = current.size - offset;
    if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || length > 64 * 1024 * 1024) {
      throw Error("NO_GRACEFUL_QUIT invalid log boundary");
    }
    const bytes = Buffer.alloc(length);
    if (readSync(fd, bytes, 0, length, offset) !== length) throw Error("NO_GRACEFUL_QUIT log changed");
    return { same, bytes };
  } finally {
    closeSync(fd);
  }
}

export function logSlice(log, mark) {
  const current = readLog(log, mark, true);
  const bytes = current.same ? current.bytes : Buffer.concat([readLog(`${log}.1`, mark, false).bytes, current.bytes]);
  return bytes;
}

export function verifyQuit(log, mark) {
  const lines = logSlice(log, mark).toString("utf8");
  const stop = /^\[[^\]\n]+\] server stop reason=(?:quit|system-shutdown)\r?$/m.exec(lines);
  if (!stop || !/^\[[^\]\n]+\] exited code=0\r?$/m.test(lines.slice(stop.index + stop[0].length))) {
    throw Error("NO_GRACEFUL_QUIT shutdown markers missing");
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, log, boundary] = process.argv.slice(2);
  if (command === "mark") console.log(JSON.stringify(markLog(log)));
  else if (command === "verify") console.log(JSON.stringify({ graceful: verifyQuit(log, JSON.parse(boundary)) }));
  else throw Error("Usage: quit.mjs mark <server.log> | verify <server.log> <boundary JSON>");
}
