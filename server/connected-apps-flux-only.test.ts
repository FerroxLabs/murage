// Connected apps run through Flux Router only. A person who once saved an own
// project key keeps that value on disk, but nothing reads it, nothing sends it
// anywhere, and the panel shows the ordinary Flux flow.
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyManagedBrokerMessage,
  authorizeService,
  BROKER_UNAVAILABLE,
  configured,
  connectedServices,
  connectionBroker,
  connectionMode,
  connectorAvailability,
  connectorPanelFields,
  primeBrokerReadiness,
  relayMcp,
  removeService,
  resetManagedBrokerState,
  setBrokerEventSink,
} from "./composio.ts";
import type { AppConfig } from "./config.ts";

const OLD_KEY = "ak_old_own_key_must_never_travel";
const FLUX_TOKEN = "b".repeat(64);

let broker: Server;
let base = "";
const seen: Array<{ path: string; method: string; headers: Record<string, string | string[] | undefined> }> = [];

beforeAll(async () => {
  broker = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    seen.push({ path: url.pathname, method: req.method ?? "", headers: req.headers });
    res.writeHead(200, { "content-type": "application/json" });
    if (url.pathname.endsWith("/health")) return res.end(JSON.stringify({ service: "flux-composio", ready: true, claims: true }));
    if (url.pathname.endsWith("/authorize")) return res.end(JSON.stringify({ url: "https://connect.composio.dev/link/x" }));
    if (url.pathname.endsWith("/connected")) {
      return res.end(JSON.stringify({ services: { gmail: { connected: true, status: "ACTIVE", accounts: [] } } }));
    }
    if (req.method === "DELETE") return res.end(JSON.stringify({ removed: 1 }));
    return res.end(JSON.stringify({ configured: true, services: {} }));
  });
  await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
  const address = broker.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterAll(async () => { await new Promise<void>((resolve) => broker.close(() => resolve())); });
beforeEach(() => { seen.length = 0; resetManagedBrokerState(); setBrokerEventSink(null); });
afterEach(() => { resetManagedBrokerState(); setBrokerEventSink(null); vi.restoreAllMocks(); });

const withOldKey = (): AppConfig => ({ composio: { apiKey: OLD_KEY, userId: "murage_x", sessionId: "trs_x" } }) as AppConfig;

async function readyFlux() {
  const url = `${base}/composio`;
  applyManagedBrokerMessage({
    type: "murage:managed-composio",
    access: null,
    fluxBrokerUrl: url,
    fluxAccess: { url, token: FLUX_TOKEN },
    legacyUntil: "",
    legacyClaim: { state: "claimed" },
    accountKind: "personal",
    tokenError: null,
  });
  await primeBrokerReadiness();
}

describe("a person with an old own key", () => {
  it("is not connected by that key: no broker means unavailable, and no request leaves", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const cfg = withOldKey();
    expect(connectionMode(cfg)).toBe("unavailable");
    expect(configured(cfg)).toBe(false);
    expect(connectorAvailability(cfg, undefined)).toBe("unconfigured");
    await expect(connectedServices(cfg)).rejects.toThrow(BROKER_UNAVAILABLE);
    await expect(authorizeService(cfg, "gmail")).rejects.toThrow();
    await expect(removeService(cfg, "gmail")).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is told, quietly, that the old key is retired", () => {
    expect(connectorPanelFields(withOldKey(), false).ownKeyRetired).toBe(true);
    expect(connectorPanelFields({} as AppConfig, false).ownKeyRetired).toBe(false);
  });

  it("gets the ordinary Flux flow, and the old key never travels", async () => {
    await readyFlux();
    const cfg = withOldKey();
    expect(connectionBroker(cfg)).toBe("flux");
    expect(connectionMode(cfg)).toBe("managed");
    const services = await connectedServices(cfg);
    expect(services.gmail?.connected).toBe(true);
    expect((await authorizeService(cfg, "gmail")).url).toContain("connect.composio.dev");
    expect((await removeService(cfg, "gmail")).removed).toBe(1);
    const relayed = await relayMcp(cfg, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(relayed.status).toBe(200);
    expect(seen.length).toBeGreaterThan(3);
    for (const request of seen) {
      expect(request.headers["x-api-key"]).toBeUndefined();
      expect(JSON.stringify(request.headers)).not.toContain(OLD_KEY);
      expect(request.path).toMatch(/^\/composio\//);
    }
    expect(connectorPanelFields(cfg, true).ownKeyRetired).toBe(true);
  });
});

describe("nothing hands the old key to the harness or sends it anywhere", () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

  it("the desktop shell tells the harness a key exists, never what it is", () => {
    const main = read("../electron/main.mjs");
    expect(main).not.toMatch(/COMPOSIO_API_KEY:\s*secureCredentials/);
    expect(main).toContain('MURAGE_CONNECTED_APPS_OWN_KEY_RETIRED: "1"');
    expect(main).not.toContain("composioApiKey: (value)");
  });

  it("the harness neither reads the key from its environment nor accepts it in a config write", () => {
    const config = read("./config.ts");
    expect(config).not.toMatch(/process\.env\.COMPOSIO_API_KEY/);
    expect(config).not.toMatch(/\[patch\.composio\?\.apiKey/);
    const index = read("./index.ts");
    expect(index).not.toContain("prepareProjectSession");
    expect(index).toContain("delete patch.composio;");
  });

  it("the stored value is left where it was", () => {
    // Retired, not removed: the field stays in the schema so a saved value
    // survives every load and save, and the secure-store move still runs.
    expect(read("./config.ts")).toContain("composio: z.object({ apiKey: optionalText");
    expect(read("../electron/main.mjs")).toContain("secureCredentials.composioApiKey = apiKey.trim();");
  });
});

describe("the old key stays out of the child environment and out of backups", () => {
  it("the desktop child environment drops it and the flag, whatever the shell exported", async () => {
    // @ts-expect-error plain .mjs without a declaration file
    const { managedComposioChildEnvironment } = await import("../electron/managed-composio.mjs");
    const env = managedComposioChildEnvironment("", {}, { COMPOSIO_API_KEY: OLD_KEY, MURAGE_CONNECTED_APPS_OWN_KEY_RETIRED: "1", PATH: "/bin" });
    expect(env.COMPOSIO_API_KEY).toBeUndefined();
    expect(env.MURAGE_CONNECTED_APPS_OWN_KEY_RETIRED).toBeUndefined();
    expect(env.PATH).toBe("/bin");
  });

  it("the backup's raw config copy omits it, and the source file is untouched", () => {
    const src = readFileSync(new URL("./installation-fidelity-snapshot.ts", import.meta.url), "utf8");
    expect(src).toContain('path==="config.json"');
    expect(src).toContain('parsed.composio.apiKey=""');
  });

  it("startup no longer blanks a saved value it does not recognise", () => {
    const main = readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");
    expect(main).not.toMatch(/else if \(typeof apiKey === "string" && apiKey\.trim\(\)\) \{\s*config\.composio\.apiKey = ""/);
  });
});
