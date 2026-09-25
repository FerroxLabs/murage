// The browser door, as the phone app meets it.
//
// The Murage app loads this door into its own WebView, so everything below is
// something a phone on a cellular link hits on every launch: the probe it
// sends before it loads anything, the files and routes a call needs, whether a
// chat full of images downloads twice, the policy the shell runs under, and
// the bytes on the wire. A fake harness rather than the real server, for the
// reason `browser.test.ts` gives: what has to be proven is what the door sends
// and what it refuses, and the fake records every path it was asked for.
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createBrowserHandler,
  type BoundIdentity,
  type BrowserDeviceStore,
  type SignInLimiter,
} from "../src/browser.ts";

type Reply = (req: IncomingMessage, res: ServerResponse) => void;

/** The shell as `vite build` writes it: one inline classic script (the
 * pre-paint skin stamp, `index.html`) and one module entry. */
const SHELL =
  '<!doctype html>\n<html lang="en">\n<head>\n<script>document.documentElement.dataset.skin = "dark";</script>\n' +
  '<script type="module" crossorigin src="/assets/index-AbC123.js"></script>\n<title>Murage</title>\n</head>\n' +
  '<body><div id="root"></div></body>\n</html>\n';

/** Per-test answers, by exact upstream path. Anything unlisted gets what the
 * real harness gives: a JSON 404 under `/api/`, and the SPA fallback —
 * index.html, status 200 — everywhere else (`server/index.ts:16872-16877`). */
const replies = new Map<string, Reply>();
/** Every path the harness was asked for, in order. */
let asked: string[] = [];

let harness: Server;
let harnessPort = 0;
let door: Server;
let doorPort = 0;

const DEVICE = { id: "dev_1", name: "Sean's iPhone", cloudDesktopAccess: false };
const sessions = new Map<string, { id: string; expiresAt: number }>();
const devices: BrowserDeviceStore = {
  redeem: (credential) =>
    credential === "murage_pair_good"
      ? { device: { ...DEVICE, createdAt: 1, lastSeenAt: 1 }, token: "murage_raw_bearer_never_leaves" }
      : { error: "that pairing credential is not right" },
  openSession: (deviceId) => {
    if (deviceId !== DEVICE.id) return null;
    const value = `murage_browser_${Math.random().toString(36).slice(2)}`;
    const session = { id: `session_${Math.random().toString(36).slice(2)}`, expiresAt: Date.now() + 90 * 24 * 3600 * 1000 };
    sessions.set(value, session);
    return { value, session };
  },
  resolveSession: (value) => {
    const session = value ? sessions.get(value) : undefined;
    return session ? { device: DEVICE, session, sessionId: session.id } : null;
  },
  sessionDeadline: (sessionId) => {
    for (const session of sessions.values()) if (session.id === sessionId) return session.expiresAt;
    return null;
  },
  closeSession: (value) => (value ? sessions.delete(value) : false),
  renewSession: () => null,
};

/** A limiter that records being consulted at all, and can be set locked. */
let limiterLocked = false;
let limiterCalls = 0;
const limiter: SignInLimiter = {
  check: () => {
    limiterCalls += 1;
    return limiterLocked ? { retryAfterMs: 60_000 } : null;
  },
  fail: () => {
    limiterCalls += 1;
    return null;
  },
  succeed: () => {
    limiterCalls += 1;
  },
};

let computerName = "Sean's computer";

const identity: BoundIdentity = {
  scheme: "http",
  hosts: new Set(["macbook.tail0a48a4.ts.net", "127.0.0.1"]),
};

