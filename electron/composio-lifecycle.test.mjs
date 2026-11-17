// Owners: composio-429-e owns the lifecycle producers and these consumers.
import { afterEach, describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createDesktopComposioProducers } from "./composio-desktop-producers.mjs";
import { createComposioLifecycle } from "./composio-lifecycle.mjs";
import { createTokenRejectionHandler, createLifecycleScheduler } from "./composio-lifecycle-policy.mjs";
import { fluxKeyFingerprint, brokerTokenFingerprint } from "./flux-composio-token.mjs";
import { withComposioCredentialChange, readComposioLegacyClaim } from "./managed-composio.mjs";
import { createComposioAdmissionStore } from "./composio-admission-store.mjs";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const origin = "https://broker.example.test";
const legacy = "https://legacy.example.test";
const start = 1_800_000_000_000;
const initial = {
  fluxApiKey: "sk-flux-fixture-owner",
  fluxComposioBrokerToken: "a".repeat(64),
  fluxComposioBrokerTokenKeyFingerprint: fluxKeyFingerprint("sk-flux-fixture-owner"),
  fluxComposioBrokerTokenExpiresAt: new Date(start + 30 * 86400_000).toISOString(),
  composioBrokerToken: "b".repeat(64),
  composioInstallationId: "fixture-installation",
};
const live = [], dirs = [], captures = [];
afterEach(() => {
  if (process.env.COMPOSIO_ADMISSION_EVIDENCE_DIR) {
    for (const capture of captures) appendFileSync(join(process.env.COMPOSIO_ADMISSION_EVIDENCE_DIR, "route-counts.jsonl"), JSON.stringify({
      sourceSha: process.env.COMPOSIO_TEST_SOURCE_SHA, fixture: "admission-transport-fixture", test: expect.getState().currentTestName, hits: capture,
    }) + "\n");
  }
  captures.length = 0;
  for (const f of live.splice(0)) f.dispose(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function fixture(over = {}) {
  let now = start, online = true, credentials = { ...initial, ...over.credentials };
  let rows = [], refuse = over.refuse;
  const hits = []; captures.push(hits);
  const timers = new Map(); let timerId = 0;
  const transport = vi.fn(async (url, init = {}) => {
    const path = new URL(url).pathname;
    hits.push({ path, at: now, method: init.method ?? "GET" });
    if (path === refuse) return new Response("{}", { status: over.status ?? 429, headers: { "retry-after": over.retryAfter ?? "7200" } });
    if (over.transport) return over.transport(url, init);
    return Response.json(path === "/health" ? { ready: true, claims: true } : path === "/v1/me" ? { accountKind: "shared", claimable: true }
      : path === "/v1/claims" ? { assertion: "fixture-assertion", jti: "fixture-claim" }
      : path === "/v1/claim" ? { claimed: true, jti: "fixture-claim" }
      : path === "/v1/tokens" ? { token: "c".repeat(64), expiresAt: new Date(now + 30 * 86400_000).toISOString() } : {});
  });
  vi.stubGlobal("fetch", transport);
  const store = over.store ?? { load: () => rows, save: value => { rows = structuredClone(value); } };
  const authority = createComposioLifecycle({
    getConfiguration: () => ({ fluxBrokerUrl: origin, legacyBrokerUrl: legacy, prepareLegacy: over.prepareLegacy ?? false }),
    getCredentials: () => credentials, saveCredentials: async next => { credentials = next; return true; },
    transport, store, now: () => now, monotonic: () => now, random: () => 1, isOnline: () => online,
    setTimer: (callback, delay) => { const id = ++timerId; timers.set(id, { callback: () => { timers.delete(id); callback(); }, delay }); return id; },
    clearTimer: id => timers.delete(id),
    savePendingCredentialWrite: over.dependencies?.savePendingRevocations, ...over.dependencies,
  });
  live.push(authority);
  return { authority, hits, timers, transport, request: intent => authority.request(intent.operation === "broker" ? { ...intent,
      tokenFingerprint: brokerTokenFingerprint(String(String(intent.url).startsWith(legacy) ? credentials.composioBrokerToken : credentials.fluxComposioBrokerToken)),
    } : intent),
    now: () => now, setTime: value => { now = value; }, setOnline: value => { online = value; },
    setRefuse: value => { refuse = value; }, credentials: () => credentials,
    setCredentials: value => { credentials = value; }, rows: () => rows };
}
const reconnect = { operation: "reconnect" };
const holdOracle = async (f, trigger) => {
  const deadline = f.authority.inspect().retryAt;
  const count = f.hits.length;
  for (const elapsed of [15_001, 60_000, 3_600_000, 7_199_999]) {
    f.setTime(start + elapsed);
    const result = await trigger();
    expect(f.hits, `upstream calls at +${elapsed}`).toHaveLength(count);
    expect(result).toMatchObject({ outcome: "held", attempted: false, retryAt: deadline });
    expect(f.authority.inspect().retryAt).toBe(deadline);
  }
};

describe("shared lifecycle regressions", () => {
  it("rejected_token_15s_cannot_remint_during_7200s", async () => {
    const f = fixture({ refuse: "/v1/tokens" });
    const handler = createTokenRejectionHandler({ getCredentials: f.credentials, markTakenOver: async () => {},
      remint: () => f.request(reconnect), now: f.now });
    await handler.onRejected({});
    expect(f.hits).toHaveLength(1);
    for (const elapsed of [15_001, 60_000, 3_600_000, 7_199_999]) {
      f.setTime(start + elapsed);
      await handler.onRejected({});
      expect(f.hits, `upstream calls at +${elapsed}`).toHaveLength(1);
    }
  });
  it("ready_false_then_true_retries_and_finishes", async () => {
    let ready = false;
    const f = fixture({ prepareLegacy: true, transport: async url => Response.json(new URL(url).pathname === "/health" ? { ready, claims: true } : { accountKind: "shared", claimable: true }) });
    const result = await f.request({ operation: "prepare" });
    expect(result.preparation).toBe("deferred");
    expect(f.hits.map(x => x.path)).toEqual(["/health"]);
    ready = true; f.setTime(start + 15_000);
    const finished = await f.request({ operation: "refresh" });
    expect(finished.preparation).toBe("complete");
    expect(readComposioLegacyClaim(f.credentials()).state).toBe("offered");
    const count = f.hits.length;
    for (let hour = 1; hour <= 3; hour++) { f.setTime(start + hour * 3600_000); await f.request({ operation: "refresh" }); }
    expect(f.hits).toHaveLength(count);
  });
  it("manual_reconnect_held_is_not_success", async () => {
    const f = fixture({ refuse: "/v1/tokens" });
    const first = await f.request(reconnect);
    expect(first).toMatchObject({ outcome: "held", attempted: true, reconnected: false });
    await holdOracle(f, () => f.request(reconnect));
    expect(f.timers.size).toBe(1);
    f.setRefuse(null); f.setTime(start + 7200_000);
    const next = await Promise.all(Array.from({ length: 20 }, () => f.request(reconnect)));
    expect(next.every(x => x.reconnected)).toBe(true);
    expect(f.hits.filter(x => x.path === "/v1/tokens")).toHaveLength(2);
  });
  it.each(["/health", "/v1/me", "/v1/claims", "/v1/claim", "/v1/claims/confirm"])("each lifecycle leg %s honors a received hold", async path => {
    const f = fixture({ refuse: path, prepareLegacy: true });
    const operation = ["/health", "/v1/me"].includes(path) ? "prepare" : "claim";
    await f.request({ operation });
    expect(f.hits.filter(x => x.path === path)).toHaveLength(1);
    const count = f.hits.length;
    await holdOracle(f, () => f.request({ operation }));
    expect(f.hits).toHaveLength(count);
  });
  it("queued_force_and_claim_recheck_after_refusal", async () => {
    let settle;
    const f = fixture({ prepareLegacy: true, transport: () => new Promise(resolve => { settle = resolve; }) });
    const ordinary = f.request(reconnect);
    const forced = f.request(reconnect), claim = f.request({ operation: "claim" });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    settle(Response.json({}, { status: 429, headers: { "retry-after": "7200" } }));
    await ordinary;
    expect((await forced).outcome).toBe("held");
    expect(await claim).toMatchObject({ outcome: "held", attempted: false });
    expect(f.hits).toHaveLength(1);
  });
  it("key_change_cannot_clear_origin_hold", async () => {
    const f = fixture({ refuse: "/v1/tokens" });
    await f.request(reconnect);
    f.setCredentials({ ...f.credentials(), fluxApiKey: "sk-flux-fixture-replacement" });
    await holdOracle(f, () => f.request({ operation: "refresh" }));
    expect(f.credentials().fluxComposioBrokerToken).toBeUndefined();
    expect(f.rows().every(x => !JSON.stringify(x).includes("fixture"))).toBe(true);
  });
  it("held_cleanup_keeps_pending_token_and_never_reports_revoked", async () => {
    const f = fixture({ credentials: { fluxComposioBrokerToken: "9".repeat(64) }, refuse: "/v1/tokens/current" });
    const first = await f.request({ operation: "revoke", token: initial.fluxComposioBrokerToken });
    expect(first.revoked).toBe(false);
    await holdOracle(f, () => f.request({ operation: "revoke", token: initial.fluxComposioBrokerToken }));
    expect(f.timers.size).toBe(1);
  });
  it.each(["/v1/me", "/v1/installations"])("legacy_me_and_registration_are_admitted: %s", async path => {
    const f = fixture({ refuse: path, dependencies: { getConfiguration: () => ({ legacyBrokerUrl: legacy, registrationAllowed: true }) },
      credentials: path === "/v1/installations" ? { composioBrokerToken: undefined, composioInstallationId: undefined } : {} });
    await f.request({ operation: "register" });
    expect(f.hits.filter(x => x.path === path)).toHaveLength(1);
    await holdOracle(f, () => f.request({ operation: "register" }));
  });
  it("wake_offline_or_held_makes_zero_requests", async () => {
    vi.useFakeTimers();
    const f = fixture({ refuse: "/v1/tokens" });
    await f.request(reconnect);
    const powerMonitor = new EventEmitter();
    const scheduler = createLifecycleScheduler({ net: { isOnline: () => false }, powerMonitor, run: () => f.request(reconnect) });
    scheduler.start(); powerMonitor.emit("resume");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.hits).toHaveLength(1); scheduler.stop();
  });
});

describe("admission durability and arithmetic", () => {
  it("restart_retains_deadline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "admission-fixture-")); dirs.push(dir);
    const store = createComposioAdmissionStore(dir);
    const first = fixture({ refuse: "/v1/tokens", store });
    await first.request(reconnect); first.authority.dispose();
    const second = fixture({ store });
    const result = await second.request(reconnect);
    expect(result).toMatchObject({ outcome: "held", attempted: false, retryAt: start + 7200_000 });
    expect(second.hits).toHaveLength(0);
    const text = readFileSync(join(dir, "composio-admission.json"), "utf8");
    expect(text).not.toContain(initial.fluxComposioBrokerToken); expect(text).not.toContain(origin);
  });
  it("failed_hold_write_is_visible", async () => {
    const f = fixture({ refuse: "/v1/tokens", store: { load: () => [], save: () => { throw new Error("fixture write unavailable"); } } });
    expect(await f.request(reconnect)).toMatchObject({ outcome: "held", reason: "admission_storage_unavailable" });
    await holdOracle(f, () => f.request(reconnect));
  });
  it("corrupt_hold_applies_bounded_visible_fallback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "admission-fixture-")); dirs.push(dir);
    writeFileSync(join(dir, "composio-admission.json"), "broken");
    const f = fixture({ store: createComposioAdmissionStore(dir) });
    expect(await f.request(reconnect)).toMatchObject({ outcome: "held", reason: "admission_storage_invalid", attempted: false });
    expect(f.hits).toHaveLength(0);
  });
  it("mcp_503_allows_fresh_expired_inventory_but_inventory_429_blocks_it", async () => {
    const f = fixture({ refuse: "/v1/mcp", status: 503 });
    await f.request({ operation: "broker", url: `${origin}/v1/mcp`, init: { method: "POST", body: "{}" } });
    expect((await f.request({ operation: "broker", url: `${origin}/v1/connectors/connected` })).attempted).toBe(true);
    f.setRefuse("/v1/connectors/connected");
    await f.request({ operation: "broker", url: `${origin}/v1/connectors/connected` });
    const count = f.hits.length;
    expect(await f.request({ operation: "broker", url: `${origin}/v1/connectors/connected` })).toMatchObject({ outcome: "held", attempted: false });
    expect(f.hits).toHaveLength(count);
  });
  it("server_floor_uncapped_7200_and_http_date", async () => {
    for (const retryAfter of ["7200", new Date(start + 7200_000).toUTCString()]) {
      const f = fixture({ refuse: "/v1/me", retryAfter });
      await f.request({ operation: "broker", url: `${origin}/v1/me` });
      expect(f.authority.inspect().retryAt).toBe(start + 7200_000);
    }
  });
});

