// Which broker holds this workspace's connected apps.
//
// There are now three possible answers and they are not interchangeable: a
// pasted Composio key reaches the user's own project, the FluxRouter broker
// reaches their FluxRouter account's identity, and the Murage Worker reaches
// the `murage_<install id>` identity this device registered years-of-usage
// ago. Picking the wrong one does not fail loudly — it returns an empty,
// perfectly healthy-looking list of connections. `activeBroker` is the single
// place that choice is made, so it is the single place worth testing hard.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
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
import { DATA_DIR, type AppConfig } from "./config.ts";
import { DEV_FLUX_TOKEN_FILE, DEV_FLUX_TOKEN_LABEL, resetDevFluxTokenState } from "./flux-composio-dev-token.ts";

const LEGACY_TOKEN = "a".repeat(64);
const FLUX_TOKEN = "b".repeat(64);
const FLUX_KEY = "sk-flux-never-a-broker-credential";

let broker: Server;
let base = "";
const requests: Array<{ path: string; method: string; authorization: string | undefined; body?: unknown }> = [];
let mintAnswer: { status: number; body: unknown } = { status: 200, body: {} };
let mintDelayMs = 0;
let minted = 0;
const MINTED_TOKEN = () => "c".repeat(63) + String(minted % 10);
let health: { status: number; body: unknown } = { status: 200, body: { service: "flux-composio", ready: true, claims: true } };
let healthProbes = 0;
let healthDelayMs = 0;
let dataAnswer: { status: number; body: unknown } = { status: 200, body: { configured: true, services: {} } };

beforeAll(async () => {
  broker = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    requests.push({ path: url.pathname, method: req.method ?? "", authorization: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined });
    if (url.pathname.endsWith("/v1/tokens") && req.method === "POST") {
      if (mintDelayMs) await new Promise((resolve) => setTimeout(resolve, mintDelayMs));
      minted += 1;
      const body = mintAnswer.status === 200
        ? { token: MINTED_TOKEN(), expiresAt: new Date(Date.now() + 30 * 24 * 3600_000).toISOString(), accountKind: "personal", ...(mintAnswer.body as object) }
        : mintAnswer.body;
      res.writeHead(mintAnswer.status, { "content-type": "application/json" });
      return res.end(JSON.stringify(body));
    }
    if (url.pathname.endsWith("/v1/tokens/current") && req.method === "DELETE") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ revoked: true }));
    }
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
  mintAnswer = { status: 200, body: {} };
  mintDelayMs = 0;
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

