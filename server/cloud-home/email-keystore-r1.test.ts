// SPDX-License-Identifier: AGPL-3.0-or-later
// Keystore fix round 1 (Astra findings H1, H2, M3 to M9 on e4e7d24b2; CLOUD-EMAIL-KEYSTORE-1019 r2 to r5). One block per finding.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { EmailSecretStore, sanitizeEmailSecrets } from "../email/email-secrets.ts";
import { SealedSecretStore } from "./secrets.ts";
import { docKeyIds, emailBootFields, readRecord, writeOwner, type EmailDoc } from "./email-keystore.ts";
import { createCloudEmailSaver } from "./email-keystore-server.ts";
import { createSupervisorPort } from "./supervisor-port.ts";
import { runOwnerSignIn, type DeviceCodePoll, type FluxDeviceCodeClient, type RevokeResult } from "./email-owner-signin.ts";
import { createFluxDeviceCodeClient, DEVICE_CAPABILITIES_PATH, DEVICE_CODE_PATH, DEVICE_TOKEN_PATH } from "./flux-device-code-client.ts";

const KEY = Buffer.alloc(32, 7), MACHINE = "fixture-machine";
const A = { token: "owner-A-CANARY", keyId: "key_A" };
const B = { token: "owner-B-CANARY", keyId: "key_B" };
const START = { deviceCode: "dc-1", userCode: "ABCD-1234", verificationUrl: "https://flux.example/device", intervalMs: 5000, expiresInMs: 600_000 };
const WIPE = { type: "murage:cloud-recovery-wipe", requestId: "11111111-1111-4111-8111-111111111111" };
const ACTOR = { environmentId: "e1", deviceId: "d1" };
const D0: EmailDoc = sanitizeEmailSecrets({ bots: { b1: { token: "bot-1", keyId: "key_b1" } } }) as EmailDoc;
const D1: EmailDoc = sanitizeEmailSecrets({ bots: { b1: { token: "bot-1", keyId: "key_b1" }, b2: { token: "bot-2", keyId: "key_b2" } } }) as EmailDoc;
const wipeFixture = () => ({ modelSignIn: { invalidateOwner: () => {}, dispatch: async () => {} } as unknown as NonNullable<Parameters<typeof createSupervisorPort>[0]["modelSignIn"]>, wipeEngineSignIns: async () => {} });
const until = async (check: () => boolean, label: string) => { for (let i = 0; i < 400; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error(`timed out: ${label}`); };
const save = (rev: number, doc: unknown, gen = 0) => ({ type: "murage:email-secrets-save", rev, epoch: 5, gen, doc });

/** A sealed store whose directory sync can fail AFTER the rename (the commit is then uncertain), and whose reread can fail once. */
function home() {
  const state = { failSync: false, failRead: false };
  const dir = join(mkdtempSync(join(tmpdir(), "keystore-r1-")), "secrets");
  const real = new SealedSecretStore(dir, MACHINE, KEY, { syncDir: () => { if (state.failSync) throw Object.assign(new Error("EIO"), { code: "EIO" }); return "synced"; } });
  const store = { getAll: () => real.getAll(), patch: real.patch.bind(real), patchDurable: (r: Record<string, string>) => real.patchDurable(r), readBack: () => { if (state.failRead) { state.failRead = false; throw new Error("EIO read"); } return real.readBack(); } };
  const seed = (owner?: typeof A) => { expect(emailBootFields(real, true).emailStore).toBe(1); if (owner) writeOwner(real, owner, 0); };
  return { real, store, state, seed, done: () => { real.close(); removeTempDirSync(join(dir, "..")); } };
}
function fakeFlux(over: Partial<{ poll: () => Promise<DeviceCodePoll>; revoke: (t: string) => Promise<RevokeResult> }> = {}) {
  const log: string[] = [];
  const client: FluxDeviceCodeClient = {
    start: vi.fn(async () => START),
    poll: over.poll ?? (async () => ({ state: "ok", owner: B, scoped: true })),
    revoke: vi.fn(async (token: string) => { log.push(`revoke:${token}`); return over.revoke ? over.revoke(token) : "revoked"; }),
  };
  return { client, log };
}
function gate() {
  const waits: Array<() => void> = [];
  return { sleep: () => new Promise<void>(resolve => { waits.push(resolve); }), release: () => { waits.splice(0).forEach(r => r()); } };
}
function boot(h: ReturnType<typeof home>, flux: ReturnType<typeof fakeFlux>, g: ReturnType<typeof gate>) {
  const send = vi.fn();
  const port = createSupervisorPort({ store: h.store, send, emailStore: true, emailSleep: async () => {}, emailBackoffSleep: g.sleep, emailDeviceCode: flux.client, ...wipeFixture() });
  const sent = (type: string) => send.mock.calls.map(c => c[0] as Record<string, unknown>).filter(m => m.type === type);
  const result = (state: string) => sent("murage:email-owner-signin-result").some(m => m.state === state);
  return { port, send, sent, result, start: (id = "r1") => port.handle({ type: "murage:email-owner-signin-start", requestId: id, actor: ACTOR, gen: 0 }) };
}

describe("H1 the saver resends until acknowledged, and a rotation waits for that", () => {
  it("a refused save is resent under a newer rev with the same doc; wait() resolves true only on a durable ack, false on a permanent refusal", async () => {
    const post = vi.fn();
    const saver = createCloudEmailSaver(0, () => 7, { post, retryStepsMs: [5] });
    const first = saver.message(D1 as never);
    const waiting = saver.wait(5_000);
    saver.ack({ type: "murage:email-secrets-refused", rev: first.rev, epoch: 7, reason: "not_durable" });
    await until(() => post.mock.calls.length >= 1, "resend");
    const again = post.mock.calls[0]![0] as { rev: number; doc: unknown };
    expect(again.rev).toBeGreaterThan(first.rev);
    expect(again.doc).toEqual(first.doc);
    saver.ack({ type: "murage:email-secrets-saved", rev: again.rev, epoch: 7, gen: 0, keyIds: ["key_b1", "key_b2"] });
    expect(await waiting).toBe(true);
    const next = saver.message(D0 as never);
    const refused = saver.wait(5_000);
    saver.ack({ type: "murage:email-secrets-refused", rev: next.rev, epoch: 7, reason: "owner_field" });
    expect(await refused).toBe(false);
  });
  it("the secret store's durable() is false when the supervisor has not acknowledged (and when the wait throws)", async () => {
    expect(await new EmailSecretStore(() => {}, async () => false).durable()).toBe(false);
    expect(await new EmailSecretStore(() => {}, async () => { throw new Error("x"); }).durable()).toBe(false);
    expect(await new EmailSecretStore(() => {}, async () => true).durable()).toBe(true);
  });
});

describe("H2 a failed recovery wipe never lets the last durably stored owner be revoked", () => {
  it("B is written, its reread fails (reconcile); the wipe renames but its dir sync fails: B is NOT revoked until a durable reread shows it gone", async () => {
    const h = home(), flux = fakeFlux(), g = gate(); h.seed(A);
    try {
      const t = boot(h, flux, g);
      h.state.failRead = true;
      await t.start(); await until(() => t.result("saving"), "saving");
      h.state.failSync = true;
      await t.port.handle(WIPE);
      expect(t.sent("murage:cloud-recovery-result")).toEqual([expect.objectContaining({ ok: false })]);
      g.release(); await new Promise(r => setTimeout(r, 60));
      g.release(); await new Promise(r => setTimeout(r, 60));
      expect(flux.log).not.toContain(`revoke:${B.token}`);
      h.state.failSync = false; g.release();
      await until(() => flux.log.includes(`revoke:${B.token}`), "B revoked after the durable reread");
    } finally { h.done(); }
  });
});

describe("M3 the production sanitizer keeps prev and retired, so would_drop_acked is real", () => {
  const withSlots = { ...D1, prev: { b1: { token: "p", keyId: "key_prev" } }, retired: [{ token: "r", keyId: "key_ret" }] };
  it("sanitizeEmailSecrets keeps valid prev and retired and drops invalid ones", () => {
    const out = sanitizeEmailSecrets({ ...withSlots, prev: { b1: { token: "p", keyId: "key_prev" }, bad: { token: "has space", keyId: "k" } }, retired: [{ token: "r", keyId: "key_ret" }, { token: "", keyId: "x" }] });
    expect(out.prev).toEqual({ b1: { token: "p", keyId: "key_prev" } });
    expect(out.retired).toEqual([{ token: "r", keyId: "key_ret" }]);
  });
  it("with NO sanitizer swap: the ack lists key_prev and key_ret, and a save that drops one is refused", async () => {
    const h = home(), send = vi.fn();
    try {
      h.seed();
      const port = createSupervisorPort({ store: h.store, send, emailStore: true });
      await port.handle(save(1, withSlots));
      const saved = send.mock.calls.map(c => c[0] as Record<string, unknown>).filter(m => m.type === "murage:email-secrets-saved");
      expect(saved).toHaveLength(1);
      expect(saved[0]!.keyIds).toEqual(["key_b1", "key_b2", "key_prev", "key_ret"]);
      await port.handle(save(2, D1));
      expect(send.mock.calls.map(c => c[0] as Record<string, unknown>).filter(m => m.type === "murage:email-secrets-refused").map(m => m.reason)).toEqual(["would_drop_acked"]);
      expect(docKeyIds(readRecord(h.real.readBack())!.doc)).toEqual(["key_b1", "key_b2", "key_prev", "key_ret"]);
    } finally { h.done(); }
  });
});

const BASE = "https://fluxrouter.ai";
const GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const CAPS = { device_authorization_grant: true, client_id: "murage-cloud", scope: "email:owner", grant_type: GRANT, device_authorization_endpoint: `${BASE}/api/device/code`, token_endpoint: `${BASE}/api/device/token`, revocation_endpoint: `${BASE}/api/device/revoke`, bot_keys: true };
const GOOD = { device_code: "dc", user_code: "WXYZ-1234", verification_uri: `${BASE}/device`, expires_in: 900, interval: 5 };
const TOKEN_OK = { api_key: "flx_owner_secret", key_id: "key_o", account_id: "acct_1", scopes: ["email:owner"] };
const reply = (status: number, body?: unknown, headers: Record<string, string> = {}) => new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status, headers: { "content-type": "application/json", ...headers } });
function wire(over: { caps?: () => Response; code?: () => Response; token?: () => Response } = {}) {
  const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === DEVICE_CAPABILITIES_PATH) return (over.caps ?? (() => reply(200, CAPS)))();
    if (path === DEVICE_CODE_PATH) return (over.code ?? (() => reply(200, GOOD)))();
    if (path === DEVICE_TOKEN_PATH) return (over.token ?? (() => reply(200, TOKEN_OK)))();
    return reply(404, {});
  });
  return { fetchMock, client: createFluxDeviceCodeClient({ baseUrl: BASE, fetch: fetchMock as unknown as typeof fetch }) };
}
const calledPaths = (m: ReturnType<typeof wire>["fetchMock"]) => m.mock.calls.map(c => new URL(String(c[0])).pathname);