it("startup_restores_hold_before_first_request", async () => {
  let load;
  const rows = new Promise(resolve => { load = resolve; });
  const first = fixture({ refuse: "/v1/tokens" }); await first.request(reconnect);
  const f = fixture({ store: { load: () => rows, save: () => {} } });
  const request = f.request(reconnect);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(f.hits).toHaveLength(0);
  load(first.rows());
  expect(await request).toMatchObject({ outcome: "held", attempted: false });
  expect(f.hits).toHaveLength(0);
});
it.each([true, false])("old_success_new_refusal_both_orders: success first %s", async successFirst => {
  let success, refusal;
  const f = fixture({ transport: url => new Promise(resolve => { if (String(url).endsWith("/v1/me")) success = resolve; else refusal = resolve; }) });
  const a = f.request({ operation: "broker", url: `${origin}/v1/me` });
  const b = f.request({ operation: "broker", url: `${origin}/v1/mcp`, init: { method: "POST" } });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  if (successFirst) { success(Response.json({})); await a; }
  refusal(Response.json({}, { status: 429, headers: { "retry-after": "7200" } })); await b;
  if (!successFirst) { success(Response.json({})); await a; }
  expect(f.authority.inspect().retryAt).toBe(start + 7200_000);
  expect(await f.request({ operation: "broker", url: `${origin}/v1/me` })).toMatchObject({ outcome: "held", attempted: false });
  expect(f.hits).toHaveLength(2);
});
it("max_deadline_survives_shorter_failure_and_held_does_not_increment_streak", async () => {
  const responses = [];
  const f = fixture({ transport: () => new Promise(resolve => responses.push(resolve)) });
  const a = f.request({ operation: "broker", url: `${origin}/v1/me` });
  const b = f.request({ operation: "broker", url: `${origin}/v1/me` });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  responses[0](Response.json({}, { status: 429, headers: { "retry-after": "7200" } })); await a;
  f.setTime(start + 1000);
  responses[1](Response.json({}, { status: 503, headers: { "retry-after": "30" } })); await b;
  expect(f.authority.inspect().retryAt).toBe(start + 7200_000);
  const rows = f.rows();
  for (let n = 0; n < 20; n++) await f.request({ operation: "broker", url: `${origin}/v1/me` });
  expect(f.rows()).toEqual(rows); expect(f.hits).toHaveLength(2);
});
it("clock_jump_no_early_release_and_long_timer_no_overflow_loop", async () => {
  let wall = start, elapsed = 0;
  const f = fixture({ refuse: "/v1/tokens", retryAfter: "4000000", dependencies: { now: () => wall, monotonic: () => elapsed } });
  await f.request(reconnect);
  expect([...f.timers.values()][0].delay).toBeLessThan(2_147_483_647);
  wall += 5_000_000_000;
  expect(await f.request(reconnect)).toMatchObject({ outcome: "held", attempted: false });
  const timer = [...f.timers.values()][0]; timer.callback();
  expect(f.hits).toHaveLength(1); expect(f.timers.size).toBe(1);
  elapsed += 4_000_000_000;
  f.setRefuse(null);
  expect((await f.request(reconnect)).reconnected).toBe(true);
});
it("admission_rechecks_after_authorization_await", async () => {
  let release, block = false;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ refuse: "/v1/mcp", dependencies: { beforeTransport: async url => { if (block && String(url).endsWith("/v1/me")) await gate; } } });
  block = true;
  const waiting = f.request({ operation: "broker", url: `${origin}/v1/me` });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await f.request({ operation: "broker", url: `${origin}/v1/mcp`, init: { method: "POST" } });
  release();
  expect(await waiting).toMatchObject({ outcome: "held", attempted: false });
  expect(f.hits).toHaveLength(1);
});

