# Plan 1, group B: the browser door (companion)

Scope: spec §3.3 rows *Public `GET /healthz`*, *Skip the in-app-browser warning*,
*Allow `/api/tts/prepare`, `/api/bots/:id/call-note`, `/vad/*`, `.wasm`/`.onnx`*,
*Keep the upstream `cache-control`*, *Compression*, *Shell CSP incl. `frame-src`*,
*Mermaid frame content-hashed*; plus §3.3 "Compression rules" and §6 rows 1 and 3.

Order matters: B6 (Mermaid frame at the door) lands before B7 (shell CSP), because the
frame is currently served *through* the shell path and B7 would otherwise put the
shell's policy on it. B8 → B9 → B10 → B11 are the compression chain.

Line numbers are from `mobile/v1` as read on 2026-09-25. Every task that edits
`companion/src/browser.ts` says which earlier task's version it edits.

New shared test file: `companion/test/browser-mobile.test.ts`. B1 creates it with the
fake harness scaffold; later tasks append `describe` blocks to it.

---

### Task B1: Public `GET /healthz` probe

**Files:**
- Modify: `companion/src/browser.ts:87-107` (`BrowserDoorOptions`), `companion/src/browser.ts:1166-1169` (handler, after the origin gate)
- Modify: `companion/src/index.ts:428-438` (pass the name)
- Create: `companion/test/browser-mobile.test.ts`
- Test: `companion/test/browser-mobile.test.ts`

**Interfaces:**
- Consumes: `machineName()` (`companion/src/index.ts:334`), the same name the device door hands out as `serverName` (`index.ts:411`, clamp as `proxy.ts:244`).
- Produces: `BrowserDoorOptions.serverName?: () => string`; `GET /healthz` (and `HEAD`) → `200 {"ok":true,"name":string,"mobile":1}`, `application/json`, `BASE_HEADERS` (no CORS), no cookie read, sign-in limiter never consulted, harness never contacted. Any other method on `/healthz` → `404 {"error":"no route: <M> /healthz"}`. The launcher (Plan 2) keys on `mobile === 1`.

- [ ] **Step 1: Write the failing test**

Create `companion/test/browser-mobile.test.ts`:

```ts
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

const reply =
  (status: number, headers: Record<string, string>, body: string | Buffer): Reply =>
  (_req, res) => {
    res.writeHead(status, headers);
    res.end(body);
  };

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
  hosts: new Set(["macbook.tail000000.ts.net", "127.0.0.1"]),
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
      host: `macbook.tail000000.ts.net:${doorPort}`,
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

/** A browser that has signed in, as a Cookie header. */
const signedIn = async (): Promise<Record<string, string>> => {
  const answer = await knock(
    "POST",
    "/session",
    { origin: `http://macbook.tail000000.ts.net:${doorPort}` },
    JSON.stringify({ credential: "murage_pair_good" }),
  );
  expect(answer.status).toBe(201);
  const set = String(answer.headers["set-cookie"]?.[0] ?? "");
  asked = [];
  return { cookie: `${cookieName("http")}=${set.slice(set.indexOf("=") + 1, set.indexOf(";"))}` };
};

