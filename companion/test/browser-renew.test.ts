// Silent session renewal, end to end.
//
// The failure this file exists to prevent is not a crash. Wayland and AionUI
// both built a refresh endpoint and never called it from the browser, so
// their advertised thirty-day cookie was a twenty-four-hour one and nothing
// anywhere said so. An endpoint nobody calls passes every test that only
// tests the endpoint. So half of what is below is about the CLIENT: that the
// door injects a script into the shell, that the script parses, and that it
// names the route and the interval.
//
// The other half is the property renewal must not cost us. Renewal rotates a
// credential; a rotation that minted a new session would make `revoke()`
// defeatable by the browser being revoked, which is the one thing a revoke
// button must never be.
import { execFileSync } from "node:child_process";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { AddressInfo } from "node:net";
import { createContext, runInContext } from "node:vm";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RENEW_INTERVAL_MS,
  cookieName,
  createBrowserHandler,
  injectRenewal,
  renewalScript,
  type BoundIdentity,
} from "../src/browser.ts";
import {
  DeviceRegistry,
  PENDING_TTL_MS,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  SESSION_MAX_LIFETIME_MS,
  successorValue,
} from "../src/devices.ts";
import { SESSION_SECRET_FILE } from "../src/session-secret.ts";
import { DATA_DIR } from "../src/state.ts";

const DAY = 24 * 60 * 60 * 1000;

const pair = (registry: DeviceRegistry, name = "Sean's laptop") => {
  const { code } = registry.openPairing();
  const result = registry.redeem(code, name);
  if ("error" in result) throw new Error(`pairing failed: ${result.error}`);
  return result;
};

const storedSessions = (): Array<Record<string, unknown>> =>
  JSON.parse(readFileSync(join(DATA_DIR, "devices.json"), "utf8")).devices[0].sessions ?? [];

/** What a browser does with a renewal: take the successor, then present it
 * on its next request, which commits it. */
const rotate = (registry: DeviceRegistry, value: string) => {
  const renewed = registry.renewSession(value);
  if (renewed) registry.resolveSession(renewed.value);
  return renewed;
};

/** Far enough on that renewal is due again. */
const dayLater = () => vi.setSystemTime(Date.now() + DAY + 60_000);