it.each([
  ["prepare me", "prepare", "/health", "/v1/me"],
  ["claim redeem", "claim", "/v1/claims", "/v1/claim"],
  ["claim confirm", "claim", "/v1/claim", "/v1/claims/confirm"],
])("next_leg_readmits_after_response_parse: %s", async (_name, operation, pauseAt, nextLeg) => {
  let entered, release;
  const paused = new Promise(resolve => { entered = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  const f = fixture({ prepareLegacy: true, transport: async url => {
    const path = new URL(url).pathname;
    if (path === "/v1/catalog") return Response.json({}, { status: 429, headers: { "retry-after": "7200" } });
    const response = Response.json(path === "/health" ? { ready: true, claims: true } : path === "/v1/claims" ? { assertion: "fixture-assertion", jti: "fixture-claim" }
      : path === "/v1/claim" ? { claimed: true, jti: "fixture-claim" } : {});
    if (path === pauseAt) {
      const json = response.json.bind(response);
      response.json = async () => { entered(); await resume; return json(); };
    }
    return response;
  } });
  const request = f.request({ operation });
  await paused;
  await f.request({ operation: "broker", url: `${origin}/v1/catalog` });
  release();
  expect((await request).outcome).toBe("held");
  expect(f.hits.filter(hit => hit.path === nextLeg)).toHaveLength(0);
  expect(f.authority.inspect().retryAt).toBe(start + 7200_000);
});
it.each(["prepare", "claim"])("internal_revocation_remint_readmits_after_hold: %s", async operation => {
  let entered, release;
  const paused = new Promise(resolve => { entered = resolve; });
  const resume = new Promise(resolve => { release = resolve; });
  const f = fixture({ prepareLegacy: true, transport: async url => {
    const path = new URL(url).pathname;
    if (path === "/v1/catalog") return Response.json({}, { status: 429, headers: { "retry-after": "7200" } });
    if (path === "/health") return Response.json({ ready: true, claims: true });
    if (path === "/v1/claims") return Response.json({ assertion: "fixture-assertion", jti: "fixture-claim" });
    const response = Response.json({ code: "broker_token_revoked" }, { status: 401 });
    const json = response.json.bind(response);
    response.json = async () => { entered(); await resume; return json(); };
    return response;
  } });
  const request = f.request({ operation });
  await paused;
  await f.request({ operation: "broker", url: `${origin}/v1/catalog` });
  release(); await request;
  expect(f.hits.filter(hit => hit.path === "/v1/tokens")).toHaveLength(0);
  expect(f.credentials().fluxComposioBrokerToken).toBe(initial.fluxComposioBrokerToken);
});

it.each([
  ["desktop", 429, [3600_000, 7200_000, 14400_000, 14400_000]],
  ["desktop", 503, [15_000, 30_000, 60_000, 120_000, 300_000, 300_000]],
  ["dev", 503, [60_000, 120_000, 240_000, 480_000, 960_000, 1920_000, 3600_000, 3600_000]],
])("backoff_doubles_jitters_caps: %s %s", async (policy, status, expected) => {
  const f = fixture({ refuse: "/v1/tokens", status, retryAfter: "0", dependencies: { policy } });
  for (const delay of expected) {
    const before = f.now();
    await f.request(reconnect);
    expect(f.authority.inspect().retryAt - before).toBe(delay);
    f.setTime(before + delay);
  }
});
it("same_scope_old_success_cannot_clear_new_503_hold", async () => {
  const responses = [];
  const f = fixture({ transport: () => new Promise(resolve => responses.push(resolve)) });
  const a = f.request({ operation: "broker", url: `${origin}/v1/me` });
  const b = f.request({ operation: "broker", url: `${origin}/v1/me` });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  responses[1](Response.json({}, { status: 503, headers: { "retry-after": "7200" } })); await b;
  responses[0](Response.json({})); await a;
  expect(f.authority.inspect().retryAt).toBe(start + 7200_000);
  expect(await f.request({ operation: "broker", url: `${origin}/v1/me` })).toMatchObject({ outcome: "held", attempted: false });
});
it("same_scope_shorter_503_never_shortens", async () => {
  const responses = [];
  const f = fixture({ transport: () => new Promise(resolve => responses.push(resolve)) });
  const a = f.request({ operation: "broker", url: `${origin}/v1/me` });
  const b = f.request({ operation: "broker", url: `${origin}/v1/me` });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  responses[0](Response.json({}, { status: 503, headers: { "retry-after": "7200" } })); await a;
  responses[1](Response.json({}, { status: 503, headers: { "retry-after": "30" } })); await b;
  expect(f.authority.inspect().retryAt).toBe(start + 7200_000);
});
it("offline_request_never_dispatches_and_keeps_recovery_intent", async () => {
  const f = fixture(); f.setOnline(false);
  expect(await f.request(reconnect)).toMatchObject({ outcome: "deferred", attempted: false, reason: "offline" });
  expect(f.hits).toHaveLength(0); expect(f.timers.size).toBe(0);
  f.setOnline(true); await f.request({ operation: "refresh" });
  for (let i = 0; i < 30; i++) await Promise.resolve();
  expect(f.hits.filter(x => x.path === "/v1/tokens")).toHaveLength(1);
});

it("recovery_force_and_claim_survive_429_together", async () => {
  const f = fixture({ refuse: "/v1/tokens", prepareLegacy: true });
  await f.request(reconnect); await f.request({ operation: "claim" });
  expect(f.hits).toHaveLength(1); expect(f.timers.size).toBe(1);
  f.setRefuse(null); f.setTime(start + 7200_000);
  await f.request({ operation: "refresh" });
  expect(f.hits.filter(x => x.path === "/v1/tokens")).toHaveLength(2);
  expect(readComposioLegacyClaim(f.credentials()).state).toBe("claimed");
  expect(readComposioLegacyClaim(f.credentials()).confirmPending).toBeUndefined();
  expect(Object.keys(f.authority).sort()).toEqual(["dispose", "inspect", "request", "subscribe"]);
});

it("first_mint_orphan_is_retained_and_revoked_after_generation_rejects_it", async () => {
  let persisted = [];
  const f = fixture({ credentials: { fluxComposioBrokerToken: undefined }, dependencies: {
    saveCredentials: async () => false,
    savePendingRevocations: async entries => { persisted = structuredClone(entries); },
  } });
  const result = await f.request(reconnect);
  expect(result).toMatchObject({ outcome: "deferred", reconnected: false, reason: "credentials_changed" });
  expect(f.hits.map(x => x.path)).toEqual(["/v1/tokens", "/v1/tokens/current"]);
  expect(persisted).toEqual([]);
});

it("credential_owner_changes_keep_origin_429_but_separate_data_503", async () => {
  for (const status of [429, 503]) {
    const f = fixture({ refuse: "/v1/me", status });
    await f.request({ operation: "broker", url: `${origin}/v1/me` });
    f.setCredentials({ ...f.credentials(), fluxApiKey: "sk-flux-fixture-next-owner" });
    f.setRefuse(null);
    const result = await f.request({ operation: "broker", url: `${origin}/v1/me` });
    expect(result.attempted).toBe(status !== 429);
    expect(f.hits).toHaveLength(status === 429 ? 1 : 2);
  }
});

it("concurrent_cleanup_intents_share_each_token_attempt", async () => {
  const issued = new Map();
  const f = fixture({ credentials: { fluxComposioBrokerToken: "9".repeat(64) }, transport: async (_url, init) => {
    const token = new Headers(init.headers).get("authorization");
    issued.set(token, (issued.get(token) ?? 0) + 1);
    await Promise.resolve(); return new Response(null, { status: 200 });
  } });
  const a = "a".repeat(64), b = "b".repeat(64);
  await Promise.all([f.request({ operation: "revoke", token: a }), f.request({ operation: "revoke", token: b })]);
  expect(issued.get(`Bearer ${a}`)).toBe(1);
  expect(issued.get(`Bearer ${b}`)).toBe(1);
  expect(f.hits).toHaveLength(2);
});

it("restored_cleanup_and_explicit_revoke_share_one_owned_task", async () => {
  let persisted = [{ fluxBrokerUrl: origin, token: initial.fluxComposioBrokerToken }];
  const f = fixture({ credentials: { fluxComposioBrokerToken: "9".repeat(64) }, dependencies: {
    getPendingRevocations: () => persisted,
    savePendingRevocations: async entries => { persisted = structuredClone(entries); },
  } });
  expect((await f.request({ operation: "revoke", token: initial.fluxComposioBrokerToken })).revoked).toBe(true);
  expect(f.hits).toHaveLength(1); expect(persisted).toEqual([]);
});

it("claimed_fallback_shares_data_hold_and_inventory_keeps_its_scope", async () => {
  const f = fixture({ refuse: "/v1/mcp", status: 503, dependencies: {
    getConfiguration: () => ({ fluxBrokerUrl: origin, legacyBrokerUrl: legacy, legacyClaimed: true, prepareLegacy: false }),
  } });
  await f.request({ operation: "broker", url: `${origin}/v1/mcp`, init: { method: "POST" } });
  expect(await f.request({ operation: "broker", url: `${legacy}/v1/me` })).toMatchObject({ outcome: "held", attempted: false });
  expect((await f.request({ operation: "broker", url: `${legacy}/v1/connectors/connected` })).attempted).toBe(true);
  expect(f.hits).toHaveLength(2);
});

it("failed_preparation_write_never_marks_identity_prepared", async () => {
  let credentials = { ...initial }, fail = true;
  const f = fixture({ prepareLegacy: true, dependencies: {
    getCredentials: () => credentials,
    saveCredentials: async next => { if (fail) throw new Error("fixture storage unavailable"); credentials = next; return true; },
  } });
  expect((await f.request({ operation: "prepare" })).outcome).toBe("deferred");
  fail = false;
  await f.request({ operation: "refresh" });
  expect(f.hits.map(x => x.path)).toEqual(["/health", "/v1/me", "/health", "/v1/me"]);
  expect(readComposioLegacyClaim(credentials).state).toBe("offered");
});

it("generation_discarded_preparation_is_recomputed_before_marking_identity_prepared", async () => {
  let credentials = { ...initial }, discard = true;
  const f = fixture({ prepareLegacy: true, dependencies: {
    getCredentials: () => credentials,
    saveCredentials: async next => { if (discard) return false; credentials = next; return true; },
  } });
  expect(await f.request({ operation: "prepare" })).toMatchObject({ outcome: "deferred", reason: "credentials_changed" });
  expect(readComposioLegacyClaim(credentials).state).toBe("none");
  discard = false;
  await f.request({ operation: "refresh" });
  expect(f.hits.map(hit => hit.path)).toEqual(["/health", "/v1/me", "/health", "/v1/me"]);
  expect(readComposioLegacyClaim(credentials).state).toBe("offered");
  await f.request({ operation: "refresh" });
  expect(f.hits).toHaveLength(4);
});

it("cleanup_receipt_is_for_its_token_while_another_revoke_is_held", async () => {
  const a = "a".repeat(64), b = "b".repeat(64);
  let persisted = [];
  const f = fixture({ credentials: { fluxComposioBrokerToken: "9".repeat(64) }, transport: async (_url, init) => {
    await Promise.resolve();
    return new Response(null, { status: new Headers(init.headers).get("authorization") === `Bearer ${b}` ? 503 : 200 });
  }, dependencies: { getPendingRevocations: () => persisted, savePendingRevocations: async entries => { persisted = structuredClone(entries); } } });
  const [first, second] = await Promise.all([f.request({ operation: "revoke", token: a }), f.request({ operation: "revoke", token: b })]);
  expect(first).toMatchObject({ revoked: true, outcome: "completed" }); expect(second).toMatchObject({ revoked: false, outcome: "held" });
  expect(persisted.map(entry => entry.token)).toEqual([b]); expect(f.hits).toHaveLength(2);
});

it("synchronous_dispatch_guard_refuses_before_transport_and_backoff_accounting", async () => {
  const f = fixture({ dependencies: { onDispatch: () => { throw new Error("fixture memory owner revoked"); } } });
  await expect(f.request({ operation: "broker", url: `${origin}/v1/me` })).rejects.toThrow("fixture memory owner revoked");
  expect(f.hits).toHaveLength(0); expect(f.rows()).toEqual([]);
});

it("broker_pending_requests_are_bounded_without_dispatching_the_excess", async () => {
  const release = [];
  const f = fixture({ transport: () => new Promise(resolve => release.push(resolve)) });
  const requests = Array.from({ length: 225 }, () => f.request({ operation: "broker", url: `${origin}/v1/me` }));
  expect((await Promise.all(requests.slice(200))).every(result => result.outcome === "deferred" && !result.attempted)).toBe(true);
  for (let i = 0; i < 40; i++) await Promise.resolve();
  expect(f.hits).toHaveLength(200); // MAIN RULING 1115-COMPOSIO-A9
  for (const resolve of release) resolve(Response.json({}));
  await Promise.all(requests);
});
it("expired_inactive_hold_records_cannot_permanently_fill_the_authority", async () => {
  const rows = Array.from({ length: 256 }, (_, n) => ({ scope: n.toString(16).padStart(64, "0"), notBefore: start - 1,
    failureStreak: 1, status: 503, generation: 1 }));
  const f = fixture({ store: { load: () => rows, save: () => {} } });
  expect(await f.request({ operation: "broker", url: `${origin}/v1/me` })).toMatchObject({ outcome: "completed", attempted: true });
  expect(f.hits).toHaveLength(1);
});

it("inflight_refusals_reserve_hold_capacity_without_evicting_active_deadlines", async () => {
  let persisted = Array.from({ length: 253 }, (_, n) => ({ scope: n.toString(16).padStart(64, "0"), notBefore: start + 7200_000,
    failureStreak: 1, status: 503, generation: 1 }));
  const release = [];
  const f = fixture({ store: { load: () => persisted, save: rows => { persisted = structuredClone(rows); } },
    transport: () => new Promise(resolve => release.push(resolve)) });
  const first = f.request({ operation: "broker", url: `${origin}/v1/me` });
  for (let i = 0; i < 40; i++) await Promise.resolve();
  f.setCredentials({ ...f.credentials(), fluxApiKey: "sk-flux-fixture-second-owner" });
  const second = f.request({ operation: "broker", url: `${origin}/v1/me` });
  for (let i = 0; i < 40; i++) await Promise.resolve();
  f.setCredentials({ ...f.credentials(), fluxApiKey: "sk-flux-fixture-third-owner" });
  expect(await f.request({ operation: "broker", url: `${origin}/v1/me` })).toMatchObject({ outcome: "deferred", attempted: false });
  expect(f.hits).toHaveLength(2);
  for (const resolve of release) resolve(Response.json({}, { status: 429, headers: { "retry-after": "7200" } }));
  await Promise.all([first, second]);
  expect(persisted).toHaveLength(256);
  expect(persisted.every(row => row.notBefore === start + 7200_000)).toBe(true);
});

it("queued_old_token_proof_cannot_dispatch_after_credential_replacement", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ dependencies: { beforeTransport: async () => gate } });
  const request = f.request({ operation: "broker", url: `${origin}/v1/me` });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  f.setCredentials({ ...f.credentials(), fluxComposioBrokerToken: "c".repeat(64) });
  release();
  expect(await request).toMatchObject({ outcome: "deferred", reason: "credentials_changed", attempted: false });
  expect(f.hits).toHaveLength(0);
});

