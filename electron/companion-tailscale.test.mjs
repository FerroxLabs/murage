// Asking the running sidecar to look at Tailscale again.
//
// The tailnet is the door Murage leads with, and the MagicDNS name behind it
// was read once, at sidecar boot. Anyone who installed Tailscale, signed into
// it, or brought it up after Murage was already running therefore had a
// perfectly working route that reported itself permanently unavailable until
// they restarted the app.
//
// These tests drive the desktop half of the fix against a stand-in control
// server: the sidecar process is faked, but the HTTP conversation with it is
// real, which is where the two things worth pinning live — that the timeout
// is long enough to actually receive a bounded CLI hunt's answer, and that a
// failure degrades to honest state rather than a thrown error in Settings.
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/** The port companion.mjs hard-codes for the sidecar's control server. */
const CONTROL_PORT = 8811;
/** The pid the fake sidecar claims. `start()` refuses to adopt a control
 * server whose pid does not match the child it forked, so both sides of this
 * test have to agree on one. */
const FAKE_PID = 424242;

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
    getPath: () => mkdtempSync(path.join(tmpdir(), "murage-companion-")),
    getAppPath: () => process.cwd(),
  },
  utilityProcess: { fork: () => child },
}));

vi.mock("./companion-entry.mjs", () => ({
  resolveCompanionEntry: () => ({ entry: "/fake/companion/index.js", execArgv: [] }),
}));

vi.mock("./companion-origin-gateway.mjs", () => ({
  createCompanionOriginEndpoint: () => ({ socketPath: "/fake/companion.sock" }),
  cleanupCompanionOriginEndpoint: () => {},
  companionOriginHealth: async () => true,
}));

const { companionRefreshTailscale, startCompanion } = await import("./companion.mjs");

/** Every request the desktop made of the control server, in order. */
const asked = [];
/** How long `POST /tailscale/refresh` should take before answering. */
let refreshDelayMs = 0;
/** The MagicDNS name the stand-in sidecar reports after a refresh. */
let tailnetName = null;

let control;

const state = () => ({
  pid: FAKE_PID,
  port: 8810,
  devices: [],
  connectedDeviceIds: [],
  pairing: null,
  tailnetName,
});

beforeAll(async () => {
  control = createServer((req, res) => {
    asked.push(`${req.method} ${req.url}`);
    const reply = () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(state()));
    };
    if (req.method === "POST" && req.url === "/tailscale/refresh") {
      // The sidecar's own CLI hunt is bounded, not instant. Answering
      // immediately here would let a too-short client timeout pass.
      tailnetName = "macbook.tail1234.ts.net";
      setTimeout(reply, refreshDelayMs).unref?.();
      return;
    }
    reply();
  });
  await new Promise((resolve, reject) => {
    control.once("error", reject);
    control.listen(CONTROL_PORT, "127.0.0.1", resolve);
  });

  const started = await startCompanion({ resourcesPath: "/fake/resources", harnessPort: 8799 });
  expect(started.enabled).toBe(true);
});

afterAll(async () => {
  await new Promise((resolve) => control.close(resolve));
});

describe("re-reading Tailscale on a running sidecar", () => {
  it("asks the sidecar to re-probe and reports the name it comes back with", async () => {
    asked.length = 0;
    refreshDelayMs = 0;
    tailnetName = null;

    const refreshed = await companionRefreshTailscale();

    // The re-probe route, not a restart and not a pairing window: a phone
    // already connected must survive somebody checking their network.
    expect(asked).toEqual(["POST /tailscale/refresh"]);
    expect(refreshed.enabled).toBe(true);
    expect(refreshed.tailnetName).toBe("macbook.tail1234.ts.net");
    expect(refreshed.error).toBeUndefined();
    expect(refreshed.pairing).toBeNull();
  });

  it("waits out the sidecar's five-second CLI hunt instead of aborting first", async () => {
    asked.length = 0;
    tailnetName = null;
    // Longer than the 4s budget every other control call uses, shorter than
    // the 5s the CLI hunt is allowed. On the old shared timeout this call is
    // aborted and the user is told Tailscale could not be checked — while the
    // sidecar was, at that moment, about to answer with the name.
    refreshDelayMs = 4_600;

    const refreshed = await companionRefreshTailscale();

    expect(asked).toEqual(["POST /tailscale/refresh"]);
    expect(refreshed.tailnetName).toBe("macbook.tail1234.ts.net");
    expect(refreshed.error).toBeUndefined();
  }, 15_000);
});

// main.mjs is the Electron entry and preload.cjs runs inside a sandboxed
// bridge, so neither is importable here. The channel they share is still a
// contract in three parts, and it is exactly the kind that breaks silently:
// the renderer's call resolves to undefined rather than throwing, so a broken
// wire looks like a button that does nothing.
describe("the IPC wire from the renderer to the sidecar", () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const read = (file) => readFileSync(path.join(HERE, file), "utf8");

  it("exposes the refresh on this app's bridge, under this app's channel", () => {
    const preload = read("preload.cjs");

    // window.muragebox, not window.ogb. The upstream this was ported from
    // names its bridge differently, and a survived identifier here is a
    // method the renderer can never reach.
    expect(preload).toContain('exposeInMainWorld("muragebox"');
    expect(preload).not.toContain("window.ogb");
    expect(preload).toMatch(/refreshTailscale: \(\) => ipcRenderer\.invoke\("companion:refresh-tailscale"\)/);
  });

  it("answers that channel in the main process", () => {
    const main = read("main.mjs");
    expect(main).toContain('ipcMain.handle("companion:refresh-tailscale"');
    expect(main).toContain("companionRefreshTailscale");
    // Off is not an answer about Tailscale, so the handler starts the sidecar
    // rather than reporting the route unavailable a second time.
    expect(main).toMatch(/async function refreshDesktopCompanionTailscale\(\)/);
  });

  it("passes the sidecar a way to re-probe at all", () => {
    // The route exists on the control server only when index.ts hands it the
    // callback; without this line every layer above is wired to a 404.
    expect(read("../companion/src/index.ts")).toContain("refreshTailscale: () => refreshTailnetName()");
  });
});