/** Writes carry an Origin; rule 4 of the origin gate requires it. */
const write = (extra: Record<string, string> = {}) => ({
  origin: `http://macbook.tail000000.ts.net:${doorPort}`,
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
```

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run companion/test/browser-mobile.test.ts -t "launcher's probe"`
Expected: FAIL with "expected 401 to be 200" (today `/healthz` falls to `denyReason` and is an unauthenticated 401, `browser.ts:1297-1331`).

- [ ] **Step 3: Write minimal implementation**

In `companion/src/browser.ts`, inside `interface BrowserDoorOptions`, after `signInLimiter?: SignInLimiter;` (line 106) add:

```ts
  /** What this computer is called, for `GET /healthz`. The same name the
   * device door hands a phone when it pairs (`index.ts` `machineName`), so a
   * workspace the launcher saved and the pairing agree on what to call it.
   * Optional: a door without one answers "Murage". */
  serverName?: () => string;
```

In `createBrowserHandler`, directly after `if (gate) return sendJson(res, gate.status, { error: gate.error });` (line 1167) and before `// ── first contact` (line 1169) add:

```ts
    // ── the launcher's probe ─────────────────────────────────────────────
    //
    // The phone app asks this before it loads anything, to tell three cases
    // apart: this door (200 with `mobile`), an older door (any other answer —
    // it 401s a path it does not know), and nothing at all. So it answers
    // without a session, and it is answered here, above the cookie and above
    // the sign-in limiter, on purpose: a launcher retrying every few seconds
    // on a flaky tailnet must never be what spends or checks the budget of
    // the person typing a code.
    //
    // Below the origin gate, not above it. The Host allowlist is still what
    // stops a rebound DNS name from reading the computer's name back, and a
    // native HTTP client sends neither `Origin` nor `Sec-Fetch-*`, so it
    // passes the gate the way `curl` does. No CORS header, like everything
    // else here: a page on another origin cannot read the answer.
    //
    // The name discloses nothing a tailnet peer does not already have: the
    // MagicDNS name is usually the same words, and the Bonjour record has
    // broadcast it on the LAN since the first release.
    if (path === "/healthz") {
      if (method !== "GET" && method !== "HEAD") return sendJson(res, 404, { error: `no route: ${method} ${path}` });
      const name = [...(options.serverName?.() || "Murage")].slice(0, 200).join("");
      return sendJson(res, 200, { ok: true, name, mobile: 1 });
    }
```

In `companion/src/index.ts`, in the `createBrowserHandler({ ... })` call (lines 428-438), after `devices,` add:

```ts
  // The same name the device door pairs with, for the launcher's probe.
  serverName: machineName,
```

- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run companion/test/browser-mobile.test.ts -t "launcher's probe" && pnpm vitest run companion/test/browser.test.ts companion/test/routes.test.ts`
Expected: PASS (the existing suites confirm `/api/healthz` is still a 401 on the device surface, `routes.test.ts:34-40`).

- [ ] **Step 5: Commit**
`git add companion/src/browser.ts companion/src/index.ts companion/test/browser-mobile.test.ts`
`git commit -m "feat(companion): public /healthz probe for the phone launcher"`

---

### Task B2: No in-app-browser warning inside the Murage app

**Files:**
- Modify: `companion/src/browser.ts:785-807` (the `/enter` script's webview check inside `enterPage`)
- Test: `companion/test/browser-code.test.ts`

**Interfaces:**
- Consumes: the app's user agent token `MurageApp/<version> (<platform>)` (spec §3.2).
- Produces: `/enter` shows no `#w` warning when `navigator.userAgent` contains `MurageApp/`; every other mark in the list still warns. The Sign-in tap is still required.

- [ ] **Step 1: Write the failing test**

In `companion/test/browser-code.test.ts`, add to the imports:

```ts
import { createContext, runInContext } from "node:vm";
```

and append:

```ts
// ─────────────────────────────────────────────────────────────────────────
// 4. THE APP: the Murage phone app is a webview too, and must not be told
//    to leave itself
// ─────────────────────────────────────────────────────────────────────────
describe("the phone app is not told to open a real browser", () => {
  /** Run `/enter`'s real script, from the real response, with a credential in
   * the fragment and just enough DOM to reach the warning. RUN it rather than
   * grep it: the check is a loop over marks, and the question is what it
   * decides for a given user agent. */
  const enterWith = async (userAgent: string): Promise<{ warning: string; tapOffered: boolean }> => {
    const page = await knock("GET", "/enter", { "sec-fetch-mode": "navigate" });
    const [script] = inlineScripts(page.body);
    const elements = new Map<string, Record<string, unknown>>();
    const byId = (id: string): Record<string, unknown> => {
      let element = elements.get(id);
      if (!element) {
        element = { hidden: true, disabled: false, textContent: "", value: "", addEventListener: () => {}, focus: () => {} };
        elements.set(id, element);
      }
      return element;
    };
    const sandbox = {
      document: { getElementById: byId },
      navigator: { userAgent },
      location: { hash: "#murage_pair_abc" },
      history: { replaceState: () => {} },
      fetch: () => new Promise(() => {}),
      setInterval: () => 0,
      clearInterval: () => {},
    };
    createContext(sandbox);
    runInContext(script, sandbox);
    return { warning: String(byId("w").textContent), tapOffered: byId("go").hidden === false };
  };

  const ANDROID_WEBVIEW =
    "Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UQ1A.240205.004; wv) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Version/4.0 Chrome/130.0.6723.58 Mobile Safari/537.36";
  const IOS_WEBVIEW =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

  it("still warns a webview that is not ours", async () => {
    // The control: without it the two tests below would pass on a script
    // that never warns anybody.
    const { warning } = await enterWith(ANDROID_WEBVIEW);
    expect(warning).toContain("built-in browser");
  });

  it("does not warn inside the Murage app on Android, whose webview says `; wv)`", async () => {
    const { warning, tapOffered } = await enterWith(`${ANDROID_WEBVIEW} MurageApp/1.0.0 (android)`);
    expect(warning).toBe("");
    // The tap stays. A crawler does not press buttons, and neither does
    // anything else that is not a person.
    expect(tapOffered).toBe(true);
  });

  it("does not warn inside the Murage app on iPhone either", async () => {
    expect((await enterWith(`${IOS_WEBVIEW} MurageApp/1.0.0 (ios)`)).warning).toBe("");
  });

  it("still warns the chat apps the list was written for, even ones that mention us", async () => {
    // The token only exempts the app it names. Instagram's webview does not
    // become ours by carrying an unrelated string somewhere else in it.
    expect((await enterWith(`${IOS_WEBVIEW} Instagram 312.0.0.32.112`)).warning).toContain("built-in browser");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run companion/test/browser-code.test.ts -t "phone app is not told"`
Expected: FAIL with `expected 'You are in an app\'s built-in browser. …' to be ''` in the Android case.

- [ ] **Step 3: Write minimal implementation**

In `companion/src/browser.ts`, inside `enterPage`'s script, replace lines 800-807:

```ts
  var webview = false;
  var marks = ["Line/", "FBAN", "FBAV", "Instagram", "WhatsApp", "MicroMessenger", "; wv)"];
  for (var i = 0; i < marks.length; i++) {
    if (ua.indexOf(marks[i]) !== -1) { webview = true; break; }
  }
  if (webview) {
```

with:

```ts
  // The Murage phone app is a webview as well, and on Android its user agent
  // carries the same "; wv)" as every other one. There the webview IS the
  // browser: the app keeps its cookies and the session is meant to live in
  // it, so telling the person to leave would send them somewhere the app
  // cannot follow. The token only decides whether a sentence is shown; it
  // grants nothing, so a spoofed one costs nobody anything.
  var ourApp = ua.indexOf("MurageApp/") !== -1;
  var webview = false;
  var marks = ["Line/", "FBAN", "FBAV", "Instagram", "WhatsApp", "MicroMessenger", "; wv)"];
  for (var i = 0; i < marks.length; i++) {
    if (ua.indexOf(marks[i]) !== -1) { webview = true; break; }
  }
  if (webview && !ourApp) {
```

(No backslash, no backtick: the template-literal rule at `browser.ts:785-797` holds; the existing parse test at `browser-code.test.ts:178-196` re-checks it.)

The fourth test ("even ones that mention us") passes because `Instagram …` has no `MurageApp/` token; it pins that the exemption is the token, not "any webview".

- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run companion/test/browser-code.test.ts`
Expected: PASS, including "parses every script the door actually serves".

- [ ] **Step 5: Commit**
`git add companion/src/browser.ts companion/test/browser-code.test.ts`
`git commit -m "fix(companion): the Murage app is not warned off as an in-app browser"`

---

### Task B3: Voice files and routes through the browser door

**Files:**
- Modify: `companion/src/routes.ts:189-199` (`/assets/` pattern and its comment), `companion/src/routes.ts:202` (add `/vad/` entry after `/favicon.ico`), `companion/src/routes.ts:332-337` (voice section of `BROWSER_ALLOWED`)
- Modify: `companion/src/browser.ts:135-145` (`STATIC_MIME`), `companion/src/browser.ts:1522-1526` (`relayStatic` cache line) plus a new exported `staticCacheControl` after `staticContentType` (line 501)
- Test: `companion/test/routes.test.ts`, `companion/test/browser-mobile.test.ts`

**Interfaces:**
- Consumes: `src/lib/silero-vad.ts:14-16,35` (loads `ort-wasm-simd-threaded.wasm?url`, `ort-wasm-simd-threaded.mjs?url`, and `/vad/silero_vad.onnx`); `src/lib/tts/index.ts:344` (`POST /api/tts/prepare`); `src/components/CallView.tsx:754` (`POST /api/bots/:id/call-note`).
- Produces: browser-surface allow entries `POST /api/tts/prepare`, `POST /api/bots/[\w-]+/call-note`, `GET /vad/silero_vad.onnx`, `/assets/[\w-]+.(js|mjs|css|woff2|svg|png|json|wasm|onnx)`; `STATIC_MIME` entries `.mjs`, `.wasm`, `.onnx`; `export function staticCacheControl(path: string): string` (B6 extends it).

Server auth, checked:
- `POST /api/tts/prepare` (`server/index.ts:16460-16466`): reads no key, writes nothing, returns `{ready, utterances}`. Safe remotely.
- `POST /api/bots/:id/call-note` (`server/index.ts:16550-16557`): the harness answers **403 to every non-desktop surface**, and the door always stamps `x-murage-companion: 1` (`browser.ts:463-467`), so the entry is inert today. The handler (`server/voice/call-note.ts:78-103`) has no visibility check. See Notes.
- `/vad/silero_vad.onnx`, `ort-*.wasm`, `ort-*.mjs`: public build output. They stay behind the session like every other static file.

- [ ] **Step 1: Write the failing test**

Append to `companion/test/routes.test.ts`:

```ts
// ── a call, from a browser ───────────────────────────────────────────────
//
// Calls run in the web layer on the phone (spec §5), and every piece of that
// was refused at this door: the utterance splitter, the call note, the speech
// model and the ONNX runtime that runs it. `.mjs` is the one the spec did not
// name — the runtime imports its glue as a module (`src/lib/silero-vad.ts:16`),
// and a refused `.mjs` is a call that never hears anyone.
describe("a call reaches the browser door", () => {
  const call: Array<[string, string]> = [
    ["POST", "/api/tts/prepare"],
    ["POST", "/api/bots/bot_123/call-note"],
    ["GET", "/vad/silero_vad.onnx"],
    ["GET", "/assets/ort-wasm-simd-threaded-B3x9Qz_d.wasm"],
    ["GET", "/assets/ort-wasm-simd-threaded-B3x9Qz_d.mjs"],
  ];

  it("allows what the call screen fetches, at the browser door and only there", () => {
    for (const [method, path] of call) {
      expect(askBrowser(method, path), path).toBeNull();
      expect(askBrowser(method, path, false)?.status, path).toBe(401);
      // The phone's native surface did not ask for any of these.
      expect(ask(method, path), path).not.toBeNull();
    }
  });

  it("opens exactly those, not their neighbours", () => {
    for (const [method, path] of [
      ["GET", "/api/tts/prepare"],
      ["POST", "/api/tts/prepare/extra"],
      ["GET", "/api/bots/bot_123/call-note"],
      // The call's fast half is desktop-only in the harness (server/index.ts:16529)
      // and stays off this list until that is a decision somebody made.
      ["POST", "/api/bots/bot_123/voice-host"],
      ["GET", "/vad/other.onnx"],
      ["GET", "/vad/silero_vad.onnx.bak"],
      ["GET", "/assets/x.exe"],
      ["GET", "/assets/../devices.wasm"],
      ["GET", "/assets/sub/x.wasm"],
    ] as const) {
      expect(askBrowser(method, path), `${method} ${path}`).not.toBeNull();
    }
  });
});
```

Append to `companion/test/browser-mobile.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run companion/test/routes.test.ts companion/test/browser-mobile.test.ts -t "call"`
Expected: FAIL: routes with `expected { status: 404, error: 'no route: POST /api/tts/prepare' } to be null`; door with `expected 404 to be 200` for the `.wasm`.

- [ ] **Step 3: Write minimal implementation**

`companion/src/routes.ts`, replace the doc-comment lines 189-191:

```ts
 * `/assets/` carries vite's content hashes. Measured against the real build:
 * all 311 files in `dist/assets` match `[\w-]+\.(js|css)`, so the pattern is
 * the hash alphabet plus the extensions the build actually emits — not `.*`.
```

with:

```ts
 * `/assets/` carries vite's content hashes, so the pattern is the hash
 * alphabet plus the extensions the build actually emits — not `.*`. `wasm`
 * and `mjs` are ONNX Runtime's, which the call's speech detector loads by URL
 * (`src/lib/silero-vad.ts:15-16`): the glue is imported as a module, so a
 * refused `.mjs` is a call that never hears anyone. `onnx` is here for the
 * day the model moves into the hashed tree; today's lives under `/vad/`.
```

replace line 199:

```ts
  { method: "GET", path: /^\/assets\/[\w-]+\.(?:js|css|woff2|svg|png|json)$/ },
```

with:

```ts
  { method: "GET", path: /^\/assets\/[\w-]+\.(?:js|mjs|css|woff2|svg|png|json|wasm|onnx)$/ },
```

after line 202 (`/favicon.ico`) add:

```ts
  // The speech detector's model (`public/vad`, fetched by
  // `src/lib/silero-vad.ts:35`). One file, by name: `/vad/*` would be the
  // first wildcard on this list, and there is nothing else in there.
  { method: "GET", path: /^\/vad\/silero_vad\.onnx$/ },
```

In `BROWSER_ALLOWED`, after line 334 (`POST /api/tts/speak`) add:

```ts
  // Splits a reply into utterances and says whether a voice is set up. It
  // reads no key and writes nothing (`server/index.ts:16460-16466`); without
  // it every spoken reply on a remote call fails before its first word.
  { method: "POST", path: /^\/api\/tts\/prepare$/ },
  // The note a call leaves in its conversation (`server/voice/call-note.ts`).
  // Listed so this door is not the thing in the way. The harness is still the
  // boundary, and today it answers 403 to every surface but the desktop
  // (`server/index.ts:16551`); lifting that is a server decision, and the
  // handler has no per-bot visibility check to lift it onto yet.
  { method: "POST", path: /^\/api\/bots\/[\w-]+\/call-note$/ },
```

`companion/src/browser.ts`, in `STATIC_MIME` after `".woff2": "font/woff2",` (line 143) add:

```ts
  // ONNX Runtime's glue is imported as a module, and a module served as
  // anything but JavaScript is refused; its WebAssembly is compiled by
  // streaming, which requires exactly this type. The same pair the harness
  // maps (`server/index.ts:521-525`).
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  // The speech model is opaque bytes to everything but the runtime.
  ".onnx": "application/octet-stream",
```

After `staticContentType` (ends line 501) add:

```ts
/** How long a browser may keep one static file.
 *
 * Hashed assets are immutable by construction; the shell never is. The speech
 * model is neither: its name is fixed and it changes only with a release, and
 * it is 2.2 MB that every call fetches. A day is long enough that a phone on
 * cellular stops paying for it per call, and short enough that a model
 * shipped in an update is in use by tomorrow. */
export function staticCacheControl(path: string): string {
  if (path.startsWith("/assets/")) return "private, max-age=31536000, immutable";
  if (path === "/vad/silero_vad.onnx") return "private, max-age=86400";
  return "private, no-store";
}
```

In `relayStatic`, replace lines 1522-1526:

```ts
  // Hashed assets are immutable by construction; the shell never is.
  const cache = path.startsWith("/assets/")
    ? "private, max-age=31536000, immutable"
    : "private, no-store";
```

with:

```ts
  const cache = staticCacheControl(path);
```

- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run companion/test/routes.test.ts companion/test/browser-mobile.test.ts companion/test/browser.test.ts`
Expected: PASS. "keeps the UI shell off the device port entirely" (`routes.test.ts:261-275`) derives `/vad/silero_vad.onnx` from the regex source and still passes.

- [ ] **Step 5: Commit**
`git add companion/src/routes.ts companion/src/browser.ts companion/test/routes.test.ts companion/test/browser-mobile.test.ts`
`git commit -m "fix(companion): a call's model, runtime and voice routes reach the browser door"`

---

### Task B4: Keep the harness's cache lifetime on images

**Files:**
- Modify: `companion/src/browser.ts:1375-1382` (the "Images and anything else" pass-through), plus new `UPSTREAM_CACHEABLE` and exported `keptCacheControl` after `staticCacheControl` (from B3)
- Test: `companion/test/browser-mobile.test.ts`

**Interfaces:**
- Consumes: the harness's `cache-control: private, max-age=31536000, immutable` on `GET /api/threads/:t/messages/:m/image` (`server/index.ts:11983-11988`) and `GET /api/attachments/:name` (`server/index.ts:12119-12124`).
- Produces: `export function keptCacheControl(method: string, path: string, status: number, upstream: string | string[] | undefined): string | null`. Pass-through responses use it, else `BASE_HEADERS["cache-control"]`.

- [ ] **Step 1: Write the failing test**

Append to `companion/test/browser-mobile.test.ts` (add `keptCacheControl` to the `../src/browser.ts` import):

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run companion/test/browser-mobile.test.ts -t "already downloaded"`
Expected: FAIL: `expected 'private, no-store' to be 'private, max-age=31536000, immutable'`, and `keptCacheControl is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `companion/src/browser.ts`, after `staticCacheControl` (B3) add:

```ts
/** The harness routes whose `cache-control` this door passes on instead of
 * replacing. Both serve bytes that never change under their name: an
 * attachment is stored under a generated filename, and a message image is the
 * image of a settled message (`server/index.ts:11983-11988`, `:12119-12124`).
 * The same two patterns `BROWSER_ALLOWED` lets through. */
const UPSTREAM_CACHEABLE: ReadonlyArray<RegExp> = [
  /^\/api\/attachments\/[\w-]+\.(?:png|jpe?g|gif|webp)$/i,
  /^\/api\/threads\/[\w-]+\/messages\/[\w-]+\/image$/,
];

/** The harness's own cache lifetime for this response when this door keeps
 * it, or null for the door's `no-store`.
 *
 * `no-store` on everything was the right default and the wrong answer here:
 * a phone scrolling back through a chat of photos downloaded every one of
 * them again, every time, over cellular. Kept only for a successful GET on
 * the two routes above, and only when the harness itself said `private` — no
 * cache shared between a person and this door may hold their pictures, and a
 * harness that stops saying `private` gets `no-store` rather than trust. */
export function keptCacheControl(
  method: string,
  path: string,
  status: number,
  upstream: string | string[] | undefined,
): string | null {
  if (method !== "GET" || status !== 200 || typeof upstream !== "string") return null;
  if (!UPSTREAM_CACHEABLE.some((route) => route.test(path))) return null;
  const value = upstream.trim();
  return /^private\s*(?:,|$)/i.test(value) ? value : null;
}
```

In `forward`'s response callback, replace line 1379:

```ts
            res.writeHead(harness.statusCode ?? 200, { ...harness.headers, ...BASE_HEADERS });
```

with:

```ts
            const status = harness.statusCode ?? 200;
            res.writeHead(status, {
              ...harness.headers,
              ...BASE_HEADERS,
              "cache-control":
                keptCacheControl(method, path, status, harness.headers["cache-control"]) ?? BASE_HEADERS["cache-control"],
            });
```

A 404 for an image is JSON and goes through `send()` (lines 1421-1437), which keeps `BASE_HEADERS`, so it stays `no-store`.

- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run companion/test/browser-mobile.test.ts companion/test/browser.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
`git add companion/src/browser.ts companion/test/browser-mobile.test.ts`
`git commit -m "fix(companion): the browser door keeps image cache lifetimes instead of no-store"`

---

### Task B5: Content-hashed Mermaid frame (build and harness side)

**Files:**
- Modify: `scripts/vite-render-plugin.ts:27` (constants), `:113-158` (`murageRenderPlugins`), plus new `frameFileName` and `FRAME_PATH_DEFINE`
- Modify: `src/mermaid-frame/protocol.ts:8-9` (`MERMAID_FRAME_PATH`)
- Modify: `server/index.ts:16869` (sandbox header for the hashed name)
- Test: `src/mermaid-frame/frame-page.test.ts`, `server/index.test.ts:399-401` (fixture) and a new `it` after `:830`

**Interfaces:**
- Consumes: `frameHtml` (`scripts/vite-render-plugin.ts:51`), `MERMAID_FRAME_PATH` used as the iframe `src` (`src/components/MermaidDiagram.tsx:134`).
- Produces: `export function frameFileName(html: string): string` → `mermaid-frame-<16 lowercase hex>.html`; `export const FRAME_PATH_DEFINE = "__MURAGE_MERMAID_FRAME_PATH__"`. A build emits `dist/mermaid-frame-<hash>.html` (no more `dist/mermaid-frame.html`) and defines the global to `"/mermaid-frame-<hash>.html"`. `MERMAID_FRAME_PATH` is that value in a build and `"/mermaid-frame.html"` in dev, in tests, and inside the frame's own esbuild bundle. The harness sends `content-security-policy: sandbox allow-scripts` for both names, and never for the SPA fallback. B6 relies on that header.

Invariants kept (`src/mermaid-frame/frame.ts:1-13`, `vite-render-plugin.ts:3-8`): the frame is still one page with one inline classic script allowed by its sha256 in the page's own meta CSP, loaded in `<iframe sandbox="allow-scripts">` with no `allow-same-origin`, and served with the `sandbox allow-scripts` header. Only the file name changes.

- [ ] **Step 1: Write the failing test**

Append to `src/mermaid-frame/frame-page.test.ts` (change the import to `import { FRAME_PATH_DEFINE, frameFileName, frameHtml, murageRenderPlugins } from "../../scripts/vite-render-plugin.ts";` and add `import { MERMAID_FRAME_PATH } from "./protocol";`):

```ts
// The frame is 5 MB. Named by its content, the browser door can let a phone
// keep it for a year and a release still reaches it the day it ships.
it("names the built frame by its content, and tells the app that name before any module is built", async () => {
  const html = await frameHtml({ minify: true });
  const name = frameFileName(html);
  expect(name).toMatch(/^mermaid-frame-[0-9a-f]{16}\.html$/);
  expect(frameFileName(html)).toBe(name);
  expect(frameFileName(`${html}\n`)).not.toBe(name);

  const plugin = murageRenderPlugins().find((p) => p.name === "murage-mermaid-frame")!;
  type ConfigHook = (config: object, env: { command: "build" | "serve"; mode: string }) => Promise<unknown>;
  const config = plugin.config as unknown as ConfigHook;
  // The same bytes the test built, so the same name: a frame whose name
  // drifted between the define and the emitted file is a 404 in every chat.
  expect(await config({}, { command: "build", mode: "production" })).toEqual({
    define: { [FRAME_PATH_DEFINE]: JSON.stringify(`/${name}`) },
  });
  // The dev server keeps serving the plain name from its middleware.
  expect(await config({}, { command: "serve", mode: "development" })).toBeUndefined();

  const emitted: Array<{ fileName?: string; source?: unknown }> = [];
  const generateBundle = plugin.generateBundle as unknown as (this: { emitFile: (file: object) => void }) => Promise<void>;
  await generateBundle.call({ emitFile: (file) => emitted.push(file as { fileName?: string; source?: unknown }) });
  expect(emitted).toEqual([{ type: "asset", fileName: name, source: html }]);
}, 120_000);

it("keeps the plain name wherever no build has named the frame", () => {
  // dev, this test run, and the frame's own bundle all see no define
  expect(MERMAID_FRAME_PATH).toBe("/mermaid-frame.html");
});
```

In `server/index.test.ts` `beforeAll`, after line 401 (`writeFileSync(join(staticDir, "assets", "smoke.css"), …)`) add:

```ts
  writeFileSync(join(staticDir, "mermaid-frame-0123456789abcdef.html"), "<!doctype html><title>Diagram frame</title>");
```

and after the "serves packaged UI assets and preserves API 404s" test (ends line 830) add:

```ts
  it("serves the content-hashed diagram frame only as a sandboxed, opaque page", async () => {
    const frame = await fetch(`${BASE}/mermaid-frame-0123456789abcdef.html`);
    expect(frame.status).toBe(200);
    expect(frame.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
    expect(await frame.text()).toContain("Diagram frame");
    // A stale hash is the SPA fallback, and carries no sandbox header. That
    // absence is what the browser door reads to refuse it rather than cache
    // the shell under a frame's name for a year.
    const stale = await fetch(`${BASE}/mermaid-frame-fedcba9876543210.html`);
    expect(await stale.text()).toContain("Packaged Murage");
    expect(stale.headers.get("content-security-policy")).toBeNull();
    expect((await fetch(`${BASE}/`)).headers.get("content-security-policy")).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run src/mermaid-frame/frame-page.test.ts` then `pnpm vitest run server/index.test.ts -t "diagram frame"`
Expected: FAIL: `frameFileName is not a function`; server: `expected null to be 'sandbox allow-scripts'`.

- [ ] **Step 3: Write minimal implementation**

`scripts/vite-render-plugin.ts`: in the header comment replace line 3 `// 1. The diagram frame page (/mermaid-frame.html). The frame runs in` with `// 1. The diagram frame page (/mermaid-frame-<hash>.html in a build, /mermaid-frame.html in dev). The frame runs in` and replace lines 7-8 (`… Served by a dev` / `middleware, emitted as dist/mermaid-frame.html in a build.`) with:

```ts
//    page, and allowed by its sha256 in the page's own CSP. Served by a dev
//    middleware under its plain name; a build names it by its content and
//    tells the app that name through a define, so it can be cached for good.
```

After `const FRAME_FILE = "mermaid-frame.html";` (line 27) add:

```ts
/** The global a build defines to the frame page's hashed address, read in
 * src/mermaid-frame/protocol.ts. */
export const FRAME_PATH_DEFINE = "__MURAGE_MERMAID_FRAME_PATH__";

/** The frame page's name in a build: its content's hash, so the browser door
 * can let a browser keep it for a year and a new release is a new name.
 * Sixteen hex digits, which is what the door's allowlist accepts. */
export function frameFileName(html: string): string {
  return `mermaid-frame-${createHash("sha256").update(html, "utf8").digest("hex").slice(0, 16)}.html`;
}
```

Replace `murageRenderPlugins`'s first line of body `let devFrame: Promise<string> | undefined;` (line 114) with:

```ts
  let devFrame: Promise<string> | undefined;
  // One build of the frame per plugin instance: the name the app is told in
  // `config` and the file `generateBundle` writes are the same bytes.
  let builtFrame: Promise<{ fileName: string; html: string }> | undefined;
  const buildFrame = () =>
    (builtFrame ??= frameHtml({ depsDir: options.depsDir, minify: true }).then((html) => ({ html, fileName: frameFileName(html) })));
```

In the `murage-mermaid-frame` plugin object (lines 136-156), after `name: "murage-mermaid-frame",` add:

```ts
      // Before any module is transformed: the app's frame URL is a define,
      // and a define has to exist before the code that reads it is built.
      async config(_config, env) {
        if (env.command !== "build") return undefined;
        const { fileName } = await buildFrame();
        return { define: { [FRAME_PATH_DEFINE]: JSON.stringify(`/${fileName}`) } };
      },
```

and replace `generateBundle` (lines 153-155):

```ts
      async generateBundle() {
        this.emitFile({ type: "asset", fileName: FRAME_FILE, source: await frameHtml({ depsDir: options.depsDir, minify: true }) });
      },
```

with:

```ts
      async generateBundle() {
        const { fileName, html } = await buildFrame();
        this.emitFile({ type: "asset", fileName, source: html });
      },
```

`src/mermaid-frame/protocol.ts`, replace lines 8-9:

```ts
/** Where the frame page is served, on the app's own origin. */
export const MERMAID_FRAME_PATH = "/mermaid-frame.html";
```

with:

```ts
/** Set by a build (scripts/vite-render-plugin.ts) to the frame page's
 * content-hashed address. Absent in dev, in tests and inside the frame's own
 * bundle, where `typeof` keeps an undeclared global from throwing. */
declare const __MURAGE_MERMAID_FRAME_PATH__: string | undefined;

/** Where the frame page is served, on the app's own origin. A build names it
 * by its content (`/mermaid-frame-<hash>.html`) so the browser door can let
 * it be cached for good; the dev server serves the plain name. */
export const MERMAID_FRAME_PATH: string =
  typeof __MURAGE_MERMAID_FRAME_PATH__ === "string" ? __MURAGE_MERMAID_FRAME_PATH__ : "/mermaid-frame.html";
```

`server/index.ts`, replace line 16869:

```ts
        if (safe === "/mermaid-frame.html") headers["content-security-policy"] = "sandbox allow-scripts";
```

with:

```ts
        // A build names the frame by its content hash (mermaid-frame-<16 hex>);
        // the plain name is the dev server's. Only the real file gets this
        // header, never the SPA fallback below, and the browser door relies on
        // that to tell a stale frame name from the frame.
        if (/^\/mermaid-frame(?:-[0-9a-f]{16})?\.html$/.test(safe)) headers["content-security-policy"] = "sandbox allow-scripts";
```

- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run src/mermaid-frame/frame-page.test.ts && pnpm vitest run server/index.test.ts -t "diagram frame|packaged UI"`
Expected: PASS

- [ ] **Step 5: Commit**
`git add scripts/vite-render-plugin.ts src/mermaid-frame/protocol.ts src/mermaid-frame/frame-page.test.ts server/index.ts server/index.test.ts`
`git commit -m "perf(render): name the diagram frame by its content hash"`

---

### Task B6: The Mermaid frame at the door: cacheable, sandboxed, frameable

Today the frame is broken at the browser door in three ways (see Notes #3):
`X-Frame-Options: DENY` from `BASE_HEADERS` (`browser.ts:152-158`) blocks the app's own
iframe; `relayStatic` writes headers from its own table (`browser.ts:1535`) and drops the
harness's `sandbox allow-scripts`; and `.html` goes through `relayShell` (`browser.ts:1530`),
which injects the renewal script into the frame.

**Files:**
- Modify: `companion/src/routes.ts:203-206` (frame entry) plus new exported `MERMAID_FRAME_FILE` above `BROWSER_STATIC`
- Modify: `companion/src/browser.ts:34` (import), `staticCacheControl` (from B3), new `FRAME_CSP` and `staticHeaders`, `relayStatic` (as left by B3)
- Test: `companion/test/browser-mobile.test.ts`, `companion/test/routes.test.ts:264-271`

**Interfaces:**
- Consumes: B5's name format and the harness's `sandbox allow-scripts` header on the real file only.
- Produces: `export const MERMAID_FRAME_FILE = /^\/mermaid-frame-[0-9a-f]{16}\.html$/` (routes.ts); `function staticHeaders(path: string, expected: string): Record<string, string>` (browser.ts, used again by B9 and B10). The frame response carries `content-security-policy: sandbox allow-scripts`, no `x-frame-options`, `cache-control: private, max-age=31536000, immutable`, and the body untouched. It is a 404 when the upstream lacks the sandbox header. `/mermaid-frame.html` is no longer allowlisted.

- [ ] **Step 1: Write the failing test**

Append to `companion/test/browser-mobile.test.ts`:

```ts
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
```

In `companion/test/routes.test.ts`, import `MERMAID_FRAME_FILE` alongside `BROWSER_STATIC` (line 13) and in "keeps the UI shell off the device port entirely" replace lines 264-271's path chooser:

```ts
      const path =
        entry.path.source === "^\\/$" ? "/"
        : entry.path.source.includes("assets") ? "/assets/index-B7zzSDok.js"
```

with:

```ts
      const path =
        entry.path.source === "^\\/$" ? "/"
        : entry.path === MERMAID_FRAME_FILE ? "/mermaid-frame-0123456789abcdef.html"
        : entry.path.source.includes("assets") ? "/assets/index-B7zzSDok.js"
```

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run companion/test/browser-mobile.test.ts -t "diagram frame"`
Expected: FAIL: `expected 404 to be 200` (the hashed name is not allowlisted).

- [ ] **Step 3: Write minimal implementation**

`companion/src/routes.ts`, directly above the `BROWSER_STATIC` doc comment (line 179) add:

```ts
/** The diagram frame's built name (`scripts/vite-render-plugin.ts`
 * `frameFileName`): sixteen lowercase hex digits of its content hash, exactly.
 * Exported because the door serves this one static page differently from the
 * shell — framed, sandboxed, never rewritten (`browser.ts` `relayStatic`). */
export const MERMAID_FRAME_FILE = /^\/mermaid-frame-[0-9a-f]{16}\.html$/;

```

and replace lines 203-206:

```ts
  // The diagram frame (src/mermaid-frame): chat renders Mermaid inside a
  // sandboxed, opaque-origin iframe loaded from this one static page. The
  // harness serves it with its own `sandbox allow-scripts` CSP header.
  { method: "GET", path: /^\/mermaid-frame\.html$/ },
```

with:

```ts
  // The diagram frame (src/mermaid-frame): chat renders Mermaid inside a
  // sandboxed, opaque-origin iframe loaded from this one static page. A build
  // names it by its content, so it is 5 MB a phone downloads once per release
  // rather than once per diagram. The plain `/mermaid-frame.html` is the dev
  // server's name and is deliberately not here.
  { method: "GET", path: MERMAID_FRAME_FILE },
```

`companion/src/browser.ts`, line 34:

```ts
import { BROWSER_STATIC, MERMAID_FRAME_FILE, denyReason, isCloudDesktopJoin, isRoutineWrite } from "./routes.ts";
```

In `staticCacheControl` (B3) replace its first line:

```ts
  if (path.startsWith("/assets/")) return "private, max-age=31536000, immutable";
```

with:

```ts
  if (path.startsWith("/assets/") || MERMAID_FRAME_FILE.test(path)) return "private, max-age=31536000, immutable";
```

After `staticCacheControl` add:

```ts
/** The diagram frame's response policy, written by this door because it
 * writes every static response's headers from its own table rather than
 * relaying the harness's — which is how the harness's `sandbox allow-scripts`
 * (`server/index.ts:16869`) was being dropped, and the one line that keeps
 * the page an opaque origin even when it is opened directly went with it.
 *
 * No `frame-ancestors`, and no `X-Frame-Options` either: DENY refuses even the
 * app's own iframe, which is the only way the page is ever shown, and what
 * someone else framing it would get is an opaque page with no secrets that
 * the session cookie does not reach cross-site anyway. */
const FRAME_CSP = "sandbox allow-scripts";

/** The headers every static response is written with. */
function staticHeaders(path: string, expected: string): Record<string, string> {
  const headers: Record<string, string> = { ...BASE_HEADERS, "cache-control": staticCacheControl(path), "content-type": expected };
  if (MERMAID_FRAME_FILE.test(path)) {
    delete headers["x-frame-options"];
    headers["content-security-policy"] = FRAME_CSP;
  }
  return headers;
}
```

In `relayStatic` (as left by B3), replace everything from `const cache = staticCacheControl(path);` to the end of the function:

```ts
  const cache = staticCacheControl(path);

  // The shell is the one response this door rewrites, and this is the line
  // that makes renewal actually happen rather than merely exist. Every other
  // static file goes through untouched.
  if (expected.startsWith("text/html")) return relayShell(harness, res, expected, cache);

  res.writeHead(200, { ...BASE_HEADERS, "cache-control": cache, "content-type": expected });
  harness.on("error", () => res.destroy());
  harness.pipe(res);
}
```

with:

```ts
  // The diagram frame is HTML and is not the shell. It is recognised by the
  // one header only the real file carries: a stale name — a page still
  // running last release's bundle — gets the SPA fallback, which is 200 and
  // HTML and would otherwise be cached for a year under a frame's name.
  const frame = MERMAID_FRAME_FILE.test(path);
  if (frame && !/\bsandbox\b/.test(String(harness.headers["content-security-policy"] ?? ""))) {
    harness.destroy();
    return sendJson(res, 404, { error: `no route: GET ${path}` });
  }

  // The shell is the one response this door rewrites, and this is the line
  // that makes renewal actually happen rather than merely exist. Every other
  // static file goes through untouched — the frame included, whose own policy
  // names its one script by hash.
  if (expected.startsWith("text/html") && !frame) return relayShell(harness, res, expected, staticCacheControl(path));

  res.writeHead(200, staticHeaders(path, expected));
  harness.on("error", () => res.destroy());
  harness.pipe(res);
}
```

- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run companion/test/browser-mobile.test.ts companion/test/routes.test.ts companion/test/browser.test.ts companion/test/browser-renew.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
`git add companion/src/routes.ts companion/src/browser.ts companion/test/browser-mobile.test.ts companion/test/routes.test.ts`
`git commit -m "fix(companion): serve the hashed diagram frame framed, sandboxed and immutable"`

---

### Task B7: Shell Content-Security-Policy with a per-response nonce

**Files:**
- Modify: `companion/src/browser.ts:955-970` (`injectRenewal` and its comment), new exported `shellCsp` and `withScriptNonce` above it, `relayShell` (`browser.ts:1548-1580`)
- Test: `companion/test/browser-mobile.test.ts`

**Interfaces:**
- Consumes: what `index.html` and `src/` load: the inline skin-stamp script (`index.html`), the vite module entry and its lazy chunks, ONNX Runtime WebAssembly (`src/lib/silero-vad.ts:14-40`), the Mermaid iframe (`MermaidDiagram.tsx:131-141`), `srcdoc` previews with `sandbox=""` (`ArtifactCards.tsx:151`, `WorkspacePane.tsx:811`, `WorkspaceFiles.tsx:184`, `Files.tsx:160`, `FirstRunCard.tsx:388`), blob and data images and media (`tts/index.ts:381`, `code-block.ts:67`, `ChatMarkdown.tsx:49`), remote connector logos (`PluginsPanel.tsx:409-414`), the service worker and manifest, and one foreign socket (`src/lib/assemblyai-transcription.ts:20`).
- Produces: `export function shellCsp(nonce: string): string`; `export function withScriptNonce(html: string, nonce: string): string`; `injectRenewal(html: string, nonce?: string): string`. Every shell response (`/`, `/index.html`, SPA deep links), including the `MAX_SHELL_BYTES` overflow, carries `content-security-policy: shellCsp(nonce)` with a fresh nonce, and every `<script` in the rewritten shell carries `nonce="<nonce>"`.

Policy (each line is justified in the code comment):
`default-src 'self'; script-src 'self' 'nonce-N' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' wss://streaming.assemblyai.com; frame-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`

A nonce, not a hash: the inline skin script's bytes are whatever `vite build` leaves in `dist/index.html`, and a hash pinned in the door would break silently on the next edit to `index.html`.

- [ ] **Step 1: Write the failing test**

Append to `companion/test/browser-mobile.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run companion/test/browser-mobile.test.ts -t "shell's policy"`
Expected: FAIL: `expected '' to match /^[A-Za-z0-9+/]{22}==$/` (no CSP on the shell today, `browser.ts:959-963`).

- [ ] **Step 3: Write minimal implementation**

In `companion/src/browser.ts`, replace the `injectRenewal` doc comment and function (lines 950-970):

```ts
/** Put the renewal script into the shell document.
 *
 * Before `</body>` when there is one, appended when there is not — an SPA
 * shell that lost its closing tag is still a document a browser will run a
 * trailing script in, and refusing to inject would silently give back the
 * ninety-day product this change exists to replace.
 *
 * No nonce, and that is checked rather than assumed: neither this door nor
 * the harness sends a Content-Security-Policy on the shell, and `dist/
 * index.html` carries no CSP meta — it already runs an inline script of its
 * own to stamp the colour scheme before first paint. The day a policy lands,
 * this is the second script that needs a nonce and the first one will have
 * shown the way. */
export function injectRenewal(html: string): string {
  const tag = `<script>${renewalScript()}</script>`;
```

with:

```ts
/** The app shell's Content-Security-Policy, for one response's nonce.
 *
 * The shell had none, and chat renders some raw HTML. Each line is here for
 * something the app actually loads, and says what:
 *
 *  - `script-src`: the bundle and its lazy chunks from 'self'; the inline
 *    scripts (the pre-paint skin stamp in `index.html`, the renewal script
 *    this door adds) by this response's nonce. A nonce rather than a hash
 *    because the stamp is whatever `vite build` left in `dist/index.html`,
 *    and a hash pinned here would break on the next edit to that file.
 *    `wasm-unsafe-eval` is WebAssembly compilation for the call's speech
 *    detector (`src/lib/silero-vad.ts`); it permits no string evaluation.
 *  - `style-src 'unsafe-inline'`: React's style props are exempt, but
 *    KaTeX's markup, TipTap's injected sheet and the sandboxed previews' own
 *    `<style>` are not — and a `srcdoc` frame inherits this policy.
 *  - `img-src`: pasted and generated images are data: and blob:; connector
 *    logos are remote (`PluginsPanel.tsx:409-414`). Chat never fetches a
 *    remote image on sight (`ChatMarkdown.tsx:401`), so `https:` here admits
 *    logos, not tracking pixels in model text.
 *  - `connect-src`: the API and the event stream are same-origin. The one
 *    foreign socket is the skill recorder's live transcription
 *    (`src/lib/assemblyai-transcription.ts:20`), named exactly.
 *  - `frame-src 'self'`: the diagram frame, same-origin by URL and made
 *    opaque by its own sandbox header. `srcdoc` previews are not governed
 *    by it; their `sandbox=""` already runs no script.
 *  - `frame-ancestors 'none'` says what `X-Frame-Options: DENY` says, for
 *    browsers that read only this. */
export function shellCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' wss://streaming.assemblyai.com",
    "frame-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Give every `<script>` in the shell this response's nonce.
 *
 * Every one, including the module entry that `'self'` would already allow:
 * the shell is this build's own document, read whole from the harness, and a
 * script tag in it is one the build put there. Only the shell goes through
 * here — never the diagram frame, whose own policy names its script by hash. */
export function withScriptNonce(html: string, nonce: string): string {
  return html.replace(/<script(?=[\s>])/gi, `<script nonce="${nonce}"`);
}

/** Put the renewal script into the shell document.
 *
 * Before `</body>` when there is one, appended when there is not — an SPA
 * shell that lost its closing tag is still a document a browser will run a
 * trailing script in, and refusing to inject would silently give back the
 * ninety-day product this change exists to replace.
 *
 * It carries the shell's nonce when there is one (`relayShell` always passes
 * it); without it `shellCsp` would refuse the very script that keeps the
 * session alive, silently. */
export function injectRenewal(html: string, nonce?: string): string {
  const tag = `<script${nonce ? ` nonce="${nonce}"` : ""}>${renewalScript()}</script>`;
```

Replace `relayShell` (lines 1548-1580) with:

```ts
function relayShell(harness: IncomingMessage, res: ServerResponse, expected: string, cache: string): void {
  // One nonce per response, never reused: it is the whole of what lets the
  // shell's own inline scripts run and an injected one not.
  const nonce = randomBytes(16).toString("base64");
  const headers: Record<string, string> = {
    ...BASE_HEADERS,
    "cache-control": cache,
    "content-type": expected,
    "content-security-policy": shellCsp(nonce),
  };
  const chunks: Buffer[] = [];
  let size = 0;
  let overflowed = false;
  harness.on("data", (chunk: Buffer) => {
    if (overflowed) return;
    size += chunk.length;
    if (size > MAX_SHELL_BYTES) {
      overflowed = true;
      // No content-length: the rest of this body is still arriving. The
      // policy goes out anyway, with a nonce no script here carries: the
      // inline skin stamp is refused and the entry bundle still loads from
      // 'self', so the app runs in its default palette. A document this door
      // could not read gets the stricter answer, not a looser one.
      res.writeHead(200, headers);
      for (const buffered of chunks) res.write(buffered);
      chunks.length = 0;
      res.write(chunk);
      harness.pipe(res);
      return;
    }
    chunks.push(chunk);
  });
  harness.on("error", () => res.destroy());
  harness.on("end", () => {
    if (overflowed) return;
    const html = injectRenewal(withScriptNonce(Buffer.concat(chunks).toString("utf8"), nonce), nonce);
    res.writeHead(200, { ...headers, "content-length": Buffer.byteLength(html) });
    res.end(html);
  });
}
```

(The existing `injectRenewal("<html>…")` calls with one argument in `browser-renew.test.ts:494-497` keep working.)

- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run companion/test/browser-mobile.test.ts companion/test/browser-renew.test.ts companion/test/browser.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
`git add companion/src/browser.ts companion/test/browser-mobile.test.ts`
`git commit -m "feat(companion): a nonce Content-Security-Policy on the app shell"`

---

### Task B8: Encoding negotiation and zlib helpers

**Files:**
- Create: `companion/src/encoding.ts`
- Test: `companion/test/encoding.test.ts`

**Interfaces:**
- Produces:
  - `export type Encoding = "br" | "gzip"`
  - `export const MIN_COMPRESS_BYTES = 1024`
  - `export function negotiateEncoding(header: string | string[] | undefined): Encoding | null`: brotli when its q is > 0 and at least gzip's, else gzip when its q is > 0, else null. `*` and `identity` are ignored.
  - `export function isCompressible(contentType: string): boolean`: `text/*` except `text/event-stream`, JSON and `+json`, `application/javascript`, `image/svg+xml`, `application/wasm`, `image/x-icon`.
  - `export function compressBuffer(body: Buffer, encoding: Encoding): Promise<Buffer>` (brotli quality 5 with a size hint, gzip level 6, on the zlib threadpool)
  - `export function compressStream(encoding: Encoding): Transform`

- [ ] **Step 1: Write the failing test**

Create `companion/test/encoding.test.ts`:

```ts
// What the browser door compresses, and how.
//
// Pure functions, tested as such. Which responses go through them — and the
// rule that a body is only ever compressed after the door has finished
// rewriting it — is `browser-mobile.test.ts`'s half.
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { compressBuffer, compressStream, isCompressible, MIN_COMPRESS_BYTES, negotiateEncoding } from "../src/encoding.ts";

describe("what a browser can decode", () => {
  it("prefers brotli, which every browser this app runs in sends", () => {
    expect(negotiateEncoding("gzip, deflate, br, zstd")).toBe("br");
    expect(negotiateEncoding("BR")).toBe("br");
    expect(negotiateEncoding(["gzip", "br"])).toBe("br");
  });

  it("falls to gzip when brotli is absent, refused or ranked lower", () => {
    expect(negotiateEncoding("gzip, deflate")).toBe("gzip");
    expect(negotiateEncoding("br;q=0, gzip")).toBe("gzip");
    expect(negotiateEncoding("gzip;q=0.5, br;q=0.4")).toBe("gzip");
  });

  it("sends plain bytes to anything that asked for neither", () => {
    for (const header of [undefined, "", "identity", "deflate", "*", "gzip;q=0", "br;q=0, gzip;q=0", "br;q=nonsense"]) {
      expect(negotiateEncoding(header), String(header)).toBeNull();
    }
  });
});

describe("what is worth compressing", () => {
  it("compresses text, code, JSON, SVG and WebAssembly", () => {
    for (const type of [
      "text/html; charset=utf-8",
      "text/javascript; charset=utf-8",
      "text/css; charset=utf-8",
      "application/json",
      "application/manifest+json",
      "image/svg+xml",
      "application/wasm",
      "image/x-icon",
    ]) {
      expect(isCompressible(type), type).toBe(true);
    }
  });

  it("never compresses the event stream, or formats that already are", () => {
    // A compressed SSE stream is buffered by the compressor until a block
    // fills: a frame the phone should see now arrives whenever.
    for (const type of ["text/event-stream", "image/png", "font/woff2", "application/octet-stream", "audio/mpeg", ""]) {
      expect(isCompressible(type), type).toBe(false);
    }
  });

  it("names the floor below which compressing is not worth it", () => {
    expect(MIN_COMPRESS_BYTES).toBe(1024);
  });
});

describe("compressing", () => {
  const body = Buffer.from(JSON.stringify({ bots: Array.from({ length: 200 }, (_, i) => ({ id: `bot_${i}`, name: `Bot ${i}` })) }));

  it("round-trips a whole body in either encoding, and makes it smaller", async () => {
    const br = await compressBuffer(body, "br");
    expect(brotliDecompressSync(br).equals(body)).toBe(true);
    expect(br.byteLength).toBeLessThan(body.byteLength / 4);
    const gz = await compressBuffer(body, "gzip");
    expect(gunzipSync(gz).equals(body)).toBe(true);
  });

  it("round-trips a stream in either encoding", async () => {
    for (const encoding of ["br", "gzip"] as const) {
      const out: Buffer[] = [];
      await pipeline(Readable.from([body.subarray(0, 100), body.subarray(100)]), compressStream(encoding), async function* (source) {
        for await (const chunk of source) out.push(chunk as Buffer);
      });
      const packed = Buffer.concat(out);
      expect((encoding === "br" ? brotliDecompressSync(packed) : gunzipSync(packed)).equals(body), encoding).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run companion/test/encoding.test.ts`
Expected: FAIL with "Failed to load url ../src/encoding.ts" (module does not exist).

- [ ] **Step 3: Write minimal implementation**

Create `companion/src/encoding.ts`:

```ts
// Compression at the browser door.
//
// The 5.5 MB main script went to phones uncompressed, through this door and
// `tailscale serve` both — ten to twenty seconds of a cold launch on cellular
// (spec §6). Everything here is node's own zlib: brotli has been in it since
// v11, and a dependency for this would be a dependency for nothing.
//
// Negotiated from what the BROWSER sent. The harness is never asked for an
// encoding — `forwardedHeaders` builds its header set from nothing and does
// not copy `accept-encoding` — so every compressed body this door sends is one
// it made itself, after it finished rewriting: scrubbed JSON, the shell with
// its nonce and renewal script in. Never the other way round.
import type { Transform } from "node:stream";
import { brotliCompress, constants, createBrotliCompress, createGzip, gzip, type BrotliOptions } from "node:zlib";

export type Encoding = "br" | "gzip";

/** Below this a compressed body can be larger than the plain one, and is
 * never meaningfully smaller. The build's pre-compressed copies use the same
 * floor (`scripts/compress-dist.mjs`). */
export const MIN_COMPRESS_BYTES = 1024;

/** The encoding to answer this `Accept-Encoding` with, or null for plain.
 *
 * Only the two this door can produce are read, with their q-values: brotli
 * when it is accepted and ranked at least as high as gzip, else gzip, else
 * nothing. `*` is not read as permission — every browser that runs this app
 * names both explicitly, and a client that says only `*` gets plain bytes,
 * which it can certainly decode. */
export function negotiateEncoding(header: string | string[] | undefined): Encoding | null {
  const raw = Array.isArray(header) ? header.join(",") : header ?? "";
  const weights = new Map<string, number>();
  for (const part of raw.split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    if (!name) continue;
    let weight = 1;
    for (const param of params) {
      const q = /^\s*q\s*=\s*(.*)$/.exec(param);
      if (q) weight = Number(q[1]);
    }
    weights.set(name.trim(), Number.isFinite(weight) ? weight : 0);
  }
  const br = weights.get("br") ?? 0;
  const gz = weights.get("gzip") ?? 0;
  if (br > 0 && br >= gz) return "br";
  if (gz > 0) return "gzip";
  return null;
}

/** Whether a response of this type is worth compressing.
 *
 * Never the event stream: a compressor holds output until a block fills, so a
 * frame the phone should see now would arrive whenever the next one pushed it
 * out — the stale watchdog's 40 s would start firing on a healthy stream.
 * Never PNG, woff2, audio or opaque bytes: already compressed, or not ours to
 * judge. */
export function isCompressible(contentType: string): boolean {
  const media = contentType.split(";")[0].trim().toLowerCase();
  if (media === "text/event-stream") return false;
  return (
    media.startsWith("text/") ||
    media === "application/json" ||
    media.endsWith("+json") ||
    media === "application/javascript" ||
    media === "image/svg+xml" ||
    media === "application/wasm" ||
    media === "image/x-icon"
  );
}

/** Brotli for a response being made now, not for a build: quality 5 is most
 * of the saving at a small fraction of 11's time. The maximum is for
 * `scripts/compress-dist.mjs`, which runs once. */
const brotliOptions = (sizeHint?: number): BrotliOptions => ({
  params: {
    [constants.BROTLI_PARAM_QUALITY]: 5,
    ...(sizeHint ? { [constants.BROTLI_PARAM_SIZE_HINT]: sizeHint } : {}),
  },
});

/** One whole body, compressed off the event loop (zlib's own threadpool). */
export function compressBuffer(body: Buffer, encoding: Encoding): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const done = (error: Error | null, packed: Buffer) => (error ? reject(error) : resolve(packed));
    if (encoding === "br") brotliCompress(body, brotliOptions(body.byteLength), done);
    else gzip(body, { level: 6 }, done);
  });
}

/** A body that is still arriving, compressed as it passes through. */
export function compressStream(encoding: Encoding): Transform {
  return encoding === "br" ? createBrotliCompress(brotliOptions()) : createGzip({ level: 6 });
}
```

- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run companion/test/encoding.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
`git add companion/src/encoding.ts companion/test/encoding.test.ts`
`git commit -m "feat(companion): encoding negotiation and zlib helpers for the browser door"`

---

### Task B9: Compress at the door: JSON after scrubbing, the shell after rewriting, static on the fly

**Files:**
- Modify: `companion/src/browser.ts:30` (import `OutgoingHttpHeaders`), `:35` (import from `./encoding.ts`), `BASE_HEADERS` (`:152-158`), new `sendBody` after `sendJson` (`:160-172`), `createBrowserHandler` credentialed section (before `const forward`, line 1349), `forward`'s `relayStatic` call (`:1366`) and `send()` (`:1421-1437`), `relayStatic` (as left by B6), `relayShell` (as left by B7)
- Test: `companion/test/browser-mobile.test.ts`

**Interfaces:**
- Consumes: B8's `negotiateEncoding`, `isCompressible`, `compressBuffer`, `compressStream`, `MIN_COMPRESS_BYTES`, `Encoding`; B6's `staticHeaders`; B7's `shellCsp` and `withScriptNonce`.
- Produces: `BASE_HEADERS.vary = "Accept-Encoding"` on every response; `relayStatic(harness, res, expected, path, encoding: Encoding | null)`; `relayShell(harness, res, expected, cache, encoding: Encoding | null)`; `function sendBody(res, status, headers: OutgoingHttpHeaders, body: Buffer, encoding: Encoding | null): void`. B10 relies on the `encoding` constant in `handle` and on `staticHeaders`.

Rules enforced (spec §3.3 "Compression rules"): JSON only after `scrub`; HTML only after nonce and renewal injection; SSE never compressed; `Vary: Accept-Encoding` always; CSP and other headers kept; a shell over `MAX_SHELL_BYTES` goes out plain.

- [ ] **Step 1: Write the failing test**

Append to `companion/test/browser-mobile.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run companion/test/browser-mobile.test.ts -t "bytes on the wire"`
Expected: FAIL: `expected undefined to be 'br'` (nothing is compressed today) and `expected undefined to be 'Accept-Encoding'`.

- [ ] **Step 3: Write minimal implementation**

`companion/src/browser.ts` line 30:

```ts
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from "node:http";
```

After line 35 add:

```ts
import { compressBuffer, compressStream, isCompressible, MIN_COMPRESS_BYTES, negotiateEncoding, type Encoding } from "./encoding.ts";
```

In `BASE_HEADERS`, after `"x-frame-options": "DENY",` add:

```ts
  // Every response, whether or not this one was compressed: a cache that
  // kept a brotli body must never hand it to a client that asked for plain.
  vary: "Accept-Encoding",
```

After `sendJson` (ends line 172) add:

```ts
/** One whole body, compressed when the browser can decode it and it is big
 * enough to be worth it. What is handed in here is final — the door has
 * finished rewriting it — which is the whole of the rule about what may be
 * compressed. A zlib failure sends the plain bytes rather than failing a
 * request whose content was fine. */
function sendBody(
  res: ServerResponse,
  status: number,
  headers: OutgoingHttpHeaders,
  body: Buffer,
  encoding: Encoding | null,
): void {
  if (!encoding || body.byteLength < MIN_COMPRESS_BYTES) {
    res.writeHead(status, { ...headers, "content-length": body.byteLength });
    res.end(body);
    return;
  }
  const chosen: Encoding = encoding;
  compressBuffer(body, chosen).then(
    (packed) => {
      if (res.destroyed) return;
      res.writeHead(status, { ...headers, "content-encoding": chosen, "content-length": packed.byteLength });
      res.end(packed);
    },
    () => {
      if (res.destroyed) return;
      res.writeHead(status, { ...headers, "content-length": body.byteLength });
      res.end(body);
    },
  );
}
```

In `createBrowserHandler`, directly before `const forward = (body: Buffer | null): void => {` (line 1349) add:

```ts
    // What this browser can decode, decided once. `forwardedHeaders` never
    // passes `accept-encoding` upstream, so the harness always answers in
    // plain bytes and every compressed body below is one this door made after
    // it finished rewriting: scrubbed JSON, the shell with its nonce and
    // renewal script in. Never the other way round.
    const encoding = negotiateEncoding(req.headers["accept-encoding"]);
```

Replace line 1366:

```ts
          if (staticType) return relayStatic(harness, res, staticType, path);
```

with:

```ts
          if (staticType) return relayStatic(harness, res, staticType, path, encoding);
```

Replace `send()` (lines 1421-1437) with:

```ts
          function send(text: string, status: number, upstreamHeaders: IncomingMessage["headers"]): void {
            const headers = { ...upstreamHeaders };
            // The body was re-serialised, so nothing the harness said about
            // its framing survives. Leaving transfer-encoding alongside the
            // content-length set here is a protocol violation Node's own
            // parser rejects outright.
            delete headers["content-length"];
            delete headers["content-encoding"];
            delete headers["transfer-encoding"];
            // Compressed here and nowhere earlier: these are the bytes `scrub`
            // produced, so nothing it withheld can ride along inside a
            // compressed copy of the original.
            sendBody(res, status, { ...headers, ...BASE_HEADERS }, Buffer.from(text, "utf8"), encoding);
          }
```

Replace `relayStatic` (as left by B6) with:

```ts
function relayStatic(
  harness: IncomingMessage,
  res: ServerResponse,
  expected: string,
  path: string,
  encoding: Encoding | null,
): void {
  const upstreamType = String(harness.headers["content-type"] ?? "");
  const status = harness.statusCode ?? 200;

  // `MURAGE_STATIC_DIR` unset: the harness has no UI to serve and falls
  // through to its own JSON 404. A blank page is the wrong way to say that.
  if (status === 404 && isJson(upstreamType)) {
    harness.resume();
    return sendJson(res, 503, { error: "the desktop app is not serving the UI" });
  }
  if (status !== 200) {
    harness.resume();
    return sendJson(res, status, { error: `no route: GET ${path}` });
  }
  if (!expected.startsWith("text/html") && upstreamType.startsWith("text/html")) {
    harness.destroy();
    return sendJson(res, 404, { error: `no route: GET ${path}` });
  }

  // The diagram frame is HTML and is not the shell. It is recognised by the
  // one header only the real file carries: a stale name — a page still
  // running last release's bundle — gets the SPA fallback, which is 200 and
  // HTML and would otherwise be cached for a year under a frame's name.
  const frame = MERMAID_FRAME_FILE.test(path);
  if (frame && !/\bsandbox\b/.test(String(harness.headers["content-security-policy"] ?? ""))) {
    harness.destroy();
    return sendJson(res, 404, { error: `no route: GET ${path}` });
  }

  // The shell is the one response this door rewrites, and this is the line
  // that makes renewal actually happen rather than merely exist. Every other
  // static file goes through untouched — the frame included, whose own policy
  // names its one script by hash.
  if (expected.startsWith("text/html") && !frame) {
    return relayShell(harness, res, expected, staticCacheControl(path), encoding);
  }

  harness.on("error", () => res.destroy());
  // Compressed as it passes, when the build left no copy of its own
  // (`relayPrecompressed` asks for that first). Streamed rather than
  // buffered: the main script is megabytes, and nothing here reads it.
  if (encoding && isCompressible(expected)) {
    res.writeHead(200, { ...staticHeaders(path, expected), "content-encoding": encoding });
    const packer = compressStream(encoding);
    packer.on("error", () => res.destroy());
    harness.pipe(packer).pipe(res);
    return;
  }
  res.writeHead(200, staticHeaders(path, expected));
  harness.pipe(res);
}
```

Replace `relayShell` (as left by B7) with:

```ts
function relayShell(
  harness: IncomingMessage,
  res: ServerResponse,
  expected: string,
  cache: string,
  encoding: Encoding | null,
): void {
  // One nonce per response, never reused: it is the whole of what lets the
  // shell's own inline scripts run and an injected one not.
  const nonce = randomBytes(16).toString("base64");
  const headers: Record<string, string> = {
    ...BASE_HEADERS,
    "cache-control": cache,
    "content-type": expected,
    "content-security-policy": shellCsp(nonce),
  };
  const chunks: Buffer[] = [];
  let size = 0;
  let overflowed = false;
  harness.on("data", (chunk: Buffer) => {
    if (overflowed) return;
    size += chunk.length;
    if (size > MAX_SHELL_BYTES) {
      overflowed = true;
      // No content-length: the rest of this body is still arriving. The
      // policy goes out anyway, with a nonce no script here carries: the
      // inline skin stamp is refused and the entry bundle still loads from
      // 'self', so the app runs in its default palette. A document this door
      // could not read gets the stricter answer, not a looser one — and it
      // goes out plain, because nothing about a guard path is worth a
      // compressor in the middle of it.
      res.writeHead(200, headers);
      for (const buffered of chunks) res.write(buffered);
      chunks.length = 0;
      res.write(chunk);
      harness.pipe(res);
      return;
    }
    chunks.push(chunk);
  });
  harness.on("error", () => res.destroy());
  harness.on("end", () => {
    if (overflowed) return;
    // Rewritten first, compressed last: the nonce and the renewal script are
    // in the bytes that get compressed.
    const html = injectRenewal(withScriptNonce(Buffer.concat(chunks).toString("utf8"), nonce), nonce);
    sendBody(res, 200, headers, Buffer.from(html, "utf8"), encoding);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run companion/test/browser-mobile.test.ts companion/test/browser.test.ts companion/test/browser-renew.test.ts companion/test/browser-session-streams.test.ts companion/test/browser-code.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
`git add companion/src/browser.ts companion/test/browser-mobile.test.ts`
`git commit -m "perf(companion): brotli and gzip at the browser door, after every rewrite"`

---

### Task B10: Prefer the build's pre-compressed siblings at the door

**Files:**
- Modify: `companion/src/browser.ts` (new exported `hasBuildSiblings` and `relayPrecompressed` after `relayStatic`; the final `forward(null);` at line 1484)
- Test: `companion/test/browser-mobile.test.ts`

**Interfaces:**
- Consumes: B9's `encoding` constant and `staticHeaders`; B11's `<file>.br` and `<file>.gz` next to `dist/assets/*` and `dist/mermaid-frame-<hash>.html`, served by the harness as `application/octet-stream` (its MIME table has no `.br` or `.gz`, `server/index.ts:518-535`).
- Produces: `export function hasBuildSiblings(path: string): boolean` (`/assets/*` and the hashed frame only). For a GET static path with siblings and a negotiated encoding, the door first asks the harness for `path + ".br"` (or `".gz"`). A 200 that is neither HTML nor JSON is relayed with `content-encoding` and the door's own static headers. Anything else (the SPA fallback, the no-UI JSON 404, an error, a timeout) falls back to B9's path.

The door does not read the disk: the harness owns the static directory (`server/index.ts:16859`), and the door learns the siblings the same way it learns everything else.

- [ ] **Step 1: Write the failing test**

Append to `companion/test/browser-mobile.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run companion/test/browser-mobile.test.ts -t "build's own compressed copies"`
Expected: FAIL: `expected [ '/assets/index-AbC123.js' ] to deeply equal [ '/assets/index-AbC123.js.br' ]`, and the body is `JS` rather than `BUILT`.

- [ ] **Step 3: Write minimal implementation**

In `companion/src/browser.ts`, after `relayStatic` add:

```ts
/** Whether the build writes compressed copies of this path
 * (`scripts/compress-dist.mjs`): the files whose names change when their
 * content does, and nothing that keeps its name across releases — a copy of
 * those would be stale the day after an update. */
export function hasBuildSiblings(path: string): boolean {
  return path.startsWith("/assets/") || MERMAID_FRAME_FILE.test(path);
}

/** Relay the build's own compressed copy of a hashed file, or hand back to
 * the ordinary path when there is none.
 *
 * Brotli at its maximum quality is far too slow to run per request and costs
 * nothing at build time, and the main script is the 5.5 MB that makes a cold
 * launch on cellular slow. So the harness is asked for `<file>.br` first. It
 * is asked the way this door asks it everything, rather than read off a disk
 * this door does not own.
 *
 * A miss is anything but a 200 that is neither HTML nor JSON: the SPA
 * fallback (index.html, 200) and the no-UI JSON 404 both mean "no copy", and
 * neither may ever be relayed under a script's name. An error or a silent
 * harness falls back too; the ordinary path then says what went wrong in its
 * own words. */
function relayPrecompressed(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  expected: string,
  encoding: Encoding,
  options: BrowserDoorOptions,
  fallback: () => void,
): void {
  let state: "asking" | "serving" | "fell-back" = "asking";
  const miss = () => {
    if (state !== "asking") return;
    state = "fell-back";
    fallback();
  };
  const upstream = httpRequest(
    {
      hostname: "127.0.0.1",
      port: options.harnessPort,
      path: `${path}${encoding === "br" ? ".br" : ".gz"}`,
      method: "GET",
      headers: forwardedHeaders(req),
    },
    (harness) => {
      clearTimeout(deadline);
      const type = String(harness.headers["content-type"] ?? "");
      if ((harness.statusCode ?? 0) !== 200 || type.startsWith("text/html") || isJson(type)) {
        harness.resume();
        return miss();
      }
      state = "serving";
      const length = harness.headers["content-length"];
      res.writeHead(200, {
        ...staticHeaders(path, expected),
        "content-encoding": encoding,
        ...(length ? { "content-length": length } : {}),
      });
      harness.on("error", () => res.destroy());
      harness.pipe(res);
    },
  );
  const deadline = setTimeout(
    () => upstream.destroy(new Error("the harness sent no response headers")),
    options.headersTimeoutMs ?? HEADERS_TIMEOUT_MS,
  );
  deadline.unref?.();
  upstream.on("error", () => {
    clearTimeout(deadline);
    if (state === "serving") res.destroy();
    else miss();
  });
  res.on("close", () => {
    if (state === "serving" && !res.writableEnded) upstream.destroy();
  });
  // The browser's own request is left unread here, so the fallback can still
  // pipe it upstream exactly as it always has.
  upstream.end();
}
```

In `createBrowserHandler`, replace the final line 1484 `forward(null);` with:

```ts
    // The build's own compressed copy first, for the files it made one of.
    const staticType = method === "GET" ? staticContentType(path) : null;
    if (staticType && encoding && hasBuildSiblings(path)) {
      return relayPrecompressed(req, res, path, staticType, encoding, options, () => forward(null));
    }
    forward(null);
```

- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run companion/test/browser-mobile.test.ts companion/test/browser.test.ts companion/test/browser-renew.test.ts`
Expected: PASS. B9's "compresses a static file on the way through" now also covers the miss path, because it registers no `.br`.

- [ ] **Step 5: Commit**
`git add companion/src/browser.ts companion/test/browser-mobile.test.ts`
`git commit -m "perf(companion): serve the build's pre-compressed assets when it made them"`

---

### Task B11: Build step: `.br` and `.gz` beside hashed dist files

**Files:**
- Create: `scripts/compress-dist.mjs`, `scripts/compress-dist.d.mts`
- Modify: `vite.config.ts:1-10` (import and plugin list)
- Test: `scripts/compress-dist.test.mjs` (already inside vitest's `scripts/**/*.test.mjs`, `vite.config.ts:19`)

**Interfaces:**
- Consumes: vite's `dist/assets/*` and B5's `dist/mermaid-frame-<16 hex>.html`.
- Produces: `export async function compressDist(dir: string): Promise<string[]>` writes `<file>.br` (brotli at maximum quality, text mode except `.wasm`) and `<file>.gz` (level 9) for `.js .mjs .css .json .svg .wasm .html` files of at least 1024 bytes in `assets/` and for the hashed frame. It never touches `index.html`, `sw.js` or the manifest. It skips a copy that is not smaller, and it is idempotent. `export function precompressPlugin(): Plugin` (`name: "murage-precompress"`, `apply: "build"`, runs in `closeBundle`); `COMPRESSIBLE_EXTENSIONS`, `MIN_COMPRESS_BYTES`.

A vite plugin, not a line in `pnpm build`: CI runs `pnpm exec vite build` directly (`.github/workflows/ci.yml:228`, `:305`), so a post-step in `package.json` would ship builds without copies. The copies land in `dist/`, which electron-builder ships as `ui` (`electron-builder.yml:106-107`), so no packaging change is needed.

- [ ] **Step 1: Write the failing test**

Create `scripts/compress-dist.test.mjs`:

```js
// The build's compressed copies, for the browser door (companion/src/browser.ts
// `relayPrecompressed`). What matters: every hashed text file gets both, the
// shell and anything else whose name outlives its content gets neither, and a
// second run changes nothing.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import { compressDist, precompressPlugin } from "./compress-dist.mjs";

const FRAME = "mermaid-frame-0123456789abcdef.html";
let dist = "";

const build = () => {
  dist = mkdtempSync(join(tmpdir(), "murage-dist-"));
  mkdirSync(join(dist, "assets"));
  const js = "export const line = 1;\n".repeat(400);
  writeFileSync(join(dist, "assets", "index-AbC123.js"), js);
  writeFileSync(join(dist, "assets", "ort-wasm-simd-threaded-Q1w2.wasm"), Buffer.alloc(8192, 0));
  writeFileSync(join(dist, "assets", "logo-AbC123.png"), Buffer.alloc(8192, 7));
  writeFileSync(join(dist, "assets", "tiny-AbC123.css"), "a{color:red}");
  writeFileSync(join(dist, FRAME), `<!doctype html>${"<p>frame</p>".repeat(200)}`);
  writeFileSync(join(dist, "index.html"), `<!doctype html>${"<!-- shell -->".repeat(200)}`);
  writeFileSync(join(dist, "sw.js"), "self.addEventListener('fetch', () => {});\n".repeat(100));
  return js;
};

afterEach(() => {
  if (dist) rmSync(dist, { recursive: true, force: true });
  dist = "";
});

describe("compressed copies of the build", () => {
  it("writes both copies beside every hashed text file, and they decode to the file", async () => {
    const js = build();
    await compressDist(dist);
    const file = join(dist, "assets", "index-AbC123.js");
    expect(brotliDecompressSync(readFileSync(`${file}.br`)).toString()).toBe(js);
    expect(gunzipSync(readFileSync(`${file}.gz`)).toString()).toBe(js);
    expect(existsSync(join(dist, "assets", "ort-wasm-simd-threaded-Q1w2.wasm.br"))).toBe(true);
    expect(existsSync(join(dist, `${FRAME}.br`))).toBe(true);
    expect(existsSync(join(dist, `${FRAME}.gz`))).toBe(true);
  });

  it("leaves images, tiny files and everything whose name outlives its content alone", async () => {
    build();
    await compressDist(dist);
    for (const name of ["logo-AbC123.png", "tiny-AbC123.css"]) {
      expect(existsSync(join(dist, "assets", `${name}.br`)), name).toBe(false);
    }
    // The door rewrites the shell per response; a copy of it would be wrong.
    for (const name of ["index.html", "sw.js"]) {
      expect(existsSync(join(dist, `${name}.br`)), name).toBe(false);
      expect(existsSync(join(dist, `${name}.gz`)), name).toBe(false);
    }
  });

  it("changes nothing on a second run", async () => {
    build();
    await compressDist(dist);
    const first = readdirSync(join(dist, "assets")).sort();
    expect(await compressDist(dist)).toEqual(
      expect.arrayContaining([expect.stringMatching(/index-AbC123\.js\.br$/)]),
    );
    expect(readdirSync(join(dist, "assets")).sort()).toEqual(first);
    expect(first.some((name) => name.endsWith(".br.br") || name.endsWith(".gz.br"))).toBe(false);
  });

  it("runs from vite once the bundle is on disk, and only for a build", async () => {
    build();
    const plugin = precompressPlugin();
    expect(plugin.name).toBe("murage-precompress");
    expect(plugin.apply).toBe("build");
    plugin.configResolved({ root: dist, build: { outDir: "." } });
    await plugin.closeBundle();
    expect(existsSync(join(dist, "assets", "index-AbC123.js.br"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `pnpm vitest run scripts/compress-dist.test.mjs`
Expected: FAIL with "Failed to load url ./compress-dist.mjs".

- [ ] **Step 3: Write minimal implementation**

Create `scripts/compress-dist.mjs`:

```js
// Pre-compressed copies of the built UI, for the browser door.
//
// The door (companion/src/browser.ts `relayPrecompressed`) asks the harness
// for `<file>.br` or `<file>.gz` before it compresses anything itself, and
// this is where those files come from. Brotli at its maximum quality is far
// too slow to run per request and costs nothing here, once per build — and it
// is the difference that matters for the 5.5 MB main script on a phone.
//
// Only files whose names change when their content does: everything in
// `assets/` (vite's hashes) and the content-hashed diagram frame. The shell,
// the service worker and the manifest keep their names across releases and
// the door rewrites the shell per response anyway, so a copy of any of them
// would be stale or wrong; the door compresses those on the fly.
//
// A vite plugin rather than a step in `pnpm build`, because CI runs
// `pnpm exec vite build` directly (.github/workflows/ci.yml:228, :305), and a
// post-step nothing runs is a build that ships without its copies. No
// dependency: node's zlib has had brotli since v11.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** Worth compressing. Images and fonts in `assets/` are compressed formats already. */
export const COMPRESSIBLE_EXTENSIONS = new Set([".js", ".mjs", ".css", ".json", ".svg", ".wasm", ".html"]);
/** Below this a copy is not worth a file. The door's floor is the same (companion/src/encoding.ts). */
export const MIN_COMPRESS_BYTES = 1024;
const FRAME = /^mermaid-frame-[0-9a-f]{16}\.html$/;

/** Write `.br` and `.gz` beside every hashed text file in a built `dist/`.
 * Returns the paths written. A second run rewrites the same copies and adds
 * none, because `.br` and `.gz` are not extensions it compresses. */
export async function compressDist(dir) {
  const assets = join(dir, "assets");
  const files = [
    ...(await readdir(assets).catch(() => [])).map((name) => join(assets, name)),
    ...(await readdir(dir)).filter((name) => FRAME.test(name)).map((name) => join(dir, name)),
  ];
  const written = [];
  for (const file of files) {
    const ext = extname(file);
    if (!COMPRESSIBLE_EXTENSIONS.has(ext)) continue;
    const bytes = await readFile(file);
    if (bytes.byteLength < MIN_COMPRESS_BYTES) continue;
    const br = await brotli(bytes, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
        [constants.BROTLI_PARAM_MODE]: ext === ".wasm" ? constants.BROTLI_MODE_GENERIC : constants.BROTLI_MODE_TEXT,
        [constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength,
      },
    });
    const gz = await gzipAsync(bytes, { level: constants.Z_BEST_COMPRESSION });
    for (const [suffix, packed] of [[".br", br], [".gz", gz]]) {
      // A copy no smaller than the file is a worse answer than the file.
      if (packed.byteLength >= bytes.byteLength) continue;
      await writeFile(`${file}${suffix}`, packed);
      written.push(`${file}${suffix}`);
    }
  }
  return written;
}

/** The vite half: runs after the bundle, the diagram frame included, is on disk. */
export function precompressPlugin() {
  let outDir = resolve("dist");
  return {
    name: "murage-precompress",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      await compressDist(outDir);
    },
  };
}
```

Create `scripts/compress-dist.d.mts`:

```ts
import type { Plugin } from "vite";