describe("M4 only the four fixed endpoints are ever called", () => {
  it.each([
    ["device_authorization_grant false", { ...CAPS, device_authorization_grant: false }],
    ["device_authorization_grant absent", { ...CAPS, device_authorization_grant: undefined }],
    ["a same-origin code endpoint on another path", { ...CAPS, device_authorization_endpoint: `${BASE}/api/other/code` }],
    ["a same-origin token endpoint on another path", { ...CAPS, token_endpoint: `${BASE}/api/other/token` }],
    ["a same-origin revocation endpoint on another path", { ...CAPS, revocation_endpoint: `${BASE}/api/other/revoke` }],
    ["the code endpoint with a query", { ...CAPS, device_authorization_endpoint: `${BASE}/api/device/code?x=1` }],
  ])("capabilities with %s: unavailable, no code request", async (_name, caps) => {
    const w = wire({ caps: () => reply(200, caps) });
    expect(await w.client.start()).toEqual({ state: "unavailable" });
    expect(calledPaths(w.fetchMock)).toEqual([DEVICE_CAPABILITIES_PATH]);
  });
  it("redirects are never followed: every request is sent with redirect manual, and a 302 answer is unavailable", async () => {
    const w = wire({ code: () => reply(302, {}, { location: "https://evil.test/steal" }) });
    expect(await w.client.start()).toEqual({ state: "unavailable" });
    for (const call of w.fetchMock.mock.calls) expect(call[1]?.redirect).toBe("manual");
    expect(calledPaths(w.fetchMock)).toEqual([DEVICE_CAPABILITIES_PATH, DEVICE_CODE_PATH]);
  });
});

