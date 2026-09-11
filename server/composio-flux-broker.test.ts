// Which broker holds this workspace's connected apps.
//
// There are now three possible answers and they are not interchangeable: a
// pasted Composio key reaches the user's own project, the FluxRouter broker
// reaches their FluxRouter account's identity, and the Murage Worker reaches
// the `murage_<install id>` identity this device registered years-of-usage
// ago. Picking the wrong one does not fail loudly — it returns an empty,
// perfectly healthy-looking list of connections. `activeBroker` is the single
// place that choice is made, so it is the single place worth testing hard.
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyManagedBrokerMessage,
  BROKER_UNAVAILABLE,
  connectedServices,
  connectionBroker,
  connectionMode,
  connectorMigration,
  connectorPanelFields,
  connectorSystemPrompt,
  invalidateBrokerReadiness,
  primeBrokerReadiness,
  resetManagedBrokerState,
  setBrokerEventSink,
} from "./composio.ts";
import type { AppConfig } from "./config.ts";

const LEGACY_TOKEN = "a".repeat(64);
const FLUX_TOKEN = "b".repeat(64);
const FLUX_KEY = "sk-flux-never-a-broker-credential";

let broker: Server;
let base = "";
const requests: Array<{ path: string; authorization: string | undefined }> = [];
let health: { status: number; body: unknown } = { status: 200, body: { service: "flux-composio", ready: true, claims: true } };
let healthProbes = 0;
let healthDelayMs = 0;
let dataAnswer: { status: number; body: unknown } = { status: 200, body: { configured: true, services: {} } };

beforeAll(async () => {
  broker = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    requests.push({ path: url.pathname, authorization: req.headers.authorization });
    if (url.pathname.endsWith("/health")) {
      healthProbes += 1;
      if (healthDelayMs) await new Promise((resolve) => setTimeout(resolve, healthDelayMs));
      res.writeHead(health.status, { "content-type": "application/json" });
      return res.end(JSON.stringify(health.body));
    }
    res.writeHead(dataAnswer.status, { "content-type": "application/json" });
    return res.end(JSON.stringify(dataAnswer.body));
  });
  await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
  const address = broker.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => broker.close(() => resolve()));
});

beforeEach(() => {
  requests.length = 0;
  healthProbes = 0;
  healthDelayMs = 0;
  health = { status: 200, body: { service: "flux-composio", ready: true, claims: true } };
  dataAnswer = { status: 200, body: { configured: true, services: {} } };
  resetManagedBrokerState();
  setBrokerEventSink(null);
});

afterEach(() => {
  resetManagedBrokerState();
  setBrokerEventSink(null);
  vi.useRealTimers();
});

const cfg = (over: Partial<AppConfig> = {}): AppConfig => ({ ...over }) as AppConfig;

/** The desktop shell's message, as main.mjs sends it. */
function shell(options: {
  legacy?: boolean;
  flux?: boolean | "url-only";
  claim?: { state: string; code?: string; installationId?: string; at?: string };
  legacyUntil?: string;
  accountKind?: "personal" | "shared" | null;
  tokenError?: string | null;
} = {}) {
  const fluxUrl = `${base}/composio`;
  applyManagedBrokerMessage({
    type: "murage:managed-composio",
    access: options.legacy === false ? null : { url: `${base}/legacy`, token: LEGACY_TOKEN },
    fluxBrokerUrl: options.flux === undefined ? "" : fluxUrl,
    fluxAccess: options.flux === true ? { url: fluxUrl, token: FLUX_TOKEN } : null,
    legacyUntil: options.legacyUntil ?? "",
    legacyClaim: options.claim ?? { state: "none" },
    accountKind: options.accountKind ?? null,
    tokenError: options.tokenError ?? null,
  });
}

async function readyFlux(options: Parameters<typeof shell>[0] = {}) {
  shell({ flux: true, ...options });
  await primeBrokerReadiness();
}