/** Extensions the build writes `.br` and `.gz` copies of. */
export const COMPRESSIBLE_EXTENSIONS: ReadonlySet<string>;
/** Files smaller than this get no copy. */
export const MIN_COMPRESS_BYTES: number;
/** Write `.br` and `.gz` beside every hashed text file in a built `dist/`; returns the paths written. */
export function compressDist(dir: string): Promise<string[]>;
/** The vite plugin that runs `compressDist` on the output directory after a build. */
export function precompressPlugin(): Plugin & {
  configResolved(config: { root: string; build: { outDir: string } }): void;
  closeBundle(): Promise<void>;
};
```

`vite.config.ts`: after line 5 (`import { murageRenderPlugins } …`) add:

```ts
import { precompressPlugin } from "./scripts/compress-dist.mjs";
```

and replace lines 8-10:

```ts
  // murageRenderPlugins: the sandboxed diagram frame page, and the lazy
  // katex/mermaid/dompurify imports that fall back to source when missing
  plugins: [react(), tailwindcss(), murageRenderPlugins()],
```

with:

```ts
  // murageRenderPlugins: the sandboxed diagram frame page, and the lazy
  // katex/mermaid/dompurify imports that fall back to source when missing.
  // precompressPlugin: `.br`/`.gz` copies of hashed assets for the browser
  // door, written after the bundle (build only; inert under vitest and dev).
  plugins: [react(), tailwindcss(), murageRenderPlugins(), precompressPlugin()],
