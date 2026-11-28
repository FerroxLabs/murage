// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Built-in browser network options: an optional SOCKS5 proxy and an optional
// locale. Both are off unless set.
//
// Storage split: the plain file holds only `{ proxy: boolean, locale }`. The
// proxy URL (host, port, username, password) is one record sealed with the
// operating-system credential store, written under the same refusal rule as
// every other secret (secret-storage-policy.mjs). Nothing about the proxy is
// ever written in the clear.
//
// Chromium cannot log in to a SOCKS5 proxy. A proxy with credentials is
// therefore reached through a loopback-only relay that answers "no auth"
// locally and logs in upstream; the credentials never reach Chromium's proxy
// rules. Every proxy uses this relay so remote DNS answers can be checked
// and the actual CONNECT pinned to a public numeric address.
import { createServer, connect, isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { browserAddressAllowed } from "./browser-snapshot.cjs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { secretWriteRefusal } from "./secret-storage-policy.mjs";

const PLAIN_FILE = "browser-network.json";
const SEALED_FILE = "browser-proxy.bin";
const LOCALE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/;

export function parseSocks5Url(text) {
  let url;
  try { url = new URL(String(text ?? "")); } catch { throw new Error("The proxy must be a socks5:// address"); }
  if (url.protocol !== "socks5:") throw new Error("The proxy must be a socks5:// address");
  const port = Number(url.port);
  if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("The proxy needs a host and a port");
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) throw new Error("The proxy address has extra parts");
  const username = decodeURIComponent(url.username), password = decodeURIComponent(url.password);
  if (Buffer.byteLength(username) > 255 || Buffer.byteLength(password) > 255) throw new Error("The proxy login is too long");
  return { host: url.hostname.replace(/^\[|\]$/g, ""), port, username, password };
}

export function createBrowserProxyStore({ safeStorage, directory, platform = process.platform, fs = { chmod, mkdir, readFile, rename, rm, writeFile } }) {
  const plainFile = path.join(directory, PLAIN_FILE), sealedFile = path.join(directory, SEALED_FILE);
  const missing = (error) => error?.code === "ENOENT";
  const write = async (file, data) => {
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, data, { mode: 0o600 });
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600).catch(() => {});
  };
  return {
    /** Only first-use absence means off. Any damaged/locked configuration
     * rejects with a fixed message so the navigation gate fails closed. */
    async read() {
      try {
        let raw;
        try { raw = await fs.readFile(plainFile, "utf8"); }
        catch (error) {
          if (!missing(error)) throw error;
          // A sealed record without its marker is interrupted/damaged state,
          // not first use. Never silently fall back to the system network.
          try { await fs.readFile(sealedFile); }
          catch (sealedError) {
            if (missing(sealedError)) return { proxy: null, locale: null };
            throw sealedError;
          }
          throw new Error("Missing proxy marker");
        }
        const plain = JSON.parse(raw);
        if (!plain || typeof plain.proxy !== "boolean" ||
            (plain.locale !== null && (typeof plain.locale !== "string" || !LOCALE.test(plain.locale)))) throw new Error("Invalid network settings");
        const locale = plain.locale;
        if (!plain.proxy) return { proxy: null, locale };
        return { proxy: parseSocks5Url(JSON.parse(safeStorage.decryptString(await fs.readFile(sealedFile))).url), locale };
      } catch {
        // Underlying errors can include the supplied URL or credential-store
        // details; neither belongs in browser notices or startup logs.
        throw new Error("Browser network settings are unavailable");
      }
    },
    /** Only the keys given are changed. `proxyUrl: null` clears the proxy; `locale: null` clears the locale. */
    async save({ proxyUrl, locale } = {}) {
      // Explicitly replacing both fields also permits recovery from damaged settings.
      const current = proxyUrl !== undefined && locale !== undefined ? { proxy: null, locale: null } : await this.read();
      const nextLocale = locale === undefined ? current.locale : locale;
      if (nextLocale !== null && !LOCALE.test(String(nextLocale))) throw new Error("The locale must look like en-US");
      let sealed = null, proxyOn = current.proxy !== null;
      if (proxyUrl !== undefined && proxyUrl !== null) {
        parseSocks5Url(proxyUrl);
        const refusal = await secretWriteRefusal({ safeStorage, platform, env: {} });
        if (refusal) throw new Error(refusal);
        sealed = safeStorage.encryptString(JSON.stringify({ url: String(proxyUrl) }));
        proxyOn = true;
      } else if (proxyUrl === null) proxyOn = false;
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      if (sealed) await write(sealedFile, sealed);
      if (!proxyOn) await fs.rm(sealedFile, { force: true });
      await write(plainFile, JSON.stringify({ proxy: proxyOn, locale: nextLocale }));
    },
  };
}

