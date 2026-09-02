// The browser door, against a fake harness.
//
// A fake rather than the real server, deliberately: what these have to prove
// is what the door *sends upstream* and what it *refuses at the front*, and
// both are invisible from behind a real harness. The fake records the exact
// request it received, so "the client cannot forge the surface marker" is an
// assertion about bytes rather than about intent.
//
// `proxy.test.ts` covers the other half — a real harness, a real stream — for
// the device door, and the forwarding here is the same shape.
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  browserBindHost,
  rebindBrowserDoor,
  tailnetBindAddress,
  browserLabel,
  clearedCookie,
  cookieName,
  createBrowserHandler,
  forwardedHeaders,
  forwardedPath,
  hostOf,
  originGate,
  readCookie,
  sessionCookie,
  staticContentType,
  type BoundIdentity,
  type BrowserDeviceStore,
} from "../src/browser.ts";
import { createConnectedDeviceTracker } from "../src/connected-devices.ts";

/** What the fake harness saw last. */
interface Seen {
  method: string;
  url: string;
  headers: NodeJS.Dict<string | string[]>;
}

let harness: Server;
let harnessPort = 0;
let seen: Seen | null = null;
/** Set by a test to make the next static request behave like the harness's
 * SPA fallback, which answers a miss with index.html at status 200. */
let staticMode: "present" | "spa-fallback" | "no-static-dir" = "present";
let streamRes: { end: () => void } | null = null;

let door: Server;
let doorPort = 0;

const DEVICE = { id: "dev_1", name: "Sean's iPhone", cloudDesktopAccess: false };

/** A device store with one paired device, one pairing credential, and one
 * live session. Structural, so the whole world is four fields. */
const sessions = new Map<string, { expiresAt: number }>();
let redeemable = "murage_pair_good";
const devices: BrowserDeviceStore = {
  redeem: (credential) =>
    credential === redeemable
      ? { device: { ...DEVICE, createdAt: 1, lastSeenAt: 1 }, token: "murage_raw_bearer_never_leaves" }
      : { error: "that pairing credential is not right" },
  openSession: (deviceId) => {
    if (deviceId !== DEVICE.id) return null;
    const value = `murage_browser_${sessions.size}_${Math.random().toString(36).slice(2)}`;
    const session = { expiresAt: Date.now() + 90 * 24 * 3600 * 1000 };
    sessions.set(value, session);
    return { value, session };
  },
  resolveSession: (value) => {
    const session = value ? sessions.get(value) : undefined;
    return session ? { device: DEVICE, session } : null;
  },
  closeSession: (value) => (value ? sessions.delete(value) : false),
};

const identity: BoundIdentity = {
  scheme: "http",
  hosts: new Set(["macbook.tail0a48a4.ts.net", "100.79.121.109", "127.0.0.1"]),
};
let currentIdentity = identity;

const tracker = createConnectedDeviceTracker();

