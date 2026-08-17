// The sidecar in front of a real harness.
//
// These boot the actual server and talk to it through the actual proxy,
// because every bug this design can have lives in the seam between them and
// none of them are visible to a unit test. In particular: SSE arriving but
// never terminating an event, a resume cursor being dropped on the way
// through, and the harness's loopback gate rejecting a proxied request.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createProxyHandler } from "../src/proxy.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const HARNESS_PORT = 19600 + Math.floor(Math.random() * 3000);
// +10, not +1: the harness opens its webhook receiver one port above itself,
// and this file needs three consecutive free ports of its own.
const SIDECAR_PORT = HARNESS_PORT + 10;
const HARNESS = `http://127.0.0.1:${HARNESS_PORT}`;
const SIDECAR = `http://127.0.0.1:${SIDECAR_PORT}`;

const TOKEN = "omb_test_token";
let harness: ChildProcess;
let sidecar: Server;
let home: string;
let stderr = "";

/** a request as a device makes it: a token, and a Host that is not loopback */
const device = async (
  method: string,
  path: string,
  opts: { token?: string | null; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> => {
  const token = opts.token === undefined ? TOKEN : opts.token;
  const res = await fetch(`${SIDECAR}${path}`, {
    method,
    headers: {
      ...(opts.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body };
};

/** raw request with a chosen Host header — fetch will not let us set one */
const withHost = (port: number, host: string, path = "/api/health", headers: Record<string, string> = {}) =>
  new Promise<number>((resolve, reject) => {
    const r = request({ hostname: "127.0.0.1", port, path, headers: { host, ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    r.on("error", reject);
    r.end();
  });

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "companion-test-"));
  mkdirSync(join(home, ".openmausbot"), { recursive: true });
  writeFileSync(
    join(home, ".openmausbot", "config.json"),
    JSON.stringify({ instances: { ghost: { driver: "not-a-real-driver", displayName: "Ghost" } } }),
  );

  harness = spawn(process.execPath, [join(ROOT, "server", "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(HARNESS_PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  harness.stderr!.on("data", (c) => (stderr += c));

  const deadline = Date.now() + 25_000;
  for (;;) {
    try {
      if ((await fetch(`${HARNESS}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`harness never came up:\n${stderr}`);
    if (harness.exitCode !== null) throw new Error(`harness exited ${harness.exitCode}:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 150));
  }

  sidecar = createServer(
    createProxyHandler({
      harnessPort: HARNESS_PORT,
      authenticate: (t) => t === TOKEN,
      redeem: (code, deviceName) =>
        code === "424242"
          ? { token: TOKEN, device: { id: "d1", name: String(deviceName) } }
          : { error: "that code is not right" },
      serverName: () => "Test computer",
    }),
  );
  await new Promise<void>((r) => sidecar.listen(SIDECAR_PORT, "127.0.0.1", r));
}, 40_000);

afterAll(async () => {
  await new Promise<void>((r) => (sidecar ? sidecar.close(() => r()) : r()));
  harness?.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (!harness || harness.exitCode !== null) return resolve();
    harness.on("close", () => resolve());
    // SIGKILL, then keep waiting for `close`. Resolving in the same tick as
    // the signal — which is what this did — starts deleting the home
    // directory out from under a process that has not died yet, and the
    // delete is what fails. A loaded CI runner loses that race; a laptop
    // wins it every time, which is why it reads as a phantom.
    setTimeout(() => harness.kill("SIGKILL"), 5_000).unref?.();
    // and a floor, so a process that somehow survives SIGKILL cannot hang
    // the suite instead
    setTimeout(resolve, 10_000).unref?.();
  });
  rmSync(home, { recursive: true, force: true });
});

describe("the sidecar in front of an unmodified harness", () => {
  it("reaches the harness with a Host the harness itself would refuse", async () => {
    // The premise of the whole design. Current upstream rejects a
    // non-loopback Host outright (DNS rebinding); a phone's Host is a LAN
    // address or a tailnet name and can never satisfy that. The sidecar
    // speaks to loopback as itself, so the device's Host never travels.
    //
    // Written so it passes against an older harness too: what is being
    // asserted is that the *sidecar* answers, whatever the harness's own
    // policy happens to be.
    expect(await withHost(SIDECAR_PORT, "macbook.tail1234.ts.net:8800", "/api/bots", {
      authorization: `Bearer ${TOKEN}`,
    })).toBe(200);
    expect(await withHost(SIDECAR_PORT, "192.168.1.42:8800", "/api/bots", {
      authorization: `Bearer ${TOKEN}`,
    })).toBe(200);
  });

  it("refuses anything carrying an Origin, before looking at the token", async () => {
    const { status } = await device("GET", "/api/bots", { headers: { origin: "https://evil.example" } });
    expect(status).toBe(403);
    // even a loopback origin, which the harness itself would allow
    const local = await device("GET", "/api/bots", { headers: { origin: `http://127.0.0.1:${HARNESS_PORT}` } });
    expect(local.status).toBe(403);
  });

  it("requires a paired token", async () => {
    expect((await device("GET", "/api/bots", { token: null })).status).toBe(401);
    expect((await device("GET", "/api/bots", { token: "omb_wrong" })).status).toBe(401);
    expect((await device("GET", "/api/bots")).status).toBe(200);
  });

  it("refuses what a device has no business doing, by default", async () => {
    // settings and credentials stay on the machine
    expect((await device("PUT", "/api/config", { body: { xai: { apiKey: "x" } } })).status).toBe(403);
    expect((await device("GET", "/api/devices")).status).toBe(403);
    expect((await device("GET", "/api/companion")).status).toBe(403);
    expect((await device("POST", "/api/local-computer/start")).status).toBe(403);
    // the internal peer-comms API does not exist off-machine
    expect((await device("GET", "/api/internal/peers")).status).toBe(404);
    // nor does the desktop UI
    expect((await device("GET", "/")).status).toBe(404);
    // but reading config is fine — it is booleans, not keys
    expect((await device("GET", "/api/config")).status).toBe(200);
  });

  it("lets a device answer an approval, and manage its own chats", async () => {
    // The approval path is the product: a card raised on the computer,
    // answered on the phone, and the bot carries on. What is checked here is
    // that the allowlist carries these routes to the harness at all — the
    // harness's own "no such pending request" is proof it arrived, and is a
    // far better signal than a 403 from the sidecar would be.
    //
    // Worth pinning separately from sending a message, because these are the
    // routes a default-deny allowlist is most likely to omit by accident.
    const { body } = await device("GET", "/api/bots");
    const bot = body.bots[0];

    for (const [method, path, payload] of [
      ["POST", `/api/threads/${bot.threadId}/respond`, { requestId: "nope", behavior: "allow" }],
      ["POST", `/api/bots/${bot.id}/messages`, { text: "hello from a test" }],
      ["POST", `/api/bots/${bot.id}/interrupt`, undefined],
      ["PATCH", `/api/bots/${bot.id}`, { unread: false }],
    ] as const) {
      const res = await device(method, path, payload ? { body: payload } : {});
      // whatever the harness decides, the sidecar must not be the one saying no
      expect(res.status, `${method} ${path} was blocked by the sidecar`).not.toBe(403);
      expect(res.status, `${method} ${path} never reached the harness`).not.toBe(404);
    }
  });

  it("never passes the provider session cursors through", async () => {
    const listed = await device("GET", "/api/bots");
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain("resumeCursors");
    for (const bot of listed.body.bots) {
      expect(bot).not.toHaveProperty("resumeCursors");
      for (const task of bot.tasks ?? []) expect(task).not.toHaveProperty("resumeCursors");
    }

    // Whether the harness sent any is deliberately NOT asserted: some
    // versions leak them, some do not, and the sidecar scrubs either way.
    // Asserting on the harness's behaviour here would make this test pass
    // or fail on which harness happens to be checked out. That the scrubber
    // is not a no-op is pinned in wire.test.ts, against a payload built to
    // contain them.
  });

  it("streams events through, terminated and scrubbed, keeping the resume cursor", async () => {
    const controller = new AbortController();
    const res = await fetch(`${SIDECAR}/api/events`, {
      headers: { accept: "text/event-stream", authorization: `Bearer ${TOKEN}` },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    /** read until `want` finds a complete event, or give up */
    const nextEvent = async (want: (event: string) => boolean): Promise<string | null> => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        let boundary = buffered.indexOf("\n\n");
        while (boundary >= 0) {
          const event = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          if (want(event)) return event;
          boundary = buffered.indexOf("\n\n");
        }
        if (Date.now() > deadline) return null;
        const { value, done } = await reader.read();
        if (done) return null;
        buffered += decoder.decode(value, { stream: true });
      }
    };

    try {
      // The blank-line terminator is the thing worth asserting: an SSE
      // transform that normalises whitespace produces a stream that parses
      // to nothing while looking perfectly healthy at both ends.
      const hello = await nextEvent((e) => e.includes('"kind":"hello"'));
      expect(hello).not.toBeNull();
      expect(JSON.parse(hello!.replace(/^data:\s*/, ""))).toMatchObject({ kind: "hello" });

      // A broadcast frame, which is the one that carries `id:` — the resume
      // cursor. Rewriting the payload must not disturb it.
      const { body } = await device("GET", "/api/bots");
      const botId = body.bots[0].id;
      await device("PATCH", `/api/bots/${botId}`, { body: { unread: true } });

      const frame = await nextEvent((e) => e.startsWith("id: "));
      expect(frame).not.toBeNull();
      expect(frame).toMatch(/^id: [0-9a-f]+:\d+\n/);
      expect(frame).not.toContain("resumeCursors");
    } finally {
      controller.abort();
    }
  });

  it("says the harness is down rather than hanging, when it is", async () => {
    const orphan = createServer(
      createProxyHandler({
        harnessPort: 1,
        authenticate: () => true,
        redeem: () => ({ error: "no" }),
        serverName: () => "Test computer",
      }),
    );
    await new Promise<void>((r) => orphan.listen(0, "127.0.0.1", r));
    const port = (orphan.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/bots`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: string }).error).toContain("not running");
    } finally {
      await new Promise<void>((r) => orphan.close(() => r()));
    }
  });
});

// The whole loop, with the real registry rather than a stub: open a pairing
// window on the control surface, redeem the code the way the phone does, and
// use the token that comes back. This is the path that has no unit-test
// equivalent — every piece is real except the phone.
describe("pairing, end to end", () => {
  it("turns a code shown on the computer into a working device token", async () => {
    const { DeviceRegistry } = await import("../src/devices.ts");
    const { createControlServer } = await import("../src/control.ts");

    const registry = new DeviceRegistry();
    const port = SIDECAR_PORT + 1;
    const controlPort = SIDECAR_PORT + 2;
    const paired = createServer(
      createProxyHandler({
        harnessPort: HARNESS_PORT,
        authenticate: (t) => Boolean(registry.authenticate(t ?? undefined)),
        redeem: (code, deviceName) => registry.redeem(code, deviceName),
        serverName: () => "Ada's computer",
      }),
    );
    const control = createControlServer({
      devices: registry,
      companionPort: port,
      discovery: () => ({ advertising: false, name: "OpenMausBot" }),
    });
    await new Promise<void>((r) => paired.listen(port, "127.0.0.1", r));
    await new Promise<void>((r) => control.listen(controlPort, "127.0.0.1", r));
    const base = `http://127.0.0.1:${port}`;
    const ctl = `http://127.0.0.1:${controlPort}`;

    try {
      // before pairing, the phone gets nowhere
      expect((await fetch(`${base}/api/bots`)).status).toBe(401);

      // the person clicks "Start pairing" on the computer
      const opened = (await (await fetch(`${ctl}/pairing`, { method: "POST" })).json()) as { code: string };
      expect(opened.code).toMatch(/^\d{6}$/);

      // a wrong code is refused, and does not burn the window
      const wrong = await fetch(`${base}/api/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "000000", deviceName: "Impostor" }),
      });
      expect(wrong.status).toBe(401);

      // the right one is redeemed exactly once, and never forwarded upstream
      const res = await fetch(`${base}/api/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: opened.code, deviceName: "Ada's iPhone" }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { token: string; serverName: string };
      expect(body.serverName).toBe("Ada's computer");
      expect(body.token).toMatch(/^omb_/);

      // and the token works on the real API, through the real proxy
      const bots = await fetch(`${base}/api/bots`, { headers: { authorization: `Bearer ${body.token}` } });
      expect(bots.status).toBe(200);
      expect(await bots.text()).not.toContain("resumeCursors");

      // the computer can see the phone, and take it away again
      const state = (await (await fetch(`${ctl}/state`)).json()) as {
        devices: Array<{ id: string; name: string }>;
      };
      expect(state.devices.map((d) => d.name)).toContain("Ada's iPhone");
      // By name, not by index. The registry reads the process-level DATA_DIR,
      // and if anything else has ever paired into it, `devices[0]` is some
      // other phone — the assertion above would still pass while the DELETE
      // below revoked a device this test never created.
      const paired = state.devices.find((d) => d.name === "Ada's iPhone");
      expect(paired).toBeDefined();
      const revoked = await fetch(`${ctl}/devices/${paired!.id}`, { method: "DELETE" });
      expect(revoked.status).toBe(200);
      expect((await fetch(`${base}/api/bots`, { headers: { authorization: `Bearer ${body.token}` } })).status).toBe(401);
    } finally {
      await new Promise<void>((r) => paired.close(() => r()));
      await new Promise<void>((r) => control.close(() => r()));
    }
  });

  it("keeps the control surface off the network", async () => {
    const { DeviceRegistry } = await import("../src/devices.ts");
    const { createControlServer } = await import("../src/control.ts");
    const control = createControlServer({
      devices: new DeviceRegistry(),
      companionPort: 8800,
      discovery: () => ({ advertising: false, name: "OpenMausBot" }),
    });
    await new Promise<void>((r) => control.listen(0, "127.0.0.1", r));
    const port = (control.address() as { port: number }).port;
    try {
      // pairing and revocation are exactly what a phone must never reach
      expect(await withHost(port, "macbook.tail1234.ts.net:8801", "/state")).toBe(403);
      expect(await withHost(port, `127.0.0.1:${port}`, "/state")).toBe(200);
    } finally {
      await new Promise<void>((r) => control.close(() => r()));
    }
  });

  // The Host check above is not enough on its own. A page anywhere can POST
  // to 127.0.0.1 without a preflight — it is a simple request — and it
  // arrives with a loopback Host like everything else. It cannot read the
  // reply, but opening a pairing window is already the damage: the code is
  // then on screen for whoever asked for it.
  it("refuses a cross-origin request even though its Host is loopback", async () => {
    const { DeviceRegistry } = await import("../src/devices.ts");
    const { createControlServer } = await import("../src/control.ts");
    const registry = new DeviceRegistry();
    const control = createControlServer({
      devices: registry,
      companionPort: 8800,
      discovery: () => ({ advertising: false, name: "OpenMausBot" }),
    });
    await new Promise<void>((r) => control.listen(0, "127.0.0.1", r));
    const port = (control.address() as { port: number }).port;
    const host = `127.0.0.1:${port}`;
    try {
      for (const origin of ["https://evil.example", "http://127.0.0.1.evil.example", "null"]) {
        expect(await withHost(port, host, "/state", { origin })).toBe(403);
      }
      // no pairing window was opened by any of that
      expect(registry.pairing()).toBeNull();

      // the control page itself is same-origin, and a native client sends
      // no Origin at all — both keep working
      expect(await withHost(port, host, "/state", { origin: `http://${host}` })).toBe(200);
      expect(await withHost(port, host, "/state", { origin: `http://localhost:${port}` })).toBe(200);
      expect(await withHost(port, host, "/state")).toBe(200);
    } finally {
      await new Promise<void>((r) => control.close(() => r()));
    }
  });
});