// Owner of the relay, remote resolver, and surface contract: up-browser-proxy.
const PRIVATE_DESTINATION = "Local and private-network pages cannot be opened in the built-in browser";
const RESOLUTION_FAILED = "Could not resolve browser destination";

/** Read exactly one protocol field without dropping following fragments. The
 * socket stays paused until pipe() takes over after authentication/validation. */
function readBytes(socket, length) {
  if (length === 0) return Promise.resolve(Buffer.alloc(0));
  return new Promise((resolve, reject) => {
    const cleanup = () => { socket.off("readable", read); socket.off("error", failed); socket.off("end", failed); socket.off("close", failed); };
    const failed = () => { cleanup(); reject(new Error(RESOLUTION_FAILED)); };
    const read = () => {
      const bytes = socket.read(length);
      if (bytes) { cleanup(); resolve(bytes); }
      else if (socket.destroyed || socket.readableEnded) failed();
    };
    socket.on("readable", read); socket.once("error", failed); socket.once("end", failed); socket.once("close", failed);
    read();
  });
}

async function readSocksAddress(socket, type) {
  if (type === 1) return [...await readBytes(socket, 4)].join(".");
  if (type === 4) {
    const bytes = await readBytes(socket, 16);
    return Array.from({ length: 8 }, (_, i) => bytes.readUInt16BE(i * 2).toString(16)).join(":");
  }
  if (type === 3) return (await readBytes(socket, (await readBytes(socket, 1))[0])).toString("ascii");
  throw new Error(RESOLUTION_FAILED);
}

function numericConnect(address, port) {
  const family = isIP(address);
  let bytes;
  if (family === 4) bytes = Buffer.from(address.split(".").map(Number));
  else if (family === 6) {
    // Answers have already passed isIP/public-range checks. Expand the one
    // optional :: run; mapped IPv4 forms are refused by the address policy.
    const [left, right] = address.split("::");
    const leading = left ? left.split(":") : [], trailing = right ? right.split(":") : [];
    const words = right === undefined ? leading : [...leading, ...Array(8 - leading.length - trailing.length).fill("0"), ...trailing];
    bytes = Buffer.alloc(16); words.forEach((word, i) => bytes.writeUInt16BE(parseInt(word, 16), i * 2));
  } else throw new Error(RESOLUTION_FAILED);
  const targetPort = Buffer.alloc(2); targetPort.writeUInt16BE(port);
  return Buffer.concat([Buffer.from([5, 1, 0, family === 4 ? 1 : 4]), bytes, targetPort]);
}

/** A separate SOCKS connection used only for a numeric, public resolver. No
 * destination name is ever submitted to the machine's DNS resolver. */
async function resolverTunnel(proxy, sockets, timeoutMs) {
  const socket = connect(proxy.port, proxy.host); sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  socket.on("error", () => {});
  const timer = setTimeout(() => socket.destroy(), timeoutMs); timer.unref();
  socket.once("close", () => clearTimeout(timer));
  try {
    socket.write(Buffer.from([5, 2, 0, 2]));
    const method = await readBytes(socket, 2);
    if (method[0] !== 5) throw new Error(RESOLUTION_FAILED);
    if (method[1] === 2) {
      const user = Buffer.from(proxy.username), password = Buffer.from(proxy.password);
      socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([password.length]), password]));
      const auth = await readBytes(socket, 2);
      if (auth[0] !== 1 || auth[1] !== 0) throw new Error(RESOLUTION_FAILED);
    } else if (method[1] !== 0) throw new Error(RESOLUTION_FAILED);
    socket.write(numericConnect("1.1.1.1", 443));
    const reply = await readBytes(socket, 4);
    if (reply[0] !== 5 || reply[1] !== 0 || reply[2] !== 0) throw new Error(RESOLUTION_FAILED);
    await readSocksAddress(socket, reply[3]); await readBytes(socket, 2);
    return socket;
  } catch { socket.destroy(); throw new Error(RESOLUTION_FAILED); }
}

/** DNS-over-HTTPS through the chosen SOCKS proxy, with certificate-verified
 * TLS to a fixed public resolver. A/AAAA replies are bounded and never fall
 * back to local DNS. The relay rechecks on every CONNECT, defeating rebinding
 * between a cached surface decision and the connection actually opened. */
