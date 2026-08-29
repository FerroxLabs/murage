// The loopback door into the browser surface for the bot's own process.
//
// A bot's tools run inside its agent CLI, which the harness spawned — two
// processes away from the Electron main process that owns the views. The
// harness already talks to Electron-owned things through a descriptor file
// (cua-connection.json): Electron writes where to connect and a per-boot
// secret, the server reads it and hands the two values to the proxy. This
// host is that door for the browser: bound to 127.0.0.1 on an ephemeral
// port, bearer-token gated, JSON in / JSON out, one route per verb.
//
// It exposes only the surface's verbs — never the app window, never the
// renderer, never a debugging port on OpenMausBot itself. The manager is
// looked up per request: windows come and go (macOS keeps the app alive
// with none open), the host and its token outlive them.
"use strict";

const http = require("node:http");
const { randomBytes } = require("node:crypto");

const MAX_BODY_BYTES = 64 * 1024;
const OPERATIONS = new Set([
  "state",
  "navigate",
  "back",
  "forward",
  "snapshot",
  "click",
  "hover",
  "drag",
  "fill",
  "type",
  "press",
  "scroll",
  "select",
  "wait",
  "read",
  "screenshot",
]);
const BOT_ROUTE = /^\/v1\/bots\/([A-Za-z0-9_-]{1,120})\/([a-z]+)$/;

function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

const isString = (value) => Object.prototype.toString.call(value) === "[object String]";

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw.trim()) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && Object.prototype.toString.call(parsed) === "[object Object]" ? parsed : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

/** Map a verb + body onto the manager; the body's field names are the tool
 * argument names the proxy uses, kept in one place here. */
async function perform(manager, botId, operation, body) {
  // "" pins the bot's own session; a name pins a profile; absent leaves
  // whatever view is active alone
  const profile = isString(body.profile) ? body.profile : undefined;
  switch (operation) {
    case "state":
      return manager.state(botId);
    case "navigate":
      return manager.navigate(botId, body.url, profile);
    case "back":
      return manager.back(botId, profile);
    case "forward":
      return manager.forward(botId, profile);
    case "snapshot":
      return manager.snapshot(botId, profile);
    case "click":
      return manager.click(botId, body.ref, { button: body.button, clickCount: body.double === true ? 2 : 1, profile });
    case "hover":
      return manager.hover(botId, body.ref, profile);
    case "drag":
      return manager.drag(botId, body.from, body.to, profile);
    case "fill":
      return manager.fill(botId, body.ref, body.text, profile);
    case "type":
      return manager.type(botId, body.text, profile);
    case "press":
      return manager.press(botId, body.key, profile);
    case "scroll":
      return manager.scroll(botId, body.direction, body.amount, profile);
    case "select":
      return manager.select(botId, body.ref, body.values, profile);
    case "wait":
      return manager.waitFor(botId, { text: body.text, url: body.url, timeoutMs: body.timeoutMs }, profile);
    case "read":
      return manager.read(botId, profile);
    case "screenshot":
      return manager.screenshot(botId, profile);
    default:
      throw new Error(`unknown browser operation: ${operation}`);
  }
}

/**
 * @param {object} options
 * @param {() => (ReturnType<import("./browser-surface.cjs").createBrowserSurfaceManager> | null)} options.manager
 *   getter — the current window's surface, or null when no window is open
 * @param {string} [options.token] 64 hex chars; generated per boot when absent
 */
function createBrowserHost({ manager, token = randomBytes(32).toString("hex") }) {
  const currentManager = manager?.constructor === Function ? manager : () => manager;
  if (!manager) throw new Error("The browser surface manager is required");
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("The browser host token must be 64 hex characters");
  let server = null;
  let url = null;

  const handle = async (req, res) => {
    if (!isLoopback(req.socket.remoteAddress)) return json(res, 403, { error: "loopback only" });
    const authorization = String(req.headers.authorization ?? "");
    if (authorization !== `Bearer ${token}`) return json(res, 401, { error: "unauthorized" });
    const path = String(req.url ?? "").split("?")[0];
    const surface = currentManager();
    if (req.method === "GET" && path === "/v1/health") return json(res, 200, { ok: true, views: surface ? surface.size() : 0, window: Boolean(surface) });
    const match = BOT_ROUTE.exec(path);
    if (!match || req.method !== "POST") return json(res, 404, { error: "not found" });
    const [, botId, operation] = match;
    if (!OPERATIONS.has(operation)) return json(res, 404, { error: "unknown browser operation" });
    if (!surface) return json(res, 503, { error: "the OpenMausBot window is closed — open it to use the browser" });
    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      return json(res, 400, { error: error?.message ?? "invalid request" });
    }
    try {
      const result = await perform(surface, botId, operation, body);
      return json(res, 200, result ?? {});
    } catch (error) {
      const message = error?.message ?? String(error);
      // Stale refs, refused navigations and timeouts are the bot's to correct;
      // everything else is the surface's.
      const status = /stale|unknown|not visible|gone|required|invalid|limited|unsupported|Only |no previous|no next|must be|timed out|no option|not a select|changed since/i.test(message)
        ? 400
        : 500;
      return json(res, status, { error: message });
    }
  };

  return {
    get token() {
      return token;
    },
    get url() {
      return url;
    },
    start() {
      if (url) return Promise.resolve(url);
      server = http.createServer((req, res) => {
        handle(req, res).catch((error) => {
          try {
            json(res, 500, { error: error?.message ?? "browser host failure" });
          } catch {}
        });
      });
      server.on("connection", (socket) => {
        if (!isLoopback(socket.remoteAddress)) socket.destroy();
      });
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          url = `http://127.0.0.1:${address.port}`;
          resolve(url);
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
        server = null;
        url = null;
      });
    },
    /** What the harness needs to reach this host: written to the descriptor file. */
    descriptor() {
      if (!url) throw new Error("The browser host is not listening");
      return { version: 1, url, token, pid: process.pid };
    },
  };
}

module.exports = { OPERATIONS, createBrowserHost };
