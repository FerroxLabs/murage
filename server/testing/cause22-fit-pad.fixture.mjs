#!/usr/bin/env node
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.21 group B witness rig (owner: lane cause22-eng; the wrapped fake engine belongs to its driver lane). Stands in for an engine
// CLI: runs the real fake engine (CAUSE22_REAL_CLI) with the same argv and environment and passes its stdin through unchanged. Its
// stdout passes through line by line, except that in every line holding the token @@PAD@@ the token becomes CAUSE22_PAD_UNITS
// "x" characters, written in 1 MiB pieces that honour drain, so the line the driver reads is the engine's real frame, longer than
// any string the runtime can hold. The token @@PADH@@ becomes CAUSE22_PADH_UNITS "x" the same way (a line a string can hold, but
// two of them pass the limit together). Lines keep their order. CAUSE22_PAD_FRAMES pads a named frame (below).
// CAUSE22_PAD_NULL_BEFORE names a frame (by `type` or `method`): before the first such frame the rig writes one extra line,
// CAUSE22_PAD_UNITS spaces then `null` (a JSON value that is not a frame, past the limit), then the frame itself unchanged.
import { spawn } from "node:child_process";

const real = process.env.CAUSE22_REAL_CLI;
const units = Number(process.env.CAUSE22_PAD_UNITS ?? "0");
const unitsH = Number(process.env.CAUSE22_PADH_UNITS ?? "0");
if (!real) { process.stderr.write("cause22 fit pad: CAUSE22_REAL_CLI is not set\n"); process.exit(2); }
const child = spawn(real, process.argv.slice(2), { stdio: ["pipe", "pipe", "inherit"], env: process.env });
child.on("error", (error) => { process.stderr.write(`cause22 fit pad: ${error.message}\n`); process.exit(2); });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); setTimeout(() => process.exit(), 50); });
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => child.kill(signal));
process.stdin.on("data", (chunk) => { if (!child.stdin.destroyed) child.stdin.write(chunk); });
process.stdin.on("end", () => child.stdin.end());
child.stdin.on("error", () => {});

const PIECE = 1024 * 1024;
const fill = "x".repeat(PIECE);
const spaces = " ".repeat(PIECE);
const queue = []; // strings, or {pad: n}
let busy = false;
const pump = () => {
  if (busy) return;
  while (queue.length) {
    const head = queue[0];
    let more;
    if (typeof head === "string") { queue.shift(); more = process.stdout.write(head); }
    else { const n = Math.min(PIECE, head.pad); head.pad -= n; if (head.pad === 0) queue.shift(); const text = head.space ? spaces : fill; more = process.stdout.write(n === PIECE ? text : text.slice(0, n)); }
    if (!more) { busy = true; process.stdout.once("drain", () => { busy = false; pump(); }); return; }
  }
};
// CAUSE22_PAD_FRAMES: a comma list of frame names. A JSON object line whose `type` or `method` is one of them gets one top-level
// member `"_pad":"@@PAD@@"` in front of its own members (each name once: the first such frame only), so the engine's real frame,
// every field unchanged, reaches the driver longer than any string.
const padNames = new Set((process.env.CAUSE22_PAD_FRAMES ?? "").split(",").filter(Boolean));
const nullIn = new Set((process.env.CAUSE22_PAD_NULL_IN ?? "").split(",").filter(Boolean));
const nullBefore = new Set((process.env.CAUSE22_PAD_NULL_BEFORE ?? "").split(",").filter(Boolean));
const padFrame = (line) => {
  if ((!padNames.size && !nullBefore.size) || !line.startsWith("{")) return line;
  let msg;
  try { msg = JSON.parse(line); } catch { return line; }
  const before = [msg?.type, msg?.method].find((n) => typeof n === "string" && nullBefore.has(n));
  if (before) { nullBefore.delete(before); return `@@PADS@@null\n${line}`; }
  const name = [msg?.type, msg?.method].find((n) => typeof n === "string" && padNames.has(n));
  if (!name) return line;
  padNames.delete(name);
  // CAUSE22_PAD_NULL_IN names a padded frame whose message.content also gets one `null` block at its end.
  if (nullIn.has(name) && Array.isArray(msg?.message?.content)) { nullIn.delete(name); msg.message.content.push(null); line = `${JSON.stringify(msg)}\n`; }
  return line.length > 2 ? `{"_pad":"@@PAD@@",${line.slice(1)}` : line;
};
let outBuf = "";
child.stdout.on("data", (chunk) => {
  outBuf += chunk.toString("utf8");
  let newline;
  while ((newline = outBuf.indexOf("\n")) !== -1) {
    let line = outBuf.slice(0, newline + 1); outBuf = outBuf.slice(newline + 1);
    line = padFrame(line);
    for (const piece of line.split(/(@@PAD[HS]?@@)/)) {
      if (piece === "@@PAD@@") queue.push({ pad: units });
      else if (piece === "@@PADS@@") queue.push({ pad: units, space: true });
      else if (piece === "@@PADH@@") queue.push({ pad: unitsH });
      else queue.push(piece);
    }
  }
  pump();
});
