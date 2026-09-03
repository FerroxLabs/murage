// One lockout, both doors.
//
// The device door (`POST /api/pair`) and the browser door (`POST /session`)
// redeem the SAME six-digit pairing code, and each was building its own
// `createSignInLimiter()` because neither was passed one. So a client that
// burned its three free guesses and locked itself out on 8810 walked over to
// 8813 with a full budget and started again — and the other way round. Two
// halves of one credential, and therefore roughly half a lockout, with the
// attacker choosing which half to spend.
//
// Nothing in either door's code was wrong. The bug was in the wiring, which
// is why the first test here drives the REAL sidecar rather than two handlers
// this file constructed: a test that hands one limiter to two doors it built
// itself proves the doors honour a shared limiter, which was never in doubt.
// What was in doubt is whether `index.ts` gives them one.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { createBrowserHandler, createSignInLimiter, SIGN_IN_FREE_ATTEMPTS } from "../src/browser.ts";
import { DeviceRegistry } from "../src/devices.ts";
import { createProxyHandler } from "../src/proxy.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "..", "src", "index.ts");

const PORTS = {
  MURAGE_PORT: "9730",
  MURAGE_COMPANION_PORT: "9740",
  MURAGE_CONTROL_PORT: "9741",
  MURAGE_BROWSER_PORT: "9742",
};

let child: ChildProcess | null = null;
let open: Server[] = [];

afterEach(async () => {
  if (child) {
    const c = child;
    child = null;
    if (c.exitCode === null && c.signalCode === null) {
      c.kill("SIGKILL");
      await new Promise<void>((r) => c.on("close", () => r()));
    }
  }
  for (const server of open) await new Promise<void>((r) => server.close(() => r()));
  open = [];
});

/** The real sidecar, both doors, waited on until `main()` has finished.
 *
 * Both doors are pinned to loopback so this test dials the same peer address
 * at each of them — the limiter's key is the socket's remote address, and two
 * doors reached over two different local addresses would be two buckets for
 * honest reasons, which would make a green here mean nothing. */
const sidecar = (): Promise<void> =>
  new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [ENTRY], {
      env: {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
        ...(process.env.USERPROFILE ? { USERPROFILE: process.env.USERPROFILE } : {}),
        ...(process.env.MURAGE_COMPANION_DIR ? { MURAGE_COMPANION_DIR: process.env.MURAGE_COMPANION_DIR } : {}),
        ...PORTS,
        MURAGE_COMPANION_BIND: "loopback",
        MURAGE_BROWSER_BIND: "loopback",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    let out = "";
    let err = "";
    proc.stdout.on("data", (c: Buffer) => {
      out += c;
      if (out.includes("pair here")) resolve();
    });
    proc.stderr.on("data", (c: Buffer) => (err += c));
    proc.on("close", (code) => reject(new Error(`sidecar exited ${code}: ${err || out}`)));
    setTimeout(() => reject(new Error(`sidecar never started: ${err || out}`)), 25_000).unref?.();
  });

/** One wrong guess at the device door. No `Origin`, which is what a native
 * app sends and what that door insists on. */
const guessAtDevice = async (): Promise<number> => {
  const res = await fetch(`http://127.0.0.1:${PORTS.MURAGE_COMPANION_PORT}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: "000000", deviceName: "Impostor" }),
  });
  await res.text();
  return res.status;
};

/** One wrong guess at the browser door.
 *
 * `Origin` is required here and forbidden at the device door, which is the
 * two doors' origin policies being genuinely different rather than one policy
 * with a flag. It has to match this door's own authority exactly — rule 4 of
 * `originGate`: a write without an `Origin` is not a browser. */
const guessAtBrowser = async (): Promise<{ status: number; retryAfter: string | null }> => {
  const origin = `http://127.0.0.1:${PORTS.MURAGE_BROWSER_PORT}`;
  const res = await fetch(`${origin}/session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ credential: "000000" }),
  });
  await res.text();
  return { status: res.status, retryAfter: res.headers.get("retry-after") };
};

describe("the two doors share one sign-in lockout", () => {
  it("honours a lockout earned at the device door when the same client arrives at the browser door", async () => {
    await sidecar();

    // Lock this client out on 8810, and only on 8810. Three free failures,
    // then the fourth is what actually sets the lockout.
    for (let i = 0; i <= SIGN_IN_FREE_ATTEMPTS; i++) {
      expect(await guessAtDevice()).toBe(401);
    }
    expect(await guessAtDevice()).toBe(429);

    // The whole test. With a limiter per door this is a 401 — a fresh budget
    // at the other half of the same credential.
    const atBrowser = await guessAtBrowser();
    expect(atBrowser.status).toBe(429);
    expect(atBrowser.retryAfter).not.toBeNull();
  }, 40_000);

  it("honours a lockout earned at the browser door when the same client arrives at the device door", async () => {
    await sidecar();

    for (let i = 0; i <= SIGN_IN_FREE_ATTEMPTS; i++) {
      expect((await guessAtBrowser()).status).toBe(401);
    }
    expect((await guessAtBrowser()).status).toBe(429);

    // The other direction, which is the one an attacker picks if only one is
    // wired: a lockout that holds one way round is still half a lockout.
    expect(await guessAtDevice()).toBe(429);
  }, 40_000);

  // The mechanism, in-process and fast, so a failure above can be told apart
  // from a failure here. If this one is red the doors do not honour a shared
  // limiter at all; if only the two above are red, `index.ts` is not handing
  // them one.
  it("counts both doors' failures into the one instance it is given", async () => {
    const limiter = createSignInLimiter();
    const devices = new DeviceRegistry();

    const device = createServer(
      createProxyHandler({
        harnessPort: 1,
        authenticate: () => null,
        redeem: (code, name, id) => devices.redeem(code, name, id),
        serverName: () => "Ada's computer",
        signInLimiter: limiter,
      }),
    );
    const browser = createServer(
      createBrowserHandler({
        harnessPort: 1,
        identity: () => ({ scheme: "http", hosts: new Set(["127.0.0.1", "localhost"]) }),
        devices,
        signInLimiter: limiter,
      }),
    );
    open.push(device, browser);
    await new Promise<void>((r) => device.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => browser.listen(0, "127.0.0.1", r));
    const devicePort = (device.address() as { port: number }).port;
    const browserPort = (browser.address() as { port: number }).port;

    // The browser door requires `Origin` on a write and the device door
    // refuses any `Origin` at all, so the header goes on exactly one of them.
    const post = async (port: number, path: string) => {
      const origin = `http://127.0.0.1:${port}`;
      const res = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(path === "/session" ? { origin } : {}),
        },
        body: JSON.stringify({ credential: "000000" }),
      });
      await res.text();
      return res.status;
    };

    // Split the budget across the two doors: neither on its own spends
    // enough to lock, and together they do. A per-door limiter cannot fail
    // this way, which is exactly what makes it the right shape of test.
    let spent = 0;
    while (spent <= SIGN_IN_FREE_ATTEMPTS) {
      const port = spent % 2 === 0 ? devicePort : browserPort;
      expect(await post(port, port === devicePort ? "/api/pair" : "/session")).toBe(401);
      spent += 1;
    }
    expect(await post(devicePort, "/api/pair")).toBe(429);
    expect(await post(browserPort, "/session")).toBe(429);
  });
});