it("automatic_recovery_arms_takeover_detection_only_after_the_token_is_saved", async () => {
  let handler;
  const takenOver = vi.fn(async () => {});
  const f = fixture({ refuse: "/v1/tokens", dependencies: {
    onAutomaticReplacement: event => handler.noteReplacement(event.tokenFingerprint, event.at),
  } });
  handler = createTokenRejectionHandler({ getCredentials: f.credentials, markTakenOver: takenOver, now: f.now,
    remint: fingerprint => f.request({ operation: "reconnect", rejectedTokenFingerprint: fingerprint }) });
  await handler.onRejected({ tokenFingerprint: brokerTokenFingerprint(initial.fluxComposioBrokerToken) });
  expect(takenOver).not.toHaveBeenCalled();
  f.setRefuse(null); f.setTime(start + 7200_000); await f.request({ operation: "refresh" });
  f.setTime(start + 7201_000);
  expect(await handler.onRejected({ tokenFingerprint: brokerTokenFingerprint(f.credentials().fluxComposioBrokerToken) })).toBe("taken-over");
  expect(takenOver).toHaveBeenCalledTimes(1);
  expect(f.hits.filter(hit => hit.path === "/v1/tokens")).toHaveLength(2);
});


describe("desktop producer admission matrix", () => {
  it.each([
    ["D01 startup", "startup"], ["D02 credential mutation", "credentialChange"],
    ["D03 consent", "claim"], ["D04 manual reconnect", "reconnect"],
    ["D05 child rejection", "rejected"], ["D06 ordinary tick", "scheduled"],
    ["D06 forced tick", "scheduledForce"], ["D07 online", "online"], ["D08 resume", "resume"],
  ])("%s producer re-admits before dispatch", async (_id, method) => {
    const f = fixture({ refuse: "/v1/tokens", prepareLegacy: method === "claim", credentials: { fluxComposioBrokerTokenExpiresAt: new Date(start - 1).toISOString() } });
    const producers = createDesktopComposioProducers(() => f.authority);
    await f.request({ operation: "reconnect" });
    expect(f.hits).toHaveLength(1);
    const trigger = () => producers[method](method === "rejected" ? brokerTokenFingerprint(initial.fluxComposioBrokerToken) : { force: true });
    await holdOracle(f, trigger);
    f.setRefuse(null); f.setTime(start + 7200_000);
    await Promise.all([trigger(), trigger(), trigger()]);
    expect(f.hits.filter(hit => hit.path === (method === "claim" ? "/v1/claims" : "/v1/tokens"))).toHaveLength(method === "claim" ? 1 : 2);
  });
});

