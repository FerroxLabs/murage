// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { appendFileSync, createReadStream, lstatSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { join } from "node:path";
import { pipeline } from "node:stream";
import { pathToFileURL } from "node:url";
import { RELEASES_OWNER, RELEASES_REPO } from "../../electron/updater-fallback.mjs";

const github = "github.com";
const api = "api.github.com";
const origin = `https://${github}`;
const base = `/${RELEASES_OWNER}/${RELEASES_REPO}/releases`;
const loopback = "127.0.0.1";
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const filenamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

async function checkedAssets(dir, manifest) {
  if (manifest?.schema !== "murage-canary-manifest/1" || !versionPattern.test(manifest.version ?? "")) {
    throw Error("Invalid canary manifest");
  }
  const entries = Object.entries(manifest.assets ?? {});
  if (!entries.length) throw Error("Invalid canary manifest");
  const assets = new Map();
  for (const [name, expected] of entries) {
    if (!filenamePattern.test(name) || !Number.isSafeInteger(expected?.size) || expected.size < 1 ||
        !/^[0-9a-f]{64}$/.test(expected.sha256 ?? "")) throw Error("Invalid canary manifest asset");
    const file = join(dir, name);
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size !== expected.size) throw Error(`ARTIFACT_MISMATCH ${name}`);
    const hash = createHash("sha256");
    for await (const part of createReadStream(file)) hash.update(part);
    if (hash.digest("hex") !== expected.sha256) throw Error(`ARTIFACT_MISMATCH ${name}`);
    assets.set(name, { file, size: stat.size });
  }
  return assets;
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, loopback, () => resolve(server.address().port));
  });
}

function serveAsset(asset, rangeHeader, res) {
  const { file, size } = asset;
  if (rangeHeader === undefined) {
    res.writeHead(200, { "content-length": size, "accept-ranges": "bytes" });
    pipeline(createReadStream(file), res, () => {});
    return 200;
  }
  const range = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
  const start = range ? Number(range[1]) : size;
  const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start > end) {
    res.writeHead(416, { "content-range": `bytes */${size}` }).end();
    return 416;
  }
  res.writeHead(206, {
    "content-length": end - start + 1,
    "content-range": `bytes ${start}-${end}/${size}`,
    "accept-ranges": "bytes",
  });
  pipeline(createReadStream(file, { start, end }), res, () => {});
  return 206;
}

export async function startFeed({ dir, manifest, from, cert, key, log, tlsPort = 0, proxyPort }) {
  if (!versionPattern.test(from ?? "") || from === manifest?.version) throw Error("Invalid baseline version");
  const assets = await checkedAssets(dir, manifest);
  const tag = `v${manifest.version}`;
  const prefix = `${base}/download/${tag}/`;
  const release = JSON.stringify({
    tag_name: tag, draft: false, prerelease: false,
    assets: [...assets.keys()].map(name => ({ name, browser_download_url: `${origin}${prefix}${name}` })),
  });
  const atom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Release notes</title>${[tag, `v${from}`].map(entry =>
    `<entry><link href="${origin}${base}/tag/${entry}"/><title>${entry}</title><content type="html">canary</content></entry>`
  ).join("")}</feed>`;
  const record = event => appendFileSync(log, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  const sockets = new Set();
  const tls = https.createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
    const path = req.url.split("?", 1)[0];
    const hostname = req.headers.host;
    const name = path.startsWith(prefix) ? path.slice(prefix.length) : "";
    if (req.method === "GET" && hostname === github && assets.has(name)) {
      record({ route: "asset", name, status: serveAsset(assets.get(name), req.headers.range, res) });
    } else if (req.method === "GET" && hostname === github && path === `${base}.atom`) {
      record({ route: "atom", status: 200 });
      res.writeHead(200, { "content-type": "application/atom+xml" }).end(atom);
    } else if (req.method === "GET" && ((hostname === github && path === `${base}/latest`) ||
        (hostname === api && path === `/repos${base}/latest`))) {
      record({ route: hostname === github ? "latest" : "api-latest", status: 200 });
      res.writeHead(200, { "content-type": "application/json" }).end(release);
    } else {
      record({ route: "denied", status: 404 });
      res.writeHead(404).end();
    }
  });
  const proxy = http.createServer((_req, res) => res.writeHead(403).end());
  const servers = proxyPort === undefined ? [tls] : [tls, proxy];
  for (const server of servers) {
    server.on("connection", socket => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
  }
  const close = async () => {
    const closed = servers.map(server => new Promise(resolve => server.close(() => resolve())));
    for (const socket of sockets) socket.destroy();
    await Promise.all(closed);
  };
  try {
    tlsPort = await listen(tls, tlsPort);
    if (proxyPort !== undefined) {
      proxy.on("connect", (req, socket, head) => {
        if (req.url !== `${github}:443` && req.url !== `${api}:443`) {
          socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          return;
        }
        // Both known origins terminate in the local fixture. There is no outbound proxy connection.
        const local = net.connect(tlsPort, loopback, () => {
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length) local.write(head);
          socket.pipe(local).pipe(socket);
        });
        socket.on("error", () => local.destroy());
        local.on("error", () => socket.destroy());
        socket.once("close", () => local.destroy());
        local.once("close", () => socket.destroy());
      });
      proxyPort = await listen(proxy, proxyPort);
    }
    return { tlsPort, proxyPort, close };
  } catch (error) {
    await close();
    throw error;
  }
}

// O23 S1 control: a HASH-VALID, SIGNATURE-INVALID payload (re-signed or unsigned, with a manifest recomputed to match
// it) served on its own port. A byte-flip control proves nothing about signatures: the yml sha512 refuses it first.
// Normal mode (startFeed) keeps refusing any byte not in the real manifest; this mode refuses to start for a real leg.
const qualProbeId = /^qual-[a-z0-9][a-z0-9-]{0,39}$/;
export async function startControlFeed({ legId, ...options }) {
  if (!qualProbeId.test(legId ?? "")) throw Error("CONTROL_FEED_REFUSED leg is not a qual probe");
  return startFeed(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const control = process.argv[2] === "--control";
  const [dir, manifestFile, from, cert, key, log, tls = "443", proxy, legId] = process.argv.slice(control ? 3 : 2);
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  const feed = await (control ? (o) => startControlFeed({ legId, ...o }) : startFeed)({ dir, manifest, from, cert, key, log, tlsPort: Number(tls),
    proxyPort: proxy === undefined ? undefined : Number(proxy) });
  console.log(JSON.stringify({ tlsPort: feed.tlsPort, proxyPort: feed.proxyPort }));
}
