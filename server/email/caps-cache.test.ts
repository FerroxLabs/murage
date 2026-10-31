// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// EMAIL-CAPS-CACHE-1011, 1.0.11 scope: the last DEFINITIVE #31 answer is kept in email-capabilities.json for the saved key, so a launch
// or a network failure never hides email or turns it off. Only a 200 capabilities body, a 401 or a 402 changes the state. The file is
// keyed by a fingerprint of the saved key (never the key); a file for another key is dropped at boot. FakeFlux, fake timers, an
// in-memory database and a temporary data folder. "Network blocked" is a fetch that never answers until the client's own timeout.
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailRuntime } from "./runtime.ts";
import { PROBE_RETRY_MS } from "./capabilities.ts";
import { readCapsFile, writeCapsFile } from "./caps-file.ts";
import { credentialFingerprint } from "./email-secrets.ts";
import { emailOwnerRoute, type OwnerRouteDeps } from "./owner-routes.ts";
import { FakeFlux, fluxError, type FakeReply } from "../testing/fake-flux-email.ts";
import { EMAIL_STATUS_COPY } from "../../shared/email-copy.ts";
import type { BotRecord } from "../store.ts";

const KEY_A = "sk-flux-account-a-fixture";
const KEY_B = "sk-flux-account-b-fixture";
const REF_A = credentialFingerprint(KEY_A);
const REF_B = credentialFingerprint(KEY_B);
const CAPS_ON = { object: "email.capabilities", enabled: true, available: true, account_state: "active", terms_version: "v1", limits: { max_inboxes: 5 } };
const CAPS_OFF = { object: "email.capabilities", enabled: false, available: true };
const CAPS_PATH = /^\/v1\/email\/capabilities$/;
const CLIENT_TIMEOUT = 30_000;
const LOCAL_BOTS = new Set(["b1"]);
const mountInput = { driverKind: "claudeAgent", agentsMcp: true, surfacesForOwner: true, directOwnerAudience: true, origin: "desktop", automationThread: false, bot: { id: "b1", threadId: "t-b1" }, threadId: "t-b1" };

let dir: string;
let file: string;
let fake: FakeFlux;
let db: DatabaseSync;
let clock: number;
let accountKey: string | null;
let blocked: boolean;
let capsReply: FakeReply;
let statusEvents: number;
let logs: string[];
let runtimes: EmailRuntime[];

const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
  if (!blocked) return fake.fetch(input, init);
  return new Promise<Response>((_, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
}) as typeof fetch;