beforeAll(async () => {
  harness = createServer((req, res) => {
    seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers };
    const path = (req.url ?? "/").split("?")[0];

    if (path === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ kind: "runtime" })}\n\n`);
      streamRes = { end: () => res.end() };
      return;
    }
    if (path.startsWith("/assets/") || path === "/" || path === "/index.html" || path === "/manifest.webmanifest") {
      if (staticMode === "no-static-dir") {
        res.writeHead(404, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: `no route: GET ${path}` }));
      }
      if (staticMode === "spa-fallback" && path.startsWith("/assets/")) {
        // Exactly what server/index.ts:9124 does on a miss.
        res.writeHead(200, { "content-type": "text/html" });
        return res.end("<!doctype html><title>Murage</title>");
      }
      if (path === "/manifest.webmanifest") {
        // The harness MIME table has no entry, so it falls to octet-stream.
        res.writeHead(200, { "content-type": "application/octet-stream" });
        return res.end('{"name":"Murage"}');
      }
      const type = path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html";
      res.writeHead(200, { "content-type": type });
      return res.end(type === "text/html" ? "<!doctype html><title>Murage</title>" : "export default 1;");
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, saw: req.url }));
  });
  await new Promise<void>((r) => harness.listen(0, "127.0.0.1", r));
  harnessPort = (harness.address() as AddressInfo).port;

  door = createServer(
    createBrowserHandler({
      harnessPort,
      identity: () => currentIdentity,
      devices,
      connected: tracker.open,
      headersTimeoutMs: 4000,
    }),
  );
  await new Promise<void>((r) => door.listen(0, "127.0.0.1", r));
  doorPort = (door.address() as AddressInfo).port;
});

afterAll(async () => {
  door.closeAllConnections?.();
  harness.closeAllConnections?.();
  await new Promise<void>((r) => door.close(() => r()));
  await new Promise<void>((r) => harness.close(() => r()));
});

interface Answer {
  status: number;
  headers: IncomingMessage["headers"];
  body: string;
}

/** One request at the door. Defaults are what a same-origin browser sends. */
const knock = (
  method: string,
  path: string,
  extra: Record<string, string> = {},
  body?: string,
): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      host: `macbook.tail0a48a4.ts.net:${doorPort}`,
      "sec-fetch-site": "same-origin",
      ...extra,
    };
    if (body !== undefined) headers["content-type"] ??= "application/json";
    const req = request({ hostname: "127.0.0.1", port: doorPort, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });

/** A browser that has signed in, as a Cookie header. */
const signedIn = async (): Promise<Record<string, string>> => {
  const answer = await knock(
    "POST",
    "/session",
    { origin: `http://macbook.tail0a48a4.ts.net:${doorPort}` },
    JSON.stringify({ credential: redeemable }),
  );
  expect(answer.status).toBe(201);
  const set = String(answer.headers["set-cookie"]?.[0] ?? "");
  const value = set.slice(set.indexOf("=") + 1, set.indexOf(";"));
  return { cookie: `${cookieName("http")}=${value}` };
};

/** Writes carry an Origin; that is the whole reason the gate can require it. */
const write = (extra: Record<string, string> = {}) => ({
  origin: `http://macbook.tail0a48a4.ts.net:${doorPort}`,
  ...extra,
});