describe("M5 the token is parsed like the desktop parser, before any write", () => {
  const poll = async (token: Record<string, unknown>) => { const w = wire({ token: () => reply(200, token) }); await w.client.start(); return w.client.poll("dc"); };
  it.each([
    ["a token with whitespace", { ...TOKEN_OK, api_key: "flx owner secret" }],
    ["an invalid key id", { ...TOKEN_OK, key_id: "bad key id!" }],
    ["a missing account_id", { ...TOKEN_OK, account_id: undefined }],
  ])("%s is never a scoped ok", async (_name, token) => {
    const answer = await poll(token);
    expect(answer.state === "ok" ? answer.scoped : false).toBe(false);
  });
  it("a good token is a scoped ok", async () => {
    expect(await poll(TOKEN_OK)).toMatchObject({ state: "ok", scoped: true, owner: { token: "flx_owner_secret", keyId: "key_o" } });
  });
});

describe("M6 a child disconnect or a session end cancels an owner sign-in; the start names its actor and generation", () => {
  it("a token released after the child disconnected installs nothing, sends nothing, and that key is revoked", async () => {
    const h = home(), g = gate(); h.seed(A);
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const flux = fakeFlux({ poll: async () => { await hold; return { state: "ok", owner: B, scoped: true }; } });
    try {
      const t = boot(h, flux, g);
      await t.start(); await until(() => (flux.client.start as ReturnType<typeof vi.fn>).mock.calls.length === 1, "started");
      t.port.disconnect?.(1);
      release();
      await until(() => flux.log.includes(`revoke:${B.token}`), "B revoked");
      await new Promise(r => setTimeout(r, 30));
      expect(t.sent("murage:cloud-email-owner")).toHaveLength(0);
      expect(readRecord(h.real.getAll())!.owner).toEqual(A);
      expect(flux.log).not.toContain(`revoke:${A.token}`);
    } finally { h.done(); }
  });
  it("the session-end message for the starting device cancels it the same way", async () => {
    const h = home(), g = gate(); h.seed(A);
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const flux = fakeFlux({ poll: async () => { await hold; return { state: "ok", owner: B, scoped: true }; } });
    try {
      const t = boot(h, flux, g);
      await t.start(); await until(() => (flux.client.start as ReturnType<typeof vi.fn>).mock.calls.length === 1, "started");
      await t.port.handle({ type: "murage:email-owner-session-end", deviceId: ACTOR.deviceId });
      release();
      await until(() => flux.log.includes(`revoke:${B.token}`), "B revoked");
      expect(t.sent("murage:cloud-email-owner")).toHaveLength(0);
      expect(readRecord(h.real.getAll())!.owner).toEqual(A);
    } finally { h.done(); }
  });
  it("a start without actor and gen, or for another generation, starts nothing", async () => {
    const h = home(), g = gate(); h.seed();
    try {
      const flux = fakeFlux(), t = boot(h, flux, g);
      await t.port.handle({ type: "murage:email-owner-signin-start", requestId: "bare" });
      expect(t.sent("murage:cloud-refused")).toHaveLength(1);
      await t.port.handle({ type: "murage:email-owner-signin-start", requestId: "old", actor: ACTOR, gen: 9 });
      expect(t.sent("murage:email-owner-signin-result")).toEqual([{ type: "murage:email-owner-signin-result", requestId: "old", state: "unavailable" }]);
      expect(flux.client.start).not.toHaveBeenCalled();
    } finally { h.done(); }
  });
});