const flush = async (rounds = 30) => { for (let i = 0; i < rounds; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
const advance = async (ms: number) => { clock += ms; await vi.advanceTimersByTimeAsync(ms); await flush(); };

function make(): EmailRuntime {
  const runtime = new EmailRuntime({
    accountKey: () => accountKey, database: () => db, transaction: fn => fn(), fetch: fetchFn, apiBase: "https://api.flux.test", appBase: "https://app.flux.test",
    now: () => clock, workspaceRoot: () => undefined, bot: id => (LOCAL_BOTS.has(id) ? { id, name: "Juniper", threadId: `t-${id}` } as unknown as BotRecord : undefined),
    log: line => logs.push(line), capsFile: file, onStatus: () => { statusEvents++; },
  });
  runtimes.push(runtime);
  return runtime;
}
const deps = (runtime: EmailRuntime): OwnerRouteDeps => ({
  runtime, bot: id => (LOCAL_BOTS.has(id) ? { id, name: "Juniper", threadId: `t-${id}` } : undefined), fluxKeyPresent: () => accountKey !== null, now: () => clock, freshProof: async () => null,
});
const route = (runtime: EmailRuntime, method: string, path: string, body?: unknown) =>
  emailOwnerRoute(deps(runtime), { method, path: new URL(`http://x${path}`).pathname, query: new URL(`http://x${path}`).searchParams, body, surface: "desktop", botCredential: false });
const tables = () => (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'email_%'").all() as Array<{ name: string }>).map(row => row.name);
const binding = (runtime: EmailRuntime, botId = "b1") => runtime.services()!.store.insertBinding({
  botId, inboxId: `ibx_${botId}`, address: `${botId}@x.mybot`, username: botId, displayName: "Juniper", emailKeyRef: `key_${botId}`, fluxAccountId: null, state: "active",
  step: null, opId: null, opStartedAt: null, policy: "ask", failure: null, updatedAt: clock,
} as never);
const capsCalls = () => fake.calls("GET", CAPS_PATH).length;

/** Session 1 online: email on and written to the file for KEY_A. */
async function firstSessionOn(): Promise<void> {
  const first = make();
  await first.start();
  expect(first.enabled()).toBe(true);
  binding(first);
  first.stop();
  expect(readCapsFile(file)).toMatchObject({ accountRef: REF_A, caps: { enabled: true } });
}

beforeEach(() => {
  clock = 1_800_000_000_000;
  dir = mkdtempSync(join(tmpdir(), "murage-caps-cache-"));
  file = join(dir, "email-capabilities.json");
  fake = new FakeFlux();
  fake.always("GET", CAPS_PATH, () => capsReply);
  fake.always("GET", /^\/v1\/email\/approvals$/, { status: 200, body: { data: [] } });
  db = new DatabaseSync(":memory:");
  accountKey = KEY_A;
  blocked = false; capsReply = { status: 200, body: CAPS_ON }; statusEvents = 0; logs = []; runtimes = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});

afterEach(() => {
  for (const runtime of runtimes) runtime.stop();
  vi.useRealTimers();
  db.close();
  removeTempDirSync(dir);
});

describe("the file holds the last definitive answer for the saved key, never the key", () => {
  it("a 200 on writes one entry keyed by the key's fingerprint; the key itself is nowhere in the file", async () => {
    const runtime = make();
    await runtime.start();
    expect(runtime.enabled()).toBe(true);
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain(KEY_A);
    expect(JSON.parse(raw)).toEqual({ v: 1, accountRef: REF_A, caps: CAPS_ON, readAt: clock });
  });
});

describe("offline, timeouts and transient answers keep email visible (rule 1, rule 5)", () => {
  it("cached on + network blocked: start() does not wait, email is up at once and stays up, the route shows the last status with the note", async () => {
    await firstSessionOn();
    blocked = true;
    const runtime = make();
    const changes: boolean[] = [];
    runtime.probe.onChange(enabled => changes.push(enabled));
    await runtime.start(); // resolves with every Flux call pending
    expect(runtime.enabled()).toBe(true);
    expect(runtime.mount("g1", mountInput as never).mounted).toBe(true);
    const before = await route(runtime, "GET", "/api/email/status");
    expect(before?.status).toBe(200);
    expect(before?.body).toMatchObject({ enabled: true, accountRef: REF_A });
    expect(before?.body.staleNote).toBeUndefined();
    await advance(CLIENT_TIMEOUT); // the boot read times out
    expect(runtime.enabled()).toBe(true);
    expect(changes).toEqual([]);
    const after = await route(runtime, "GET", "/api/email/status");
    expect(after?.status).toBe(200);
    expect(after?.body).toMatchObject({ enabled: true, staleNote: EMAIL_STATUS_COPY.staleNote });
    expect(statusEvents).toBeGreaterThan(0);
    expect(runtime.services()!.store.getBinding("b1")?.state).toBe("active");
    expect(readCapsFile(file)).toMatchObject({ accountRef: REF_A, caps: { enabled: true } });
  });

  it("503, 500, 429, 403, 404, 400, a reset, a 200 [] and a 200 {} each change nothing (state and file the same)", async () => {
    await firstSessionOn();
    const runtime = make();
    await runtime.start();
    await runtime.whenBooted();
    const changes: boolean[] = [];
    runtime.probe.onChange(enabled => changes.push(enabled));
    const fileBefore = readFileSync(file, "utf8");
    const replies: FakeReply[] = [
      fluxError(503, "capability_unavailable"), { status: 500, body: "oops" }, fluxError(500, "internal_error"), fluxError(429, "rate_limit_error"),
      fluxError(403, "some_new_refusal"), { status: 403, body: {} }, fluxError(404, "not_found"), fluxError(400, "bad_request"), "reset",
      { status: 200, body: [] }, { status: 200, body: {} }, { status: 201, body: CAPS_OFF }, { status: 204 },
    ];
    for (const reply of replies) {
      capsReply = reply;
      await runtime.probe.refresh();
      expect(runtime.enabled()).toBe(true);
      expect(readFileSync(file, "utf8")).toBe(fileBefore);
      expect((await route(runtime, "GET", "/api/email/status"))?.body).toMatchObject({ enabled: true, staleNote: EMAIL_STATUS_COPY.staleNote });
    }
    expect(changes).toEqual([]);
  });

  it("a read with no answer is tried again on the backoff (30 s, then 60 s) until a definitive answer lands, then the note clears", async () => {
    await firstSessionOn();
    const runtime = make();
    capsReply = fluxError(503, "capability_unavailable");
    await runtime.start();
    await runtime.whenBooted();
    const reads = capsCalls();
    await advance(PROBE_RETRY_MS[0]!);
    expect(capsCalls()).toBe(reads + 1);
    capsReply = { status: 200, body: CAPS_ON };
    await advance(PROBE_RETRY_MS[1]!);
    expect(capsCalls()).toBe(reads + 2);
    expect((await route(runtime, "GET", "/api/email/status"))?.body.staleNote).toBeUndefined();
    await advance(PROBE_RETRY_MS[4]! * 3);
    expect(capsCalls()).toBe(reads + 2); // no more re-reads once a definitive answer landed
  });

  it("a 503 with retry_after_s waits that long before the next read", async () => {
    await firstSessionOn();
    const runtime = make();
    capsReply = fluxError(503, "capability_unavailable", { retry_after_s: 300 });
    await runtime.start();
    await runtime.whenBooted();
    const reads = capsCalls();
    await advance(PROBE_RETRY_MS[0]!);
    expect(capsCalls()).toBe(reads);
    await advance(300_000 - PROBE_RETRY_MS[0]!);
    expect(capsCalls()).toBe(reads + 1);
  });
});

describe("401, 402, a known 403 and a 200 body are definitive", () => {
  for (const [name, reply] of [["401", fluxError(401, "unauthorized")], ["402", fluxError(402, "premium_locked")], ["403 email_scope_required", fluxError(403, "email_scope_required")], ["403 owner_required", fluxError(403, "owner_required")], ["200 enabled:false", { status: 200, body: CAPS_OFF }]] as const) {
    it(`${name} turns email off, writes off to the file, and the route answers 404`, async () => {
      await firstSessionOn();
      const runtime = make();
      await runtime.start();
      await runtime.whenBooted();
      const changes: boolean[] = [];
      runtime.probe.onChange(enabled => changes.push(enabled));
      capsReply = reply as FakeReply;
      await runtime.probe.refresh();
      expect(runtime.enabled()).toBe(false);
      expect(changes).toEqual([false]);
      expect(readCapsFile(file)).toMatchObject({ accountRef: REF_A, caps: { enabled: false } });
      expect((await route(runtime, "GET", "/api/email/status"))?.status).toBe(404);
      expect(runtime.mount("g1", mountInput as never).mounted).toBe(false);
    });
  }

  it("a cached off launches off at once (no Checking), and a later 200 on brings email up and runs the boot work once", async () => {
    capsReply = { status: 200, body: CAPS_OFF };
    const first = make();
    await first.start();
    first.stop();
    expect(readCapsFile(file)).toMatchObject({ caps: { enabled: false } });
    expect(tables()).toEqual([]); // dark launch: an off makes no email table
    blocked = true;
    const runtime = make();
    runtime.secrets.setOwner({ token: "owner-fixture", keyId: "key_owner" }); // adoptHolds reads with the owner token
    void runtime.start(); // no cached on: start() waits for the read, as 1.0.10 did
    await flush();
    expect((await route(runtime, "GET", "/api/email/status"))?.status).toBe(404);
    blocked = false;
    capsReply = { status: 200, body: CAPS_ON };
    const approvals = fake.calls("GET", /^\/v1\/email\/approvals$/).length;
    await advance(CLIENT_TIMEOUT); // the blocked boot read times out, then the backoff re-reads
    await advance(PROBE_RETRY_MS[0]!);
    await runtime.whenBooted();
    expect(runtime.enabled()).toBe(true);
    expect(fake.calls("GET", /^\/v1\/email\/approvals$/).length).toBe(approvals + 1); // adoptHolds ran once
  });
});

describe("account isolation is boot-time: the fingerprint of the saved key", () => {
  it("a file for another key is dropped at boot: Checking until this key's own answer, never the other key's answer", async () => {
    await firstSessionOn(); // file holds KEY_A: on
    accountKey = KEY_B;
    blocked = true;
    const runtime = make();
    void runtime.start();
    await flush();
    expect(runtime.enabled()).toBe(false);
    expect(existsSync(file)).toBe(false);
    const checking = await route(runtime, "GET", "/api/email/status");
    expect(checking).toEqual({ status: 200, body: { enabled: false, checking: true, accountRef: REF_B } });
    expect(runtime.mount("g1", mountInput as never).mounted).toBe(false);
    blocked = false;
    capsReply = { status: 200, body: CAPS_OFF };
    await advance(CLIENT_TIMEOUT);
    await advance(PROBE_RETRY_MS[0]!);
    expect(readCapsFile(file)).toMatchObject({ accountRef: REF_B, caps: { enabled: false } });
    expect((await route(runtime, "GET", "/api/email/status"))?.status).toBe(404);
  });

  it("an answer that lands after the saved key changed in memory is not shown under the new key and not written for it", async () => {
    const runtime = make();
    await runtime.start();
    expect(runtime.enabled()).toBe(true);
    let release: (reply: FakeReply) => void = () => undefined;
    capsReply = (() => new Promise<FakeReply>(resolve => { release = resolve; })) as unknown as FakeReply;
    const late = runtime.probe.refresh();
    await flush();
    accountKey = KEY_B;
    release({ status: 200, body: CAPS_ON });
    await late;
    expect(runtime.enabled()).toBe(false); // KEY_B has no answer of its own
    expect(runtime.probe.checking()).toBe(true);
    expect(readCapsFile(file)?.accountRef).toBe(REF_A);
  });

  it("a malformed or other-version file reads as no cache (Checking), never as on", async () => {
    writeFileSync(file, JSON.stringify({ v: 2, accountRef: REF_A, caps: CAPS_ON, readAt: 1 }));
    blocked = true;
    const runtime = make();
    void runtime.start();
    await flush();
    expect(runtime.enabled()).toBe(false);
    expect((await route(runtime, "GET", "/api/email/status"))?.body).toMatchObject({ checking: true });
    writeFileSync(file, "{not json");
    const again = make();
    void again.start();
    await flush();
    expect(again.enabled()).toBe(false);
  });

  it("logout (no key) answers 404 and keeps the file; the same key back finds its entry", async () => {
    await firstSessionOn();
    accountKey = null;
    const runtime = make();
    await runtime.start();
    expect((await route(runtime, "GET", "/api/email/status"))?.status).toBe(404);
    expect(readCapsFile(file)?.accountRef).toBe(REF_A);
    accountKey = KEY_A;
    blocked = true;
    const back = make();
    await back.start();
    expect(back.enabled()).toBe(true);
  });
});

describe("first run, lifecycle and consent", () => {
  it("first run offline with no cache: Checking, no email table; a 200 off writes off and still no table", async () => {
    blocked = true;
    const runtime = make();
    const started = runtime.start();
    await flush();
    expect((await route(runtime, "GET", "/api/email/status"))?.body).toEqual({ enabled: false, checking: true, accountRef: REF_A });
    await advance(CLIENT_TIMEOUT);
    await started;
    expect(tables()).toEqual([]);
    blocked = false;
    capsReply = { status: 200, body: CAPS_OFF };
    await advance(PROBE_RETRY_MS[0]!);
    expect(readCapsFile(file)).toMatchObject({ caps: { enabled: false } });
    expect(tables()).toEqual([]);
    expect((await route(runtime, "GET", "/api/email/status"))?.status).toBe(404);
  });

  for (const [name, reply] of [["unknown 403", fluxError(403, "some_new_refusal")], ["404", { status: 404, body: { error: "not found" } }], ["500", { status: 500, body: {} }], ["503", fluxError(503, "capability_unavailable")]] as const) {
    it(`no cache and a ${name} on the read: Checking turns into a plain note, never off, and the next definitive answer settles it`, async () => {
      capsReply = reply as FakeReply;
      const runtime = make();
      await runtime.start();
      expect(runtime.enabled()).toBe(false);
      const note = { enabled: false, checking: true, accountRef: REF_A, note: EMAIL_STATUS_COPY.checkingNote };
      expect(await route(runtime, "GET", "/api/email/status")).toEqual({ status: 200, body: note });
      expect(tables()).toEqual([]);
      expect(readCapsFile(file)).toBeNull();
      // the backoff keeps reading; every failed read leaves the note
      const before = capsCalls();
      await advance(PROBE_RETRY_MS[0]!);
      expect(capsCalls()).toBe(before + 1);
      expect(await route(runtime, "GET", "/api/email/status")).toEqual({ status: 200, body: note });
      // a definitive answer ends it, on or off
      capsReply = { status: 200, body: CAPS_OFF };
      await advance(PROBE_RETRY_MS[1]!);
      expect((await route(runtime, "GET", "/api/email/status"))?.status).toBe(404);
      capsReply = { status: 200, body: CAPS_ON };
      await route(runtime, "GET", "/api/email/status?refresh=1");
      await flush();
      await runtime.whenBooted();
      const on = await route(runtime, "GET", "/api/email/status");
      expect(on?.status).toBe(200);
      expect(on?.body.enabled).toBe(true);
      expect(on?.body.staleNote).toBeUndefined();
    });
  }

  it("a key saved after boot: the first status read starts the capability read, and repeated status reads never make a read loop", async () => {
    accountKey = null;
    const runtime = make();
    await runtime.start();
    expect(capsCalls()).toBe(0);
    accountKey = KEY_A;
    capsReply = { status: 500, body: {} };
    expect((await route(runtime, "GET", "/api/email/status"))?.body).toEqual({ enabled: false, checking: true, accountRef: REF_A });
    await flush();
    expect(capsCalls()).toBe(1);
    for (let i = 0; i < 5; i++) expect((await route(runtime, "GET", "/api/email/status"))?.body).toMatchObject({ note: EMAIL_STATUS_COPY.checkingNote });
    await flush();
    expect(capsCalls()).toBe(1); // the backoff owns the next read
    capsReply = { status: 200, body: CAPS_ON };
    await advance(PROBE_RETRY_MS[0]!);
    await runtime.whenBooted();
    expect(runtime.enabled()).toBe(true);
  });

  it("cached on: an unknown 403, a 404 or a 500 keeps email on with the last-status note; a definitive 200 off turns it off", async () => {
    await firstSessionOn();
    for (const reply of [fluxError(403, "some_new_refusal"), { status: 404, body: {} }, { status: 500, body: {} }] as FakeReply[]) {
      capsReply = reply;
      const runtime = make();
      await runtime.start();
      await runtime.whenBooted();
      expect(runtime.enabled()).toBe(true);
      expect(runtime.mount("g1", mountInput as never).mounted).toBe(true);
      expect((await route(runtime, "GET", "/api/email/status"))?.body).toMatchObject({ enabled: true, staleNote: EMAIL_STATUS_COPY.staleNote });
      runtime.stop();
    }
    capsReply = { status: 200, body: CAPS_OFF };
    const runtime = make();
    await runtime.start();
    await runtime.whenBooted();
    expect(runtime.enabled()).toBe(false);
    expect((await route(runtime, "GET", "/api/email/status"))?.status).toBe(404);
  });

  it("?refresh=1 answers at once from local state; the read runs in the background", async () => {
    await firstSessionOn();
    blocked = true;
    const runtime = make();
    await runtime.start();
    const answer = await route(runtime, "GET", "/api/email/status?refresh=1");
    expect(answer?.status).toBe(200);
    expect(answer?.body.enabled).toBe(true);
  });

  it("a scope 403 with the owner token saved changes nothing; the next read goes on that token, and a 503 there keeps the cached on", async () => {
    await firstSessionOn();
    const runtime = make();
    runtime.secrets.setOwner({ token: "owner-fixture-token", keyId: "key_owner" });
    const fileBefore = readFileSync(file, "utf8");
    const replies: FakeReply[] = [fluxError(403, "email_scope_required"), fluxError(503, "capability_unavailable")];
    capsReply = (() => replies.shift()) as unknown as FakeReply;
    await runtime.start();
    await runtime.whenBooted();
    expect(runtime.enabled()).toBe(true);
    await advance(PROBE_RETRY_MS[0]!);
    expect(fake.calls("GET", CAPS_PATH).slice(-2).map(call => call.headers.authorization)).toEqual([`Bearer ${KEY_A}`, "Bearer owner-fixture-token"]);
    expect(runtime.enabled()).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(fileBefore);
  });

  it("stop() during the owner read drops its answer: no file write, no listener", async () => {
    await firstSessionOn();
    const runtime = make();
    runtime.secrets.setOwner({ token: "owner-fixture-token", keyId: "key_owner" });
    let release: (reply: FakeReply) => void = () => undefined;
    const replies: Array<() => unknown> = [() => fluxError(403, "email_scope_required"), () => new Promise<FakeReply>(resolve => { release = resolve; })];
    capsReply = (() => replies.shift()!()) as unknown as FakeReply;
    await runtime.start();
    await runtime.whenBooted();
    void runtime.probe.refresh();
    await flush();
    const changes: boolean[] = [];
    runtime.probe.onChange(enabled => changes.push(enabled));
    const fileBefore = readFileSync(file, "utf8");
    runtime.stop();
    release(fluxError(401, "unauthorized"));
    await flush();
    expect(readFileSync(file, "utf8")).toBe(fileBefore);
    expect(changes).toEqual([]);
    expect(runtime.enabled()).toBe(true);
  });

  it("stop() drops an answer that lands later: no file write, no listener, no further re-read", async () => {
    await firstSessionOn();
    const runtime = make();
    let release: (reply: FakeReply) => void = () => undefined;
    capsReply = (() => new Promise<FakeReply>(resolve => { release = resolve; })) as unknown as FakeReply;
    await runtime.start();
    await flush();
    const changes: boolean[] = [];
    runtime.probe.onChange(enabled => changes.push(enabled));
    const fileBefore = readFileSync(file, "utf8");
    runtime.stop();
    release(fluxError(401, "unauthorized"));
    await flush();
    expect(readFileSync(file, "utf8")).toBe(fileBefore);
    expect(changes).toEqual([]);
    expect(logs.some(line => line.includes("stale capability answer dropped"))).toBe(true);
    const reads = capsCalls();
    await advance(PROBE_RETRY_MS[4]! * 2);
    expect(capsCalls()).toBe(reads);
  });

  it("turning the account on with only the file's answer and no network answers 503 and keeps email on; consent never rests on the file", async () => {
    await firstSessionOn();
    blocked = true;
    const runtime = make();
    runtime.secrets.setOwner({ token: "owner-fixture-token", keyId: "key_owner" });
    await runtime.start();
    const pending = route(runtime, "POST", "/api/email/account", { on: true, acceptTermsVersion: "v1" });
    await advance(CLIENT_TIMEOUT);
    const answer = await pending;
    expect(answer?.status).toBe(503);
    expect(answer?.body.error).toBe(EMAIL_STATUS_COPY.consentOffline);
    expect(fake.calls("POST", /^\/v1\/email\/enable$/)).toHaveLength(0);
    expect(runtime.enabled()).toBe(true);
  });
});

describe("existing 1.0.9 and 1.0.10 setups keep working with no re-enable (rule 3)", () => {
  it("an install with a live binding and no cache file comes up on after its first read, binding untouched", async () => {
    const first = make();
    await first.start();
    binding(first);
    first.stop();
    rmSync(file, { force: true }); // 1.0.10 wrote no file
    const runtime = make();
    await runtime.start();
    expect(runtime.enabled()).toBe(true);
    expect(runtime.services()!.store.getBinding("b1")?.state).toBe("active");
    expect(runtime.mount("g1", mountInput as never).mounted).toBe(true);
    expect(readCapsFile(file)?.accountRef).toBe(REF_A);
  });
});

describe("caps-file", () => {
  it("writes atomically and reads back; a missing file is null", () => {
    expect(readCapsFile(file)).toBeNull();
    writeCapsFile(file, { accountRef: REF_B, caps: CAPS_OFF, readAt: 5 });
    expect(readCapsFile(file)).toEqual({ v: 1, accountRef: REF_B, caps: CAPS_OFF, readAt: 5 });
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });
});