// ─────────────────────────────────────────────────────────────────────────
// THE ONE THAT MATTERS
// ─────────────────────────────────────────────────────────────────────────
//
// `requestSurface` (server/sse-visibility.ts) resolves in this order:
// `x-murage-companion: "1"` → remote, checked FIRST; then
// `x-murage-surface: desktop` → desktop; then `?surface=desktop` → desktop.
//
// A browser can type `?surface=desktop` into a URL bar. If either the header
// stamp or the query strip failed, one query parameter would give any browser
// tab an unscoped grep of every transcript on the machine — silently, and
// visible only to whoever is reading the stream.
describe("the surface marker cannot be forged or cleared", () => {
  it("stamps x-murage-companion into a header set built from nothing", async () => {
    const cookie = await signedIn();
    seen = null;
    const answer = await knock("GET", "/api/bots", {
      ...cookie,
      // Every spelling of the lie, at once.
      "x-murage-companion": "0",
      "x-murage-surface": "desktop",
      "tailscale-user-login": "attacker@example.com",
      "tailscale-user-name": "Attacker",
      "x-forwarded-for": "203.0.113.9",
      "x-forwarded-proto": "https",
      authorization: "Bearer stolen",
    });
    expect(answer.status).toBe(200);

    // The marker is ours, not theirs.
    expect(seen!.headers["x-murage-companion"]).toBe("1");
    // And nothing the client said about identity or surface travelled.
    for (const forged of [
      "x-murage-surface",
      "tailscale-user-login",
      "tailscale-user-name",
      "x-forwarded-for",
      "x-forwarded-proto",
      "authorization",
      "cookie",
      "origin",
    ]) {
      expect(seen!.headers[forged], forged).toBeUndefined();
    }
    // `host` is Node's own, pointed at loopback — never the browser's.
    expect(String(seen!.headers.host)).toBe(`127.0.0.1:${harnessPort}`);
  });

  it("deletes ?surface from the URL it replays upstream", async () => {
    const cookie = await signedIn();
    seen = null;
    const answer = await knock("GET", "/api/bots?surface=desktop&limit=5", cookie);
    expect(answer.status).toBe(200);
    expect(seen!.url).toBe("/api/bots?limit=5");
    expect(seen!.url).not.toContain("surface");
  });

  it("does the same on the live stream, which is where the leak would be worst", async () => {
    const cookie = await signedIn();
    seen = null;
    const answer = await new Promise<{ status: number }>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: doorPort,
          path: "/api/events?surface=desktop",
          method: "GET",
          headers: { host: `macbook.tail0a48a4.ts.net:${doorPort}`, "sec-fetch-site": "same-origin", ...cookie },
        },
        (res) => {
          res.on("data", () => {
            resolve({ status: res.statusCode ?? 0 });
            req.destroy();
          });
        },
      );
      req.on("error", () => {});
      req.end();
      setTimeout(() => reject(new Error("no stream")), 3000).unref?.();
    });
    expect(answer.status).toBe(200);
    expect(seen!.url).toBe("/api/events");
    expect(seen!.headers["x-murage-companion"]).toBe("1");
    expect(seen!.headers["x-murage-surface"]).toBeUndefined();
    streamRes?.end();
  });

  // The unit form of the same property, so a refactor of the handler cannot
  // quietly drop it without a second failure pointing straight at the cause.
  it("builds the forwarded header set from nothing, as a function", () => {
    const out = forwardedHeaders({
      headers: {
        "x-murage-companion": "0",
        "x-murage-surface": "desktop",
        "tailscale-user-login": "attacker@example.com",
        cookie: "murage_session=abc",
        authorization: "Bearer stolen",
        host: "evil.example",
        origin: "https://evil.example",
        accept: "application/json",
      },
    } as unknown as IncomingMessage);
    expect(out).toEqual({ accept: "application/json", "x-murage-companion": "1" });
  });

  it("strips only the surface parameter, and only when it is there", () => {
    expect(forwardedPath("/api/bots")).toBe("/api/bots");
    expect(forwardedPath("/api/bots?limit=5")).toBe("/api/bots?limit=5");
    expect(forwardedPath("/api/bots?surface=desktop")).toBe("/api/bots");
    expect(forwardedPath("/api/bots?a=1&surface=desktop&b=2")).toBe("/api/bots?a=1&b=2");
    expect(forwardedPath("/api/bots?surface=desktop&surface=desktop")).toBe("/api/bots");
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("the front gate", () => {
  it("refuses a Host it did not bind", async () => {
    const answer = await knock("GET", "/", { host: "evil.example" });
    expect(answer.status).toBe(403);
    expect(JSON.parse(answer.body).error).toBe("forbidden: unexpected host");
  });

  it("refuses same-site — which is what two ports on one hostname are", async () => {
    // `SameSite` cookies do not see this: site is scheme plus registrable
    // domain, and ports are not part of it. Murage runs four listeners on one
    // MagicDNS name, so this check is the one that actually holds.
    for (const site of ["same-site", "cross-site"]) {
      const answer = await knock("GET", "/api/bots", { "sec-fetch-site": site });
      expect(answer.status, site).toBe(403);
    }
  });

  it("refuses a request with no Sec-Fetch-Site at all", async () => {
    const answer = await new Promise<Answer>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: doorPort,
          path: "/",
          method: "GET",
          headers: { host: `macbook.tail0a48a4.ts.net:${doorPort}` },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(answer.status).toBe(403);
  });

  it("lets a typed URL reach the shell and nothing else", async () => {
    // `none` is a bookmark or an address bar — a navigation with no
    // initiator. Fine for the page, never for an API route. Without a
    // session the page is a sentence rather than a JSON object, and still
    // a 401 rather than a redirect.
    const cookie = await signedIn();
    expect((await knock("GET", "/", { "sec-fetch-site": "none", ...cookie })).status).toBe(200);
    const anonymous = await knock("GET", "/", { "sec-fetch-site": "none" });
    expect(anonymous.status).toBe(401);
    expect(String(anonymous.headers["content-type"])).toContain("text/html");
    expect(anonymous.body).toContain("Not signed in");
    expect((await knock("GET", "/api/bots", { "sec-fetch-site": "none" })).status).toBe(403);
    expect((await knock("POST", "/session", { "sec-fetch-site": "none" }, "{}")).status).toBe(403);
  });

  it("refuses a foreign Origin, and a write that carries none", async () => {
    const cookie = await signedIn();
    const foreign = await knock("POST", "/api/bots", { ...cookie, origin: "https://evil.example" }, "{}");
    expect(foreign.status).toBe(403);
    const bare = await knock("POST", "/api/bots", cookie, "{}");
    expect(bare.status).toBe(403);
    expect(JSON.parse(bare.body).error).toBe("forbidden: cross-origin request");
  });

  it("emits no CORS headers, ever", async () => {
    // Without them a cross-origin read is opaque, so a GET that slipped a
    // gate still leaks nothing back to the page that made it. This is also
    // why there is no CSRF token on reads.
    const cookie = await signedIn();
    for (const answer of [
      await knock("GET", "/"),
      await knock("GET", "/api/bots", cookie),
      await knock("GET", "/api/bots"),
      await knock("GET", "/", { host: "evil.example" }),
      await knock("GET", "/enter"),
    ]) {
      for (const header of Object.keys(answer.headers)) {
        expect(header.startsWith("access-control-"), header).toBe(false);
      }
    }
  });

  it("parses a bracketed IPv6 authority rather than mangling it", () => {
    expect(hostOf("[::1]:8813")).toBe("::1");
    expect(hostOf("[::1].evil.example")).toBe("[::1].evil.example");
    expect(hostOf("macbook.tail0a48a4.ts.net:8813")).toBe("macbook.tail0a48a4.ts.net");
  });

  it("says no to every rule in turn, as a function", () => {
    const ask = (headers: Record<string, string>, method = "GET", url = "/api/bots") =>
      originGate({ headers, method, url } as unknown as IncomingMessage, identity);
    const host = "macbook.tail0a48a4.ts.net:8813";
    expect(ask({ host, "sec-fetch-site": "same-origin" })).toBeNull();
    expect(ask({ host: "evil.example", "sec-fetch-site": "same-origin" })?.error).toBe("forbidden: unexpected host");
    expect(ask({ host })).not.toBeNull();
    expect(ask({ host, "sec-fetch-site": "same-site" })).not.toBeNull();
    expect(ask({ host, "sec-fetch-site": "none" })).not.toBeNull();
    expect(ask({ host, "sec-fetch-site": "none" }, "GET", "/")).toBeNull();
    expect(
      ask({ host, "sec-fetch-site": "same-origin", origin: "http://macbook.tail0a48a4.ts.net:8813" }),
    ).toBeNull();
    expect(ask({ host, "sec-fetch-site": "same-origin", origin: "http://evil.example" })).not.toBeNull();
    expect(ask({ host, "sec-fetch-site": "same-origin" }, "POST")).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("sessions", () => {
  it("puts the credential in a cookie and never in the body", async () => {
    const answer = await knock(
      "POST",
      "/session",
      write(),
      JSON.stringify({ credential: redeemable }),
    );
    expect(answer.status).toBe(201);
    // The raw device bearer is generated, hashed and discarded inside the
    // sidecar. A body page script can read is a body an XSS can read.
    expect(answer.body).not.toContain("murage_raw_bearer_never_leaves");
    expect(answer.body).not.toContain("murage_browser_");
    expect(JSON.parse(answer.body)).toEqual({ ok: true, device: { name: "Sean's iPhone" } });

    const set = String(answer.headers["set-cookie"]?.[0] ?? "");
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Strict");
    expect(set).toContain("Path=/");
    // Host-only. `ts.net` is a public suffix, so a Domain cookie would be
    // scoped to every node in the tailnet.
    expect(set).not.toContain("Domain");
  });

  it("upgrades to __Host- and Secure the day the tailnet has certificates", () => {
    const http = sessionCookie("abc", { scheme: "http", hosts: new Set() }, 60);
    expect(http.startsWith("murage_session=abc")).toBe(true);
    expect(http).not.toContain("Secure");

    const https = sessionCookie("abc", { scheme: "https", hosts: new Set() }, 60);
    expect(https.startsWith("__Host-murage_session=abc")).toBe(true);
    expect(https).toContain("Secure");
    // __Host- forbids Domain and forces Path=/; both must hold or the prefix
    // is rejected by the browser and the cookie is silently dropped.
    expect(https).not.toContain("Domain");
    expect(https).toContain("Path=/");
    expect(clearedCookie({ scheme: "https", hosts: new Set() })).toContain("Max-Age=0");
  });

  it("refuses a wrong credential without opening anything", async () => {
    const before = sessions.size;
    const answer = await knock("POST", "/session", write(), JSON.stringify({ credential: "nope" }));
    expect(answer.status).toBe(401);
    expect(sessions.size).toBe(before);
  });

  it("answers who-am-i, and signs one browser out", async () => {
    const cookie = await signedIn();
    const who = await knock("GET", "/session", cookie);
    expect(who.status).toBe(200);
    expect(JSON.parse(who.body).device).toEqual({ name: "Sean's iPhone" });

    const out = await knock("DELETE", "/session", write(cookie));
    expect(out.status).toBe(200);
    expect(String(out.headers["set-cookie"]?.[0] ?? "")).toContain("Max-Age=0");
    expect((await knock("GET", "/session", cookie)).status).toBe(401);
    expect((await knock("GET", "/api/bots", cookie)).status).toBe(401);
  });

  it("reads one cookie out of a header that holds several", () => {
    expect(readCookie("a=1; murage_session=xyz=; b=2", "murage_session")).toBe("xyz=");
    expect(readCookie("murage_sessionx=no", "murage_session")).toBeUndefined();
    expect(readCookie(undefined, "murage_session")).toBeUndefined();
    expect(readCookie("murage_session=", "murage_session")).toBeUndefined();
  });

  it("serves first contact from the fragment, never the query string", async () => {
    const answer = await knock("GET", "/enter");
    expect(answer.status).toBe(200);
    // A fragment is never sent to the server, never enters an access log, and
    // never leaks through Referer.
    expect(answer.body).toContain("location.hash");
    // And the page clears it before it does anything else.
    expect(answer.body).toContain('history.replaceState(null, "", "/enter")');
    expect(answer.body).not.toContain("location.search");
    const csp = String(answer.headers["content-security-policy"] ?? "");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9+/=]+'/);
    expect(csp).toContain("frame-ancestors 'none'");
    // The one unauthenticated route on this door, and it needs no cookie.
    expect(answer.headers["set-cookie"]).toBeUndefined();
  });

  it("labels a browser from its user agent, clamped like a device name", () => {
    expect(browserLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit Version/17.0 Safari/605")).toBe(
      "Safari on iPhone",
    );
    expect(browserLabel("Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537")).toBe("Chrome on Windows");
    expect(browserLabel(undefined)).toBe("Browser");
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("the allowlist, at this door", () => {
  it("refuses an unauthenticated API request with a place to go", async () => {
    const answer = await knock("GET", "/api/bots");
    expect(answer.status).toBe(401);
    expect(JSON.parse(answer.body)).toEqual({ error: "sign in", signIn: "/enter" });
  });

  it("refuses the execution routes even with a valid session", async () => {
    const cookie = await signedIn();
    for (const [method, path] of [
      ["POST", "/api/cli-test"],
      ["PATCH", "/api/instances/claude"],
      ["POST", "/api/local-computer/start"],
      ["POST", "/api/bots/bot_123/local-computer/exec"],
    ] as const) {
      seen = null;
      const answer = await knock(method, path, write(cookie), "{}");
      expect(answer.status, `${method} ${path}`).toBe(404);
      // Refused at the door: the harness never heard of it.
      expect(seen, `${method} ${path}`).toBeNull();
    }
  });

  it("forwards what it does allow", async () => {
    const cookie = await signedIn();
    seen = null;
    expect((await knock("GET", "/api/bots", cookie)).status).toBe(200);
    expect(seen!.url).toBe("/api/bots");
  });

  it("keeps cloud desktop off unless the computer owner turned it on", async () => {
    const cookie = await signedIn();
    seen = null;
    const answer = await knock("POST", "/api/bots/bot_123/computer/join", write(cookie), "{}");
    expect(answer.status).toBe(403);
    expect(seen).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("the static shell", () => {
  it("serves the shell and its assets through the harness", async () => {
    staticMode = "present";
    const cookie = await signedIn();
    const shell = await knock("GET", "/", cookie);
    expect(shell.status).toBe(200);
    expect(shell.headers["content-type"]).toBe("text/html; charset=utf-8");

    const asset = await knock("GET", "/assets/index-B7zzSDok.js", cookie);
    expect(asset.status).toBe(200);
    expect(asset.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(asset.headers["cache-control"]).toContain("immutable");
  });

  it("does NOT accept the harness's SPA fallback for a missing asset", async () => {
    // server/index.ts:9124 answers a miss with index.html, content-type
    // text/html, status 200. A service worker precaching a stale hashed asset
    // would cache HTML under a .js URL and break the app in a way that
    // survives reload. The door turns that into a 404.
    staticMode = "spa-fallback";
    const answer = await knock("GET", "/assets/index-STALEHASH.js", await signedIn());
    staticMode = "present";
    expect(answer.status).toBe(404);
    expect(answer.body).not.toContain("<!doctype html>");
    expect(String(answer.headers["content-type"])).toContain("application/json");
  });

  it("gives a manifest the type the harness MIME table has no entry for", async () => {
    // The harness maps eight extensions and .webmanifest is not one, so it
    // falls to application/octet-stream and the browser ignores it. The
    // door's own table is the fix that lives in this lane.
    staticMode = "present";
    const answer = await knock("GET", "/manifest.webmanifest", await signedIn());
    expect(answer.status).toBe(200);
    expect(answer.headers["content-type"]).toBe("application/manifest+json");
  });

  it("404s a static path nobody allowlisted, without asking the harness", async () => {
    const cookie = await signedIn();
    seen = null;
    for (const path of ["/secrets.txt", "/assets/../devices.json", "/assets/x.exe", "/random-page"]) {
      const answer = await knock("GET", path, { "sec-fetch-site": "none", ...cookie });
      expect(answer.status, path).toBe(404);
    }
    expect(seen).toBeNull();
  });

  it("says so in a sentence when the desktop app is not serving the UI", async () => {
    staticMode = "no-static-dir";
    const answer = await knock("GET", "/", await signedIn());
    staticMode = "present";
    expect(answer.status).toBe(503);
    expect(JSON.parse(answer.body).error).toBe("the desktop app is not serving the UI");
  });

  it("knows which allowed paths are static and what type they are", () => {
    expect(staticContentType("/")).toBe("text/html; charset=utf-8");
    expect(staticContentType("/chat/bot_123")).toBe("text/html; charset=utf-8");
    expect(staticContentType("/assets/index-B7zzSDok.css")).toBe("text/css; charset=utf-8");
    expect(staticContentType("/manifest.webmanifest")).toBe("application/manifest+json");
    expect(staticContentType("/api/bots")).toBeNull();
    expect(staticContentType("/assets/evil.exe")).toBeNull();
    // NC16 in the negative-control run: widening the allowlist check inside
    // this function did not turn anything red, because `denyReason` refuses
    // an unlisted path first. It is still the wrong function to widen, so
    // the extension-less cases — the ones that would otherwise fall through
    // to "serve it as HTML" — are pinned here directly.
    expect(staticContentType("/random-page")).toBeNull();
    expect(staticContentType("/chat/bot_123/extra/deep")).toBeNull();
    expect(staticContentType("/index.htmlx")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("the live stream", () => {
  it("registers with the tracker, so a revoke kills it in flight", async () => {
    const cookie = await signedIn();
    const opened = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: doorPort,
          path: "/api/events",
          method: "GET",
          headers: { host: `macbook.tail0a48a4.ts.net:${doorPort}`, "sec-fetch-site": "same-origin", ...cookie },
        },
        (res) => res.once("data", () => resolve(res)),
      );
      req.on("error", reject);
      req.end();
      setTimeout(() => reject(new Error("no stream")), 4000).unref?.();
    });
    expect(opened.statusCode).toBe(200);
    // Present, by device id, the same way the device port's streams are.
    expect(tracker.ids()).toContain(DEVICE.id);

    const closed = new Promise<void>((r) => opened.once("close", () => r()));
    // What control.ts calls on revoke.
    expect(tracker.disconnect(DEVICE.id)).toBe(true);
    await closed;
    expect(tracker.ids()).not.toContain(DEVICE.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("where this door may bind", () => {
  it("never offers 0.0.0.0, and refuses to start rather than fall back", () => {
    expect(browserBindHost("loopback", null)).toBe("127.0.0.1");
    expect(browserBindHost("loopback", "100.79.121.109")).toBe("127.0.0.1");
    expect(browserBindHost("tailnet", "100.79.121.109")).toBe("100.79.121.109");
    // Falling back to 0.0.0.0 "so it works" is how a tailnet-only door
    // becomes a LAN door, and nobody would see it happen.
    expect(() => browserBindHost("tailnet", null)).toThrow(/no Tailscale address/i);
  });

  it("auto takes the tailnet when there is one and loopback when there is not", () => {
    // The shipped setting, and the only one that is right on a laptop: a
    // demand for the tailnet refuses to start before Tailscale is signed in,
    // and a demand for loopback leaves a signed-in tailnet with no door on it.
    expect(browserBindHost("auto", "100.79.121.109", "100.79.121.109")).toBe("100.79.121.109");
    expect(browserBindHost("auto", "100.79.121.109")).toBe("100.79.121.109");
    expect(browserBindHost("auto", null)).toBe("127.0.0.1");
    // and it says why, rather than silently being loopback
    const declined: string[] = [];
    expect(browserBindHost("auto", null, null, (r) => declined.push(r))).toBe("127.0.0.1");
    expect(declined).toEqual(["this machine has no Tailscale address"]);
  });

  it("refuses an address Tailscale and the interface table disagree about", () => {
    // 100.64/10 is CGNAT space and Tailscale does not own it. A carrier-grade
    // -NAT uplink or a second mesh VPN puts a real address in that range in
    // front of the one Tailscale issued, and the interface picker takes the
    // first one it finds — so the door would open on a network nobody chose.
    const disagreement = tailnetBindAddress("100.64.0.7", "100.79.121.109");
    expect(disagreement).toEqual({
      refused: expect.stringContaining("Something else is using Tailscale's address range"),
    });
    // auto declines the address rather than the process
    const declined: string[] = [];
    expect(browserBindHost("auto", "100.64.0.7", "100.79.121.109", (r) => declined.push(r))).toBe(
      "127.0.0.1",
    );
    expect(declined[0]).toMatch(/will not pick between them/);
    // an operator who wrote `tailnet` down meant it, and gets a refusal
    expect(() => browserBindHost("tailnet", "100.64.0.7", "100.79.121.109")).toThrow(
      /Something else is using Tailscale's address range/,
    );
  });

  it("refuses an address no interface actually carries", () => {
    // Nothing can bind an address the kernel does not have. Saying so beats
    // an EADDRNOTAVAIL from three frames away.
    expect(tailnetBindAddress(null, "100.79.121.109")).toEqual({
      refused: expect.stringContaining("no interface on this machine carries that address"),
    });
    expect(browserBindHost("auto", null, "100.79.121.109")).toBe("127.0.0.1");
  });

  it("treats a missing CLI answer as no evidence, not as a disagreement", () => {
    // Tailscale may simply not be installed where we looked. The interface
    // address is then the only evidence there is, and it is the same one the
    // pairing page has always printed.
    expect(tailnetBindAddress("100.79.121.109", null)).toEqual({ address: "100.79.121.109" });
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("moving the door without restarting the sidecar", () => {
  /** The sidecar's own bind helper, minus the error decoration. */
  const bind = (server: Server, port: number, host: string) =>
    new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    });

  const freePort = async (): Promise<number> => {
    const probe = createServer();
    await bind(probe, 0, "127.0.0.1");
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));
    return port;
  };

  it("does nothing at all when the address has not changed", async () => {
    const server = createServer();
    const port = await freePort();
    await bind(server, port, "127.0.0.1");
    try {
      let listens = 0;
      const result = await rebindBrowserDoor({
        server,
        port,
        boundHost: "127.0.0.1",
        desiredHost: () => "127.0.0.1",
        listen: async (...args) => {
          listens += 1;
          return bind(...args);
        },
      });
      expect(result).toEqual({ host: "127.0.0.1", note: "already bound to 127.0.0.1" });
      // The socket was never touched, so no browser session was dropped.
      expect(listens).toBe(0);
      expect(server.listening).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("moves the door, and only the door", async () => {
    const server = createServer((_req, res) => res.end("door"));
    const port = await freePort();
    await bind(server, port, "127.0.0.1");
    // A second listener standing in for the device port: it must survive.
    const untouched = createServer();
    const otherPort = await freePort();
    await bind(untouched, otherPort, "127.0.0.1");
    try {
      const result = await rebindBrowserDoor({
        server,
        port,
        boundHost: "127.0.0.1",
        // 0.0.0.0 is never a real destination here; ::1 is a second loopback
        // this machine has, which is enough to prove the socket moved.
        desiredHost: () => "::1",
        listen: bind,
      });
      expect(result.host).toBe("::1");
      expect(result.note).toBe("moved from 127.0.0.1 to ::1");
      expect(server.listening).toBe(true);
      expect(untouched.listening).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await new Promise<void>((r) => untouched.close(() => r()));
    }
  });

  it("puts the door back where it was when the new address will not bind", async () => {
    const server = createServer();
    const port = await freePort();
    await bind(server, port, "127.0.0.1");
    try {
      const result = await rebindBrowserDoor({
        server,
        port,
        boundHost: "127.0.0.1",
        // an address this machine does not have
        desiredHost: () => "100.99.99.99",
        listen: bind,
      });
      expect(result.host).toBe("127.0.0.1");
      expect(result.note).toMatch(/^could not bind 100\.99\.99\.99 .*stayed on 127\.0\.0\.1$/);
      // Still answering on the address the panel was told about.
      expect(server.listening).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("leaves the door where it is when the mode refuses to name an address", async () => {
    // `tailnet` mode with no tailnet throws out of desiredHost. That is not a
    // reason to close a working socket.
    const server = createServer();
    const port = await freePort();
    await bind(server, port, "127.0.0.1");
    try {
      const result = await rebindBrowserDoor({
        server,
        port,
        boundHost: "127.0.0.1",
        desiredHost: () => {
          throw new Error("the browser door is set to bind the Tailscale address and cannot");
        },
        listen: bind,
      });
      expect(result.host).toBe("127.0.0.1");
      expect(result.note).toMatch(/set to bind the Tailscale address/);
      expect(server.listening).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("the word that must never appear", () => {
  it("has no `funnel` anywhere in the sidecar", async () => {
    // `tailscale serve` is tailnet-scoped. `tailscale funnel` is the public
    // internet. The two subcommands differ by one word and the difference is
    // the whole security model — Wayland shipped a bug that was exactly this
    // substitution. A lint that reads the source is cheap insurance.
    const { readdirSync, readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
    const offenders: string[] = [];
    for (const name of readdirSync(src)) {
      if (!name.endsWith(".ts")) continue;
      const text = readFileSync(join(src, name), "utf8");
      // The one permitted mention is the comment saying never to use it.
      for (const [i, line] of text.split("\n").entries()) {
        if (!/funnel/i.test(line)) continue;
        if (/never|not\b|rather than|public internet|differ by one word/i.test(line)) continue;
        offenders.push(`${name}:${i + 1}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the door a person actually taps", () => {
  const identity = { scheme: "http" as const, host: "phone.tail0a48a4.ts.net", port: 8813, hosts: new Set(["phone.tail0a48a4.ts.net"]) };
  const ask = (headers: Record<string, string>, url = "/enter", method = "GET") =>
    originGate({ method, url, headers: { host: "phone.tail0a48a4.ts.net:8813", ...headers } } as never, identity as never);

  // Sean pasted the pairing link to his phone, tapped it, and got
  // "forbidden: cross-origin request". `none` is only ever sent for a URL
  // TYPED into the address bar; tapping a link in Messages, mail, a notes app
  // or a QR scanner is a navigation with an initiator, and every browser
  // sends `cross-site` for that. The door refused the one flow it exists for.
  it("lets a phone open the shell from a link in another app", () => {
    for (const site of ["cross-site", "same-site"]) {
      expect(
        ask({ "sec-fetch-site": site, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }),
        `a tapped link sending Sec-Fetch-Site: ${site} must reach the shell`,
      ).toBeNull();
    }
    // A browser too old to send Sec-Fetch at all is STILL refused — see the
    // note in originGate. Pinned here so widening it is a deliberate act.
    expect(ask({ accept: "text/html" })).toMatchObject({ status: 403 });
    // the two that already worked keep working
    expect(ask({ "sec-fetch-site": "none", "sec-fetch-mode": "navigate" })).toBeNull();
    expect(ask({ "sec-fetch-site": "same-origin" })).toBeNull();
  });

  // The exemption is a NAVIGATION exemption. It must not become a hole for
  // the data routes, which is where cross-site and same-site actually bite.
  it("still refuses a cross-site request for anything but the shell", () => {
    // an API read, dressed as a navigation, from another site
    expect(
      ask({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }, "/api/bots"),
    ).toMatchObject({ status: 403 });
    // a subresource fetch, not a navigation
    expect(ask({ "sec-fetch-site": "cross-site", "sec-fetch-dest": "empty" })).toMatchObject({ status: 403 });
    // a write, which is never a safe method
    expect(
      ask({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", origin: "http://evil.example" }, "/enter", "POST"),
    ).toMatchObject({ status: 403 });
    // and the host allowlist still comes first
    expect(
      originGate(
        { method: "GET", url: "/enter", headers: { host: "evil.example", "sec-fetch-mode": "navigate" } } as never,
        identity as never,
      ),
    ).toMatchObject({ status: 403, error: "forbidden: unexpected host" });
  });
});
