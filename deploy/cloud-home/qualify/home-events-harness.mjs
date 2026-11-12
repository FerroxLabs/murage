// SPDX-License-Identifier: AGPL-3.0-or-later
// J5b r7 rig app child: the BUILT home-events module, a RestoreJobStore stand-in, privilege drop to uid murage, and /api/health on 127.0.0.1:8830 (not
// through Caddy; the rig states that limit). Control routes for the tests (loopback only): POST /rig/abort {job}, POST /rig/finish (exit 75),
// POST /rig/stuck {stuck}. Barriers are files in J5B_HOME_BARRIER_DIR (r7: /run/j5b-home, tmpfiles.d makes it 0700 murage; murage-home.service is ProtectSystem=full so /run is writable). A fault
// point NOTES (creates barrier-<name> and continues) or STALLS (creates it, then blocks until release-<name> exists). Hold: /run/j5b-home/hold-ack makes the
// app skip ACK reads once extended mode is set (seam env MURAGE_HOME_EVENTS_HOLD_ACK, test only).
// SKELETON: the wiring to the built home-events module is completed by the builders once its API is final (r7).
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
const events = await import(process.env.J5B_HOME_EVENTS_JS);
const barriers = process.env.J5B_HOME_BARRIER_DIR ?? "/run/j5b-home";
mkdirSync(barriers, { recursive: true });
process.env.MURAGE_HOME_EVENTS_HOLD_ACK ??= `${barriers}/hold-ack`;
events.loadHomeEventsOutbox?.();
if (process.getuid?.() === 0 && process.env.J5B_DROP_UID) { process.setgid(Number(process.env.J5B_DROP_UID)); process.setuid(Number(process.env.J5B_DROP_UID)); }
createServer((req, res) => {
  const reply = (code, value) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  let body = "";
  req.on("data", c => { body += c; });
  req.on("end", () => {
    if (req.method === "GET" && req.url === "/api/health") return reply(200, { app: "murage", ...(events.homeEventsHealthFields?.(process.env) ?? {}) });
    if (req.method === "POST" && req.url === "/rig/abort") { events.noteRestoreAborted?.(JSON.parse(body).job); writeFileSync(`${barriers}/barrier-after_outbox_fsync`, ""); return reply(200, {}); }
    if (req.method === "POST" && req.url === "/rig/stuck") { events.noteRestoreStuck?.(process.env.MURAGE_HOME_EVENTS_DIR, process.env.J5B_STUCK_MARKER, JSON.parse(body).stuck); return reply(200, {}); }
    if (req.method === "POST" && req.url === "/rig/finish") { reply(200, {}); setTimeout(() => process.exit(75), 50); return; }
    reply(404, {});
  });
}).listen(8830, "127.0.0.1");
