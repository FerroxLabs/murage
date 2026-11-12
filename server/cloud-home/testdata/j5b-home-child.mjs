// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// J5b r7 child harness for server/cloud-home/home-events-channel.test.ts. A real node process that loads server/home-events.ts and takes one JSON command
// per stdin line, answering one JSON line on stdout. node:fs is wrapped BEFORE the module loads (the live bindings follow through
// syncBuiltinESMExports), so the child can (1) record the order of write, fsync and rename calls, (2) cut the outbox at an exact write, and (3) leave a
// barrier file right after the first fsync of the outbox. Faults are files under $J5B_CTL:
//   outbox-erofs   writes to and opens-for-write of home-events.outbox raise EROFS
//   outbox-eio     the same with EIO (T15: the append shim that raises EIO from then on)
//   outbox-short   content N: the next outbox write is cut to N bytes (a short count is returned), later writes raise ENOSPC while the file exists
//   outbox-dirfsync-after-rename   after the outbox compaction rename every directory fsync raises EIO while the file exists (T19)
//   now            content ms: Date.now() answers this number (a clock stepped back)
// Barrier: $J5B_CTL/barrier-after_outbox_fsync is created after the first fsync of the outbox.
// Commands: load | report {type,at,id} | abort {job} | stuck {stuck} | health | trace | drain {ms} | outbox | exit.
// Names the real module must provide (the design names them; the seams are the builders' to keep): reportHomeEvent, noteRestoreAborted(job),
// noteRestoreStuck(dir, markerFile, stuck), homeEventsHealthFields(env), loadHomeEventsOutbox(), drainHomeEvents(ms); env seams MURAGE_HOME_EVENTS_OUTBOX,
// MURAGE_HOME_EVENTS_ACK_FILE and MURAGE_HOME_EVENTS_ACK_UID (honoured only under VITEST or NODE_ENV=test). At base none exist, so every command
// falls back to the base call (spoolHomeEvent, eventSpoolFailures) and the test fails on the missing behavior, not on a missing export.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createInterface } from "node:readline";

const CTL = process.env.J5B_CTL;
const has = name => fs.existsSync(`${CTL}/${name}`);
const trace = [];
const pathOf = fd => { try { return fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { return ""; } };
const isOutbox = path => String(path).endsWith("home-events.outbox");
const failing = () => (has("outbox-erofs") ? "EROFS" : has("outbox-eio") ? "EIO" : null);
const fail = code => Object.assign(new Error(code), { code });
const real = { writeSync: fs.writeSync, fsyncSync: fs.fsyncSync, renameSync: fs.renameSync, openSync: fs.openSync, unlinkSync: fs.unlinkSync };
let shortArmed = false, barrier = false;

fs.writeSync = (fd, data, ...rest) => {
  const path = pathOf(fd);
  trace.push({ op: "write", path });
  if (isOutbox(path)) {
    if (failing()) throw fail(failing());
    if (has("outbox-fail-done") && Buffer.from(data).toString().includes(`"r":"done","id":"${fs.readFileSync(`${CTL}/outbox-fail-done`, "utf8").trim()}`)) throw fail("EIO");
    if (has("outbox-short")) {
      if (shortArmed) throw fail("ENOSPC");
      shortArmed = true;
      const count = Number(fs.readFileSync(`${CTL}/outbox-short`, "utf8").trim() || "7");
      const buffer = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
      return real.writeSync(fd, buffer.subarray(0, count));
    }
    shortArmed = false;
  }
  return real.writeSync(fd, data, ...rest);
};
fs.openSync = (path, flags, ...rest) => {
  const writing = typeof flags === "number" ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT)) !== 0 : /[wa+]/.test(String(flags));
  if (isOutbox(path) && writing && failing()) throw fail(failing());
  return real.openSync(path, flags, ...rest);
};
let renamedOutbox = false;
fs.fsyncSync = fd => {
  if (renamedOutbox && has("outbox-dirfsync-after-rename")) { try { if (fs.fstatSync(fd).isDirectory()) throw fail("EIO"); } catch (error) { if (error && error.code === "EIO") throw error; } }
  const result = real.fsyncSync(fd);
  let dir = false;
  try { dir = fs.fstatSync(fd).isDirectory(); } catch { /* closed */ }
  const path = pathOf(fd);
  trace.push({ op: "fsync", dir, path });
  if (isOutbox(path) && !barrier) { barrier = true; fs.writeFileSync(`${CTL}/barrier-after_outbox_fsync`, ""); }
  return result;
};
fs.renameSync = (from, to) => { trace.push({ op: "rename", from: String(from), to: String(to) }); const r = real.renameSync(from, to); if (isOutbox(to)) renamedOutbox = true; return r; };
fs.unlinkSync = path => {
  if (String(path) === process.env.J5B_STUCK_MARKER && has("crash-before-marker-clear")) {
    fs.writeFileSync(`${CTL}/barrier-before-marker-clear`, "");
    process.exit(86);
  }
  return real.unlinkSync(path);
};
const realNow = Date.now.bind(Date);
Date.now = () => (has("now") ? Number(fs.readFileSync(`${CTL}/now`, "utf8").trim()) : realNow());
syncBuiltinESMExports();

const he = await import(process.env.J5B_HOME_EVENTS_TS);
const eventsDir = process.env.MURAGE_HOME_EVENTS_DIR;
const marker = process.env.J5B_STUCK_MARKER;
const out = value => process.stdout.write(JSON.stringify(value) + "\n");

const commands = {
  load: () => { he.loadHomeEventsOutbox?.(); return {}; },
  report: c => { if (he.reportHomeEvent) he.reportHomeEvent(c.type, c.at, c.id); else he.spoolHomeEvent(eventsDir, c.type, c.at); return {}; },
  abort: c => { if (he.noteRestoreAborted) he.noteRestoreAborted(c.job); else he.spoolHomeEvent(eventsDir, "restore.aborted", Date.now()); return {}; },
  stuck: c => { he.noteRestoreStuck(eventsDir, marker, c.stuck); return {}; },
  health: () => ({ body: he.homeEventsHealthFields ? he.homeEventsHealthFields(process.env) : { eventSpoolFailures: he.homeEventSpoolFailures() } }),
  trace: () => ({ trace }),
  drain: async c => { const t0 = realNow(); if (!he.drainHomeEvents) throw fail("NO_DRAIN"); await he.drainHomeEvents(c.ms); return { elapsedMs: realNow() - t0 }; },
};
createInterface({ input: process.stdin }).on("line", line => {
  let command;
  try { command = JSON.parse(line); } catch { out({ error: "bad_command" }); return; }
  if (command.cmd === "exit") process.exit(0);
  Promise.resolve().then(() => commands[command.cmd](command)).then(value => out({ ok: true, ...value }), error => out({ ok: false, error: String(error && error.code || error) }));
});
out({ ready: true });