describe("which broker a data call uses", () => {
  it("lets a pasted Composio key beat every managed broker", async () => {
    await readyFlux();
    const own = cfg({ composio: { apiKey: "ak_live" } });
    expect(connectionBroker(own)).toBeNull();
    expect(connectionMode(own)).toBe("self-hosted");
  });

  it("prefers FluxRouter once this install has no live Worker identity", async () => {
    for (const state of ["claimed", "conflict", "abandoned"]) {
      await readyFlux({ claim: { state } });
      expect(connectionBroker(cfg())).toBe("flux");
    }
    // An install that never registered with the Worker at all.
    await readyFlux({ legacy: false });
    expect(connectionBroker(cfg())).toBe("flux");
  });

  it("keeps the Worker while it is still the identity holding the connections", async () => {
    // Until the claim has actually happened, `murage_<install id>` is where
    // the user's Gmail grant lives. Switching to FluxRouter early would show
    // them an empty list and invite them to reconnect everything.
    for (const state of ["none", "offered", "pending"]) {
      await readyFlux({ claim: { state } });
      expect(connectionBroker(cfg())).toBe("legacy");
    }
  });

  it("falls back to the Worker when FluxRouter is not reachable", async () => {
    health = { status: 503, body: { ready: false } };
    shell({ flux: true, claim: { state: "claimed" } });
    await primeBrokerReadiness();
    // Both brokers point at the same Composio user after a claim, so the
    // fallback orphans nothing; whether the Worker serves it is the Worker's
    // decision (its MIGRATION_GATE), not this process's.
    expect(connectionBroker(cfg())).toBe("legacy");
  });

  it("has no broker left once the Worker cut-off has passed", async () => {
    health = { status: 503, body: { ready: false } };
    shell({ flux: true, claim: { state: "claimed" }, legacyUntil: "2020-01-01T00:00:00Z" });
    await primeBrokerReadiness();
    expect(connectionBroker(cfg())).toBeNull();
    expect(connectionMode(cfg())).toBe("unavailable");
  });

  it("ignores a FluxRouter token that is not the same 64-hex shape as the Worker's", () => {
    const fluxUrl = `${base}/composio`;
    expect(() => applyManagedBrokerMessage({
      type: "murage:managed-composio",
      access: null,
      fluxBrokerUrl: fluxUrl,
      fluxAccess: { url: fluxUrl, token: "sk-flux-live-key" },
    })).toThrow();
    expect(connectionBroker(cfg())).toBeNull();
  });
});

describe("what a broker request carries", () => {
  it("sends the broker token to the FluxRouter path, and never the Flux API key", async () => {
    const previousKey = process.env.FLUX_API_KEY;
    process.env.FLUX_API_KEY = FLUX_KEY;
    try {
      await readyFlux({ claim: { state: "claimed" } });
      await connectedServices(cfg());
      const call = requests.find((request) => request.path.endsWith("/v1/connectors/connected"));
      expect(call?.path).toBe("/composio/v1/connectors/connected");
      expect(call?.authorization).toBe(`Bearer ${FLUX_TOKEN}`);
      expect(JSON.stringify(requests)).not.toContain(FLUX_KEY);
    } finally {
      if (previousKey === undefined) delete process.env.FLUX_API_KEY;
      else process.env.FLUX_API_KEY = previousKey;
    }
  });

  it("names both ways out when nothing can serve connected apps", async () => {
    shell({ legacy: false });
    await expect(connectedServices(cfg())).rejects.toThrow(BROKER_UNAVAILABLE);
    expect(BROKER_UNAVAILABLE).toContain("FluxRouter");
    expect(BROKER_UNAVAILABLE).toContain("Composio key");
  });

  it("tells the model the same thing it tells the user", () => {
    const prompt = connectorSystemPrompt("unconfigured");
    expect(prompt).toContain("connected apps run through FluxRouter");
    expect(prompt).not.toContain("no managed connection service");
  });

  it("keeps a FluxRouter 402 or 429 as itself, so the model and the panel see the real reason", async () => {
    // These are the two answers that carry a decision for the user: the free
    // allowance is spent, or the account is over a limit. Flattening them to
    // 502 would turn "add credit" into "something went wrong".
    await readyFlux({ claim: { state: "claimed" } });
    for (const [status, code] of [[402, "composio_upgrade_required"], [429, "daily_call_ceiling"]] as const) {
      dataAnswer = { status, body: { error: "no", code } };
      await expect(connectedServices(cfg())).rejects.toMatchObject({ status });
    }
    // A server fault is the one that becomes 502.
    dataAnswer = { status: 500, body: { error: "boom" } };
    await expect(connectedServices(cfg())).rejects.toMatchObject({ status: 502 });
  });

  it("stops trusting FluxRouter's readiness when it answers 404 or 503", async () => {
    await readyFlux({ claim: { state: "claimed" } });
    expect(connectionBroker(cfg())).toBe("flux");
    // 404 is how the broker answers while its dark flag is off.
    dataAnswer = { status: 404, body: { error: "not found" } };
    await connectedServices(cfg()).catch(() => undefined);
    expect(connectionBroker(cfg())).toBe("legacy");
  });

  it("asks the desktop for a new token when FluxRouter revokes the one it has", async () => {
    const events: Array<{ type: string }> = [];
    setBrokerEventSink((event) => events.push(event));
    await readyFlux({ claim: { state: "claimed" } });
    dataAnswer = { status: 401, body: { error: "gone", code: "broker_token_revoked" } };
    await connectedServices(cfg()).catch(() => undefined);
    expect(events).toEqual([{ type: "murage:flux-composio-token-rejected" }]);
    // And it stops using a broker it cannot authenticate against.
    expect(connectionBroker(cfg())).toBe("legacy");
  });

  it("recognises an install whose apps somebody else moved", async () => {
    // The Worker 410s an install it believes has migrated, and this device
    // has no record of claiming it. That is the stolen-install-token case, and
    // the panel needs to be able to say so with a support reference.
    shell({ flux: "url-only", claim: { state: "none", installationId: "install-1" } });
    dataAnswer = { status: 410, body: { error: "moved", code: "migrated_to_flux" } };
    await connectedServices(cfg()).catch(() => undefined);
    expect(connectorMigration(cfg())).toMatchObject({ state: "moved-elsewhere", installationId: "install-1" });
  });
});

