import { createDesktopComposioProducers } from "./composio-desktop-producers.mjs";
import { createComposioLifecycle } from "./composio-lifecycle.mjs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createLifecycleScheduler, lifecycleDelay } from "./composio-lifecycle-policy.mjs";
import { ensureFluxComposioBrokerToken } from "./testing/composio-fixture.mjs";

beforeEach(() => { vi.useFakeTimers(); vi.spyOn(Math, "random").mockReturnValue(1); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("M3 desktop 429 delays double, jitter, cap and honor Retry-After", () => {
  const hour = 3600_000;
  expect([1, 2, 3, 4, 20].map(rateLimitFailures => lifecycleDelay({ rateLimited: true, rateLimitFailures }))).toEqual([hour, 2 * hour, 4 * hour, 4 * hour, 4 * hour]);
  vi.mocked(Math.random).mockReturnValue(0);
  expect(lifecycleDelay({ rateLimited: true, rateLimitFailures: 2 })).toBe(hour);
  expect(lifecycleDelay({ rateLimited: true, rateLimitFailures: 1, retryAfterMs: 6 * hour })).toBe(6 * hour);
});

it.each([429, 503])("M3 token HTTP %s carries Retry-After to scheduler; wake/flaps cannot bypass it", async status => {
  const powerMonitor = new EventEmitter();
  const net = { isOnline: () => true };
  const run = vi.fn();
  const scheduler = createLifecycleScheduler({ net, powerMonitor, run });
  scheduler.start();
  const notify = vi.fn(retryAfter => scheduler.afterPass({ rateLimited: status === 429, transient: status === 503, retryAfter }));
  await ensureFluxComposioBrokerToken({ fluxBrokerUrl: "https://flux.example.test/composio", fluxKey: "sk-flux-fixture-key", credentials: {},
    fetchImpl: async () => Response.json({}, { status, headers: { "retry-after": "7200" } }), onRateLimited: notify, onTransientFailure: notify });
  expect(notify).toHaveBeenCalledWith("7200");
  powerMonitor.emit("resume");
  await vi.advanceTimersByTimeAsync(7199_000);
  expect(run).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(run).toHaveBeenCalledTimes(1);
  scheduler.stop();
});

// Execute the shipped lifecycle pass with fake desktop/store boundaries. Importing main
// itself would launch Electron; this keeps its actual orchestration under the fake clock.
import { readFileSync } from "node:fs";
import { claimLegacyComposioInstall, prepareLegacyComposioClaim } from "./testing/composio-fixture.mjs";
import { readComposioLegacyClaim } from "./managed-composio.mjs";
import { fluxKeyFingerprint } from "./flux-composio-token.mjs";
import { check, readLists, select } from "../scripts/ci-test-tiers.mjs";

function desktopFixture({ state = "none", refuse, status = 429, retryAfter = "7200" } = {}) {
  const powerMonitor = new EventEmitter();
  let online = true;
  const hits = [];
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function runComposioLifecyclePass(");
  const end = source.indexOf("\n/** One pass at a time.", start);
  const scope = {
    preparedLegacyClaimIdentity: undefined,
    desktopShutdownStarted: false, secureCredentialState: true, desktopDataDir: undefined,
    secureCredentials: { fluxApiKey: "sk-flux-fixture", composioBrokerToken: "a".repeat(64), composioInstallationId: "fixture-install",
      fluxComposioBrokerToken: "b".repeat(64), fluxComposioBrokerTokenKeyFingerprint: fluxKeyFingerprint("sk-flux-fixture"),
      fluxComposioBrokerTokenExpiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
      composioLegacyClaim: { state, ...(state === "claimed" ? { confirmPending: true, jti: "fixture-claim" } : {}) } },
    fluxComposioBrokerUrlValue: () => "https://flux.example.test/composio", fluxComposioLifecycleEnabled: () => true,
    composioBrokerUrl: () => "https://legacy.example.test", mintLabel: () => "fixture-install", slog: () => {},
    ensureFluxComposioBrokerToken, readComposioLegacyClaim, claimLegacyComposioInstall, prepareLegacyComposioClaim,
    lifecycleRetryAfterMs: (value, now = Date.now()) => { const parsed = /^\d+$/.test(value ?? "") ? Number(value) * 1000 : Date.parse(value) - now; return Number.isFinite(parsed) ? Math.max(0, parsed) : 0; },
    publicComposioLegacyClaim: value => value.composioLegacyClaim,
    composioLifecycleOptions: () => ({ fetchImpl: async (url, init = {}) => {
      const path = new URL(url).pathname; hits.push({ path, at: Date.now(), method: init.method ?? "GET" });
      if (path === refuse) return Response.json({}, { status, headers: { "retry-after": retryAfter } });
      const body = path.endsWith("/health") ? { ready: true, claims: true } : path.endsWith("/v1/me") ? { accountKind: "shared", claimable: true }
        : path === "/v1/claims" ? { assertion: "fixture-assertion", jti: "fixture-claim" } : path.endsWith("/v1/claim") ? { claimed: true, jti: "fixture-claim" } : {};
      return Response.json(body);
    }}),
    updateSecureCredentialDocument: async update => { scope.secureCredentials = update(scope.secureCredentials); },
    applyComposioCredentialResult: (_current, _snapshot, next) => ({ applied: true, credentials: next }),
    MANAGED_COMPOSIO_UPDATE_OPTIONS: {}, revokeFluxComposioBrokerToken: vi.fn(), syncManagedComposioCredentials: () => {},
  };
  const authority = createComposioLifecycle({
    getConfiguration: () => ({ fluxBrokerUrl: scope.fluxComposioBrokerUrlValue(), legacyBrokerUrl: scope.composioBrokerUrl() }),
    getCredentials: () => scope.secureCredentials,
    saveCredentials: async next => { scope.secureCredentials = next; return true; },
    transport: scope.composioLifecycleOptions().fetchImpl,
    now: Date.now, monotonic: Date.now, random: () => 1,
    store: { load: () => [], save: () => {} }, isOnline: () => online,
  });
  scope.connectedAppsAuthority = () => authority;
  scope.composioProducers = createDesktopComposioProducers(scope.connectedAppsAuthority);
  const pass = new Function("scope", `with (scope) { return (${source.slice(start, end)}); }`)(scope);
  const scheduler = createLifecycleScheduler({ net: { isOnline: () => online }, powerMonitor, run: options => pass(options) });
  scope.composioScheduler = scheduler;
  const stop = scheduler.stop; scheduler.stop = () => { stop(); authority.dispose(); };
  scheduler.start();
  return { pass, scheduler, hits, powerMonitor, scope, flap: () => { online = !online; } };
}

it.each(["none", "offered"])("R2 desktop idle hour prepares %s once and makes no recurring health/account calls", async state => {
  const f = desktopFixture({ state });
  try {
    await f.pass({});
    expect(f.hits.map(hit => hit.path)).toEqual(["/composio/health", "/composio/v1/me"]);
    f.hits.length = 0;
    for (let tick = 0; tick < 720; tick++) {
      if (tick % 3 === 0) f.flap();
      if (tick % 11 === 0) f.powerMonitor.emit("resume");
      await vi.advanceTimersByTimeAsync(5000);
    }
    console.log(`desktop idle ${state}: ${f.hits.length} recurring upstream calls/hour`);
    expect(f.hits).toHaveLength(0);
    // A replacement credential is a new migration decision and prepares again.
    f.scope.secureCredentials.fluxComposioBrokerToken = "c".repeat(64);
    await f.pass({});
    expect(f.hits.map(hit => hit.path)).toEqual(["/composio/health", "/composio/v1/me"]);
  } finally { f.scheduler.stop(); }
});

it.each(["/composio/health", "/composio/v1/me", "/v1/claims", "/composio/v1/claim", "/v1/claims/confirm"].flatMap(refuse => [429, 503].map(status => ({ refuse, status }))))(
  "R2 desktop $refuse HTTP $status preserves Retry-After through wake/network events", async ({ refuse, status }) => {
    const state = refuse === "/v1/claims/confirm" ? "claimed" : refuse.includes("claim") ? "pending" : "none";
    const f = desktopFixture({ state, refuse, status });
    try {
      await f.pass({});
      const initial = f.hits.length;
      expect(f.hits.at(-1).path).toBe(refuse);
      for (let tick = 0; tick < 1439; tick++) {
        f.flap(); if (tick % 3 === 0) f.powerMonitor.emit("resume");
        await vi.advanceTimersByTimeAsync(5000);
      }
      expect(f.hits).toHaveLength(initial);
      // Reach the floor online and observe a real retry, rather than a permanently disabled caller.
      f.flap();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(f.hits.length).toBeGreaterThan(initial);
    } finally { f.scheduler.stop(); }
  });

it("R3 every Composio release regression is classified and selected by the blocking CI tier", () => {
  const files = ["server/composio-429-backoff.test.ts", "server/composio-429-workflow.test.ts", "electron/composio-429-review.test.mjs", "server/composio-429-final-review.test.ts"];
  const lists = readLists();
  const classified = check();
  const selections = ["linux", "mac", "windows"].map(os => select({ tier: "gate", os }).files);
  for (const file of files) {
    expect(lists.gate.has(file), file).toBe(true);
    expect(classified.problems.filter(problem => problem.includes(file))).toEqual([]);
    for (const selected of selections) expect(selected).toContain(file);
  }
});

it.each(["none", "offered"])("R2 desktop steady idle %s makes no periodic upstream calls in one hour", async state => {
  const f = desktopFixture({ state });
  try {
    await f.pass({});
    expect(f.hits.map(hit => hit.path)).toEqual(["/composio/health", "/composio/v1/me"]);
    f.hits.length = 0;
    await vi.advanceTimersByTimeAsync(3600_000);
    console.log(`desktop steady idle ${state}: ${f.hits.length} recurring upstream calls/hour`);
    expect(f.hits).toHaveLength(0);
  } finally { f.scheduler.stop(); }
});