beforeAll(async () => {
  harness = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    asked.push(path);
    const answer = replies.get(path);
    if (answer) return answer(req, res);
    if (path.startsWith("/api/")) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: `no route: ${req.method} ${path}` }));
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(SHELL);
  });
  await new Promise<void>((r) => harness.listen(0, "127.0.0.1", r));
  harnessPort = (harness.address() as AddressInfo).port;

  door = createServer(
    createBrowserHandler({
      harnessPort,
      identity: () => identity,
      devices,
      signInLimiter: limiter,
      serverName: () => computerName,
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

beforeEach(() => {
  replies.clear();
  asked = [];
  limiterLocked = false;
  limiterCalls = 0;
  computerName = "Sean's computer";
});

interface Answer {
  status: number;
  headers: IncomingMessage["headers"];
  /** The bytes on the wire. */
  raw: Buffer;
  /** The body as a browser would see it: decoded by what the response says it is. */
  body: string;
}

const decode = (raw: Buffer, encoding: string | undefined): string =>
  (encoding === "br" ? brotliDecompressSync(raw) : encoding === "gzip" ? gunzipSync(raw) : raw).toString("utf8");

/** One request at the door. Defaults are what a same-origin browser sends;
 * an empty value removes a default, which is how a native client is spelled. */
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
    for (const [name, value] of Object.entries(headers)) if (value === "") delete headers[name];
    if (body !== undefined) headers["content-type"] ??= "application/json";
    const req = request({ hostname: "127.0.0.1", port: doorPort, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, raw, body: decode(raw, res.headers["content-encoding"]) });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });

/** Writes carry an Origin; rule 4 of the origin gate requires it. */
const write = (extra: Record<string, string> = {}) => ({
  origin: `http://macbook.tail0a48a4.ts.net:${doorPort}`,
  ...extra,
});

// ─────────────────────────────────────────────────────────────────────────
describe("the launcher's probe", () => {
  it("says what this door is and what it is called, with no session", async () => {
    const answer = await knock("GET", "/healthz");
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toEqual({ ok: true, name: "Sean's computer", mobile: 1 });
    expect(answer.headers["content-type"]).toBe("application/json");
    expect(answer.headers["cache-control"]).toBe("private, no-store");
    expect(answer.headers["set-cookie"]).toBeUndefined();
  });

  it("answers a native HTTP client, which sends no browser headers at all", async () => {
    // URLSession and OkHttp send neither Origin nor Sec-Fetch-*. That is the
    // client the launcher uses, so it is the one that must get a 200.
    const answer = await knock("GET", "/healthz", { "sec-fetch-site": "" });
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body).mobile).toBe(1);
  });

  it("sends no CORS header, and still refuses a Host it did not bind", async () => {
    const answer = await knock("GET", "/healthz");
    for (const header of Object.keys(answer.headers)) {
      expect(header.startsWith("access-control-"), header).toBe(false);
    }
    // DNS rebinding would otherwise read the computer's name back.
    expect((await knock("GET", "/healthz", { host: "evil.example" })).status).toBe(403);
    // A page on another origin fetching it is refused at the gate, and could
    // not have read the answer anyway.
    const crossSite = await knock("GET", "/healthz", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" });
    expect(crossSite.status).toBe(403);
  });

  it("never reads or charges the sign-in limiter", async () => {
    // A launcher retrying on a flaky tailnet must not be what locks out the
    // person typing a six-digit code — and a locked-out client must still be
    // told the door is there.
    limiterLocked = true;
    for (let i = 0; i < 25; i += 1) expect((await knock("GET", "/healthz")).status).toBe(200);
    expect(limiterCalls).toBe(0);
  });

  it("answers without asking the harness", async () => {
    // Cheap by construction: it is the door that is being probed.
    await knock("GET", "/healthz");
    expect(asked).toEqual([]);
  });

  it("falls back to Murage, and clamps a name it did not choose", async () => {
    computerName = "";
    expect(JSON.parse((await knock("GET", "/healthz")).body).name).toBe("Murage");
    computerName = "é".repeat(300);
    expect([...JSON.parse((await knock("GET", "/healthz")).body).name]).toHaveLength(200);
  });

  it("is a read and only a read", async () => {
    const post = await knock("POST", "/healthz", write(), "{}");
    expect(post.status).toBe(404);
    // and it is one path, not a family: anything under it is an ordinary
    // unauthenticated request
    expect((await knock("GET", "/healthz/extra")).status).toBe(401);
  });
});