describe("the FluxRouter readiness probe", () => {
  it("probes once and then trusts a healthy answer for five minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await readyFlux({ claim: { state: "claimed" } });
    expect(healthProbes).toBe(1);

    await primeBrokerReadiness();
    await primeBrokerReadiness();
    expect(healthProbes).toBe(1);

    vi.setSystemTime(Date.now() + 4 * 60_000);
    await primeBrokerReadiness();
    expect(healthProbes).toBe(1);

    vi.setSystemTime(Date.now() + 2 * 60_000);
    await primeBrokerReadiness();
    expect(healthProbes).toBe(2);
  });

  it("re-probes an unhealthy answer after twenty seconds, not five minutes", async () => {
    // A blip must not take connected apps away from every bot for five
    // minutes; the asymmetry is the whole point of the two TTLs.
    vi.useFakeTimers({ toFake: ["Date"] });
    health = { status: 503, body: { ready: false } };
    await readyFlux({ claim: { state: "claimed" } });
    expect(connectionBroker(cfg())).toBe("legacy");

    vi.setSystemTime(Date.now() + 10_000);
    await primeBrokerReadiness();
    expect(healthProbes).toBe(1);

    vi.setSystemTime(Date.now() + 15_000);
    health = { status: 200, body: { ready: true, claims: true } };
    await primeBrokerReadiness();
    expect(healthProbes).toBe(2);
    expect(connectionBroker(cfg())).toBe("flux");
  });

  it("treats a 200 that does not say ready as not ready", async () => {
    health = { status: 200, body: { service: "flux-composio", ready: false, claims: false } };
    await readyFlux({ claim: { state: "claimed" } });
    expect(connectionBroker(cfg())).toBe("legacy");
  });

  it("never makes a turn wait on a probe that is already running", async () => {
    healthDelayMs = 150;
    shell({ flux: true, claim: { state: "claimed" } });
    const inFlight = primeBrokerReadiness();
    const started = Date.now();
    await primeBrokerReadiness({ turn: true });
    expect(Date.now() - started).toBeLessThan(100);
    await inFlight;
    expect(healthProbes).toBe(1);
  });

  it("forgets its answer on demand", async () => {
    await readyFlux({ claim: { state: "claimed" } });
    expect(connectionBroker(cfg())).toBe("flux");
    invalidateBrokerReadiness();
    expect(connectionBroker(cfg())).toBe("legacy");
  });

  it("does not probe at all when this build has no FluxRouter broker", async () => {
    shell();
    await primeBrokerReadiness();
    expect(healthProbes).toBe(0);
    expect(connectionBroker(cfg())).toBe("legacy");
  });
});

describe("what the panel is told", () => {
  it("reports the legacy stage and its deadline while the Worker still holds the apps", () => {
    shell({ flux: "url-only", legacyUntil: "2026-12-15T00:00:00Z" });
    expect(connectorPanelFields(cfg(), false)).toMatchObject({
      broker: "legacy",
      fluxConfigured: false,
      fluxBrokerEnabled: true,
      freeRunsRemainingToday: null,
      migration: { state: "legacy", legacyUntil: "2026-12-15T00:00:00Z" },
    });
  });

  it("carries the account kind and the conflict code the copy depends on", () => {
    shell({
      flux: "url-only",
      accountKind: "shared",
      claim: { state: "conflict", code: "account_has_connections", installationId: "install-1" },
    });
    expect(connectorMigration(cfg())).toMatchObject({
      state: "claim-conflict",
      code: "account_has_connections",
      accountKind: "shared",
      installationId: "install-1",
    });
  });

  it("surfaces a token error without the token or the key", () => {
    shell({ flux: "url-only", tokenError: "flux_key_budget_exhausted" });
    const fields = connectorPanelFields(cfg(), true);
    expect(fields.migration.tokenError).toBe("flux_key_budget_exhausted");
    expect(JSON.stringify(fields)).not.toContain(FLUX_TOKEN);
    expect(JSON.stringify(fields)).not.toContain(LEGACY_TOKEN);
  });

  it("says nothing about a move for a workspace running its own key", () => {
    shell({ flux: "url-only", claim: { state: "offered" } });
    expect(connectorMigration(cfg({ composio: { apiKey: "ak_live" } }))).toMatchObject({ state: "none" });
  });
});