it.each(["remove", "replace"])("D02/D13 %s hides the old token and holds its cleanup", async change => {
  const f = fixture({ refuse: "/v1/me" });
  await f.request({ operation: "broker", url: `${origin}/v1/me` });
  f.setCredentials({ ...f.credentials(), fluxApiKey: change === "remove" ? "" : "sk-flux-fixture-replacement" });
  const held = await f.request({ operation: "refresh" });
  expect(f.hits).toHaveLength(1);
  expect(held.outcome).toBe("held");
  expect(f.credentials().fluxComposioBrokerToken).toBeUndefined();
  f.setRefuse(null); f.setTime(start + 7200_000);
  await f.request({ operation: "refresh" });
  expect(f.hits.filter(hit => hit.path === "/v1/tokens/current")).toHaveLength(1);
});

it.each([true, false])("D13 saved=%s retains the owned cleanup after a concurrent hold", async saved => {
  let entered, release;
  const paused = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ dependencies: { saveCredentials: async next => { if (saved) f.setCredentials(next); return saved; } }, transport: async url => {
    const path = new URL(url).pathname;
    if (path === "/v1/catalog") return Response.json({}, { status: 429, headers: { "retry-after": "7200" } });
    if (path === "/v1/tokens") {
      const response = Response.json({ token: "c".repeat(64), expiresAt: new Date(start + 30 * 86400_000).toISOString() });
      const json = response.json.bind(response);
      response.json = async () => { entered(); await gate; return json(); };
      return response;
    }
    return Response.json({});
  } });
  const replacement = f.request({ operation: "reconnect" });
  await paused;
  await f.request({ operation: "broker", url: `${origin}/v1/catalog` });
  release(); await replacement;
  expect(f.hits.filter(hit => hit.path === "/v1/tokens/current")).toHaveLength(0);
  f.setTime(start + 7200_000);
  const result = await f.request({ operation: "revoke", token: saved ? initial.fluxComposioBrokerToken : "c".repeat(64) });
  expect(result.revoked).toBe(true);
  expect(f.hits.filter(hit => hit.path === "/v1/tokens/current")).toHaveLength(1);
});

it.each(["force", "claim"])("D09 queued %s rechecks the refusal after the running pass", async queued => {
  let release;
  let mint = 0;
  const f = fixture({ prepareLegacy: true, credentials: { fluxComposioBrokerTokenExpiresAt: new Date(start - 1).toISOString() }, transport: async url => {
    if (String(url).endsWith("/v1/tokens") && ++mint === 1) return new Promise(resolve => { release = resolve; });
    return Response.json(String(url).endsWith("/v1/claims") ? { assertion: "fixture-assertion", jti: "fixture-claim" } : {});
  } });
  const running = f.request({ operation: "refresh" });
  for (let i = 0; i < 30; i++) await Promise.resolve();
  const waiting = f.request(queued === "force" ? { operation: "reconnect", force: true } : { operation: "claim" });
  for (let i = 0; i < 30; i++) await Promise.resolve();
  release(Response.json({}, { status: 429, headers: { "retry-after": "7200" } }));
  await running;
  expect((await waiting).outcome).toBe("held");
  expect(f.hits).toHaveLength(1);
});

it.each(["personal", "already migrated"])("D10 %s auto-claim re-admits after the account reply", async mode => {
  let entered, release;
  const paused = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ prepareLegacy: true, transport: async url => {
    const path = new URL(url).pathname;
    if (path === "/v1/catalog") return Response.json({}, { status: 429, headers: { "retry-after": "7200" } });
    if (path === "/health") return Response.json({ ready: true, claims: true });
    const response = Response.json({ accountKind: mode === "personal" ? "personal" : "shared", claimable: true,
      ...(mode === "already migrated" ? { legacyInstallationId: initial.composioInstallationId } : {}) });
    const json = response.json.bind(response);
    response.json = async () => { entered(); await gate; return json(); };
    return response;
  } });
  const preparation = f.request({ operation: "prepare" });
  await paused;
  await f.request({ operation: "broker", url: `${origin}/v1/catalog` });
  release();
  expect((await preparation).outcome).toBe("held");
  expect(f.hits.filter(hit => hit.path === "/v1/claims")).toHaveLength(0);
});

it("D06 automatic forced recovery waits for the maximum durable deadline", async () => {
  vi.useFakeTimers(); vi.setSystemTime(start);
  const f = fixture({ refuse: "/v1/tokens", dependencies: {
    now: Date.now, monotonic: Date.now, setTimer: setTimeout, clearTimer: clearTimeout,
  } });
  await f.request({ operation: "reconnect", force: true });
  for (const elapsed of [15_001, 60_000, 3600_000, 7199_999]) {
    f.setTime(start + elapsed);
    await vi.advanceTimersByTimeAsync(start + elapsed - Date.now());
    expect(f.hits.filter(hit => hit.path === "/v1/tokens")).toHaveLength(1);
  }
  f.setRefuse(null); f.setTime(start + 7200_000);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.hits.filter(hit => hit.path === "/v1/tokens")).toHaveLength(2);
  expect(f.credentials().fluxComposioBrokerToken).toBe("c".repeat(64));
});

it.each([429, 503])("D07 network flaps preserve the HTTP %s authority floor", async status => {
  vi.useFakeTimers(); vi.setSystemTime(start);
  const f = fixture({ refuse: "/v1/tokens", status, credentials: { fluxComposioBrokerTokenExpiresAt: new Date(start - 1).toISOString() } });
  await f.request({ operation: "reconnect" });
  const producers = createDesktopComposioProducers(() => f.authority);
  const network = { online: true, isOnline: () => network.online }, powerMonitor = new EventEmitter();
  const run = vi.fn(() => producers.online({}));
  const scheduler = createLifecycleScheduler({ net: network, powerMonitor, run, now: f.now, dispatchers: { online: run } });
  try {
    scheduler.start();
    for (let tick = 0; tick < 120; tick++) {
      network.online = tick % 2 === 1;
      f.setTime(start + (tick + 1) * 5000);
      await vi.advanceTimersByTimeAsync(5000);
    }
    expect(run.mock.calls.length).toBeGreaterThan(0);
    expect(f.hits).toHaveLength(1);
    expect(f.authority.inspect()).toMatchObject({ outcome: "held", retryAt: start + 7200_000 });
  } finally { scheduler.stop(); }
});