describe("M7 polling retries to expiry, whole seconds, elapsed time", () => {
  const events = { code: () => {}, token: async () => true as const };
  it("a transient poll failure does not end the attempt: the next answer is used", async () => {
    const answers: DeviceCodePoll[] = [{ state: "retry" }, { state: "retry" }, { state: "ok", owner: B, scoped: true }]; let i = 0;
    const client: FluxDeviceCodeClient = { start: async () => START, poll: async () => answers[i++]!, revoke: async () => "revoked" };
    expect(await runOwnerSignIn(client, events, { sleep: async () => {} })).toBe("done");
    expect(i).toBe(3);
  });
  it("a fractional or tiny interval is never obeyed below one whole second", async () => {
    const slept: number[] = [];
    const client: FluxDeviceCodeClient = { start: async () => ({ ...START, intervalMs: 1 }), poll: async () => ({ state: "denied" }), revoke: async () => "revoked" };
    await runOwnerSignIn(client, events, { sleep: async ms => { slept.push(ms); } });
    expect(slept[0]).toBeGreaterThanOrEqual(1000);
    expect(slept[0]! % 1000).toBe(0);
  });
  it("the client turns interval 0.001 into at least 5 whole seconds", async () => {
    const w = wire({ code: () => reply(200, { ...GOOD, interval: 0.001 }) });
    const started = await w.client.start();
    expect((started as { intervalMs: number }).intervalMs).toBeGreaterThanOrEqual(5000);
    expect((started as { intervalMs: number }).intervalMs % 1000).toBe(0);
  });
  it("expiry counts elapsed time (request latency included), not the sleeps asked for", async () => {
    let clock = 0, polls = 0;
    const client: FluxDeviceCodeClient = { start: async () => ({ ...START, expiresInMs: 250_000 }), poll: async () => { polls++; clock += 100_000; return { state: "pending" }; }, revoke: async () => "revoked" };
    expect(await runOwnerSignIn(client, events, { sleep: async () => {}, now: () => clock })).toBe("expired");
    expect(polls).toBeLessThanOrEqual(4);
  });
});

