// Live browser streams end with the browser session that opened them.
//
// A device and a session are different boundaries. Revoking a device already
// ended every stream it owned; what did not happen was the narrower case — one
// browser signed out, evicted by a newer sign-in, or past its expiry, while its
// already-open `/api/events` connection kept receiving frames. These tests
// drive the real registry through the real door against a fake harness that
// can push a frame at any moment, so "no later frame arrives" is measured on
// the wire rather than inferred from a flag.
import { rmSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { cookieName, createBrowserHandler, type BoundIdentity } from "../src/browser.ts";
import { createConnectedDeviceTracker } from "../src/connected-devices.ts";
import { DeviceRegistry, SESSION_IDLE_MS } from "../src/devices.ts";
import { DATA_DIR } from "../src/state.ts";

const HOST = "macbook.tail0a48a4.ts.net";
const identity: BoundIdentity = { scheme: "http", hosts: new Set([HOST, "127.0.0.1"]) };

let registry: DeviceRegistry;
let tracker: ReturnType<typeof createConnectedDeviceTracker>;
let unsubscribe: () => void = () => {};

let harness: Server;
let harnessPort = 0;
let door: Server;
let doorPort = 0;
/** Every event stream the fake harness is currently holding open. */
const upstreams = new Set<ServerResponse>();
/** When set, the harness holds `/api/events` response headers until released. */
let headerGate: Promise<void> | null = null;
/** How many `/api/events` requests reached the harness in this test. */
let eventRequests = 0;

const pair = (): string => {
  const { code } = registry.openPairing();
  const result = registry.redeem(code, "iPhone");
  if ("error" in result) throw new Error(result.error);
  return result.device.id;
};

const signInBrowser = (deviceId: string) => {
  const opened = registry.openSession(deviceId, "Safari on iPhone");
  if (!opened) throw new Error("could not open a session");
  return opened;
};

/** Push one frame to every open upstream stream. */
const broadcast = (frame: string) => {
  for (const res of upstreams) res.write(`data: ${JSON.stringify({ frame })}\n\n`);
};

const waitFor = async (check: () => boolean, what: string): Promise<void> => {
  const until = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

interface Stream {
  res: IncomingMessage;
  text: () => string;
  closed: Promise<void>;
  isClosed: () => boolean;
}

/** Ask the door for `/api/events` and resolve once response headers arrive. */
const openStream = (cookie: string): Promise<Stream> =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: doorPort,
        path: "/api/events",
        method: "GET",
        agent: false,
        headers: {
          host: `${HOST}:${doorPort}`,
          "sec-fetch-site": "same-origin",
          cookie: `${cookieName("http")}=${cookie}`,
        },
      },
      (res) => {
        let text = "";
        let closed = false;
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("error", () => {});
        const closedPromise = new Promise<void>((done) =>
          res.once("close", () => {
            closed = true;
            done();
          }),
        );
        resolve({ res, text: () => text, closed: closedPromise, isClosed: () => closed });
      },
    );
    req.on("error", reject);
    req.end();
  });

/** A stream that is open and has delivered the harness's first frame. */
const liveStream = async (cookie: string): Promise<Stream> => {
  const stream = await openStream(cookie);
  expect(stream.res.statusCode).toBe(200);
  await waitFor(() => stream.text().includes("hello"), "the first frame");
  return stream;
};

const doorWrite = (
  method: string,
  path: string,
  cookie: string,
): Promise<{ status: number; setCookie: string; body: string }> =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port: doorPort,
        path,
        method,
        agent: false,
        headers: {
          host: `${HOST}:${doorPort}`,
          "sec-fetch-site": "same-origin",
          origin: `http://${HOST}:${doorPort}`,
          cookie: `${cookieName("http")}=${cookie}`,
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, setCookie: String(res.headers["set-cookie"]?.[0] ?? ""), body }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });

const signOut = (cookie: string) => doorWrite("DELETE", "/session", cookie);

const renew = async (cookie: string): Promise<string> => {
  const answer = await doorWrite("POST", "/session/renew", cookie);
  expect(answer.status).toBe(200);
  return answer.setCookie.slice(answer.setCookie.indexOf("=") + 1, answer.setCookie.indexOf(";"));
};