```

- [ ] **Step 4: Run test to verify it passes**
Run: `pnpm vitest run scripts/compress-dist.test.mjs`
Expected: PASS. The first real `pnpm build` must run on the Hetzner build box, not on this Mac (Sean's golden rule). Check there that `dist/assets/index-*.js.br` exists and is about 1 MB.

- [ ] **Step 5: Commit**
`git add scripts/compress-dist.mjs scripts/compress-dist.d.mts scripts/compress-dist.test.mjs vite.config.ts`
`git commit -m "perf(build): pre-compressed brotli and gzip copies of hashed dist files"`

---

## Notes for the plan author

1. **`call-note` at the door does nothing on its own.** The harness returns 403 to every non-desktop surface (`server/index.ts:16550-16551`). So does the call's "fast half", `/api/bots/:id/voice-host` (`server/index.ts:16529`). So remote calls run engine-only, and `CallView.tsx:753` posts a call note only when the host took part (`answered`, `looked_up` or `not_started`). A remote call therefore never sends one. B3 still adds the entry, because the spec asks for it and it opens nothing. But spec §5's "host fixes it needs … `call-note`" is not enough for host-assisted calls. That needs a server decision to lift both desktop gates. `handleCallNoteRoute` (`server/voice/call-note.ts:78-103`) has **no per-bot visibility check**: `store.bot(id)` resolves hidden bots too. If the gate is lifted without adding a check, a remote device could append notes to a hidden bot's thread. This is not in group B; flag it for whoever owns §5.
2. **The spec left out `.mjs`.** `src/lib/silero-vad.ts:16` imports `onnxruntime-web/ort-wasm-simd-threaded.mjs?url`, and ORT loads it as a module. Allowing only `.wasm` would still leave calls with no voice detection remotely. B3 adds `.mjs` and the matching MIME types. Without the `STATIC_MIME` entries, `staticContentType` returns null and the files would be relayed as API responses.
3. **Diagrams are broken at the browser door today, three ways**, even after `be1c0402`:
   - `X-Frame-Options: DENY` is on every response (`browser.ts:152-158`), so the app's own sandboxed iframe is refused.
   - `relayStatic` writes headers from its own table (`browser.ts:1535`), so the harness's `sandbox allow-scripts` is dropped. The comment at `routes.ts:203-205` is wrong at this door.
   - `.html` goes through `relayShell` (`browser.ts:1530`), which injects the renewal script into the frame.

   B6 fixes all three. It sets no `frame-ancestors` on the frame on purpose: how `'self'` matches inside a sandboxed (opaque) document is not something I could verify for all three engines. Being frameable costs nothing, because the page is opaque, holds no secrets, and the Lax session cookie does not ride a cross-site iframe load. If a reviewer wants `frame-ancestors`, the safe form is the door's exact origin from `expectedOrigin(req, identity)`, not `'self'`. Verify it on real Safari and Chrome first.
4. **`/healthz` sits after the origin gate.** A launcher that probes with WebView `fetch` from `capacitor://localhost` gets 403 (cross-site). It could not read the answer anyway, because there is no CORS header. The launcher must use native HTTP (CapacitorHttp, URLSession or OkHttp), as spec §3.1 says. Tell the Plan 2 author.
5. **CSP must be proven on the real build in a real browser** (docs/verification). Unit tests pin the header, not the absence of violations from libraries. Two choices to confirm:
   - `img-src https:` keeps connector logos (`PluginsPanel.tsx:409-414`). Without it they fall back to a monogram. Chat itself never loads remote images.
   - `connect-src … wss://streaming.assemblyai.com` is there for the skill recorder. Drop it if that page is desktop-only.

   zod 4's `new Function` probe will log one CSP violation report and then fall back. That is expected. The service worker caches the shell's response headers along with the body (`public/sw.js`), so the offline fallback replays a matching nonce/body pair.
