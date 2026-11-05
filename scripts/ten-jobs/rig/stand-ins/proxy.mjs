#!/usr/bin/env node
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Local stand-in for the Telegram Bot API (ten-jobs job 7, Connect Telegram), for the gate box only.
// Murage's Telegram transport talks to https://api.telegram.org and nothing else, so the rig runs the
// packaged app behind this HTTP proxy (HTTPS_PROXY + NODE_USE_ENV_PROXY, which the app's Node honours):
//   - CONNECT api.telegram.org:443 is answered HERE, over TLS with a leaf signed by a CA made for this run
//     only (linux.sh, trusted by this run's app through NODE_EXTRA_CA_CERTS). No real account, no real call.
//   - every other CONNECT is a plain byte tunnel to the real host (Flux Router and the engines keep working);
//     their TLS runs end to end, so nothing here can read them.
// It logs method names and tunnel hosts only, never a token, a path or a body.
//
//   node proxy.mjs <stand-in dir holding leaf.pem + leaf.key>     writes <dir>/proxy.port once listening
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { TLSSocket } from "node:tls";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = process.argv[2];
if (!DIR) { console.error("usage: proxy.mjs <stand-in dir>"); process.exit(2); }
const cert = readFileSync(join(DIR, "leaf.pem")), key = readFileSync(join(DIR, "leaf.key"));
const note = (line) => { try { appendFileSync(join(DIR, "telegram.log"), `${new Date().toISOString()} ${line}\n`); } catch { /* best effort */ } };

let messageId = 0;
const BOT = { id: 7000000001, is_bot: true, first_name: "Ten Jobs Gate", username: "tenjobs_gate_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false };
const telegram = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => { if (chunks.reduce((n, x) => n + x.length, 0) < 1 << 20) chunks.push(c); });
  req.on("end", () => {
    const m = /^\/bot[^/]+\/([A-Za-z]+)$/.exec(new URL(req.url ?? "/", "https://api.telegram.org").pathname);
    const method = m ? m[1] : "?";
    let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { body = {}; }
    note(`telegram ${method}`);
    const send = (o, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (!m) return send({ ok: false, error_code: 404, description: "Not Found" }, 404);
    if (method === "getMe") return send({ ok: true, result: BOT });
    if (method === "getUpdates") { // a long poll with nothing new: answer after a short wait, never a hot loop
      const wait = Math.min(Math.max(Number(body.timeout ?? 0), 0), 2) * 1000 || 1000;
      const t = setTimeout(() => send({ ok: true, result: [] }), wait); res.on("close", () => clearTimeout(t)); return;
    }
    if (method === "sendMessage") return send({ ok: true, result: { message_id: ++messageId, date: Math.floor(Date.now() / 1000), chat: { id: Number(body.chat_id) || 0, type: "private" }, text: String(body.text ?? "") } });
    if (method === "getWebhookInfo") return send({ ok: true, result: { url: "", has_custom_certificate: false, pending_update_count: 0 } });
    if (method === "getChat") return send({ ok: true, result: { id: Number(body.chat_id) || 0, type: "private" } });
    return send({ ok: true, result: true }); // deleteWebhook, setMyCommands, sendChatAction and the like
  });
});

const proxy = createServer((req, res) => { // plain-HTTP proxy requests: forwarded as they are
  let u; try { u = new URL(req.url ?? ""); } catch { res.writeHead(400); return res.end(); }
  if (u.protocol !== "http:") { res.writeHead(400); return res.end(); }
  note(`http ${u.hostname}`);
  const up = httpRequest({ host: u.hostname, port: u.port || 80, method: req.method, path: u.pathname + u.search, headers: req.headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
  up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(up);
});
proxy.on("connect", (req, socket, head) => {
  const [host, portText] = String(req.url ?? "").split(":"); const port = Number(portText) || 443;
  socket.on("error", () => {});
  if (host === "api.telegram.org") {
    note("connect api.telegram.org (stand-in)");
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) socket.unshift(head);
    const tls = new TLSSocket(socket, { isServer: true, cert, key });
    tls.on("error", () => {});
    telegram.emit("connection", tls);
    return;
  }
  note(`tunnel ${host}:${port}`);
  const up = connect(port, host, () => { socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head?.length) up.write(head); up.pipe(socket); socket.pipe(up); });
  up.on("error", () => { try { socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); } catch { /* gone */ } });
});
proxy.listen(0, "127.0.0.1", () => { writeFileSync(join(DIR, "proxy.port"), String(proxy.address().port)); note(`listening ${proxy.address().port}`); });