it("D02 first key save cannot create a new origin allowance", async () => {
  const f = fixture({ refuse: "/health", credentials: { fluxApiKey: "", fluxComposioBrokerToken: undefined } });
  await f.request({ operation: "broker", url: `${origin}/health` });
  f.setCredentials({ ...f.credentials(), fluxApiKey: "sk-flux-fixture-first-key" });
  const producers = createDesktopComposioProducers(() => f.authority);
  expect(await producers.credentialChange()).toMatchObject({ outcome: "held", attempted: false });
  expect(f.hits).toHaveLength(1);
  f.setRefuse(null); f.setTime(start + 7200_000);
  await producers.credentialChange();
  expect(f.hits.filter(hit => hit.path === "/v1/tokens")).toHaveLength(1);
});

it("D08 online wake still asks the authority during a hold", async () => {
  vi.useFakeTimers(); vi.setSystemTime(start);
  const f = fixture({ refuse: "/v1/tokens", credentials: { fluxComposioBrokerTokenExpiresAt: new Date(start - 1).toISOString() } });
  await f.request({ operation: "reconnect" });
  const producers = createDesktopComposioProducers(() => f.authority), powerMonitor = new EventEmitter();
  const resume = vi.fn(options => producers.resume(options));
  const scheduler = createLifecycleScheduler({ net: { isOnline: () => true }, powerMonitor, run: () => {}, dispatchers: { resume }, now: f.now });
  try {
    scheduler.start(); powerMonitor.emit("resume");
    f.setTime(start + 3000); await vi.advanceTimersByTimeAsync(3000);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(f.hits).toHaveLength(1);
    expect(f.authority.inspect().outcome).toBe("held");
  } finally { scheduler.stop(); }
});

it("concurrent_distinct_intents_share_inflight_cleanup", async () => {
  const releases = [];
  const f = fixture({ credentials: { fluxComposioBrokerToken: "9".repeat(64) }, transport: (url, init) => init?.method === "DELETE" ? new Promise(resolve => releases.push(resolve)) : Response.json({}) });
  const revoke = f.request({ operation: "revoke", token: initial.fluxComposioBrokerToken });
  for (let i = 0; i < 30; i++) await Promise.resolve();
  expect(releases).toHaveLength(1);
  const refresh = f.request({ operation: "refresh" });
  for (let i = 0; i < 40; i++) await Promise.resolve();
  const attempts = f.hits.length;
  for (const resolve of releases) resolve(Response.json({}));
  const [result] = await Promise.all([revoke, refresh]);
  expect(attempts).toBe(1);
  expect(result.revoked).toBe(true);
});


it.each(["not-ready", "invalid-account", "account-refused"])("H1 repeated %s escalates until preparation actually recovers", async kind => {
  let recovered = false;
  const f = fixture({ prepareLegacy: true, transport: async url => {
    const health = new URL(url).pathname === "/health";
    return Response.json(health ? { ready: recovered || kind !== "not-ready", claims: true }
      : { accountKind: recovered || kind !== "invalid-account" ? "shared" : "unknown", claimable: true },
      { status: !health && !recovered && kind === "account-refused" ? 503 : 200 });
  } });
  for (const delay of [15_000, 30_000, 60_000, 120_000, 300_000, 300_000]) {
    const at = f.now();
    expect((await f.request({ operation: "prepare" })).preparation).toBe("deferred");
    expect(f.authority.inspect().retryAt - at).toBe(delay);
    const count = f.hits.length;
    f.setTime(at + delay - 1);
    expect(await f.request({ operation: "refresh" })).toMatchObject({ outcome: "held", attempted: false });
    expect(f.hits).toHaveLength(count);
    f.setTime(at + delay);
  }
  recovered = true;
  expect(await f.request({ operation: "refresh" })).toMatchObject({ outcome: "completed", preparation: "complete" });
  recovered = false;
  expect((await f.request({ operation: "prepare" })).preparation).toBe("deferred");
  expect(f.authority.inspect().retryAt - f.now()).toBe(15_000);
});

it.each(["throw-before", "throw-after", "discard"])("H2 minted custody survives %s save and storage recovery without another mint", async mode => {
  let credentials = { ...initial }, fail = true, persisted = [];
  const deletes = [], saves = [];
  const f = fixture({ dependencies: {
    getCredentials: () => credentials,
    saveCredentials: async (next, snapshot) => {
      saves.push({ next, snapshot });
      if (fail) {
        if (mode === "throw-after") credentials = next;
        throw new Error("fixture storage unavailable");
      }
      if (mode === "discard" || mode === "throw-after") return false;
      credentials = next; return true;
    },
    getPendingRevocations: () => persisted,
    savePendingRevocations: async entries => { persisted = structuredClone(entries); },
  }, transport: async (url, init) => {
    if (init.method === "DELETE") { deletes.push(new Headers(init.headers).get("authorization")); return Response.json({}); }
    return Response.json({ token: "c".repeat(64), expiresAt: new Date(start + 30 * 86400_000).toISOString() });
  } });
  const first = await f.request(reconnect);
  expect(persisted.some(entry => entry.token === "c".repeat(64))).toBe(true);
  expect(first).toMatchObject({ outcome: "deferred", reconnected: false, reason: "credential_storage_unavailable" });
  expect(deletes).toEqual([]);
  expect(f.timers.size).toBe(1);
  const retryAt = first.retryAt;
  expect(retryAt).toBeGreaterThan(f.now());
  f.setTime(retryAt - 1);
  await f.request({ operation: "refresh" });
  expect(saves).toHaveLength(1);
  expect(f.hits.filter(x => x.path === "/v1/tokens")).toHaveLength(1);
  fail = false; f.setTime(retryAt);
  [...f.timers.values()][0].callback();
  for (let n = 0; n < 100; n++) await Promise.resolve();
  expect(saves).toHaveLength(2);
  expect(f.hits.filter(x => x.path === "/v1/tokens")).toHaveLength(1);
  expect(deletes).toEqual([`Bearer ${mode === "discard" ? "c".repeat(64) : initial.fluxComposioBrokerToken}`]);
  expect(credentials.fluxComposioBrokerToken).toBe(mode === "discard" ? initial.fluxComposioBrokerToken : "c".repeat(64));
  expect(persisted).toEqual([]);
  expect(f.timers.size).toBe(0);
});


it("bounded cleanup loads unchanged custody once and drains at most sixteen tokens per pass", async () => {
  let persisted = Array.from({ length: 256 }, (_, n) => ({ fluxBrokerUrl: origin, token: n.toString(16).padStart(64, "0") }));
  let version = 0;
  const load = vi.fn(() => persisted), sizes = [];
  const f = fixture({ dependencies: {
    pendingRevocationsVersion: () => version,
    getPendingRevocations: load,
    savePendingRevocations: async entries => { sizes.push(entries.length); persisted = structuredClone(entries); version++; },
  } });
  expect(await f.request(reconnect)).toMatchObject({ outcome: "deferred", reason: "revocation_backlog_capacity", reconnected: false });
  expect(f.hits.filter(x => x.path === "/v1/tokens")).toHaveLength(0);
  expect(f.hits.filter(x => x.method === "DELETE")).toHaveLength(16);
  expect(persisted).toHaveLength(240);
  expect(load).toHaveBeenCalledTimes(1);
  for (let n = 0; n < 3; n++) await f.request({ operation: "refresh" });
  expect(load).toHaveBeenCalledTimes(1);
  expect(sizes.every(size => size <= 256)).toBe(true);
});

it("bounded cleanup backpressures repeated replacements without dropping owned tokens", async () => {
  let persisted = [], sequence = 0;
  const f = fixture({ dependencies: {
    getPendingRevocations: () => persisted,
    savePendingRevocations: async entries => { persisted = structuredClone(entries); },
  }, transport: async (url, init) => {
    if (init.method === "DELETE") return Response.json({}, { status: 503 });
    if (new URL(url).pathname === "/v1/tokens") return Response.json({ token: (++sequence).toString(16).padStart(64, "0"), expiresAt: new Date(start + 30 * 86400_000).toISOString() });
    return Response.json({});
  } });
  for (let n = 0; n < 270; n++) {
    await f.request(reconnect);
    expect(persisted.length).toBeLessThanOrEqual(256);
    f.setTime(f.authority.inspect().retryAt ?? f.now() + 15_000);
  }
  expect(sequence).toBe(255);
  expect(persisted).toHaveLength(255);
  expect(new Set([...persisted.map(entry => entry.token), f.credentials().fluxComposioBrokerToken]).size).toBe(sequence + 1);
});