export function createProxyHostResolver(proxy, { secureConnect = tlsConnect, timeoutMs = 10000 } = {}) {
  const sockets = new Set();
  let closed = false;
  const query = async (hostname, type) => {
    if (closed) throw new Error(RESOLUTION_FAILED);
    const socket = await resolverTunnel(proxy, sockets, timeoutMs);
    let secured, agent;
    try {
      if (closed) throw new Error(RESOLUTION_FAILED);
      secured = secureConnect({ socket, servername: "cloudflare-dns.com", rejectUnauthorized: true });
      sockets.add(secured); secured.once("close", () => sockets.delete(secured));
      agent = new HttpAgent();
      agent.createConnection = () => secured;
      return await new Promise((resolve, reject) => {
        // HTTP framing over the already encrypted socket; this request cannot
        // create a direct connection or perform a local resolver lookup.
        const request = httpRequest({ host: "cloudflare-dns.com", path: `/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`, headers: { Accept: "application/dns-json", Connection: "close" }, agent }, response => {
          let bytes = 0, text = "";
          response.on("data", chunk => { bytes += chunk.length; if (bytes > 65536) request.destroy(new Error(RESOLUTION_FAILED)); else text += chunk.toString(); });
          response.on("error", reject);
          response.on("end", () => {
            try {
              if (response.statusCode !== 200) throw new Error(RESOLUTION_FAILED);
              const answer = JSON.parse(text);
              if (answer.Status !== 0) throw new Error(RESOLUTION_FAILED);
              resolve((answer.Answer ?? []).filter(record => record.type === type).map(record => ({ address: record.data })));
            } catch { reject(new Error(RESOLUTION_FAILED)); }
          });
        });
        request.on("error", reject); request.end();
      });
    } finally { agent?.destroy(); secured?.destroy(); socket.destroy(); }
  };
  const resolveHost = async hostname => {
    try {
      if (typeof hostname !== "string" || !hostname || hostname.length > 253) throw new Error(RESOLUTION_FAILED);
      const endpoints = (await Promise.all([query(hostname, 1), query(hostname, 28)])).flat();
      if (!endpoints.length) throw new Error(RESOLUTION_FAILED);
      return { endpoints };
    } catch { throw new Error(RESOLUTION_FAILED); }
  };
  resolveHost.close = () => { closed = true; for (const socket of sockets) socket.destroy(); };
  return resolveHost;
}

/** Loopback SOCKS5 server: authenticate upstream, resolve remotely, validate
 * every answer and forward only a checked numeric CONNECT. Credentials never
 * reach Chromium; neither proxy mode can bypass the destination boundary. */
export function createSocks5AuthRelay(proxy, { handshakeTimeoutMs = 10000, resolveHost = createProxyHostResolver(proxy) } = {}) {
  const { host, port, username, password } = proxy;
  const checkedResolveHost = async hostname => {
    const resolved = await resolveHost(hostname);
    const endpoints = resolved?.endpoints;
    if (!endpoints?.length) throw new Error(RESOLUTION_FAILED);
    if (!endpoints.every(endpoint => browserAddressAllowed(endpoint?.address))) throw new Error(PRIVATE_DESTINATION);
    return resolved;
  };
  const sockets = new Set();
  const server = createServer((client) => {
    sockets.add(client);
    let stage = "greeting", buffer = Buffer.alloc(0), upstream = null;
    const fail = () => { clearTimeout(timer); client.destroy(); upstream?.destroy(); };
    const timer = setTimeout(fail, handshakeTimeoutMs);
    timer.unref();
    client.on("close", () => { sockets.delete(client); fail(); });
    client.on("error", fail);
    const startUpstream = (request) => {
      // Begin authentication immediately, but collect CONNECT's complete
      // (possibly fragmented) address before forwarding any destination.
      client.unshift(request);
      const target = (async () => {
        const header = await readBytes(client, 4);
        if (header[0] !== 5 || header[1] !== 1 || header[2] !== 0) throw new Error(RESOLUTION_FAILED);
        let address = await readSocksAddress(client, header[3]);
        const targetPort = (await readBytes(client, 2)).readUInt16BE(0);
        if (header[3] === 3) address = (await checkedResolveHost(address)).endpoints[0].address;
        if (!browserAddressAllowed(address)) throw new Error(PRIVATE_DESTINATION);
        return numericConnect(address, targetPort);
      })();
      target.catch(fail);
      upstream = connect(port, host); sockets.add(upstream); upstream.on("close", () => { sockets.delete(upstream); client.destroy(); }); upstream.on("error", fail);
      let step = "method", inbox = Buffer.alloc(0);
      upstream.once("connect", () => upstream.write(Buffer.from([5, 2, 0, 2])));
      const forward = () => {
        step = "connecting";
        void target.then(request => {
          if (client.destroyed || upstream.destroyed) return;
          upstream.write(request);
          clearTimeout(timer);
          upstream.off("data", onData);
          if (inbox.length) client.write(inbox);
          upstream.pipe(client); client.pipe(upstream);
        }).catch(fail);
      };
      const onData = (chunk) => {
        inbox = Buffer.concat([inbox, chunk]);
        if (step === "method") {
          if (inbox.length < 2) return;
          if (inbox[0] !== 5) return fail();
          const method = inbox[1]; inbox = inbox.subarray(2);
          if (method === 2) {
            const u = Buffer.from(username), p = Buffer.from(password);
            upstream.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p])); step = "auth";
          } else if (method === 0) forward(); else return fail();
        }
        if (step === "auth") {
          if (inbox.length < 2) return;
          if (inbox[0] !== 1 || inbox[1] !== 0) return fail();
          inbox = inbox.subarray(2); forward();
        }
      };
      upstream.on("data", onData);
    };
    const onClientData = (chunk) => {
      if (stage === "pipe") return;
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === "greeting") {
        if (buffer.length < 2) return;
        if (buffer[0] !== 5) return fail();
        if (buffer.length < 2 + buffer[1]) return;
        if (!buffer.subarray(2, 2 + buffer[1]).includes(0)) return fail();
        buffer = buffer.subarray(2 + buffer[1]); client.write(Buffer.from([5, 0])); stage = "request";
      }
      if (stage === "request" && buffer.length) { stage = "pipe"; client.pause(); client.off("data", onClientData); startUpstream(buffer); }
    };
    client.on("data", onClientData);
  });
  return new Promise((resolve, reject) => {
    server.once("error", error => { resolveHost.close?.(); reject(error); });
    server.listen(0, "127.0.0.1", () => resolve({
      port: server.address().port,
      address: server.address().address,
      resolveHost: checkedResolveHost,
      close() { server.close(); for (const socket of sockets) socket.destroy(); resolveHost.close?.(); },
    }));
  });
}

