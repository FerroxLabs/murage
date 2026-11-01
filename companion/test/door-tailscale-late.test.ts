// The restart order that left a phone locked out (11-01): Murage starts, then
// Tailscale connects. This boots the real companion with a fake Tailscale CLI
// that is "not running" until the test switches it on, and asks the door for
// /healthz under the MagicDNS name, the way `tailscale serve` forwards a phone.
// No button is pressed: the door has to adopt the Serve front on its own.
//
// Skipped on Windows, and where a real Tailscale is installed at one of the absolute paths the
// companion tries before PATH: the fake must be the only CLI it can reach.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { tailscaleCandidates } from "../src/listener.ts";

const NAME = "late-mac.tailtest.ts.net";
const ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));
// The fake CLI is a /bin/sh script, which Windows cannot run; the gate row
// already limits this file to Linux and macOS.
const skip = process.platform === "win32" || tailscaleCandidates().filter((cli) => cli !== "tailscale").some((cli) => existsSync(cli));

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

const get = (port: number, path: string, headers: Record<string, string>) =>
  new Promise<{ status: number; body: string }>((resolve) => {
    const req = request({ host: "127.0.0.1", port, path, headers, timeout: 3_000 }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve({ status: 0, body: "" }));
    req.end();
  });

async function until(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Rig {
  child: ChildProcess;
  dir: string;
  flag: string;
  log: () => string;
  /** Every argv the fake CLI was run with, one per line. */
  calls: () => string[];
  health: () => Promise<number>;
  /** The door as the control page reports it to the desktop app. */
  door: () => Promise<{ scheme: string; host: string; port: number } | null>;
}

const rigs: Rig[] = [];
afterEach(() => {
  for (const rig of rigs.splice(0)) {
    rig.child.kill("SIGKILL");
    rmSync(rig.dir, { recursive: true, force: true });
  }
});

async function boot(tailscaleUp: boolean): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "door-late-"));
  const bin = join(dir, "bin");
  const flag = join(dir, "tailscale-up");
  const callLog = join(dir, "calls.log");
  const [port, harness, webhook, device, control] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
  const controlToken = randomBytes(32).toString("base64url");
  // Fake CLI: logs every call, fails like a Tailscale that has not connected
  // until the flag exists, then answers the two read-only calls the door makes.
  const script = [
    "#!/bin/sh",
    `echo "$*" >> '${callLog}'`,
    `[ -f '${flag}' ] || { echo 'Tailscale is not running' >&2; exit 1; }`,
    'case "$1 $2" in',
    `  "status --json") printf '%s\\n' '{"BackendState":"Running","Self":{"DNSName":"${NAME}.","TailscaleIPs":["100.101.102.103"]}}' ;;`,
    `  "serve status") printf '%s\\n' '{"TCP":{"443":{"HTTPS":true}},"Web":{"${NAME}:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:${port}"}}}}}' ;;`,
    "  *) exit 1 ;;",
    "esac",
    "",
  ].join("\n");
  mkdirSync(bin);
  writeFileSync(join(bin, "tailscale"), script);
  chmodSync(join(bin, "tailscale"), 0o755);
  writeFileSync(callLog, "");
  if (tailscaleUp) writeFileSync(flag, "");
  let out = "";
  const child = spawn(process.execPath, ["--experimental-strip-types", ENTRY], {
    env: {
      HOME: dir,
      TMPDIR: dir,
      PATH: `${bin}:/usr/bin:/bin`,
      MURAGE_PORT: String(harness),
      MURAGE_WEBHOOK_PORT: String(webhook),
      MURAGE_COMPANION_PORT: String(device),
      MURAGE_COMPANION_BIND: "off",
      MURAGE_CONTROL_PORT: String(control),
      MURAGE_BROWSER_PORT: String(port),
      MURAGE_COMPANION_DIR: join(dir, "companion"),
      MURAGE_COMPANION_NAME: "Late Tailscale",
      MURAGE_COMPANION_TOKEN: randomBytes(32).toString("hex"),
      MURAGE_COMPANION_CONTROL_TOKEN: controlToken,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => (out += d));
  child.stderr?.on("data", (d) => (out += d));
  const rig: Rig = {
    child,
    dir,
    flag,
    log: () => out,
    calls: () => readFileSync(callLog, "utf8").split("\n").filter(Boolean),
    health: async () => (await get(port, "/healthz", { host: NAME })).status,
    door: async () => {
      const res = await get(control, "/state", { "x-murage-control-token": controlToken });
      return res.status === 200 ? (JSON.parse(res.body).browser ?? null) : null;
    },
  };
  rigs.push(rig);
  const up = await until(async () => (await get(port, "/healthz", { host: "127.0.0.1" })).status !== 0, 20_000);
  if (!up) throw new Error(`door did not start:\n${out}`);
  return rig;
}

describe.skipIf(skip)("Tailscale connecting after Murage started", () => {
  it("adopts the Serve front on its own, answers the MagicDNS name, then stops asking", async () => {
    const rig = await boot(false);
    expect(await rig.health()).toBe(403);
    expect((await rig.door())?.scheme).toBe("http");

    writeFileSync(rig.flag, ""); // Tailscale connects; nobody presses anything
    // Wait for the front, not just the name: HTTPS on 443 under the MagicDNS
    // name, which is what the QR and the phone are given, and the watch done.
    const moved = await until(async () => {
      const door = await rig.door();
      return door?.scheme === "https" && door.host === NAME && door.port === 443 && rig.log().includes("rechecks stopped");
    }, 20_000);
    expect(moved, rig.log()).toBe(true);
    expect(await rig.health()).toBe(200);
    expect(await rig.door()).toEqual({ scheme: "https", host: NAME, port: 443 });
    expect(rig.calls().length).toBeGreaterThan(0);
    expect(rig.calls().some((c) => c.startsWith("serve status"))).toBe(true);
    expect(rig.log()).toContain("Tailscale route found; rechecks stopped");

    const settled = rig.calls().length;
    await pause(5_000);
    expect(rig.calls().length).toBe(settled);
  }, 60_000);
});

describe.skipIf(skip)("a door that already has its tailnet route at startup", () => {
  it("answers the MagicDNS name at once and never starts rechecking", async () => {
    const rig = await boot(true);
    expect(await rig.health()).toBe(200);
    expect(await rig.door()).toEqual({ scheme: "https", host: NAME, port: 443 });
    const atStartup = rig.calls().length;
    expect(atStartup).toBeGreaterThan(0);
    await pause(5_000); // past the first two recheck slots
    expect(rig.calls().length).toBe(atStartup);
    expect(rig.log()).not.toContain("waiting for Tailscale");
    expect(await rig.health()).toBe(200);
  }, 60_000);
});
