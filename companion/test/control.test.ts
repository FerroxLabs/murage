// The control plane's own front door.
//
// This server binds loopback and serves the pairing page, which makes it feel
// unreachable from outside. It is not: a browser on the victim's machine is
// inside that boundary, and any page on the internet can aim a form at it.
// These tests pin the rule that keeps that from mattering.
import { type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createControlServer, originIsLoopback } from "../src/control.ts";
import { DeviceRegistry } from "../src/devices.ts";

let control: Server;
let port = 0;

const ask = async (
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
};

beforeAll(async () => {
  control = createControlServer({
    devices: new DeviceRegistry(),
    companionPort: 8810,
    discovery: () => ({ advertising: false, name: "Test computer" }),
  });
  port = await new Promise<number>((resolve) =>
    control.listen(0, "127.0.0.1", () => resolve((control.address() as { port: number }).port)),
  );
});

afterAll(async () => {
  await new Promise<void>((resolve) => control.close(() => resolve()));
});

describe("origins the control server will change state for", () => {
  it("refuses a state change from a foreign page", async () => {
    // The attack this exists for: a form POST needs no preflight, and the
    // Host header on it is the loopback one this server already approves.
    // Same-origin policy hides the reply, so the code is never read — but a
    // pairing window opens on the victim's screen regardless.
    const { status, body } = await ask("POST", "/pairing", { origin: "https://evil.example" });
    expect(status).toBe(403);
    expect(body.error).toContain("cross-origin");
    // and it did not happen anyway
    expect((await ask("GET", "/state")).body.pairing).toBeNull();
  });

  it("refuses an opaque origin", async () => {
    // A sandboxed iframe and a file:// page both send the literal string
    // "null". Treating that as absent would hand the hole straight back.
    expect((await ask("POST", "/pairing", { origin: "null" })).status).toBe(403);
    expect((await ask("DELETE", "/pairing", { origin: "null" })).status).toBe(403);
  });

  it("allows the loopback page it serves, on any port", async () => {
    const { status } = await ask("POST", "/pairing", { origin: `http://127.0.0.1:${port}` });
    expect(status).toBe(201);
    expect((await ask("GET", "/state")).body.pairing).not.toBeNull();
    await ask("DELETE", "/pairing", { origin: `http://127.0.0.1:${port}` });
  });

  it("allows a client that sends no origin at all", async () => {
    // The Electron main process, which is not a browser and is the normal
    // desktop path. A CSRF check aimed at it would break the toggle.
    expect((await ask("POST", "/pairing")).status).toBe(201);
    await ask("DELETE", "/pairing");
  });

  it("leaves safe methods alone", async () => {
    // Nothing to protect: the SOP stops a foreign page reading the reply and
    // this server sends no CORS headers to weaken that.
    expect((await ask("GET", "/state", { origin: "https://evil.example" })).status).toBe(200);
  });
});

describe("originIsLoopback", () => {
  it("accepts loopback and absence, and nothing else", () => {
    expect(originIsLoopback(undefined)).toBe(true);
    expect(originIsLoopback("http://127.0.0.1:8811")).toBe(true);
    expect(originIsLoopback("http://localhost:3000")).toBe(true);
    expect(originIsLoopback("http://[::1]:8811")).toBe(true);

    expect(originIsLoopback("null")).toBe(false);
    expect(originIsLoopback("https://evil.example")).toBe(false);
    // the prefix trick: a hostname that merely starts with the loopback one
    expect(originIsLoopback("https://127.0.0.1.evil.example")).toBe(false);
    expect(originIsLoopback("https://localhost.evil.example")).toBe(false);
  });
});