6. **What compression costs.**
   - The build: brotli at maximum quality on about 20 MB (main script, ORT wasm around 11 MB, the 5 MB frame) adds tens of seconds to `vite build`.
   - Packaged size: the `.br` and `.gz` copies ship in `Resources/ui` and add roughly 40% of the assets' compressed size.
   - Per request: without copies (a dev `vite build` elsewhere, or an old dist), every hashed asset is compressed at quality 5 on every request. It is off the event loop but uses CPU. Assets are immutable, so each browser pays this once.
7. **Needs a measurement on a real phone.** `tailscale serve` should pass `Content-Encoding` and `Vary` through unchanged, because it is a Go `ReverseProxy` and the client set `Accept-Encoding` explicitly. Nothing here measures that. Add it to the §6 on-device measurement.
8. **`Vary: Accept-Encoding` goes on every response,** including SSE, errors, `/enter` and `/healthz`, because it lives in `BASE_HEADERS`. That is the simplest way to meet "always", and it is harmless.
9. **The model file gets a one-day cache.** B3 gives `/vad/silero_vad.onnx` `private, max-age=86400`. The spec is silent on it, but it is 2.2 MB re-downloaded on every call under `no-store`. Say so if you would rather keep `no-store`.
10. **The build now emits only the hashed frame, not `dist/mermaid-frame.html`.** A tab still running a bundle from before the update asks for the plain name, gets a 404 at the door, and shows the diagram source until it reloads. The chunk-load-failure reload in §3.6 covers this.

**Review Focus candidates:**
- **An old frame name after an update.** A page still running last release's bundle asks for the old `mermaid-frame-<hash>.html`. The harness's SPA fallback returns 200 text/html, which could otherwise be cached as immutable for a year under that name. Test: B6, "refuses a stale frame name rather than cache the shell under it for a year" (with B5's server test showing the fallback has no sandbox header).
- **A launcher retrying on a flaky tailnet while someone types a code.** The probe must never read or charge the shared sign-in limiter (`index.ts:374`), even while that limiter is locked. Test: B1, "never reads or charges the sign-in limiter".
- **Clients that decline or skip encodings.** For example `br;q=0, gzip`, `*` only, no `Accept-Encoding`, or a shell over `MAX_SHELL_BYTES`. Each must get a body it can decode, with `Vary` set. Tests: B8, "sends plain bytes to anything that asked for neither" and "falls to gzip when brotli is absent, refused or ranked lower"; B9, "sends a shell too big to rewrite exactly as it came, uncompressed".