afterEach(() => {
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────
describe("renewing a browser session, in the registry", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("rotates the credential inside the row it already had", () => {
    const registry = new DeviceRegistry();
    const { device } = pair(registry);
    const opened = registry.openSession(device.id, "Chrome on Mac")!;
    const createdAt = storedSessions()[0].createdAt;

    dayLater();
    const renewed = registry.renewSession(opened.value)!;
    expect(renewed).not.toBeNull();
    expect(renewed.value).not.toBe(opened.value);

    // The new value works, the old one is gone, and there is still exactly
    // one session — a rotation that appended would be an extra live
    // credential per renewal and would evict the other browsers on the cap.
    expect(registry.resolveSession(renewed.value)?.device.id).toBe(device.id);
    expect(registry.resolveSession(opened.value)).toBeNull();
    expect(storedSessions()).toHaveLength(1);
    // createdAt is the anchor the ceiling is measured from. Renewal never
    // rewrites it; if it did, the wall would move with every renewal and
    // would not be a wall.
    expect(storedSessions()[0].createdAt).toBe(createdAt);
    // and the raw value still never reaches the file
    expect(readFileSync(join(DATA_DIR, "devices.json"), "utf8")).not.toContain(renewed.value);
  });

  it("does not let renewal defeat revocation", () => {
    // THE PROPERTY. Rotating inside the device record is the whole reason
    // this is a registry method rather than close-then-open: revoke() takes
    // the device and every credential form hanging off it, renewed or not.
    const registry = new DeviceRegistry();
    const { device } = pair(registry);
    const opened = registry.openSession(device.id, "Chrome on Mac")!;

    let value = opened.value;
    for (let i = 0; i < 5; i += 1) {
      dayLater();
      value = rotate(registry, value)!.value;
    }
    expect(registry.resolveSession(value)).not.toBeNull();

    expect(registry.revoke(device.id)).toBe(true);
    expect(registry.resolveSession(value)).toBeNull();
    // and it does not come back from the file either
    expect(new DeviceRegistry().resolveSession(value)).toBeNull();
  });

  it("carries a browser that keeps checking in past the ninety-day cap", () => {
    const registry = new DeviceRegistry();
    const { device } = pair(registry);
    const renewing = registry.openSession(device.id, "Chrome on Mac")!;
    const silent = registry.openSession(device.id, "Safari on iPhone")!;

    let value = renewing.value;
    // Ten days at a time, well inside the idle window, for a third of a year.
    for (let day = 10; day <= 120; day += 10) {
      vi.setSystemTime(Date.now() + 10 * DAY);
      // The other browser is used just as often, and is not renewed. It is
      // the control: it is what every session did before this change.
      registry.resolveSession(silent.value);
      const renewed = rotate(registry, value);
      // Every one of these succeeds, INCLUDING the ones past day 90. That is
      // the change: before it, day 90 was the end of the road for a session
      // that had done nothing wrong except keep being used.
      expect(renewed, `day ${day}`).not.toBeNull();
      value = renewed!.value;
    }
    // Day 120: past the old absolute cap by a month.
    expect(registry.resolveSession(value)?.device.id).toBe(device.id);
    expect(registry.resolveSession(silent.value)).toBeNull();
    vi.useRealTimers();
  });

  it("cannot be renewed past the wall no client can move", () => {
    // A cap any client can push forever is not a cap. The ceiling is
    // measured from createdAt, which renewal never touches, so a chain of
    // renewals converges on it and stops.
    const registry = new DeviceRegistry();
    const { device } = pair(registry);
    const opened = registry.openSession(device.id, "Chrome on Mac")!;
    const createdAt = Date.now();

    let value = opened.value;
    let alive = true;
    for (let day = 10; day <= 400 && alive; day += 10) {
      vi.setSystemTime(createdAt + day * DAY);
      const renewed = rotate(registry, value);
      if (!renewed) {
        alive = false;
        // It died at the ceiling, not before it and not after.
        expect(day * DAY).toBeGreaterThan(SESSION_MAX_LIFETIME_MS);
        expect((day - 10) * DAY).toBeLessThan(SESSION_MAX_LIFETIME_MS);
        break;
      }
      value = renewed.value;
      expect(renewed.session.expiresAt).toBeLessThanOrEqual(createdAt + SESSION_MAX_LIFETIME_MS);
      expect(renewed.expiresAt).toBeLessThanOrEqual(createdAt + SESSION_MAX_LIFETIME_MS);
    }
    expect(alive).toBe(false);
    expect(registry.resolveSession(value)).toBeNull();
    vi.useRealTimers();
  });

  it("refuses to raise the dead, and changes nothing when it refuses", () => {
    const registry = new DeviceRegistry();
    const { device } = pair(registry);
    const opened = registry.openSession(device.id, "Chrome on Mac")!;

    expect(registry.renewSession(undefined)).toBeNull();
    expect(registry.renewSession("")).toBeNull();
    expect(registry.renewSession("murage_browser_never_issued")).toBeNull();
    // The live session is untouched by any of that.
    expect(registry.resolveSession(opened.value)).not.toBeNull();

    // A fortnight and a minute of nobody opening it: idle-expired, and
    // renewal must not be a back door around the bound it just failed.
    vi.setSystemTime(Date.now() + SESSION_IDLE_MS + 60_000);
    expect(registry.renewSession(opened.value)).toBeNull();
    expect(registry.resolveSession(opened.value)).toBeNull();
    vi.useRealTimers();
  });

  it("leaves the old cookie working when the rotation cannot be written down", () => {
    // Fail CLOSED, and closed means "exactly as it was". A rotation that
    // lived in memory but not on disk would sign this browser out at the
    // next restart — the silent logout renewal exists to prevent.
    const registry = new DeviceRegistry();
    const { device } = pair(registry);
    const opened = registry.openSession(device.id, "Chrome on Mac")!;

    // Make the atomic rename fail: the target path is a non-empty directory.
    const file = join(DATA_DIR, "devices.json");
    const saved = readFileSync(file, "utf8");
    rmSync(file);
    mkdirSync(file);
    writeFileSync(join(file, "occupied"), "x");

    dayLater();
    expect(registry.renewSession(opened.value)).toBeNull();

    rmSync(file, { recursive: true, force: true });
    writeFileSync(file, saved);
    // The cookie the browser is holding still works, in memory and on disk.
    expect(registry.resolveSession(opened.value)?.device.id).toBe(device.id);
    expect(new DeviceRegistry().resolveSession(opened.value)?.device.id).toBe(device.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Recoverable renewal. A phone suspended mid-response, or a network that
// drops, loses the renewal reply. What it still holds must keep working, and
// asking again must hand it the same successor, never a second one.
// ─────────────────────────────────────────────────────────────────────────
describe("renewal is derived, idempotent and committed on first use", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    vi.useRealTimers();
  });

  const signedIn = () => {
    const registry = new DeviceRegistry();
    const { device } = pair(registry);
    const opened = registry.openSession(device.id, "Murage on iPhone")!;
    return { registry, device, value: opened.value };
  };

  const pendingGeneration = (): number =>
    (storedSessions()[0].pending as { generation: number } | undefined)?.generation ?? 0;

  it("is not due until a day after the credential became current", () => {
    const { registry, value } = signedIn();
    const start = Date.now();
    expect(registry.renewSession(value)).toBeNull();
    vi.setSystemTime(start + DAY - 60_000);
    expect(registry.renewSession(value)).toBeNull();
    vi.setSystemTime(start + DAY + 60_000);
    expect(registry.renewSession(value)).not.toBeNull();
  });

  it("gives a retry whose response was lost the identical successor", () => {
    const { registry, value } = signedIn();
    dayLater();
    const first = registry.renewSession(value)!;
    const retry = registry.renewSession(value)!;
    expect(retry.value).toBe(first.value);
    expect(retry.value).not.toBe(value);
    // One generation spent, not two, and the plaintext never reaches the file.
    expect(pendingGeneration()).toBe(1);
    expect(readFileSync(join(DATA_DIR, "devices.json"), "utf8")).not.toContain(first.value);
    // Nothing is committed yet, so the value the phone holds still works.
    expect(registry.resolveSession(value)).not.toBeNull();
  });

  it("cannot be confused by responses that arrive out of order", () => {
    const { registry, value } = signedIn();
    dayLater();
    const early = registry.renewSession(value)!;
    const late = registry.renewSession(value)!;
    // Whichever reply lands last in the cookie jar, it is the same value.
    expect(late.value).toBe(early.value);
    expect(registry.resolveSession(late.value)).not.toBeNull();
    // A renewal still in flight with the retired value changes nothing and
    // never un-commits what the phone now holds.
    expect(registry.renewSession(value)).toBeNull();
    expect(registry.resolveSession(early.value)).not.toBeNull();
  });

  it("commits on the first request that presents the successor, and only then retires the old value", () => {
    const { registry, device, value } = signedIn();
    dayLater();
    const { value: next } = registry.renewSession(value)!;
    expect(registry.resolveSession(value)).not.toBeNull();

    const committed = registry.resolveSession(next)!;
    expect(committed.session.pending).toBeUndefined();
    expect(committed.session.committedAt).toBe(Date.now());
    expect(registry.resolveSession(value)).toBeNull();
    // Durable in both directions.
    expect(new DeviceRegistry().resolveSession(value)).toBeNull();
    expect(new DeviceRegistry().resolveSession(next)?.device.id).toBe(device.id);
  });

  it("commits through the renewal route too, and is then not due for another day", () => {
    const { registry, value } = signedIn();
    dayLater();
    const { value: next } = registry.renewSession(value)!;
    const committed = registry.renewSession(next)!;
    expect(committed.value).toBe(next);
    expect(committed.expiresAt).toBe(committed.session.expiresAt);
    expect(registry.resolveSession(value)).toBeNull();
    expect(registry.renewSession(next)).toBeNull();
  });

  it("stops accepting an unused successor after a week, and leaves the current value alone", () => {
    const { registry, value } = signedIn();
    dayLater();
    const stale = registry.renewSession(value)!.value;
    vi.setSystemTime(Date.now() + PENDING_TTL_MS + 60_000);
    expect(registry.resolveSession(stale)).toBeNull();
    expect(registry.resolveSession(value)).not.toBeNull();

    const fresh = registry.renewSession(value)!;
    expect(fresh.value).not.toBe(stale);
    expect(pendingGeneration()).toBe(2);
    expect(registry.resolveSession(stale)).toBeNull();
  });

  it("hands out the same successor after a restart", () => {
    const { registry, value } = signedIn();
    dayLater();
    const before = registry.renewSession(value)!.value;

    const restarted = new DeviceRegistry();
    expect(restarted.renewSession(value)!.value).toBe(before);
    expect(restarted.resolveSession(before)).not.toBeNull();
    expect(new DeviceRegistry().resolveSession(value)).toBeNull();
  });

  it("revoking the device kills the current value and the successor", () => {
    const { registry, device, value } = signedIn();
    dayLater();
    const next = registry.renewSession(value)!.value;
    expect(registry.revoke(device.id)).toBe(true);
    expect(registry.resolveSession(value)).toBeNull();
    expect(registry.resolveSession(next)).toBeNull();
    expect(registry.renewSession(value)).toBeNull();
    const restarted = new DeviceRegistry();
    expect(restarted.resolveSession(value)).toBeNull();
    expect(restarted.resolveSession(next)).toBeNull();
  });

  it("signs a browser out whichever of the two values it presents", () => {
    const { registry, value } = signedIn();
    dayLater();
    const next = registry.renewSession(value)!.value;
    expect(registry.closeSession(next)).toBe(true);
    expect(registry.resolveSession(value)).toBeNull();
    expect(registry.resolveSession(next)).toBeNull();
  });

  it("never reuses a generation, across sessions or across a restart", () => {
    const { registry, device, value } = signedIn();
    const other = registry.openSession(device.id, "Safari on iPad")!.value;
    dayLater();
    registry.renewSession(value);
    registry.renewSession(other);
    const generations = storedSessions().map((s) => (s.pending as { generation: number }).generation);
    expect(generations.sort()).toEqual([1, 2]);

    const restarted = new DeviceRegistry();
    const next = restarted.renewSession(value)!.value;
    restarted.resolveSession(next);
    dayLater();
    restarted.renewSession(next);
    expect(Math.max(...storedSessions().map((s) => (s.pending as { generation: number } | undefined)?.generation ?? 0))).toBe(3);
  });

  it("derives from the session's id and creation time as well as its hash", () => {
    const secret = Buffer.alloc(32, 7);
    const base = { id: "11111111-2222-3333-4444-555555555555", createdAt: 1, hash: "ab".repeat(32) };
    const value = successorValue(secret, base, 1);
    expect(value.startsWith("murage_browser_")).toBe(true);
    expect(successorValue(secret, base, 1)).toBe(value);
    expect(successorValue(secret, { ...base, id: "66666666-7777-8888-9999-000000000000" }, 1)).not.toBe(value);
    expect(successorValue(secret, { ...base, createdAt: 2 }, 1)).not.toBe(value);
    expect(successorValue(secret, base, 2)).not.toBe(value);
    expect(successorValue(Buffer.alloc(32, 8), base, 1)).not.toBe(value);
  });

  it("fails closed, changing nothing, when there is no secret to derive from", () => {
    const { registry, value } = signedIn();
    rmSync(SESSION_SECRET_FILE, { force: true });
    mkdirSync(SESSION_SECRET_FILE);
    try {
      dayLater();
      expect(registry.renewSession(value)).toBeNull();
      expect(storedSessions()[0].pending).toBeUndefined();
      expect(registry.resolveSession(value)).not.toBeNull();
    } finally {
      rmSync(SESSION_SECRET_FILE, { recursive: true, force: true });
    }
  });

  it("keeps a successor it can no longer re-send, rather than deriving over it", () => {
    // The secret file was lost and recreated between the renewal and its
    // retry. The phone whose reply got through holds that successor; deriving
    // a new one over it would sign that phone out.
    const { registry, value } = signedIn();
    dayLater();
    const sent = registry.renewSession(value)!.value;
    const before = storedSessions()[0].pending;
    writeFileSync(SESSION_SECRET_FILE, `${"ab".repeat(32)}\n`);

    const restarted = new DeviceRegistry();
    expect(restarted.renewSession(value)).toBeNull();
    expect(storedSessions()[0].pending).toEqual(before);
    // What was sent still commits, by its hash.
    expect(restarted.resolveSession(sent)).not.toBeNull();
    expect(restarted.resolveSession(value)).toBeNull();
  });

  it("does not sign a browser out with a successor that has aged out", () => {
    const { registry, value } = signedIn();
    dayLater();
    const stale = registry.renewSession(value)!.value;
    vi.setSystemTime(Date.now() + PENDING_TTL_MS + 60_000);
    expect(registry.closeSession(stale)).toBe(false);
    expect(registry.resolveSession(value)).not.toBeNull();
    expect(new DeviceRegistry().resolveSession(value)).not.toBeNull();
  });

  it("reads a generation past what a double counts exactly as malformed", () => {
    // Left as it was, the counter could never move again and this device
    // could never renew.
    const { value } = signedIn();
    const file = join(DATA_DIR, "devices.json");
    const stored = JSON.parse(readFileSync(file, "utf8"));
    stored.devices[0].sessionGeneration = 2 ** 60;
    writeFileSync(file, JSON.stringify(stored));

    const restarted = new DeviceRegistry();
    dayLater();
    expect(restarted.renewSession(value)).not.toBeNull();
    expect(pendingGeneration()).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The door, against a fake harness serving a realistic shell.
// ─────────────────────────────────────────────────────────────────────────

const SHELL =
  '<!doctype html>\n<html lang="en">\n  <head>\n    <script>\n      // the pre-paint skin stamp\n    </script>\n' +
  '    <title>Murage</title>\n  </head>\n  <body>\n    <div id="root"></div>\n  </body>\n</html>\n';

let harness: Server;
let harnessPort = 0;
let door: Server;
let doorPort = 0;
let registry: DeviceRegistry;
let pairingCredential = "";

const identity: BoundIdentity = {
  scheme: "http",
  hosts: new Set(["macbook.tailexample.ts.net", "127.0.0.1"]),
};

interface Answer {
  status: number;
  headers: IncomingMessage["headers"];
  body: string;
}

const knock = (
  method: string,
  path: string,
  extra: Record<string, string> = {},
): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      host: `macbook.tailexample.ts.net:${doorPort}`,
      "sec-fetch-site": "same-origin",
      ...extra,
    };
    const req = request({ hostname: "127.0.0.1", port: doorPort, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.on("error", reject);
    req.end();
  });

/** What a same-origin browser sends on a write. */
const write = () => ({ origin: `http://macbook.tailexample.ts.net:${doorPort}` });

const cookieOf = (answer: Answer): string => {
  const set = String(answer.headers["set-cookie"]?.[0] ?? "");
  return set.slice(set.indexOf("=") + 1, set.indexOf(";"));
};

beforeAll(async () => {
  harness = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/" || path === "/index.html") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(SHELL);
    }
    if (path.startsWith("/assets/")) {
      res.writeHead(200, { "content-type": "text/javascript" });
      return res.end("export default 1;");
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => harness.listen(0, "127.0.0.1", r));
  harnessPort = (harness.address() as AddressInfo).port;

  door = createServer(
    createBrowserHandler({
      harnessPort,
      identity: () => identity,
      devices: {
        redeem: (credential, name) => registry.redeem(credential, name),
        openSession: (id, label) => registry.openSession(id, label),
        resolveSession: (value) => registry.resolveSession(value),
        sessionDeadline: (sessionId) => registry.sessionDeadline(sessionId),
        closeSession: (value) => registry.closeSession(value),
        renewSession: (value) => registry.renewSession(value),
        signOutDevice: (value) => registry.signOutDevice(value),
      },
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

/** A signed-in browser, through the real door and the real registry. */
const signIn = async (): Promise<string> => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  registry = new DeviceRegistry();
  pairingCredential = registry.openPairing().token;
  const answer = await new Promise<Answer>((resolve, reject) => {
    const body = JSON.stringify({ credential: pairingCredential });
    const req = request(
      {
        hostname: "127.0.0.1",
        port: doorPort,
        path: "/session",
        method: "POST",
        headers: {
          host: `macbook.tailexample.ts.net:${doorPort}`,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...write(),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
  expect(answer.status).toBe(201);
  return cookieOf(answer);
};

describe("the door's renewal route", () => {
  it("rotates the cookie and retires the one that was presented", async () => {
    const first = await signIn();
    dayLater();
    const answer = await knock("POST", "/session/renew", {
      ...write(),
      cookie: `${cookieName("http")}=${first}`,
    });
    expect(answer.status).toBe(200);
    const second = cookieOf(answer);
    expect(second).not.toBe(first);
    expect(second).not.toBe("");

    // The new cookie signs in; the old one does not. Proven at the door,
    // through a real route, not just in the registry.
    const withNew = await knock("GET", "/session", { cookie: `${cookieName("http")}=${second}` });
    expect(withNew.status).toBe(200);
    const withOld = await knock("GET", "/session", { cookie: `${cookieName("http")}=${first}` });
    expect(withOld.status).toBe(401);
  });

  it("answers a stranger with silence rather than a sign-out", async () => {
    // Fail closed AND silent. A 401 here would invite a background call to
    // conclude it had been signed out — which is the outcome renewal exists
    // to prevent, arriving by the route meant to prevent it.
    const cookie = await signIn();
    const nobody = await knock("POST", "/session/renew", write());
    expect(nobody.status).toBe(204);
    expect(nobody.headers["set-cookie"]).toBeUndefined();
    expect(nobody.body).toBe("");

    const wrong = await knock("POST", "/session/renew", {
      ...write(),
      cookie: `${cookieName("http")}=murage_browser_never_issued`,
    });
    expect(wrong.status).toBe(204);
    expect(wrong.headers["set-cookie"]).toBeUndefined();

    // And the real session is exactly as signed in as it was.
    expect((await knock("GET", "/session", { cookie: `${cookieName("http")}=${cookie}` })).status).toBe(200);
  });

  it("is a write, so nothing cross-site can trigger a rotation", async () => {
    const cookie = await signIn();
    const header = { cookie: `${cookieName("http")}=${cookie}` };

    // A GET would be a rotation any <img src> could fire.
    expect((await knock("GET", "/session/renew", header)).status).toBe(404);
    // A POST with no Origin is not a browser; rule 4 of the origin gate.
    expect((await knock("POST", "/session/renew", header)).status).toBe(403);
    // A POST from somewhere else is not us.
    const foreign = await knock("POST", "/session/renew", { ...header, origin: "http://evil.example" });
    expect(foreign.status).toBe(403);

    // None of the three rotated anything.
    expect((await knock("GET", "/session", header)).status).toBe(200);
  });

  /** Make every write to devices.json fail, as a full disk would. */
  const failWrites = (target: DeviceRegistry = registry) => {
    (target as unknown as { persist: () => void }).persist = () => {
      throw new Error("disk full");
    };
    return () => delete (target as unknown as { persist?: unknown }).persist;
  };
  const inMemory = () => JSON.stringify((registry as unknown as { devices: unknown }).devices);
  /** What a restart would read. The stubbed `persist` means the file cannot
   * have changed, so this checks what it holds instead: the successor still
   * pending and the old value still current. The reloaded registry cannot
   * write either, or presenting the successor would commit it here. */
  const expectDiskUncommitted = (first: string, next: string) => {
    const restarted = new DeviceRegistry();
    failWrites(restarted);
    expect(restarted.resolveSession(first)).not.toBeNull();
    expect(restarted.resolveSession(next)?.session.pending).toBeDefined();
  };

  it("still serves a successor it could not commit, and commits it on the next request", async () => {
    const first = await signIn();
    dayLater();
    const next = cookieOf(await knock("POST", "/session/renew", { ...write(), cookie: `${cookieName("http")}=${first}` }));
    const memory = inMemory();

    const restore = failWrites();
    try {
      // Pending on disk is an authorisation, so the request is served...
      expect((await knock("GET", "/session", { cookie: `${cookieName("http")}=${next}` })).status).toBe(200);
      // ...and nothing moved: not the hash, not the pending, not the cap.
      expect(inMemory()).toBe(memory);
      expectDiskUncommitted(first, next);
      expect((await knock("GET", "/session", { cookie: `${cookieName("http")}=${first}` })).status).toBe(200);
    } finally {
      restore();
    }

    expect((await knock("GET", "/session", { cookie: `${cookieName("http")}=${next}` })).status).toBe(200);
    expect((await knock("GET", "/session", { cookie: `${cookieName("http")}=${first}` })).status).toBe(401);
  });

  it("answers a renewal it could not commit with silence, and changes nothing", async () => {
    const first = await signIn();
    dayLater();
    const next = cookieOf(await knock("POST", "/session/renew", { ...write(), cookie: `${cookieName("http")}=${first}` }));
    const memory = inMemory();

    const restore = failWrites();
    try {
      const answer = await knock("POST", "/session/renew", { ...write(), cookie: `${cookieName("http")}=${next}` });
      expect(answer.status).toBe(204);
      expect(answer.headers["set-cookie"]).toBeUndefined();
      expect(inMemory()).toBe(memory);
      expectDiskUncommitted(first, next);
    } finally {
      restore();
    }

    // Both values still sign in until the successor is committed.
    expect((await knock("GET", "/session", { cookie: `${cookieName("http")}=${first}` })).status).toBe(200);
    expect((await knock("POST", "/session/renew", { ...write(), cookie: `${cookieName("http")}=${next}` })).status).toBe(200);
    expect((await knock("GET", "/session", { cookie: `${cookieName("http")}=${first}` })).status).toBe(401);
  });

  it("says nothing while renewal is not due", async () => {
    const cookie = await signIn();
    const answer = await knock("POST", "/session/renew", { ...write(), cookie: `${cookieName("http")}=${cookie}` });
    expect(answer.status).toBe(204);
    expect(answer.headers["set-cookie"]).toBeUndefined();
  });

  it("gives a retried renewal the same cookie, and keeps the old one working until the new one is used", async () => {
    const first = await signIn();
    dayLater();
    const header = { ...write(), cookie: `${cookieName("http")}=${first}` };
    // The first reply is "lost": the browser never stored it and asks again.
    const lost = await knock("POST", "/session/renew", header);
    const retried = await knock("POST", "/session/renew", header);
    expect(retried.status).toBe(200);
    expect(cookieOf(retried)).toBe(cookieOf(lost));

    // Until the new value is presented, the old one is still a sign-in.
    expect((await knock("GET", "/session", { cookie: `${cookieName("http")}=${first}` })).status).toBe(200);
    expect((await knock("GET", "/session", { cookie: `${cookieName("http")}=${cookieOf(retried)}` })).status).toBe(200);
    expect((await knock("GET", "/session", { cookie: `${cookieName("http")}=${first}` })).status).toBe(401);
  });

  it("refreshes the cookie when the successor itself is presented for renewal", async () => {
    const first = await signIn();
    dayLater();
    const next = cookieOf(await knock("POST", "/session/renew", { ...write(), cookie: `${cookieName("http")}=${first}` }));
    const again = await knock("POST", "/session/renew", { ...write(), cookie: `${cookieName("http")}=${next}` });
    expect(again.status).toBe(200);
    expect(cookieOf(again)).toBe(next);
    expect((await knock("GET", "/session", { cookie: `${cookieName("http")}=${first}` })).status).toBe(401);
  });
});

describe("the browser actually calls it", () => {
  it("serves the shell with the renewal script inside it", async () => {
    const cookie = await signIn();
    const shell = await knock("GET", "/", { cookie: `${cookieName("http")}=${cookie}` });
    expect(shell.status).toBe(200);
    expect(shell.headers["content-type"]).toBe("text/html; charset=utf-8");
    // The document is intact and the script went in before </body>, not
    // after it, and not in place of anything.
    expect(shell.body).toContain('<div id="root"></div>');
    expect(shell.body).toContain("/session/renew");
    expect(shell.body.indexOf("/session/renew")).toBeLessThan(shell.body.indexOf("</body>"));
    // and the length the door declared matches what it sent
    expect(Number(shell.headers["content-length"])).toBe(Buffer.byteLength(shell.body));
  });

  it("serves a script that actually parses", () => {
    // The hazard, stated: this script is emitted inside a TEMPLATE LITERAL.
    // One backtick ends the literal and one backslash is eaten as an escape,
    // and the result is a syntax error in a file that only ever runs in
    // somebody else's browser — a blank page, with nothing in any test. So
    // the string is extracted and handed to node --check.
    const script = renewalScript();
    expect(script).not.toContain("`");
    expect(script).not.toContain("\\");

    const dir = mkdtempSync(join(tmpdir(), "murage-renew-"));
    const file = join(dir, "renew.js");
    writeFileSync(file, script);
    // Throws, with the parser's own message, if the served script is broken.
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("renews on load, on a timer, and when a backgrounded tab comes back", () => {
    // RUN the script rather than grep it. Grepping for "renew();" passes on
    // a script that only ever calls it from the visibility handler, which is
    // exactly the shape of the bug this whole file exists to prevent: the
    // call is present in the source and never happens.
    const calls: Array<{ url: string; method: unknown; credentials: unknown }> = [];
    let now = 1_700_000_000_000;
    let tick: (() => void) | null = null;
    let intervalMs = -1;
    let onVisible: (() => void) | null = null;

    const sandbox = {
      fetch: (url: string, init: Record<string, unknown>) => {
        calls.push({ url, method: init?.method, credentials: init?.credentials });
        return Promise.resolve({});
      },
      setInterval: (fn: () => void, ms: number) => {
        tick = fn;
        intervalMs = ms;
        return 0;
      },
      Date: { now: () => now },
      document: {
        visibilityState: "visible",
        addEventListener: (name: string, fn: () => void) => {
          if (name === "visibilitychange") onVisible = fn;
        },
      },
    };
    createContext(sandbox);
    runInContext(renewalScript(), sandbox);

    // 1. On load. Not scheduled — already sent.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ url: "/session/renew", method: "POST", credentials: "same-origin" });

    // 2. On a timer, and the timer is the one derived from the idle window
    //    rather than a second hard-coded copy that can drift from it.
    expect(intervalMs).toBe(RENEW_INTERVAL_MS);
    // The rule is "renewal fires far more often than the session can go
    // idle", not a fixed ratio. It used to be pinned as an exact fourteenth,
    // which quietly meant raising the idle window would stretch renewal with
    // it — to every four days at sixty, when daily renewal is what keeps any
    // cookie sitting in a jar at most 24 hours stale. Rotation freshness and
    // the idle window are separate concerns and this now says so.
    //
    // Fourteen consecutive failures survivable was the old floor; at 24 hours
    // against sixty days it is fifty-nine, so the margin improved by
    // decoupling them.
    expect(RENEW_INTERVAL_MS * 14).toBeLessThanOrEqual(SESSION_IDLE_MS);
    now += RENEW_INTERVAL_MS;
    tick!();
    expect(calls).toHaveLength(2);

    // 3. When a backgrounded tab comes back, because setInterval in a frozen
    //    mobile tab is a hope rather than a schedule.
    now += RENEW_INTERVAL_MS;
    onVisible!();
    expect(calls).toHaveLength(3);

    // ...but an app switch a second later does not rotate again. A phone in
    // a pocket produces dozens of these.
    now += 1_000;
    onVisible!();
    expect(calls).toHaveLength(3);
  });

  it("presents a new cookie straight away, which is what commits it", async () => {
    const calls: Array<{ url: string; method: unknown }> = [];
    const sandbox = {
      fetch: (url: string, init: Record<string, unknown>) => {
        calls.push({ url, method: init?.method });
        return Promise.resolve(url === "/session/renew" ? { status: 200 } : { status: 200 });
      },
      setInterval: () => 0,
      Date: { now: () => 1_700_000_000_000 },
      document: { visibilityState: "visible", addEventListener: () => {} },
    };
    createContext(sandbox);
    runInContext(renewalScript(), sandbox);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([
      { url: "/session/renew", method: "POST" },
      { url: "/session", method: undefined },
    ]);
  });

  it("asks for nothing more when the door had nothing to renew", async () => {
    const calls: string[] = [];
    const sandbox = {
      fetch: (url: string) => {
        calls.push(url);
        return Promise.resolve({ status: 204 });
      },
      setInterval: () => 0,
      Date: { now: () => 1_700_000_000_000 },
      document: { visibilityState: "visible", addEventListener: () => {} },
    };
    createContext(sandbox);
    runInContext(renewalScript(), sandbox);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(["/session/renew"]);
  });

  it("puts the script in even when the shell has lost its closing tag", () => {
    expect(injectRenewal("<html><body>x</body></html>")).toContain("</script></body>");
    // A shell with no </body> still runs a trailing script; refusing to
    // inject would silently hand back the ninety-day product.
    expect(injectRenewal("<html>x")).toContain("/session/renew");
  });

  it("leaves every other static file alone", async () => {
    const cookie = await signIn();
    const asset = await knock("GET", "/assets/index-B7zzSDok.js", { cookie: `${cookieName("http")}=${cookie}` });
    expect(asset.status).toBe(200);
    expect(asset.body).toBe("export default 1;");
    expect(asset.body).not.toContain("/session/renew");
  });

  it("keeps the absolute cap it advertises in the cookie", async () => {
    const cookie = await signIn();
    dayLater();
    const answer = await knock("POST", "/session/renew", {
      ...write(),
      cookie: `${cookieName("http")}=${cookie}`,
    });
    const set = String(answer.headers["set-cookie"]?.[0] ?? "");
    const maxAge = Number(/Max-Age=(\d+)/.exec(set)?.[1] ?? -1);
    // Ninety days, give or take the second the test took, and never the
    // year — the cookie carries the cap, not the ceiling.
    expect(maxAge).toBeGreaterThan(SESSION_ABSOLUTE_MS / 1000 - 60);
    expect(maxAge).toBeLessThanOrEqual(SESSION_ABSOLUTE_MS / 1000);
    expect(set).toContain("HttpOnly");
  });
});
