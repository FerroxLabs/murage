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
  cookieName,
  createBrowserHandler,
  keptCacheControl,
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
/** A canned upstream answer, for a path that needs a specific status, headers
 * and body rather than the harness's defaults. */
const reply =
  (status: number, headers: Record<string, string>, body: string | Buffer): Reply =>
  (_req, res) => {
    res.writeHead(status, headers);
    res.end(body);
  };
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

/** A browser that has signed in, as a Cookie header. */
const signedIn = async (): Promise<Record<string, string>> => {
  const answer = await knock("POST", "/session", write(), JSON.stringify({ credential: "murage_pair_good" }));
  expect(answer.status).toBe(201);
  const set = String(answer.headers["set-cookie"]?.[0] ?? "");
  const value = set.slice(set.indexOf("=") + 1, set.indexOf(";"));
  return { cookie: `${cookieName("http")}=${value}` };
};

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

// ─────────────────────────────────────────────────────────────────────────
describe("what a call needs, through the door", () => {
  const WASM = "/assets/ort-wasm-simd-threaded-Q1w2E3.wasm";
  const GLUE = "/assets/ort-wasm-simd-threaded-Q1w2E3.mjs";
  const MODEL = "/vad/silero_vad.onnx";

  it("serves the speech detector's runtime with the types a browser insists on", async () => {
    replies.set(WASM, reply(200, { "content-type": "application/wasm" }, Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])));
    replies.set(GLUE, reply(200, { "content-type": "text/javascript" }, "export default 1;"));
    replies.set(MODEL, reply(200, { "content-type": "application/octet-stream" }, Buffer.from([8, 7, 18, 3])));
    const cookie = await signedIn();

    const wasm = await knock("GET", WASM, cookie);
    expect(wasm.status).toBe(200);
    // Streaming compilation refuses anything else.
    expect(wasm.headers["content-type"]).toBe("application/wasm");
    expect(wasm.headers["cache-control"]).toBe("private, max-age=31536000, immutable");

    const glue = await knock("GET", GLUE, cookie);
    // A module served as anything but JavaScript is refused.
    expect(glue.headers["content-type"]).toBe("text/javascript; charset=utf-8");

    const model = await knock("GET", MODEL, cookie);
    expect(model.status).toBe(200);
    expect(model.headers["content-type"]).toBe("application/octet-stream");
    // 2.2 MB, fetched on every call. Not hashed, so not immutable — but not
    // re-downloaded on every call either.
    expect(model.headers["cache-control"]).toBe("private, max-age=86400");
    expect(model.raw.equals(Buffer.from([8, 7, 18, 3]))).toBe(true);
  });

  it("forwards the two voice routes a call makes", async () => {
    replies.set("/api/tts/prepare", reply(200, { "content-type": "application/json" }, '{"ready":true,"utterances":["Hi."]}'));
    replies.set("/api/bots/bot_1/call-note", reply(200, { "content-type": "application/json" }, '{"ok":true,"written":true}'));
    const cookie = await signedIn();
    const prepared = await knock("POST", "/api/tts/prepare", write(cookie), '{"text":"Hi."}');
    expect(prepared.status).toBe(200);
    expect(JSON.parse(prepared.body).utterances).toEqual(["Hi."]);
    const noted = await knock("POST", "/api/bots/bot_1/call-note", write(cookie), '{"log":[]}');
    expect(noted.status).toBe(200);
    expect(asked).toEqual(["/api/tts/prepare", "/api/bots/bot_1/call-note"]);
  });

  it("serves none of it to a browser that has not signed in", async () => {
    expect((await knock("GET", MODEL)).status).toBe(401);
    expect((await knock("POST", "/api/tts/prepare", write(), "{}")).status).toBe(401);
    expect(asked).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("images a chat has already downloaded", () => {
  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const FOREVER = "private, max-age=31536000, immutable";

  it("keeps the harness's lifetime on an attachment and on a message image", async () => {
    // `no-store` here meant a phone scrolling back through a chat of photos
    // downloaded every one of them again, every time, over cellular.
    replies.set("/api/attachments/avatar-1.png", reply(200, { "content-type": "image/png", "cache-control": FOREVER }, PNG));
    replies.set("/api/threads/th_1/messages/msg_1/image", reply(200, { "content-type": "image/png", "cache-control": FOREVER }, PNG));
    const cookie = await signedIn();
    for (const path of ["/api/attachments/avatar-1.png", "/api/threads/th_1/messages/msg_1/image"]) {
      const answer = await knock("GET", path, cookie);
      expect(answer.status, path).toBe(200);
      expect(answer.headers["cache-control"], path).toBe(FOREVER);
      expect(answer.raw.equals(PNG), path).toBe(true);
      // Only the lifetime is the harness's; the door's other headers stand.
      expect(answer.headers["x-frame-options"], path).toBe("DENY");
      expect(answer.headers["referrer-policy"], path).toBe("no-referrer");
    }
  });

  it("never lets a shared cache keep one", async () => {
    replies.set("/api/attachments/avatar-2.png", reply(200, { "content-type": "image/png", "cache-control": "public, max-age=31536000" }, PNG));
    replies.set("/api/attachments/avatar-3.png", reply(200, { "content-type": "image/png" }, PNG));
    const cookie = await signedIn();
    expect((await knock("GET", "/api/attachments/avatar-2.png", cookie)).headers["cache-control"]).toBe("private, no-store");
    // Saying nothing is not permission either.
    expect((await knock("GET", "/api/attachments/avatar-3.png", cookie)).headers["cache-control"]).toBe("private, no-store");
  });

  it("keeps no-store on a refusal and on every other route", async () => {
    replies.set("/api/threads/th_1/messages/msg_9/image", reply(404, { "content-type": "application/json", "cache-control": FOREVER }, '{"error":"no image on that message"}'));
    replies.set("/api/tts/speak", reply(200, { "content-type": "audio/mpeg", "cache-control": "private, max-age=60" }, Buffer.from([1, 2, 3])));
    const cookie = await signedIn();
    const missing = await knock("GET", "/api/threads/th_1/messages/msg_9/image", cookie);
    expect(missing.status).toBe(404);
    expect(missing.headers["cache-control"]).toBe("private, no-store");
    const speech = await knock("POST", "/api/tts/speak", write(cookie), '{"text":"hi"}');
    expect(speech.headers["cache-control"]).toBe("private, no-store");
  });

  it("decides it as a function", () => {
    const image = "/api/threads/th_1/messages/msg_1/image";
    expect(keptCacheControl("GET", image, 200, FOREVER)).toBe(FOREVER);
    expect(keptCacheControl("HEAD", image, 200, FOREVER)).toBeNull();
    expect(keptCacheControl("GET", image, 206, FOREVER)).toBeNull();
    expect(keptCacheControl("GET", image, 200, "privately, max-age=1")).toBeNull();
    expect(keptCacheControl("GET", image, 200, [FOREVER])).toBeNull();
    expect(keptCacheControl("GET", "/api/attachments/x.svg", 200, FOREVER)).toBeNull();
    expect(keptCacheControl("GET", "/api/bots", 200, FOREVER)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("the diagram frame", () => {
  const FRAME = "/mermaid-frame-0123456789abcdef.html";
  const FRAME_HTML =
    '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'sha256-x\'">' +
    '<body><div id="diagram"></div><script>draw()</script></body>\n';
  const served = () =>
    replies.set(FRAME, reply(200, { "content-type": "text/html", "content-security-policy": "sandbox allow-scripts" }, FRAME_HTML));

  it("can be framed by the app, stays an opaque origin, and is kept for good", async () => {
    served();
    const answer = await knock("GET", FRAME, { ...(await signedIn()), "sec-fetch-dest": "iframe" });
    expect(answer.status).toBe(200);
    expect(answer.headers["content-type"]).toBe("text/html; charset=utf-8");
    // The harness's header, which this door used to drop.
    expect(answer.headers["content-security-policy"]).toBe("sandbox allow-scripts");
    // DENY forbade the app's own iframe — the only way this page is shown.
    expect(answer.headers["x-frame-options"]).toBeUndefined();
    expect(answer.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
  });

  it("is not the shell: no renewal script, no rewriting at all", async () => {
    served();
    const answer = await knock("GET", FRAME, await signedIn());
    // Its own meta policy would refuse an injected script anyway; a byte
    // changed here is a hash that no longer matches.
    expect(answer.body).toBe(FRAME_HTML);
    expect(answer.body).not.toContain("/session/renew");
  });

  it("refuses a stale frame name rather than cache the shell under it for a year", async () => {
    // After an update, a page still running the old bundle asks for the old
    // hash. The harness answers with the SPA fallback — index.html, 200 — and
    // without the sandbox header only the real file gets.
    const answer = await knock("GET", "/mermaid-frame-fedcba9876543210.html", await signedIn());
    expect(answer.status).toBe(404);
    expect(answer.body).not.toContain("<!doctype html>");
  });

  it("refuses a frame the harness did not sandbox", async () => {
    replies.set(FRAME, reply(200, { "content-type": "text/html", "content-security-policy": "default-src 'none'" }, FRAME_HTML));
    expect((await knock("GET", FRAME, await signedIn())).status).toBe(404);
  });

  it("serves no other spelling of the name", async () => {
    const cookie = await signedIn();
    for (const path of ["/mermaid-frame.html", "/mermaid-frame-0123.html", "/mermaid-frame-0123456789ABCDEF.html"]) {
      expect((await knock("GET", path, cookie)).status, path).toBe(404);
    }
    expect(asked).toEqual([]);
  });
});
