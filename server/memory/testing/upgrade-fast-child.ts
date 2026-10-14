// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Child process of the timed upgrade test (upgrade-fast.test.ts): a miniature of the real server's start. It opens the database (the
// blocking part of the upgrade, with the pre-listen health responder answering on PORT), hands the port to a plain HTTP server that
// answers /api/health 200 with memoryIntegrity, and starts the background upgrade work. MURAGE_DATA_DIR and PORT come from the parent.
// GET /probe/withheld?thread=t0 answers whether replay of that conversation's outputs is withheld; GET /exit ends it.
// KILL_AFTER_SLICES=n ends the process abruptly (no clean shutdown) after n background slices, to test a resume.
import { createServer } from "node:http";
import { bootLaunchId } from "../boot-nonce.ts";
import { releasePreListenHealth, setPreListenHealthForTest } from "../upgrade-health.ts";

const port = Number(process.env.PORT);
// (the responder worker is unref'd, so something must hold the loop open while the handoff is awaited, as the real server's many handles do)
setInterval(() => {}, 1_000);
setPreListenHealthForTest(port);
const started = performance.now();
const say = (event: string, extra: Record<string, unknown> = {}) => process.stdout.write(`${JSON.stringify({ event, ms: Math.round(performance.now() - started), ...extra })}\n`);
say("start");
const { ancestryWithheld } = await import("../replay-lineage.ts");
const { database, memoryIntegrityStatus, startBackgroundUpgrade, writersHeldForIndexBuild } = await import("../../database.ts");
say("modules");
const db = database();
say("database-open");
await releasePreListenHealth();
let slices = 0;
const kill = Number(process.env.KILL_AFTER_SLICES ?? 0);
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const send = (code: number, body: unknown) => { const raw = JSON.stringify(body); res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(raw) }); res.end(raw); };
  if (url.pathname === "/api/health") return send(200, { app: "murage", pid: process.pid, launch: bootLaunchId(), static: true, memoryIntegrity: memoryIntegrityStatus() });
  if (url.pathname === "/probe/withheld") return send(200, { withheld: ancestryWithheld(db, url.searchParams.get("thread") ?? "t0"), gate: writersHeldForIndexBuild() });
  if (url.pathname === "/exit") { send(200, { ok: true }); setTimeout(() => process.exit(0), 20); return; }
  send(404, {});
});
server.listen(port, "127.0.0.1", () => {
  say("listening");
  const handle = startBackgroundUpgrade({ afterSlice: job => { slices++; if (kill && slices >= kill) { say("killed", { job }); process.exit(137); } } });
  void handle.done.then(() => say("background-done", { slices: handle.slices }));
});