beforeAll(async () => {
  harness = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path !== "/api/events") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    eventRequests += 1;
    const start = () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ frame: "hello" })}\n\n`);
      upstreams.add(res);
      res.on("close", () => upstreams.delete(res));
    };
    if (headerGate) void headerGate.then(start);
    else start();
  });
  await new Promise<void>((r) => harness.listen(0, "127.0.0.1", r));
  harnessPort = (harness.address() as AddressInfo).port;

  door = createServer(
    createBrowserHandler({
      harnessPort,
      identity: () => identity,
      // Delegates to whichever registry the current test built.
      devices: {
        redeem: (credential, name) => registry.redeem(credential, name),
        openSession: (id, label) => registry.openSession(id, label),
        resolveSession: (value) => registry.resolveSession(value),
        sessionDeadline: (sessionId) => registry.sessionDeadline(sessionId),
        closeSession: (value) => registry.closeSession(value),
        renewSession: (value) => registry.renewSession(value),
      },
      connected: (deviceId, disconnect, sessionId) => tracker.open(deviceId, disconnect, sessionId),
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
  rmSync(DATA_DIR, { recursive: true, force: true });
  registry = new DeviceRegistry();
  tracker = createConnectedDeviceTracker();
  // Exactly the wiring `index.ts` installs.
  unsubscribe = registry.onSessionEnded(({ sessionId }) => tracker.disconnectSession(sessionId));
  headerGate = null;
  eventRequests = 0;
});

afterEach(() => {
  unsubscribe();
  for (const res of upstreams) res.destroy();
  upstreams.clear();
});

// ─────────────────────────────────────────────────────────────────────────
describe("the registry names and ends sessions", () => {
  it("keeps one session id through renewal, and its deadline follows the renewal", () => {
    const deviceId = pair();
    const { value } = signInBrowser(deviceId);
    const before = registry.resolveSession(value)!;
    const renewed = registry.renewSession(value, Date.now() + 1000)!;
    const after = registry.resolveSession(renewed.value)!;

    expect(after.sessionId).toBe(before.sessionId);
    expect(registry.sessionDeadline(after.sessionId)).toBe(
      Math.min(renewed.session.expiresAt, renewed.session.lastSeenAt + SESSION_IDLE_MS + 1),
    );
    // The retired cookie names nothing any more; the session is unaffected.
    expect(registry.resolveSession(value)).toBeNull();
    expect(registry.sessionDeadline(before.sessionId)).not.toBeNull();
  });

  it("reports sign-out, eviction, expiry and revoke, each for the session that ended", () => {
    const ended: string[] = [];
    registry.onSessionEnded(({ sessionId }) => ended.push(sessionId));
    const deviceId = pair();

    const signedOut = signInBrowser(deviceId);
    const signedOutId = registry.resolveSession(signedOut.value)!.sessionId;
    expect(registry.closeSession(signedOut.value)).toBe(true);
    expect(ended).toEqual([signedOutId]);
    expect(registry.sessionDeadline(signedOutId)).toBeNull();

    ended.length = 0;
    const oldest = signInBrowser(deviceId);
    const oldestId = registry.resolveSession(oldest.value)!.sessionId;
    oldest.session.lastSeenAt -= 5 * 60_000;
    const kept = [signInBrowser(deviceId), signInBrowser(deviceId)];
    expect(ended).toEqual([]);
    signInBrowser(deviceId); // the fourth browser evicts the least recently used
    expect(ended).toEqual([oldestId]);
    expect(registry.sessionDeadline(oldestId)).toBeNull();

    ended.length = 0;
    const expiring = kept[0];
    const expiringId = registry.resolveSession(expiring.value)!.sessionId;
    expiring.session.expiresAt = Date.now() - 1;
    expect(registry.sessionDeadline(expiringId)).toBeNull();
    expect(registry.resolveSession(expiring.value)).toBeNull();
    expect(ended).toEqual([expiringId]);

    ended.length = 0;
    const remainingId = registry.resolveSession(kept[1].value)!.sessionId;
    expect(registry.revoke(deviceId)).toBe(true);
    expect(ended).toContain(remainingId);
    expect(registry.sessionDeadline(remainingId)).toBeNull();
  });

  it("does not count a deadline check as use of the session", () => {
    const deviceId = pair();
    const { value, session } = signInBrowser(deviceId);
    const { sessionId } = registry.resolveSession(value)!;
    session.lastSeenAt -= 10 * 60_000;
    const lastSeen = session.lastSeenAt;

    expect(registry.sessionDeadline(sessionId)).toBe(Math.min(session.expiresAt, lastSeen + SESSION_IDLE_MS + 1));
    expect(session.lastSeenAt).toBe(lastSeen);
    // Past the idle window by the clock, it is over — however often it is asked.
    expect(registry.sessionDeadline(sessionId, lastSeen + SESSION_IDLE_MS + 1)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("a live browser stream", () => {
  it("closes when that browser signs out, and the other browser on the device keeps streaming", async () => {
    const deviceId = pair();
    const first = signInBrowser(deviceId);
    const second = signInBrowser(deviceId);
    const signedOut = await liveStream(first.value);
    const stays = await liveStream(second.value);
    expect(tracker.ids()).toEqual([deviceId]);

    expect((await signOut(first.value)).status).toBe(200);
    await signedOut.closed;
    broadcast("after-sign-out");

    await waitFor(() => stays.text().includes("after-sign-out"), "the other browser's frame");
    expect(signedOut.text()).not.toContain("after-sign-out");
    expect(stays.isClosed()).toBe(false);
    expect(tracker.ids()).toEqual([deviceId]);
    stays.res.destroy();
  });

  it("closes when a newer sign-in evicts that browser", async () => {
    const deviceId = pair();
    const evicted = signInBrowser(deviceId);
    const kept = signInBrowser(deviceId);
    signInBrowser(deviceId);
    const evictedStream = await liveStream(evicted.value);
    const keptStream = await liveStream(kept.value);
    // After the streams open, because opening one is a use of the session.
    evicted.session.lastSeenAt -= 5 * 60_000;

    signInBrowser(deviceId);
    await evictedStream.closed;
    broadcast("after-eviction");

    await waitFor(() => keptStream.text().includes("after-eviction"), "the kept browser's frame");
    expect(evictedStream.text()).not.toContain("after-eviction");
    keptStream.res.destroy();
  });

  it("closes on its own when the session reaches its expiry", async () => {
    const deviceId = pair();
    const browser = signInBrowser(deviceId);
    // Close to expiry before the stream opens, so the door's own timer is what
    // has to notice. Nothing signs out and no frame is sent.
    browser.session.expiresAt = Date.now() + 800;
    const stream = await liveStream(browser.value);

    await stream.closed;
    expect(tracker.ids()).toEqual([]);
    broadcast("after-expiry");
    expect(stream.text()).not.toContain("after-expiry");
  });

  it("forwards no frame once the session is past its expiry, even before a timer fires", async () => {
    const deviceId = pair();
    const browser = signInBrowser(deviceId);
    const stream = await liveStream(browser.value);

    // The wall clock passed the deadline without the timer seeing it — a
    // laptop that slept. Nothing announces the end; the next frame must not
    // be the thing that tells anybody.
    browser.session.expiresAt = Date.now() - 1;
    broadcast("after-expiry");

    await stream.closed;
    expect(stream.text()).not.toContain("after-expiry");
    expect(tracker.ids()).toEqual([]);
  });

  it("survives renewal, and follows the session to the renewed cookie", async () => {
    const deviceId = pair();
    const browser = signInBrowser(deviceId);
    const stream = await liveStream(browser.value);

    const renewed = await renew(browser.value);
    broadcast("after-renewal");
    await waitFor(() => stream.text().includes("after-renewal"), "the frame after renewal");

    // The retired cookie is not this session any more, so it signs nothing out.
    expect((await signOut(browser.value)).status).toBe(200);
    broadcast("after-stale-sign-out");
    await waitFor(() => stream.text().includes("after-stale-sign-out"), "the frame after a stale sign-out");
    expect(stream.isClosed()).toBe(false);

    expect((await signOut(renewed)).status).toBe(200);
    await stream.closed;
    broadcast("after-sign-out");
    expect(stream.text()).not.toContain("after-sign-out");
  });

  it("gets no stream when the browser signs out while the harness is still producing headers", async () => {
    const deviceId = pair();
    const browser = signInBrowser(deviceId);
    let release!: () => void;
    headerGate = new Promise<void>((r) => (release = r));

    const pending = openStream(browser.value);
    await waitFor(() => eventRequests === 1, "the stream request to reach the harness");
    expect((await signOut(browser.value)).status).toBe(200);
    release();

    const stream = await pending;
    expect(stream.res.statusCode).toBe(401);
    await stream.closed;
    expect(tracker.ids()).toEqual([]);
  });

  it("still gets its stream when the browser renews while the harness is producing headers", async () => {
    const deviceId = pair();
    const browser = signInBrowser(deviceId);
    let release!: () => void;
    headerGate = new Promise<void>((r) => (release = r));

    const pending = openStream(browser.value);
    await waitFor(() => eventRequests === 1, "the stream request to reach the harness");
    await renew(browser.value);
    release();

    const stream = await pending;
    expect(stream.res.statusCode).toBe(200);
    await waitFor(() => stream.text().includes("hello"), "the first frame");
    expect(tracker.ids()).toEqual([deviceId]);
    stream.res.destroy();
  });

  it("stays signed in and streaming when the sign-out cannot be written, and signs out on retry", async () => {
    const deviceId = pair();
    const browser = signInBrowser(deviceId);
    const stream = await liveStream(browser.value);
    // SAFETY: private `persist` shadowed on this registry only.
    const writable = registry as unknown as { persist?: () => void };
    writable.persist = () => {
      throw new Error("EROFS: read-only file system, open '/Users/someone/.murage-companion/devices.json'");
    };
    try {
      const failed = await signOut(browser.value);
      expect(failed.status).toBe(500);
      expect(JSON.parse(failed.body)).toEqual({ error: "could not sign out on this computer — try again" });
      // The cookie is not cleared: the credential is still live on disk, and
      // this browser is the one that can retry.
      expect(failed.setCookie).toBe("");
      broadcast("after-failed-sign-out");
      await waitFor(() => stream.text().includes("after-failed-sign-out"), "the frame after a failed sign-out");
      expect(stream.isClosed()).toBe(false);
    } finally {
      delete writable.persist;
    }

    expect((await signOut(browser.value)).status).toBe(200);
    await stream.closed;
    expect(tracker.ids()).toEqual([]);
  });

  it("still ends every browser's stream when the whole device is revoked", async () => {
    const deviceId = pair();
    const first = await liveStream(signInBrowser(deviceId).value);
    const second = await liveStream(signInBrowser(deviceId).value);

    expect(registry.revoke(deviceId)).toBe(true);
    // What control.ts calls after a successful revoke.
    tracker.disconnect(deviceId);
    await Promise.all([first.closed, second.closed]);
    expect(tracker.ids()).toEqual([]);
  });
});
