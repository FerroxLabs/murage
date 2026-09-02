// The browser door, as the desktop app names it and reports it.
//
// The door shipped built, hardened and unreachable: `companion/src/index.ts`
// knew about MURAGE_BROWSER_PORT/BIND/SCHEME and nothing ever set them, and
// `/state` carried the phone's port, the LAN addresses and the MagicDNS name
// but no word about where the door itself was answering. So the renderer had
// no way to build a URL for a phone that did not amount to guessing three
// separate decisions taken in another process.
//
// Two properties are pinned here. First: the fork names the door, the way it
// already names the device and control ports — a default that lives only in
// the sidecar is a default the desktop can silently disagree with. Second:
// `browser` is a key on every shape this module returns, including the two it
// makes up when there is no sidecar to ask, so "off" and "not responding" are
// complete answers rather than absences the panel has to interpret.
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/** The port companion.mjs hard-codes for the sidecar's control server. */
const CONTROL_PORT = 8811;
/** `start()` refuses to adopt a control server whose pid does not match the
 * child it forked, so both sides of this test agree on one. */
const FAKE_PID = 515151;

/** Every environment the fake fork was handed, newest last. */
const forkEnvironments = [];

const child = Object.assign(new EventEmitter(), {
  pid: FAKE_PID,
  stdout: null,
  stderr: null,
  kill() {
    this.emit("exit", 0);
    return true;
  },
});

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: () => mkdtempSync(path.join(tmpdir(), "murage-browser-door-")),
    getAppPath: () => process.cwd(),
  },
  utilityProcess: {
    fork: (_entry, _args, options) => {
      forkEnvironments.push(options.env);
      return child;
    },
  },
}));

vi.mock("./companion-entry.mjs", () => ({
  resolveCompanionEntry: () => ({ entry: "/fake/companion/index.js", execArgv: [] }),
}));

vi.mock("./companion-origin-gateway.mjs", () => ({
  createCompanionOriginEndpoint: () => ({ socketPath: "/fake/companion.sock" }),
  cleanupCompanionOriginEndpoint: () => {},
  companionOriginHealth: async () => true,
}));

const { companionState, startCompanion, stopCompanion } = await import("./companion.mjs");

/** What the stand-in sidecar reports for the door. */
let door = { scheme: "http", host: "macbook.tail1234.ts.net", port: 8813 };
/** Whether the stand-in control server answers at all. */
let answering = true;

let control;

beforeAll(async () => {
  control = createServer((req, res) => {
    if (!answering) return res.destroy();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        pid: FAKE_PID,
        port: 8810,
        devices: [],
        connectedDeviceIds: [],
        pairing: null,
        browser: door,
      }),
    );
  });
  await new Promise((resolve, reject) => {
    // A running copy of Murage owns this port, and companion.mjs hard-codes
    // it. Without this the failure is an uncaught EADDRINUSE and a 30-second
    // hook timeout attributed to whichever file vitest was in at the time —
    // which is how the pre-existing companion-tailscale.test.mjs reads too.
    control.once("error", (error) =>
      reject(
        error.code === "EADDRINUSE"
          ? new Error(
              `port ${CONTROL_PORT} is in use — quit the running Murage desktop app before this suite, ` +
                "or it and this stand-in sidecar will fight over the control port",
            )
          : error,
      ),
    );
    control.listen(CONTROL_PORT, "127.0.0.1", resolve);
  });
});

afterAll(async () => {
  await stopCompanion().catch(() => {});
  await new Promise((resolve) => control.close(resolve));
});

describe("the desktop names the browser door", () => {
  it("passes the port, the bind preference and the scheme to the fork", async () => {
    await startCompanion({ resourcesPath: "/fake/resources", harnessPort: 8799 });
    const env = forkEnvironments.at(-1);
    expect(env.MURAGE_BROWSER_PORT).toBe("8813");
    // Not 8812: companion-origin-gateway.mjs owns that one, and the door
    // landing on top of it is the collision this number exists to avoid.
    expect(env.MURAGE_BROWSER_PORT).not.toBe("8812");
    // `auto`, not `tailnet` — the door has to come up on a laptop whose
    // Tailscale is not signed in yet, and a demand for the tailnet address
    // refuses to bind rather than falling back.
    expect(env.MURAGE_BROWSER_BIND).toBe("auto");
    // Plain HTTP until `tailscale serve` is really in front with a
    // certificate. The value decides the cookie name and the Secure
    // attribute, so claiming https early breaks the session.
    expect(env.MURAGE_BROWSER_SCHEME).toBe("http");
  });

  it("lets an operator's own environment win over the fork's default", async () => {
    const previous = process.env.MURAGE_BROWSER_BIND;
    process.env.MURAGE_BROWSER_BIND = "loopback";
    try {
      await stopCompanion();
      await startCompanion({ resourcesPath: "/fake/resources", harnessPort: 8799 });
      expect(forkEnvironments.at(-1).MURAGE_BROWSER_BIND).toBe("loopback");
    } finally {
      if (previous === undefined) delete process.env.MURAGE_BROWSER_BIND;
      else process.env.MURAGE_BROWSER_BIND = previous;
    }
  });

  it("reports where the door answers, from the sidecar rather than from a guess", async () => {
    await stopCompanion();
    await startCompanion({ resourcesPath: "/fake/resources", harnessPort: 8799 });
    const state = await companionState();
    expect(state.enabled).toBe(true);
    expect(state.browser).toEqual({ scheme: "http", host: "macbook.tail1234.ts.net", port: 8813 });
  });

  it("says the door is not listening rather than leaving the key out", async () => {
    // A sidecar bound to loopback with no tailnet reports null, and the panel
    // has an "off" to render instead of a host to invent.
    door = null;
    await stopCompanion();
    await startCompanion({ resourcesPath: "/fake/resources", harnessPort: 8799 });
    expect((await companionState()).browser).toBeNull();
    door = { scheme: "http", host: "macbook.tail1234.ts.net", port: 8813 };
  });

  it("carries the key on the two shapes it makes up itself", async () => {
    await stopCompanion();
    // Off: no sidecar to ask at all.
    const off = await companionState();
    expect(off.enabled).toBe(false);
    expect("browser" in off).toBe(true);
    expect(off.browser).toBeNull();

    // Running, but the control server has stopped answering. "Not
    // responding" says nothing about the door, and the honest answer is the
    // same one "off" gives.
    await startCompanion({ resourcesPath: "/fake/resources", harnessPort: 8799 });
    answering = false;
    try {
      const stalled = await companionState();
      expect(stalled.enabled).toBe(true);
      expect(stalled.error).toBe("the companion is not responding");
      expect("browser" in stalled).toBe(true);
      expect(stalled.browser).toBeNull();
    } finally {
      answering = true;
    }
  });
});
