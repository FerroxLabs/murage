// Why connected apps read as "unreachable". A person was told "Connected apps
// can't be reached right now" and the server log held no line saying whether
// the broker, the token or the network failed. Every unreachable path now logs
// one `connected apps:` line with the cause, throttled per cause.
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyManagedBrokerMessage,
  BROKER_UNREACHABLE,
  connectorAccess,
  primeBrokerReadiness,
  relayMcp,
  resetManagedBrokerState,
} from "./composio.ts";
import type { AppConfig } from "./config.ts";

const FLUX_TOKEN = "b".repeat(64);
let broker: Server;
let base = "";
let health = { status: 503, body: { ready: false, secret: "should-never-be-logged" } };
let dark = { status: 503, body: { error: "dark" } as Record<string, unknown> };
const cfg = (): AppConfig => ({}) as AppConfig;

beforeAll(async () => {
  broker = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const answer = url.pathname.endsWith("/health") ? health : dark;
    res.writeHead(answer.status, { "content-type": "application/json" });
    res.end(JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
  const address = broker.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => broker.close(() => resolve()));
});

function shellFlux(url: string) {
  applyManagedBrokerMessage({
    type: "murage:managed-composio",
    access: null,
    fluxBrokerUrl: url,
    fluxAccess: { url, token: FLUX_TOKEN },
    legacyUntil: "",
    legacyClaim: { state: "none" },
    accountKind: null,
    tokenError: null,
  });
}

let warn: ReturnType<typeof vi.spyOn>;
const lines = () => warn.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.startsWith("connected apps:"));

beforeEach(() => {
  health = { status: 503, body: { ready: false, secret: "should-never-be-logged" } };
  dark = { status: 503, body: { error: "dark" } };
  resetManagedBrokerState();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  resetManagedBrokerState();
  warn.mockRestore();
  vi.useRealTimers();
});

describe("connected apps unreachable log", () => {
  it("logs the HTTP status when the readiness probe is refused, once per 5 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    shellFlux(`${base}/composio`);
    await primeBrokerReadiness();
    expect(lines()).toEqual(["connected apps: unreachable (readiness probe): HTTP 503"]);

    vi.setSystemTime(Date.now() + 25_000);
    await primeBrokerReadiness();
    expect(lines()).toHaveLength(1);

    vi.setSystemTime(Date.now() + 5 * 60_000);
    await primeBrokerReadiness();
    expect(lines()).toHaveLength(2);
  });

  it("logs the error code when the broker cannot be reached at all", async () => {
    // A port that was open a moment ago and is closed now (port 1 is on
    // fetch's blocked list and would fail with "bad port", not a socket error).
    const spare = createServer();
    await new Promise<void>((resolve) => spare.listen(0, "127.0.0.1", resolve));
    const port = (spare.address() as { port: number }).port;
    await new Promise<void>((resolve) => spare.close(() => resolve()));
    shellFlux(`http://127.0.0.1:${port}/composio`);
    await primeBrokerReadiness();
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatch(/^connected apps: unreachable \(readiness probe\): ECONNREFUSED$/);
  });

  it("logs when a tool call and the session gate end in unreachable, without secrets", async () => {
    shellFlux(`${base}/composio`);
    // The probe's own line (HTTP 503) is throttled; the tool call and the
    // session gate share that cause, so they stay quiet inside the window.
    await primeBrokerReadiness();
    const reply = await relayMcp(cfg(), { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "X", arguments: {} } });
    expect(Buffer.from(reply.bytes).toString("utf8")).toContain(BROKER_UNREACHABLE);
    expect(connectorAccess({ cfg: cfg(), botComposio: undefined, installedFromPackage: false, engineMountsConnectors: true, mounted: false })).toBe("unreachable");
    const all = lines();
    expect(all).toEqual(["connected apps: unreachable (readiness probe): HTTP 503"]);
    for (const line of lines()) {
      expect(line).toMatch(/^connected apps: unreachable \(readiness probe\): HTTP 503$/);
      expect(line).not.toMatch(/Composio|should-never-be-logged|127\.0\.0\.1|bbbb|\?/);
      expect(line.length).toBeLessThan(120);
    }
  });

  it("logs a tool call the broker answers 503 even though its health probe said ready", async () => {
    health = { status: 200, body: { ready: true, secret: "should-never-be-logged" } };
    shellFlux(`${base}/composio`);
    await primeBrokerReadiness();
    expect(lines()).toEqual([]);
    const reply = await relayMcp(cfg(), { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "X", arguments: {} } });
    expect(Buffer.from(reply.bytes).toString("utf8")).toContain(BROKER_UNREACHABLE);
    expect(lines()).toEqual(["connected apps: unreachable (tool call): HTTP 503"]);
  });

  it("names a rejected token in the log, without secrets", async () => {
    health = { status: 200, body: { ready: true, secret: "should-never-be-logged" } };
    dark = { status: 401, body: { error: "token_revoked", secret: "should-never-be-logged" } };
    shellFlux(`${base}/composio`);
    await primeBrokerReadiness();
    await relayMcp(cfg(), { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "X", arguments: {} } });
    expect(lines()).toEqual(["connected apps: unreachable (tool call): HTTP 401 token rejected"]);
    for (const line of lines()) expect(line).not.toMatch(/should-never-be-logged|bbbb|127\.0\.0\.1/);
  });
});