/** Point one Electron session at the saved settings. Without a proxy the session keeps the system's behaviour. */
export async function applyBrowserNetwork(ses, settings, { startRelay = createSocks5AuthRelay, resolveHost } = {}) {
  const { proxy, locale } = settings ?? {};
  let relay = null;
  try {
    if (proxy) {
      relay = await startRelay(proxy, { resolveHost });
      await ses.setProxy({ mode: "fixed_servers", proxyRules: `socks5://127.0.0.1:${relay.port}` });
    } else await ses.setProxy({ mode: "system" });
    if (locale) ses.setUserAgent(ses.getUserAgent?.() ?? "", locale);
    return { remoteDns: Boolean(proxy), resolveHost: relay?.resolveHost, close() { relay?.close(); relay = null; } };
  } catch (error) { relay?.close(); throw error; }
}

/** Configuration entry point, before desktop startup. Launch the closed app
 * with --browser-network-config and supply JSON on stdin:
 * {"proxyUrl":"socks5://…:1080", "locale":"en-US"}.
 * Use null to clear a field. Credentials never appear in argv or output.
 * Supplying both fields explicitly can repair unreadable previous settings. */
export async function runBrowserNetworkCommand({ argv, input, store, ready, exit, write, timeoutMs = 30000 }) {
  if (!argv.includes("--browser-network-config")) return false;
  try {
    const text = await new Promise((resolve, reject) => {
      let value = "", bytes = 0;
      const finish = (error) => {
        clearTimeout(timer); input.pause();
        input.off("data", data); input.off("end", end); input.off("error", failed);
        if (error) reject(error); else resolve(value);
      };
      const data = chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 16384) return finish(new Error("Input limit"));
        value += chunk.toString();
      };
      const end = () => finish();
      const failed = () => finish(new Error("Input failed"));
      const timer = setTimeout(() => finish(new Error("Input timed out")), timeoutMs);
      input.setEncoding("utf8"); input.on("data", data); input.once("end", end); input.once("error", failed); input.resume();
    });
    const settings = JSON.parse(text);
    if (!settings || typeof settings !== "object" || Array.isArray(settings) ||
        Object.keys(settings).some(key => !["proxyUrl", "locale"].includes(key)) ||
        Object.values(settings).some(value => value !== null && typeof value !== "string")) throw new Error("Invalid input");
    await ready();
    await store.save(settings);
    write("Browser network settings saved. Restart Murage to apply them.\n");
    exit(0);
  } catch {
    write("Browser network settings could not be saved.\n");
    exit(1);
  }
  return true;
}