it("oversized inherited cleanup refuses new issuance and preserves the protected document", async () => {
  const persisted = Array.from({ length: 257 }, (_, n) => ({ fluxBrokerUrl: origin, token: n.toString(16).padStart(64, "0") }));
  const load = vi.fn(() => persisted), save = vi.fn();
  const f = fixture({ dependencies: { pendingRevocationsVersion: () => persisted, getPendingRevocations: load, savePendingRevocations: save } });
  for (let n = 0; n < 5; n++) expect(await f.request(reconnect)).toMatchObject({ outcome: "deferred", reason: "revocation_backlog_capacity", attempted: false });
  expect(load).toHaveBeenCalledTimes(1); expect(save).not.toHaveBeenCalled(); expect(f.hits).toHaveLength(0);
  expect(persisted).toHaveLength(257);
});

it("key replacement retains the old document when protected cleanup has no capacity", () => {
  const current = { ...initial, composioPendingRevocations: JSON.stringify(Array.from({ length: 256 }, (_, n) => ({ fluxBrokerUrl: origin, token: n.toString(16).padStart(64, "0") }))) };
  const before = structuredClone(current);
  expect(() => withComposioCredentialChange(current, { ...current, fluxApiKey: "sk-flux-fixture-next-owner" }, origin)).toThrow("Connected apps cleanup is full.");
  expect(current).toEqual(before);
});

it.each([false, true])("H2 restored ambiguous save preserves the active token (committed=%s)", async committed => {
  let credentials = { ...initial }, persisted = [];
  const f = fixture({ dependencies: {
    getCredentials: () => credentials,
    getPendingRevocations: () => persisted,
    savePendingRevocations: async entries => { persisted = structuredClone(entries); },
    saveCredentials: async next => { if (committed) credentials = next; throw new Error("fixture storage unavailable"); },
  } });
  await f.request(reconnect);
  expect(persisted).toHaveLength(1);
  f.authority.dispose();
  const deletes = [];
  const restarted = fixture({ dependencies: {
    getCredentials: () => credentials,
    getPendingRevocations: () => persisted,
    savePendingRevocations: async entries => { persisted = structuredClone(entries); },
    saveCredentials: async () => true,
  }, transport: async (_url, init) => { deletes.push(new Headers(init.headers).get("authorization")); return Response.json({}); } });
  await restarted.request({ operation: "refresh" });
  restarted.setTime(start + 15_000);
  [...restarted.timers.values()][0].callback();
  for (let n = 0; n < 100; n++) await Promise.resolve();
  expect(deletes).toEqual([`Bearer ${committed ? initial.fluxComposioBrokerToken : "c".repeat(64)}`]);
  expect(credentials.fluxComposioBrokerToken).toBe(committed ? "c".repeat(64) : initial.fluxComposioBrokerToken);
  expect(persisted).toEqual([]);
});


it("H1 successful cleanup cannot reset a still-failing preparation leg", async () => {
  const f = fixture({ prepareLegacy: true, transport: async url => Response.json(new URL(url).pathname === "/health" ? { ready: false } : {}) });
  await f.request({ operation: "prepare" });
  f.setTime(start + 15_000);
  expect(await f.request({ operation: "revoke", token: "d".repeat(64) })).toMatchObject({ outcome: "completed", revoked: true });
  await f.request({ operation: "prepare" });
  expect(f.authority.inspect().retryAt).toBe(start + 45_000);
});

it("H2 repeated storage failures back off while retaining one minted capability", async () => {
  let credentials = { ...initial }, persisted = [], fail = true, attempts = 0;
  const f = fixture({ dependencies: {
    getCredentials: () => credentials,
    saveCredentials: async next => { attempts++; if (fail) throw new Error("fixture storage unavailable"); credentials = next; return true; },
    getPendingRevocations: () => persisted,
    savePendingRevocations: async entries => { persisted = structuredClone(entries); },
  } });
  await f.request(reconnect);
  for (const delay of [15_000, 30_000, 60_000]) { // MAIN RULING 1115-COMPOSIO-H2
    expect(f.authority.inspect().retryAt - f.now()).toBe(delay);
    expect(f.hits.filter(x => x.path === "/v1/tokens")).toHaveLength(1);
    expect(persisted.map(entry => entry.token)).toEqual(["c".repeat(64)]);
    const at = f.now(), count = attempts;
    f.setTime(at + delay - 1); await f.request({ operation: "refresh" });
    expect(attempts).toBe(count);
    f.setTime(at + delay); [...f.timers.values()][0].callback();
    for (let n = 0; n < 100; n++) await Promise.resolve();
    expect(attempts).toBe(count + 1);
  }
  expect(f.authority.inspect()).toMatchObject({ outcome: "failed", reason: "credential_recovery_failed" }); // MAIN RULING 1115-COMPOSIO-H2
  expect(f.authority.inspect()).not.toHaveProperty("retryAt"); // MAIN RULING 1115-COMPOSIO-H2
  expect(f.timers.size).toBe(0); // MAIN RULING 1115-COMPOSIO-H2
  const stoppedAttempts = attempts, stoppedHits = [...f.hits];
  f.setTime(f.now() + 300_001);
  expect(await f.request({ operation: "refresh" })).toMatchObject({ outcome: "failed", reason: "credential_recovery_failed" }); // MAIN RULING 1115-COMPOSIO-H2
  expect(attempts).toBe(stoppedAttempts); // MAIN RULING 1115-COMPOSIO-H2
  expect(f.hits).toEqual(stoppedHits); // MAIN RULING 1115-COMPOSIO-H2
  expect(f.timers.size).toBe(0); // MAIN RULING 1115-COMPOSIO-H2
  fail = false;
  await f.request({ operation: "refresh", retryRecovery: true }); // MAIN RULING 1115-COMPOSIO-H2
  expect(credentials.fluxComposioBrokerToken).toBe("c".repeat(64));
  expect(persisted).toEqual([]);
  expect(f.hits.filter(x => x.path === "/v1/tokens")).toHaveLength(1);
});

it("H2 failed custody persistence retries storage before saving or minting again", async () => {
  let fail = true, persisted = [];
  const save = vi.fn(async next => { f.setCredentials(next); return true; });
  const f = fixture({ dependencies: {
    saveCredentials: save,
    getPendingRevocations: () => persisted,
    savePendingRevocations: async entries => { if (fail) throw new Error("fixture storage unavailable"); persisted = structuredClone(entries); },
  } });
  expect(await f.request(reconnect)).toMatchObject({ outcome: "deferred", reason: "credential_storage_unavailable" });
  expect(save).not.toHaveBeenCalled(); expect(f.hits).toHaveLength(1);
  fail = false; f.setTime(f.authority.inspect().retryAt);
  [...f.timers.values()][0].callback();
  for (let n = 0; n < 100; n++) await Promise.resolve();
  expect(save).toHaveBeenCalledTimes(1);
  expect(f.hits.map(x => x.path)).toEqual(["/v1/tokens", "/v1/tokens/current"]);
  expect(f.credentials().fluxComposioBrokerToken).toBe("c".repeat(64));
  expect(persisted).toEqual([]);
});


it.each(["write", "load"])("validated lifecycle recovery also recovers admission storage after a failed %s", async mode => {
  let broken = true;
  const f = fixture({ refuse: mode === "write" ? "/v1/tokens" : undefined, store: {
    load: () => { if (mode === "load" && broken) throw new Error("fixture storage unavailable"); return []; },
    save: () => { if (broken) throw new Error("fixture storage unavailable"); },
  } });
  expect((await f.request(reconnect)).outcome).toBe("held");
  const deadline = f.authority.inspect().retryAt;
  broken = false; f.setRefuse(undefined); f.setTime(deadline - 1);
  expect(await f.request(reconnect)).toMatchObject({ outcome: "held", attempted: false });
  f.setTime(deadline);
  expect(await f.request({ operation: "refresh" })).toMatchObject({ outcome: "completed", reconnected: true });
  expect(f.authority.inspect()).toMatchObject({ outcome: "completed", reason: "ready" });
});