// The dev harness (`pnpm dev:server`) has no desktop parent to mint its
// FluxRouter token, so it mints for itself from the Flux key in config.json.
// Same helper, same rules, same account for the same key: this is the
// "two identities" hazard's dev half.
describe("the dev harness mints its own FluxRouter token", () => {
  const CONFIG_PATH = join(DATA_DIR, "config.json");
  const TOKEN_PATH = join(DATA_DIR, DEV_FLUX_TOKEN_FILE);
  const ENV = ["MURAGE_FLUX_COMPOSIO_BROKER_URL", "MURAGE_FLUX_COMPOSIO_BROKER_TOKEN", "MURAGE_DESKTOP_PARENT", "FLUX_API_KEY"] as const;
  const saved: Partial<Record<(typeof ENV)[number], string | undefined>> = {};

  function storeFluxKey(key: string | null) {
    if (key === null) rmSync(CONFIG_PATH, { force: true });
    else writeFileSync(CONFIG_PATH, JSON.stringify({ flux: { apiKey: key } }));
  }
  const mints = () => requests.filter((request) => request.path === "/composio/v1/tokens" && request.method === "POST");
  const revocations = () => requests.filter((request) => request.path === "/composio/v1/tokens/current" && request.method === "DELETE");

  beforeEach(() => {
    for (const name of ENV) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    process.env.MURAGE_FLUX_COMPOSIO_BROKER_URL = `${base}/composio`;
    mkdirSync(DATA_DIR, { recursive: true });
    rmSync(TOKEN_PATH, { force: true });
    storeFluxKey(FLUX_KEY);
    minted = 0;
    resetManagedBrokerState();
  });

  afterEach(() => {
    for (const name of ENV) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    rmSync(TOKEN_PATH, { force: true });
    rmSync(CONFIG_PATH, { force: true });
    resetManagedBrokerState();
  });

  it("mints from the stored Flux key, keeps the token owner-only on disk, and uses it for data calls", async () => {
    await primeBrokerReadiness();
    expect(mints()).toHaveLength(1);
    expect(mints()[0].authorization).toBe(`Bearer ${FLUX_KEY}`);
    expect(mints()[0].body).toEqual({ label: DEV_FLUX_TOKEN_LABEL });
    expect(connectionBroker(cfg())).toBe("flux");
    expect(connectorPanelFields(cfg(), true)).toMatchObject({ broker: "flux", fluxBrokerEnabled: true, migration: { accountKind: "personal" } });

    await connectedServices(cfg());
    const call = requests.find((request) => request.path.endsWith("/v1/connectors/connected"));
    expect(call?.authorization).toBe(`Bearer ${MINTED_TOKEN()}`);
    expect(JSON.stringify(requests.filter((request) => !request.path.endsWith("/v1/tokens")))).not.toContain(FLUX_KEY);

    if (process.platform !== "win32") expect(statSync(TOKEN_PATH).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(TOKEN_PATH, "utf8"))).toMatchObject({ fluxComposioBrokerToken: MINTED_TOKEN(), fluxComposioAccountKind: "personal" });
    // The key is what the panel must never see; the token file does not carry it either.
    expect(readFileSync(TOKEN_PATH, "utf8")).not.toContain(FLUX_KEY);
  });

  it("re-uses the stored token after a restart instead of minting again", async () => {
    await primeBrokerReadiness();
    expect(mints()).toHaveLength(1);
    // A restart forgets memory, not the file.
    resetDevFluxTokenState();
    invalidateBrokerReadiness();
    await primeBrokerReadiness();
    expect(mints()).toHaveLength(1);
    expect(connectionBroker(cfg())).toBe("flux");
  });

  it("lets an env-pinned token win, and never mints inside the packaged app", async () => {
    process.env.MURAGE_FLUX_COMPOSIO_BROKER_TOKEN = FLUX_TOKEN;
    await primeBrokerReadiness();
    expect(mints()).toHaveLength(0);
    expect(connectionBroker(cfg())).toBe("flux");
    await connectedServices(cfg());
    expect(requests.find((request) => request.path.endsWith("/v1/connectors/connected"))?.authorization).toBe(`Bearer ${FLUX_TOKEN}`);

    delete process.env.MURAGE_FLUX_COMPOSIO_BROKER_TOKEN;
    resetManagedBrokerState();
    process.env.MURAGE_DESKTOP_PARENT = "1";
    await primeBrokerReadiness();
    expect(mints()).toHaveLength(0);
    expect(connectionBroker(cfg())).toBeNull();
    expect(existsSync(TOKEN_PATH)).toBe(false);

    // The same once the desktop shell has spoken, whatever the env says.
    delete process.env.MURAGE_DESKTOP_PARENT;
    resetManagedBrokerState();
    shell({ flux: "url-only", legacy: false });
    await primeBrokerReadiness();
    expect(mints()).toHaveLength(0);
  });

  it("has nothing to mint from without a stored key, and drops the token when the key goes", async () => {
    storeFluxKey(null);
    await primeBrokerReadiness();
    expect(mints()).toHaveLength(0);
    expect(connectionBroker(cfg())).toBeNull();
    expect(connectorPanelFields(cfg(), false)).toMatchObject({ broker: null, fluxBrokerEnabled: true, fluxConfigured: false });

    storeFluxKey(FLUX_KEY);
    await primeBrokerReadiness();
    expect(connectionBroker(cfg())).toBe("flux");
    const token = MINTED_TOKEN();

    storeFluxKey(null);
    await primeBrokerReadiness();
    expect(connectionBroker(cfg())).toBeNull();
    expect(revocations()).toHaveLength(1);
    expect(revocations()[0].authorization).toBe(`Bearer ${token}`);
    expect(existsSync(TOKEN_PATH)).toBe(false);
  });

  it("re-mints under a changed key and revokes the token the old key minted", async () => {
    await primeBrokerReadiness();
    const first = MINTED_TOKEN();
    storeFluxKey("sk-flux-another-account");
    await primeBrokerReadiness();
    expect(mints()).toHaveLength(2);
    expect(mints()[1].authorization).toBe("Bearer sk-flux-another-account");
    expect(revocations().map((request) => request.authorization)).toEqual([`Bearer ${first}`]);
    await connectedServices(cfg());
    expect(requests.find((request) => request.path.endsWith("/v1/connectors/connected"))?.authorization).toBe(`Bearer ${MINTED_TOKEN()}`);
  });

  it("shows the panel why FluxRouter declined, and does not re-present a declined key on every route", async () => {
    mintAnswer = { status: 402, body: { error: "no credit", code: "flux_key_budget_exhausted" } };
    await primeBrokerReadiness();
    await primeBrokerReadiness();
    await primeBrokerReadiness();
    expect(mints()).toHaveLength(1);
    expect(connectionBroker(cfg())).toBeNull();
    const fields = connectorPanelFields(cfg(), true);
    expect(fields.migration.tokenError).toBe("flux_key_budget_exhausted");
    expect(JSON.stringify(fields)).not.toContain(FLUX_KEY);
  });

  it("re-mints once FluxRouter says the token it holds was revoked", async () => {
    await primeBrokerReadiness();
    const first = MINTED_TOKEN();
    dataAnswer = { status: 401, body: { error: "gone", code: "broker_token_revoked" } };
    await connectedServices(cfg()).catch(() => undefined);
    expect(connectionBroker(cfg())).toBeNull();
    dataAnswer = { status: 200, body: { configured: true, services: {} } };
    await primeBrokerReadiness();
    expect(mints()).toHaveLength(2);
    expect(MINTED_TOKEN()).not.toBe(first);
    expect(connectionBroker(cfg())).toBe("flux");
    await connectedServices(cfg());
    expect(requests.filter((request) => request.path.endsWith("/v1/connectors/connected")).at(-1)?.authorization).toBe(`Bearer ${MINTED_TOKEN()}`);
  });

  it("never makes a turn wait on a mint another request already started", async () => {
    mintDelayMs = 150;
    const started = Date.now();
    const priming = primeBrokerReadiness();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await primeBrokerReadiness({ turn: true });
    expect(Date.now() - started).toBeLessThan(100);
    await priming;
    expect(mints()).toHaveLength(1);
    expect(connectionBroker(cfg())).toBe("flux");
  });
});
