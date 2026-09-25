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
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
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

// ─────────────────────────────────────────────────────────────────────────
describe("the shell's policy", () => {
  const cspOf = (answer: Answer): string => String(answer.headers["content-security-policy"] ?? "");
  const nonceOf = (csp: string): string => /'nonce-([^']+)'/.exec(csp)?.[1] ?? "";
  const directive = (csp: string, name: string): string =>
    csp.split("; ").find((d) => d.startsWith(`${name} `)) ?? "";

  it("names every script in the shell by this response's nonce, and allows nothing else inline", async () => {
    const shell = await knock("GET", "/", await signedIn());
    const csp = cspOf(shell);
    const nonce = nonceOf(csp);
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    const tags = [...shell.body.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    // the skin stamp, the module entry, and the renewal script this door adds
    expect(tags).toHaveLength(3);
    for (const tag of tags) expect(tag).toContain(`nonce="${nonce}"`);
    expect(shell.body).toContain("/session/renew");
    expect(directive(csp, "script-src")).toBe(`script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'`);
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it("carries what the app needs and no wider", async () => {
    const csp = cspOf(await knock("GET", "/", await signedIn()));
    // the diagram frame, by URL; srcdoc previews are not governed by frame-src
    expect(directive(csp, "frame-src")).toBe("frame-src 'self'");
    expect(directive(csp, "connect-src")).toBe("connect-src 'self' wss://streaming.assemblyai.com");
    expect(directive(csp, "img-src")).toBe("img-src 'self' data: blob: https:");
    expect(directive(csp, "media-src")).toBe("media-src 'self' data: blob:");
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
    expect(directive(csp, "base-uri")).toBe("base-uri 'none'");
    expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(csp).not.toMatch(/(?:^|; )default-src [^;]*\*/);
  });

  it("mints a fresh nonce for every response", async () => {
    const cookie = await signedIn();
    const first = nonceOf(cspOf(await knock("GET", "/", cookie)));
    const second = nonceOf(cspOf(await knock("GET", "/", cookie)));
    expect(first).not.toBe(second);
  });

  it("covers the deep links, which are the same document", async () => {
    const deep = await knock("GET", "/chat/bot_1", await signedIn());
    expect(deep.status).toBe(200);
    const nonce = nonceOf(cspOf(deep));
    expect(nonce).not.toBe("");
    expect(deep.body).toContain(`nonce="${nonce}"`);
  });

  it("keeps the policy on a shell too big to rewrite", async () => {
    // Above the ceiling the bytes go through unmodified. The policy still
    // goes out, with a nonce no script carries: the inline skin stamp is
    // refused and the page paints in the default palette, while the entry
    // bundle loads from 'self' and the app runs. Loosening the policy for a
    // document this door could not read would be the wrong way round.
    replies.set("/", reply(200, { "content-type": "text/html" }, SHELL.replace("</body>", `${"x".repeat(2 * 1024 * 1024 + 16)}</body>`)));
    const big = await knock("GET", "/", await signedIn());
    expect(big.status).toBe(200);
    expect(nonceOf(cspOf(big))).not.toBe("");
    expect(big.body).not.toContain("nonce=");
    expect(big.body).not.toContain("/session/renew");
  });

  it("leaves the sign-in page's own tighter policy alone", async () => {
    const page = await knock("GET", "/", { "sec-fetch-mode": "navigate" });
    expect(page.status).toBe(401);
    expect(cspOf(page)).toContain("default-src 'none'");
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("bytes on the wire", () => {
  const JS = "export const line = 1;\n".repeat(400);
  const BR = { "accept-encoding": "gzip, deflate, br, zstd" };
  let upstreamAcceptEncoding: string | undefined = "unset";
  const bots = () =>
    replies.set("/api/bots", (req, res) => {
      upstreamAcceptEncoding = req.headers["accept-encoding"];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        bots: Array.from({ length: 200 }, (_, i) => ({ id: `bot_${i}`, name: `Bot ${i}`, resumeCursors: { claude: `sess_${i}` } })),
      }));
    });

  it("compresses JSON only after it has been scrubbed", async () => {
    bots();
    const answer = await knock("GET", "/api/bots", { ...(await signedIn()), ...BR });
    expect(answer.headers["content-encoding"]).toBe("br");
    expect(Number(answer.headers["content-length"])).toBe(answer.raw.byteLength);
    const parsed = JSON.parse(answer.body);
    expect(parsed.bots).toHaveLength(200);
    // Withheld before compression, so not hiding inside it either.
    expect(answer.body).not.toContain("resumeCursors");
    // The harness was never asked to compress, so it never can have first.
    expect(upstreamAcceptEncoding).toBeUndefined();
  });

  it("uses gzip for a browser that only takes gzip, and plain bytes for one that takes neither", async () => {
    bots();
    const cookie = await signedIn();
    const gz = await knock("GET", "/api/bots", { ...cookie, "accept-encoding": "gzip" });
    expect(gz.headers["content-encoding"]).toBe("gzip");
    expect(JSON.parse(gz.body).bots).toHaveLength(200);
    const plain = await knock("GET", "/api/bots", cookie);
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(plain.headers.vary).toBe("Accept-Encoding");
    expect(JSON.parse(plain.body).bots).toHaveLength(200);
  });

  it("leaves a small body plain", async () => {
    replies.set("/api/config", reply(200, { "content-type": "application/json" }, '{"configured":true}'));
    const answer = await knock("GET", "/api/config", { ...(await signedIn()), ...BR });
    expect(answer.headers["content-encoding"]).toBeUndefined();
    expect(answer.body).toBe('{"configured":true}');
  });

  it("never compresses the event stream", async () => {
    replies.set("/api/events", (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ kind: "runtime", pad: "x".repeat(4096) })}\n\n`);
    });
    const answer = await knock("GET", "/api/events", { ...(await signedIn()), ...BR });
    expect(answer.headers["content-type"]).toBe("text/event-stream");
    expect(answer.headers["content-encoding"]).toBeUndefined();
    expect(answer.raw.toString("utf8")).toContain('data: {"kind":"runtime"');
    expect(answer.headers.vary).toBe("Accept-Encoding");
  });

  it("compresses a static file on the way through, and keeps its type and lifetime", async () => {
    replies.set("/assets/index-AbC123.js", reply(200, { "content-type": "text/javascript" }, JS));
    const answer = await knock("GET", "/assets/index-AbC123.js", { ...(await signedIn()), ...BR });
    expect(answer.headers["content-encoding"]).toBe("br");
    expect(answer.body).toBe(JS);
    expect(answer.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(answer.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(answer.headers.vary).toBe("Accept-Encoding");
  });

  it("leaves an image alone", async () => {
    const PNG = Buffer.alloc(4096, 7);
    replies.set("/assets/logo-AbC123.png", reply(200, { "content-type": "image/png" }, PNG));
    const answer = await knock("GET", "/assets/logo-AbC123.png", { ...(await signedIn()), ...BR });
    expect(answer.headers["content-encoding"]).toBeUndefined();
    expect(answer.raw.equals(PNG)).toBe(true);
  });

  it("compresses the shell only after it has been rewritten, and keeps its policy", async () => {
    const answer = await knock("GET", "/", { ...(await signedIn()), "accept-encoding": "gzip" });
    expect(answer.headers["content-encoding"]).toBe("gzip");
    expect(Number(answer.headers["content-length"])).toBe(answer.raw.byteLength);
    const nonce = /'nonce-([^']+)'/.exec(String(answer.headers["content-security-policy"]))?.[1];
    expect(nonce).toBeTruthy();
    // What was compressed is the rewritten document, not the harness's.
    expect(answer.body).toContain("/session/renew");
    expect(answer.body).toContain(`<script nonce="${nonce}" type="module"`);
    expect(answer.headers["x-frame-options"]).toBe("DENY");
    expect(answer.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("sends a shell too big to rewrite exactly as it came, uncompressed", async () => {
    replies.set("/", reply(200, { "content-type": "text/html" }, SHELL.replace("</body>", `${"x".repeat(2 * 1024 * 1024 + 16)}</body>`)));
    const answer = await knock("GET", "/", { ...(await signedIn()), ...BR });
    expect(answer.status).toBe(200);
    expect(answer.headers["content-encoding"]).toBeUndefined();
    expect(answer.headers.vary).toBe("Accept-Encoding");
    expect(answer.raw.byteLength).toBeGreaterThan(2 * 1024 * 1024);
  });

  it("varies on Accept-Encoding everywhere, refusals included", async () => {
    for (const answer of [await knock("GET", "/healthz"), await knock("GET", "/api/bots"), await knock("GET", "/enter")]) {
      expect(answer.headers.vary).toBe("Accept-Encoding");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("the build's own compressed copies", () => {
  const JS = "export const line = 1;\n".repeat(400);
  /** Different words from JS on purpose: seeing these proves the door sent
   * the build's copy rather than compressing its own. */
  const BUILT = "/* the build's copy */ export const line = 1;\n".repeat(100);
  const ASSET = "/assets/index-AbC123.js";

  it("sends the brotli copy the build made, and asks for nothing else", async () => {
    replies.set(ASSET, reply(200, { "content-type": "text/javascript" }, JS));
    replies.set(`${ASSET}.br`, reply(200, { "content-type": "application/octet-stream" }, brotliCompressSync(BUILT)));
    const answer = await knock("GET", ASSET, { ...(await signedIn()), "accept-encoding": "gzip, br" });
    expect(answer.status).toBe(200);
    expect(answer.headers["content-encoding"]).toBe("br");
    expect(answer.body).toBe(BUILT);
    // The door's type, never the harness's octet-stream for a `.br` file.
    expect(answer.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(answer.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(answer.headers.vary).toBe("Accept-Encoding");
    expect(asked).toEqual([`${ASSET}.br`]);
  });

  it("asks for the gzip copy when that is all the browser takes", async () => {
    replies.set(`${ASSET}.gz`, reply(200, { "content-type": "application/octet-stream" }, gzipSync(BUILT)));
    const answer = await knock("GET", ASSET, { ...(await signedIn()), "accept-encoding": "gzip" });
    expect(answer.headers["content-encoding"]).toBe("gzip");
    expect(answer.body).toBe(BUILT);
    expect(asked).toEqual([`${ASSET}.gz`]);
  });

  it("falls back to compressing on the fly when the build left no copy", async () => {
    // No `.br` registered: the harness answers the SPA fallback, HTML at 200,
    // which must read as "no copy" and never as the answer.
    replies.set(ASSET, reply(200, { "content-type": "text/javascript" }, JS));
    const answer = await knock("GET", ASSET, { ...(await signedIn()), "accept-encoding": "br" });
    expect(answer.headers["content-encoding"]).toBe("br");
    expect(answer.body).toBe(JS);
    expect(asked).toEqual([`${ASSET}.br`, ASSET]);
  });

  it("falls back when the harness is serving no UI at all", async () => {
    replies.set(`${ASSET}.br`, reply(404, { "content-type": "application/json" }, '{"error":"no route"}'));
    replies.set(ASSET, reply(200, { "content-type": "text/javascript" }, JS));
    const answer = await knock("GET", ASSET, { ...(await signedIn()), "accept-encoding": "br" });
    expect(answer.status).toBe(200);
    expect(answer.body).toBe(JS);
  });

  it("does not ask for a copy of anything whose name outlives its content", async () => {
    replies.set("/manifest.webmanifest", reply(200, { "content-type": "application/octet-stream" }, JSON.stringify({ name: "Murage", pad: "x".repeat(2048) })));
    const cookie = await signedIn();
    await knock("GET", "/manifest.webmanifest", { ...cookie, "accept-encoding": "br" });
    await knock("GET", "/", { ...cookie, "accept-encoding": "br" });
    expect(asked).toEqual(["/manifest.webmanifest", "/"]);
  });

  it("does not ask for a copy when the browser takes neither encoding", async () => {
    replies.set(ASSET, reply(200, { "content-type": "text/javascript" }, JS));
    await knock("GET", ASSET, await signedIn());
    expect(asked).toEqual([ASSET]);
  });

  it("keeps the diagram frame sandboxed and frameable when it comes from a copy", async () => {
    const FRAME = "/mermaid-frame-0123456789abcdef.html";
    replies.set(`${FRAME}.br`, reply(200, { "content-type": "application/octet-stream" }, brotliCompressSync("<!doctype html><p>frame</p>")));
    const answer = await knock("GET", FRAME, { ...(await signedIn()), "accept-encoding": "br" });
    expect(answer.body).toBe("<!doctype html><p>frame</p>");
    expect(answer.headers["content-security-policy"]).toBe("sandbox allow-scripts");
    expect(answer.headers["x-frame-options"]).toBeUndefined();
  });
});