it.each([false, true])("H2 a later credential generation retains both ambiguous cleanup legs (restart=%s)", async restart => {
  let credentials = { ...initial }, persisted = [], fail = true;
  const deletes = [];
  const dependencies = {
    getCredentials: () => credentials,
    getPendingRevocations: () => persisted,
    savePendingRevocations: async entries => { persisted = structuredClone(entries); },
    saveCredentials: async next => { if (fail) { credentials = next; throw new Error("fixture storage unavailable"); } return false; },
  };
  let f = fixture({ dependencies, transport: async (url, init) => {
    if (init.method === "DELETE") { deletes.push(new Headers(init.headers).get("authorization")); return Response.json({}); }
    return Response.json({ token: "c".repeat(64), expiresAt: new Date(start + 30 * 86400_000).toISOString() });
  } });
  await f.request(reconnect);
  expect(persisted.map(entry => entry.token)).toEqual(["c".repeat(64)]);
  credentials = { ...credentials, fluxComposioBrokerToken: "d".repeat(64) };
  fail = false;
  if (restart) {
    f.authority.dispose();
    f = fixture({ dependencies, transport: async (_url, init) => { deletes.push(new Headers(init.headers).get("authorization")); return Response.json({}); } });
    await f.request({ operation: "revoke", token: "c".repeat(64) });
  } else {
    f.setTime(f.authority.inspect().retryAt);
    await f.request({ operation: "refresh" });
  }
  for (let pass = 0; pass < 3 && persisted.length; pass++) {
    f.setTime(f.now() + 15_000);
    [...f.timers.values()][0].callback();
    for (let n = 0; n < 100; n++) await Promise.resolve();
  }
  expect(deletes).toEqual([`Bearer ${"c".repeat(64)}`, `Bearer ${initial.fluxComposioBrokerToken}`]);
  expect(credentials.fluxComposioBrokerToken).toBe("d".repeat(64));
  expect(persisted).toEqual([]);
  expect(f.hits.filter(x => x.path === "/v1/tokens")).toHaveLength(restart ? 0 : 1);
});


it("H2 restart reconciles compound custody before another forced mint", async () => {
  let credentials = { ...initial, fluxComposioBrokerToken: "c".repeat(64) };
  let persisted = [{ fluxBrokerUrl: origin, token: "c".repeat(64), previous: initial.fluxComposioBrokerToken, replacement: true }];
  const deletes = [];
  const f = fixture({ dependencies: {
    getCredentials: () => credentials,
    getPendingRevocations: () => persisted,
    savePendingRevocations: async entries => { persisted = structuredClone(entries); },
    saveCredentials: async next => { credentials = next; return true; },
  }, transport: async (url, init) => {
    if (init.method === "DELETE") { deletes.push(new Headers(init.headers).get("authorization")); return Response.json({}); }
    return Response.json({ token: "d".repeat(64), expiresAt: new Date(start + 30 * 86400_000).toISOString() });
  } });
  expect(await f.request(reconnect)).toMatchObject({ outcome: "deferred", reason: "credential_custody_pending", reconnected: false });
  expect(f.hits).toHaveLength(0);
  expect(persisted.map(entry => entry.token)).toEqual([initial.fluxComposioBrokerToken]);
  f.setTime(start + 15_000); [...f.timers.values()][0].callback();
  for (let n = 0; n < 100; n++) await Promise.resolve();
  expect(f.hits.filter(x => x.path === "/v1/tokens")).toHaveLength(1);
  expect(deletes).toEqual([`Bearer ${initial.fluxComposioBrokerToken}`, `Bearer ${"c".repeat(64)}`]);
  expect(credentials.fluxComposioBrokerToken).toBe("d".repeat(64));
  expect(persisted).toEqual([]);
});

import { createSecureCredentialState } from "./secure-credential-state.mjs";
import { applyComposioCredentialResult, applyComposioCustodyDelta, readComposioCustody } from "./managed-composio.mjs";
it("T4 desktop hung credential write keeps its writer fence after the 30-second owner failure", async () => {
  vi.useFakeTimers(); vi.setSystemTime(start);
  const dir = mkdtempSync(join(tmpdir(), "desktop-custody-")); dirs.push(dir);
  const file = join(dir, "protected-fixture.json"); writeFileSync(file, JSON.stringify(initial));
  let release, hung = false;
  const state = createSecureCredentialState(initial, async document => {
    if (document.fluxComposioBrokerToken === "c".repeat(64) && !hung) {
      hung = true; await new Promise(resolve => { release = resolve; });
    }
    writeFileSync(file, JSON.stringify(document));
  });
  const events = [], deletes = [];
  const saveCustody = async (entries, delta) => {
    const document = await state.update(current => ({ ...current, composioPendingRevocations: JSON.stringify(applyComposioCustodyDelta(current.composioPendingRevocations, entries, delta)) }));
    return readComposioCustody(document.composioPendingRevocations);
  };
  const f = fixture({ dependencies: {
    requireDurableCustody: true, now: Date.now, monotonic: Date.now, setTimer: setTimeout, clearTimer: clearTimeout,
    getCredentials: state.read, readDurableCredentials: async () => JSON.parse(readFileSync(file, "utf8")),
    pendingRevocationsVersion: () => state.read().composioPendingRevocations,
    getPendingRevocations: () => readComposioCustody(state.read().composioPendingRevocations),
    savePendingRevocations: saveCustody, savePendingCredentialWrite: saveCustody,
    saveCredentials: async (next, snapshot) => { let applied; await state.update(current => { const result = applyComposioCredentialResult(current, snapshot, next); applied = result.applied; return result.credentials; }); return applied; },
  }, transport: async (_url, init) => { if (init.method === "DELETE") deletes.push(new Headers(init.headers).get("authorization")); return Response.json({ token: "c".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z" }); } });
  f.authority.subscribe(value => events.push(value));
  let outcome; const pending = f.request(reconnect).then(value => { outcome = value; });
  for (let n = 0; n < 160; n++) await Promise.resolve(); expect(hung).toBe(true);
  await vi.advanceTimersByTimeAsync(29_999); expect(outcome).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1); await pending;
  expect(outcome).toMatchObject({ outcome: "failed", reason: "credential_recovery_failed", attempted: false, reconnected: false });
  expect(await f.request({ ...reconnect, retryRecovery: true })).toMatchObject({ outcome: "failed", attempted: false });
  expect(f.hits).toHaveLength(1); expect(deletes).toEqual([]);
  const count = events.length; f.authority.dispose(); release();
  for (let n = 0; n < 160; n++) await Promise.resolve();
  expect(events).toHaveLength(count); expect(deletes).toEqual([]);
  const disk = JSON.parse(readFileSync(file, "utf8"));
  expect(disk.fluxComposioBrokerToken).toBe("c".repeat(64));
  expect(readComposioCustody(disk.composioPendingRevocations).map(entry => entry.token)).toEqual(["c".repeat(64)]);
});

it("T2 desktop credential writer preserves W1 and unrelated additions without resurrecting settled custody", async () => {
  const minted = "c".repeat(64), added = "e".repeat(64), settled = "f".repeat(64);
  const state = createSecureCredentialState({ ...initial, composioPendingRevocations: JSON.stringify([{ fluxBrokerUrl: origin, token: settled }]) }, async () => {});
  const snapshot = state.read(), replacement = { fluxBrokerUrl: origin, token: minted, previous: initial.fluxComposioBrokerToken, replacement: true };
  await state.update(current => ({ ...current, composioPendingRevocations: JSON.stringify([replacement]) }));
  await state.update(current => ({ ...current, composioPendingRevocations: JSON.stringify([...readComposioCustody(current.composioPendingRevocations), { fluxBrokerUrl: origin, token: added }]) }));
  await state.update(current => applyComposioCredentialResult(current, snapshot, { ...snapshot, fluxComposioBrokerToken: minted }).credentials);
  expect(state.read().fluxComposioBrokerToken).toBe(minted);
  expect(readComposioCustody(state.read().composioPendingRevocations).map(entry => entry.token)).toEqual([minted, added]);
  expect(() => applyComposioCustodyDelta(state.read().composioPendingRevocations, [], [{ previous: undefined, entry: { fluxBrokerUrl: origin, token: added } }])).not.toThrow();
  expect(() => applyComposioCustodyDelta(state.read().composioPendingRevocations, [], [{ previous: replacement }])).not.toThrow();
  expect(() => applyComposioCustodyDelta(state.read().composioPendingRevocations, [], [{ previous: { ...replacement, attempts: 1 } }])).toThrow("credential_custody_changed");
});