describe("M8 conditional owner unlink (r4 C) against a replacement", () => {
  it("unlink of A with no replacement: A is revoked, then the slot is cleared once", async () => {
    const h = home(), g = gate(), flux = fakeFlux(); h.seed(A);
    try {
      const t = boot(h, flux, g);
      await t.port.handle({ type: "murage:email-owner-unlink", requestId: "u1" });
      await until(() => t.sent("murage:email-owner-unlink-result").some(m => m.state === "unlinked"), "unlinked");
      expect(flux.log).toEqual([`revoke:${A.token}`]);
      expect(readRecord(h.real.readBack())!.owner).toBeUndefined();
    } finally { h.done(); }
  });
  it("O5. A is replaced by B while A's revoke is in flight: the slot keeps B, B is never revoked, the answer is replaced", async () => {
    const h = home(), g = gate(); h.seed(A);
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const flux = fakeFlux({ revoke: async () => { await hold; return "revoked"; } });
    try {
      const t = boot(h, flux, g);
      await t.port.handle({ type: "murage:email-owner-unlink", requestId: "u1" });
      await until(() => flux.log.includes(`revoke:${A.token}`), "A revoke started");
      writeOwner(h.real, B, 0);
      release();
      await until(() => t.sent("murage:email-owner-unlink-result").length > 0, "answer");
      expect(t.sent("murage:email-owner-unlink-result")).toEqual([{ type: "murage:email-owner-unlink-result", requestId: "u1", state: "replaced" }]);
      expect(readRecord(h.real.readBack())!.owner).toEqual(B);
      expect(flux.log).not.toContain(`revoke:${B.token}`);
    } finally { h.done(); }
  });
  it("O6. the first revoke is not confirmed (retry) and B replaces A before the retry: no second revoke, the slot keeps B", async () => {
    const h = home(), g = gate(); h.seed(A);
    const flux = fakeFlux({ revoke: async () => "retry" });
    try {
      const t = boot(h, flux, g);
      await t.port.handle({ type: "murage:email-owner-unlink", requestId: "u1" });
      await until(() => flux.log.length === 1, "first revoke");
      await until(() => t.sent("murage:email-owner-unlink-result").some(m => m.state === "disconnecting"), "disconnecting");
      writeOwner(h.real, B, 0);
      g.release();
      await until(() => t.sent("murage:email-owner-unlink-result").some(m => m.state === "replaced"), "replaced");
      expect(flux.log).toEqual([`revoke:${A.token}`]);
      expect(readRecord(h.real.readBack())!.owner).toEqual(B);
    } finally { h.done(); }
  });
});

describe("M9 the revision fence tracks the last WRITTEN revision", () => {
  it("rev 2 renamed but its dir sync failed: rev 1 is refused as stale and never overwrites it", async () => {
    const h = home(), send = vi.fn(); h.seed();
    try {
      const port = createSupervisorPort({ store: h.store, send, emailStore: true });
      h.state.failSync = true;
      await port.handle(save(2, D1));
      h.state.failSync = false;
      await port.handle(save(1, D0));
      const refused = send.mock.calls.map(c => c[0] as Record<string, unknown>).filter(m => m.type === "murage:email-secrets-refused");
      expect(refused.map(m => m.reason)).toEqual([expect.stringMatching(/not_durable|write_failed/), "stale_revision"]);
      expect(docKeyIds(readRecord(h.real.readBack())!.doc)).toEqual(["key_b1", "key_b2"]);
    } finally { h.done(); }
  });
});
