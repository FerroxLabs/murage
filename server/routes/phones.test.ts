// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.9 phone tools S14: the phone job routes and the revoke and minted routes, through the handler module with injected deps.
// The revocation barrier (Astra AS2) and the abrupt restart after LEASED (Astra AS8) are tested here against a real messages.db file.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { PhoneAuthorities } from "../phones/authority.ts";
import { PhoneJobs, type BotOutcome } from "../phones/jobs.ts";
import { PhoneRegistry, PhoneRevocations, initializePhones } from "../phones/registry.ts";
import { leaseAnswerSchema, pollSchema, targetedAnswerSchema } from "../../shared/phone-jobs-contract.ts";
import { AskRevocations } from "../phones/ask-revocations.ts";
import { askRevokeRoute, phoneRoute, type PhoneRouteAnswer, type PhoneRouteDeps } from "./phones.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const CONTRACT = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "apps", "mobile", "contract", "phone-jobs.json"), "utf8"));
const REGISTRATION = CONTRACT.registration.valid;
const SCRATCH = mkdtempSync(join(tmpdir(), "murage-phone-routes-"));
/** Every file database a test opens, closed before the folder goes: Windows will not remove a file that is still open. */
const openedDbs: DatabaseSync[] = [];
const openDb = (file: string) => { const db = new DatabaseSync(file); openedDbs.push(db); return db; };
const closeOpenedDbs = () => { for (const db of openedDbs.splice(0)) { try { db.close(); } catch { /* already closed by the test */ } } };
afterAll(() => { closeOpenedDbs(); removeTempDirSync(SCRATCH); });
let dbCount = 0;
const newDbFile = () => join(SCRATCH, `messages-${++dbCount}.db`);

const A = "device-a";
const B = "device-b";
const CAL_ARGS = { start: "2026-10-26T09:00:00Z", end: "2026-10-26T17:00:00Z" };
const OK_RESULT = { events: [{ id: "ev-1", title: "Standup SECRET-TITLE", start: "2026-10-27T09:00:00-07:00", end: "2026-10-27T09:15:00-07:00", allDay: false, calendar: "Work", location: "Room 4", notes: "Bring the numbers" }], truncated: false };

interface Rig {
  deps: PhoneRouteDeps; jobs: PhoneJobs; registry: PhoneRegistry; revocations: PhoneRevocations; authorities: PhoneAuthorities;
  rows: Array<{ threadId: string; text: string }>; db: DatabaseSync; advance(ms: number): void;
}
/** One harness lifetime on a messages.db file. Building a second rig on the same file is a restart (memory is gone, the file stays). */
function makeRig(file: string, grant: Record<string, string> = { calendar: "read", reminders: "read" }): Rig {
  const db = openDb(file);
  initializePhones(db);
  let t = 1_000_000;
  let n = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let ids = 0;
  const salt = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
  const jobs = new PhoneJobs({
    now: () => t,
    setTimer: (ms, fn) => { const id = ++n; timers.set(id, { at: t + ms, fn }); return () => { timers.delete(id); }; },
    push: { park: () => {}, withdraw: () => {} },
    ids: () => `00000000-0000-4000-8000-${salt}${(++ids).toString(16).padStart(6, "0")}`,
    leaseToken: () => `lease${String(++ids).padStart(38, "0")}`.padEnd(43, "x"),
  });
  const registry = new PhoneRegistry(db, () => t);
  const revocations = new PhoneRevocations(db, () => t);
  const authorities = new PhoneAuthorities();
  const rows: Array<{ threadId: string; text: string }> = [];
  const deps: PhoneRouteDeps = { registry, revocations, jobs, authorities, grant: () => grant as never, askOffered: () => true, activity: (threadId, text) => { rows.push({ threadId, text }); } };
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      timers.delete(next[0]);
      t = Math.max(t, next[1].at);
      next[1].fn();
    }
    t = end;
  };
  return { deps, jobs, registry, revocations, authorities, rows, db, advance };
}

interface Opts { body?: unknown; device?: string | null; companion?: boolean; desktop?: boolean; signal?: AbortSignal }
const call = (rig: Rig, method: string, target: string, o: Opts = {}): Promise<PhoneRouteAnswer | null> => {
  const url = new URL(target, "http://harness.invalid");
  return phoneRoute({
    method, path: url.pathname, query: url.searchParams, deviceId: o.device === undefined ? A : o.device, companion: o.companion === true, desktop: o.desktop === true,
    readBody: async () => o.body, signal: o.signal ?? new AbortController().signal,
  }, rig.deps);
};
const ok = async (p: Promise<PhoneRouteAnswer | null>) => { const a = await p; expect(a).not.toBeNull(); return a!; };

let mint = 0;
const open = (rig: Rig, over: { deviceId?: string; action?: string; capability?: "calendar" | "reminders"; args?: unknown; botId?: string } = {}) => {
  const generation = `gen-${++mint}`;
  const authority = rig.authorities.mint({ threadId: `thread-${mint}`, turnId: `turn-${mint}`, generation, origin: "desktop", botId: over.botId ?? "bot-1" });
  const { operationId, outcome } = rig.jobs.request({
    authority, deviceId: over.deviceId ?? A, capability: over.capability ?? "calendar", action: over.action ?? "calendar.read", args: over.args ?? CAL_ARGS,
    say: "read your calendar", provider: { id: "claude", name: "Claude" }, phoneName: "Sean's iPhone",
  });
  return { operationId, outcome, authority };
};
const register = async (rig: Rig, device = A, body: unknown = REGISTRATION) => ok(call(rig, "PUT", "/api/phones/self", { body, device }));
const pollOnce = async (rig: Rig, device = A) => (await ok(call(rig, "GET", "/api/phones/self/jobs", { device }))).body as { jobs: Array<{ operationId: string; offerId: string }> };
const settled = async (p: Promise<BotOutcome>): Promise<BotOutcome | "pending"> => Promise.race([p, new Promise<"pending">((r) => setTimeout(() => r("pending"), 5))]);

const SELF_ROUTES: Array<[string, string]> = [
  ["PUT", "/api/phones/self"], ["GET", "/api/phones/self/jobs"], ["GET", "/api/phones/self/jobs?eventRef=" + "a".repeat(64)],
  ["GET", "/api/phones/self/jobs/00000000-0000-4000-8000-000000000001"], ["POST", "/api/phones/self/jobs/00000000-0000-4000-8000-000000000001/lease"],
  ["POST", "/api/phones/self/jobs/00000000-0000-4000-8000-000000000001/decline"], ["POST", "/api/phones/self/jobs/00000000-0000-4000-8000-000000000001/result"],
  ["POST", "/api/phones/self/foreground"], ["DELETE", "/api/phones/self"],
];

describe("who may call (F3)", () => {
  it("every phone route refuses a caller that is not the phone's own runner (a desktop secret, an owner-phone session and a bare door token give no device)", async () => {
    const rig = makeRig(newDbFile());
    for (const [method, target] of SELF_ROUTES) {
      const answer = await ok(call(rig, method, target, { device: null, body: {}, desktop: true, companion: true }));
      expect(answer.status, `${method} ${target}`).toBe(403);
    }
    expect(rig.registry.list()).toEqual([]);
  });
  it("revoke and minted take the companion class only; the list takes the desktop only", async () => {
    const rig = makeRig(newDbFile());
    expect((await ok(call(rig, "POST", "/api/phones/revoke", { body: { deviceId: A, reason: "removed" }, device: null, desktop: true }))).status).toBe(403);
    expect((await ok(call(rig, "POST", "/api/phones/minted", { body: { deviceId: A }, device: A }))).status).toBe(403);
    expect(rig.revocations.barred(A)).toBe(false);
    expect((await ok(call(rig, "GET", "/api/phones", { device: A, companion: true }))).status).toBe(403);
    expect((await ok(call(rig, "GET", "/api/phones", { device: null, desktop: true }))).status).toBe(200);
  });
  it("a path that is not a phone route is not answered", async () => {
    const rig = makeRig(newDbFile());
    expect(await call(rig, "GET", "/api/bots")).toBeNull();
    expect((await ok(call(rig, "GET", "/api/phones/self/unknown"))).status).toBe(404);
    expect((await ok(call(rig, "PATCH", "/api/phones/self"))).status).toBe(405);
  });
});

describe("registration (PUT /api/phones/self)", () => {
  it("stores the registration under the device id of the caller, never one in the body", async () => {
    const rig = makeRig(newDbFile());
    expect((await register(rig, A, { ...REGISTRATION, deviceId: "someone-else" })).status).toBe(400);
    expect((await register(rig)).body).toEqual({ ok: true });
    expect(rig.registry.get(A)?.name).toBe(REGISTRATION.name);
    expect(rig.registry.get("someone-else")).toBeNull();
    expect((await ok(call(rig, "GET", "/api/phones", { desktop: true, device: null }))).body).toMatchObject({ phones: [{ deviceId: A }] });
  });
  it("narrowed capabilities end that phone's open jobs for them (F7)", async () => {
    const rig = makeRig(newDbFile());
    await register(rig);
    const cal = open(rig); const rem = open(rig, { capability: "reminders", action: "reminders.read", args: {} });
    const { calendar: _dropped, ...kept } = REGISTRATION.capabilities;
    await register(rig, A, { ...REGISTRATION, capabilities: kept });
    expect((await settled(cal.outcome))).toMatchObject({ kind: "did_not_run" });
    expect(await settled(rem.outcome)).toBe("pending");
  });
});

describe("the job routes", () => {
  it("poll, lease, result: an offer that matches the contract, a lease, a result that ends DONE with an activity row naming the action and the phone", async () => {
    const rig = makeRig(newDbFile());
    await register(rig);
    const { operationId, outcome, authority } = open(rig);
    const polled = await ok(call(rig, "GET", "/api/phones/self/jobs"));
    expect(pollSchema.safeParse(polled.body).success).toBe(true);
    const offerId = (polled.body as any).jobs[0].offerId;
    const leased = await ok(call(rig, "POST", `/api/phones/self/jobs/${operationId}/lease`, { body: { offerId } }));
    expect(leaseAnswerSchema.safeParse(leased.body).success).toBe(true);
    expect((leased.body as any).active).toBe(true);
    const done = await ok(call(rig, "POST", `/api/phones/self/jobs/${operationId}/result`, { body: { leaseToken: (leased.body as any).leaseToken, ok: true, result: OK_RESULT } }));
    expect(done.status).toBe(200);
    expect(await outcome).toMatchObject({ kind: "done", phoneName: "Sean's iPhone" });
    expect(rig.rows).toHaveLength(1);
    expect(rig.rows[0]).toMatchObject({ threadId: authority.threadId });
    expect(rig.rows[0]!.text).toBe("Read your calendar on the iPhone");
    expect(rig.rows[0]!.text).not.toContain("SECRET-TITLE");
  });
  it("a job that fails or is declined posts no activity row", async () => {
    const rig = makeRig(newDbFile());
    await register(rig);
    const a = open(rig);
    const offer = (await pollOnce(rig)).jobs[0]!;
    expect((await ok(call(rig, "POST", `/api/phones/self/jobs/${a.operationId}/decline`, { body: { offerId: offer.offerId } }))).status).toBe(200);
    expect(await a.outcome).toMatchObject({ kind: "declined" });
    expect(rig.rows).toEqual([]);
    const b = open(rig);
    const offerB = (await pollOnce(rig)).jobs[0]!;
    const lease = (await ok(call(rig, "POST", `/api/phones/self/jobs/${b.operationId}/lease`, { body: { offerId: offerB.offerId } }))).body as any;
    expect((await ok(call(rig, "POST", `/api/phones/self/jobs/${b.operationId}/result`, { body: { leaseToken: lease.leaseToken, ok: false, code: "denied", error: "no" } }))).status).toBe(200);
    expect(rig.rows).toEqual([]);
  });
  it("a token for device A cannot read, lease, decline or answer device B's job (F19)", async () => {
    const rig = makeRig(newDbFile());
    await register(rig, A); await register(rig, B);
    const job = open(rig, { deviceId: B });
    const offer = (await pollOnce(rig, B)).jobs[0]!;
    expect((await ok(call(rig, "GET", `/api/phones/self/jobs/${job.operationId}`, { device: A }))).body).toEqual({ handled: true, reason: "unknown" });
    expect((await ok(call(rig, "POST", `/api/phones/self/jobs/${job.operationId}/lease`, { device: A, body: { offerId: offer.offerId } }))).body).toEqual({ active: false });
    expect((await ok(call(rig, "POST", `/api/phones/self/jobs/${job.operationId}/decline`, { device: A, body: { offerId: offer.offerId } }))).status).toBe(409);
    const lease = (await ok(call(rig, "POST", `/api/phones/self/jobs/${job.operationId}/lease`, { device: B, body: { offerId: offer.offerId } }))).body as any;
    expect(lease.active).toBe(true);
    expect((await ok(call(rig, "POST", `/api/phones/self/jobs/${job.operationId}/result`, { device: A, body: { leaseToken: lease.leaseToken, ok: true, result: OK_RESULT } }))).status).toBe(409);
    expect(await settled(job.outcome)).toBe("pending");
  });
  it("a 300 KB result is 413 and the job FAILED (may have run), with no activity row (F14)", async () => {
    const rig = makeRig(newDbFile());
    await register(rig);
    const job = open(rig, { action: "calendar.read" });
    const offer = (await pollOnce(rig)).jobs[0]!;
    const lease = (await ok(call(rig, "POST", `/api/phones/self/jobs/${job.operationId}/lease`, { body: { offerId: offer.offerId } }))).body as any;
    const answer = await ok(call(rig, "POST", `/api/phones/self/jobs/${job.operationId}/result`, { body: { leaseToken: lease.leaseToken, ok: true, result: { text: "a".repeat(300 * 1024) } } }));
    expect(answer.status).toBe(413);
    expect(await job.outcome).toMatchObject({ kind: "may_have_run" });
    expect(rig.rows).toEqual([]);
  });
  it("a body that cannot be read is refused with 400 and nothing changes", async () => {
    const rig = makeRig(newDbFile());
    await register(rig);
    const job = open(rig);
    const bad = await phoneRoute({ method: "POST", path: `/api/phones/self/jobs/${job.operationId}/lease`, query: new URLSearchParams(), deviceId: A, companion: false, desktop: false,
      readBody: async () => { throw Object.assign(new Error("invalid JSON body"), { status: 400 }); }, signal: new AbortController().signal }, rig.deps);
    expect(bad?.status).toBe(400);
    expect((await ok(call(rig, "POST", `/api/phones/self/jobs/${job.operationId}/lease`, { body: { offerId: "not-a-uuid" } }))).status).toBe(400);
    expect(await settled(job.outcome)).toBe("pending");
  });
  it("a long poll waits 20 s and answers empty; an aborted poll answers empty", async () => {
    const rig = makeRig(newDbFile());
    await register(rig);
    const waiting = call(rig, "GET", "/api/phones/self/jobs");
    rig.advance(20_000);
    expect((await waiting)?.body).toEqual({ jobs: [] });
    const ac = new AbortController();
    const aborted = call(rig, "GET", "/api/phones/self/jobs", { signal: ac.signal });
    ac.abort();
    expect((await aborted)?.body).toEqual({ jobs: [] });
  });
  it("foreground off requeues an offered job with a fresh offer (F23)", async () => {
    const rig = makeRig(newDbFile());
    await register(rig);
    const job = open(rig);
    const first = (await pollOnce(rig)).jobs[0]!;
    expect((await ok(call(rig, "POST", "/api/phones/self/foreground", { body: { active: false } }))).status).toBe(200);
    expect((await ok(call(rig, "POST", `/api/phones/self/jobs/${job.operationId}/lease`, { body: { offerId: first.offerId } }))).body).toEqual({ active: false });
    expect((await pollOnce(rig)).jobs[0]!.offerId).not.toBe(first.offerId);
    expect((await ok(call(rig, "POST", "/api/phones/self/foreground", { body: { active: "no" } }))).status).toBe(400);
  });
  it("a lease whose grant, registration or authority no longer holds is refused and the bot hears it did not run", async () => {
    const rig = makeRig(newDbFile());
    await register(rig);
    const job = open(rig);
    const offer = (await pollOnce(rig)).jobs[0]!;
    rig.authorities.revokeGeneration(job.authority.generation);
    expect((await ok(call(rig, "POST", `/api/phones/self/jobs/${job.operationId}/lease`, { body: { offerId: offer.offerId } }))).body).toEqual({ active: false });
    expect(await job.outcome).toMatchObject({ kind: "did_not_run" });
  });
});

describe("location precision downgrade (S14 follow-up)", () => {
  const withLocation = (location: string) => ({ ...REGISTRATION, capabilities: { ...REGISTRATION.capabilities, location } });
  const openLocation = (rig: Rig, precision: "approximate" | "precise") => open(rig, { capability: "location" as never, action: "location.get", args: { precision } });

  it("a queued precise job is ended after a re-PUT that reports approximate", async () => {
    const rig = makeRig(newDbFile(), { location: "precise" });
    await register(rig);
    const job = openLocation(rig, "precise");
    await register(rig, A, withLocation("approximate"));
    expect(await settled(job.outcome)).toMatchObject({ kind: "did_not_run" });
  });

  it("with the revoke bypassed, a precise job is not leased under an approximate report", async () => {
    const rig = makeRig(newDbFile(), { location: "precise" });
    await register(rig);
    const job = openLocation(rig, "precise");
    const offer = (await pollOnce(rig)).jobs[0]!;
    rig.registry.put(A, withLocation("approximate"));
    expect((await ok(call(rig, "POST", `/api/phones/self/jobs/${job.operationId}/lease`, { body: { offerId: offer.offerId } }))).body).toEqual({ active: false });
    expect(await job.outcome).toMatchObject({ kind: "did_not_run" });
  });

  it("an approximate job under an approximate report still leases", async () => {
    const rig = makeRig(newDbFile(), { location: "precise" });
    await register(rig, A, withLocation("approximate"));
    const job = openLocation(rig, "approximate");
    const offer = (await pollOnce(rig)).jobs[0]!;
    const leased = await ok(call(rig, "POST", `/api/phones/self/jobs/${job.operationId}/lease`, { body: { offerId: offer.offerId } }));
    expect((leased.body as any).active).toBe(true);
  });
});

describe("targeted reads (S1b)", () => {
  it("every TargetedAnswer member through the operation id and through ?eventRef=, and another device's id is unknown", async () => {
    const rig = makeRig(newDbFile());
    await register(rig); await register(rig, B);
    const job = open(rig);
    const eventRef = rig.jobs.eventRefFor(job.operationId);
    const members: unknown[] = [];
    // a read of a waiting job offers it afresh, so the two reads differ only in the offer id
    const strip = (a: any) => (a.jobs ? { jobs: a.jobs.map(({ offerId: _o, ...rest }: any) => rest) } : a);
    const read = async () => {
      const byOp = (await ok(call(rig, "GET", `/api/phones/self/jobs/${job.operationId}`))).body as any;
      const byRef = (await ok(call(rig, "GET", `/api/phones/self/jobs?eventRef=${eventRef}`))).body as any;
      expect(strip(byRef)).toEqual(strip(byOp));
      expect(targetedAnswerSchema.safeParse(byOp).success).toBe(true);
      expect(targetedAnswerSchema.safeParse(byRef).success).toBe(true);
      members.push(byRef);
      return byRef;
    };
    expect((await read()).jobs).toHaveLength(1);
    const offerId = (await read()).jobs[0].offerId;
    const lease = (await ok(call(rig, "POST", `/api/phones/self/jobs/${job.operationId}/lease`, { body: { offerId } }))).body as any;
    expect((await read()).leased).toBe(true);
    await ok(call(rig, "POST", `/api/phones/self/jobs/${job.operationId}/result`, { body: { leaseToken: lease.leaseToken, ok: true, result: OK_RESULT } }));
    expect(await read()).toEqual({ handled: true, reason: "done" });
    expect((await ok(call(rig, "GET", `/api/phones/self/jobs/${job.operationId}`, { device: B }))).body).toEqual({ handled: true, reason: "unknown" });
    expect((await ok(call(rig, "GET", `/api/phones/self/jobs?eventRef=${eventRef}`, { device: B }))).body).toEqual({ handled: true, reason: "unknown" });
    expect((await ok(call(rig, "GET", "/api/phones/self/jobs?eventRef=nothex"))).status).toBe(400);
    const revoked = open(rig);
    rig.jobs.revokeFor({ deviceId: A });
    expect((await ok(call(rig, "GET", `/api/phones/self/jobs/${revoked.operationId}`))).body).toEqual({ handled: true, reason: "revoked" });
    const ended = open(rig);
    rig.jobs.turnEnded(ended.authority.generation);
    expect((await ok(call(rig, "GET", `/api/phones/self/jobs/${ended.operationId}`))).body).toEqual({ handled: true, reason: "ended" });
    expect(members.length).toBeGreaterThanOrEqual(4);
  });
});

describe("revoke (companion) and the barrier (Astra AS2)", () => {
  it("after /api/phones/revoke the same device's poll is empty and lease is inactive even with the door token still valid", async () => {
    const rig = makeRig(newDbFile());
    await register(rig);
    const job = open(rig);
    const offer = (await pollOnce(rig)).jobs[0]!;
    // the phone leases it, so a second long poll has nothing to be offered and stays open
    const lease = (await ok(call(rig, "POST", `/api/phones/self/jobs/${job.operationId}/lease`, { body: { offerId: offer.offerId } }))).body as any;
    expect(lease.active).toBe(true);
    const waiting = call(rig, "GET", "/api/phones/self/jobs", { device: A });
    const answer = await ok(call(rig, "POST", "/api/phones/revoke", { companion: true, device: null, body: { deviceId: A, reason: "removed" } }));
    expect(answer).toEqual({ status: 200, body: { revoked: 1 } });
    expect(await job.outcome).toMatchObject({ kind: "may_have_run" }); // past the LEASED write the bot hears "may have run"
    expect((await waiting)?.body).toEqual({ jobs: [] }); // the open long poll was answered at once, by the revoke
    expect((await ok(call(rig, "POST", `/api/phones/self/jobs/${job.operationId}/result`, { body: { leaseToken: lease.leaseToken, ok: true, result: OK_RESULT } }))).status).toBe(403);
    // every phone route of that device now answers 403 revoked, with the same valid door envelope
    for (const [method, target] of SELF_ROUTES.filter(([m]) => m !== "DELETE")) {
      const refused = await ok(call(rig, method, target.replace("00000000-0000-4000-8000-000000000001", job.operationId), { body: method === "PUT" ? REGISTRATION : { offerId: offer.offerId } }));
      expect(refused, `${method} ${target}`).toEqual({ status: 403, body: { error: "revoked" } });
    }
    expect(rig.registry.get(A)).toBeNull();
    expect(rig.registry.chooseFor("calendar")).toBeNull();
  });
  it("re-registration of a barred device is refused and stores nothing; a forced request for it is never offered", async () => {
    const rig = makeRig(newDbFile());
    await register(rig);
    await ok(call(rig, "POST", "/api/phones/revoke", { companion: true, device: null, body: { deviceId: A, reason: "switch-off" } }));
    expect(await register(rig)).toEqual({ status: 403, body: { error: "revoked" } });
    expect(rig.registry.get(A)).toBeNull();
    const forced = open(rig);
    expect((await ok(call(rig, "GET", "/api/phones/self/jobs"))).status).toBe(403);
    expect(await settled(forced.outcome)).toBe("pending");
  });
  it("POST /api/phones/minted clears the barrier: PUT stores the registration and a new job is offered", async () => {
    const rig = makeRig(newDbFile());
    await register(rig);
    await ok(call(rig, "POST", "/api/phones/revoke", { companion: true, device: null, body: { deviceId: A, reason: "removed" } }));
    expect((await ok(call(rig, "POST", "/api/phones/minted", { companion: true, device: null, body: { deviceId: A } })))).toEqual({ status: 200, body: { ok: true } });
    expect((await register(rig)).status).toBe(200);
    open(rig);
    expect((await pollOnce(rig)).jobs).toHaveLength(1);
  });
  it("minted with scope ask answers ok and leaves the jobs barrier alone (the ask side is the generation, which only grows)", async () => {
    const rig = makeRig(newDbFile());
    await register(rig);
    await ok(call(rig, "POST", "/api/phones/revoke", { companion: true, device: null, body: { deviceId: A, reason: "removed" } }));
    expect((await ok(call(rig, "POST", "/api/phones/minted", { companion: true, device: null, body: { deviceId: A, scope: "ask" } })))).toEqual({ status: 200, body: { ok: true } });
    expect(rig.revocations.barred(A)).toBe(true);
    expect((await ok(call(rig, "POST", "/api/phones/minted", { companion: true, device: null, body: { deviceId: A, scope: "jobs" } })))).toEqual({ status: 200, body: { ok: true } });
    expect(rig.revocations.barred(A)).toBe(false);
    expect((await ok(call(rig, "POST", "/api/phones/minted", { companion: true, device: null, body: { deviceId: A, scope: "other" } }))).status).toBe(400);
  });
  it("revoke and minted refuse a malformed body, and revoke answers 0 for a device with nothing open", async () => {
    const rig = makeRig(newDbFile());
    for (const body of [{}, { deviceId: "bad id" }, { deviceId: A, reason: "other" }, { deviceId: A }]) {
      expect((await ok(call(rig, "POST", "/api/phones/revoke", { companion: true, device: null, body }))).status).toBe(400);
    }
    expect((await ok(call(rig, "POST", "/api/phones/minted", { companion: true, device: null, body: { deviceId: "bad id" } }))).status).toBe(400);
    expect((await ok(call(rig, "POST", "/api/phones/revoke", { companion: true, device: null, body: { deviceId: A, reason: "removed" } }))).body).toEqual({ revoked: 0 });
    expect(rig.revocations.barred(A)).toBe(true);
  });
  it("DELETE /api/phones/self revokes the device's jobs, removes the registration and bars it (switch-off); a second DELETE is 200 too", async () => {
    const rig = makeRig(newDbFile());
    await register(rig);
    const job = open(rig);
    expect((await ok(call(rig, "DELETE", "/api/phones/self"))).status).toBe(200);
    expect(await job.outcome).toMatchObject({ kind: "did_not_run" });
    expect(rig.registry.get(A)).toBeNull();
    expect(rig.revocations.barred(A)).toBe(true);
    expect((await ok(call(rig, "DELETE", "/api/phones/self"))).status).toBe(200);
    expect((await register(rig)).status).toBe(403);
  });
  it("durable after a restart: a new registry, revocations and route deps on the same messages.db still refuse PUT, poll, lease and result; minted clears it", async () => {
    const file = newDbFile();
    const before = makeRig(file);
    await register(before);
    await ok(call(before, "POST", "/api/phones/revoke", { companion: true, device: null, body: { deviceId: A, reason: "removed" } }));
    before.db.close();
    const after = makeRig(file);
    const op = "00000000-0000-4000-8000-0000000000aa";
    for (const [method, target, body] of [
      ["PUT", "/api/phones/self", REGISTRATION], ["GET", "/api/phones/self/jobs", undefined],
      ["POST", `/api/phones/self/jobs/${op}/lease`, { offerId: op }], ["POST", `/api/phones/self/jobs/${op}/result`, { leaseToken: "x".repeat(43), ok: true }],
      ["GET", `/api/phones/self/jobs/${op}`, undefined], ["POST", "/api/phones/self/foreground", { active: false }],
    ] as const) {
      expect(await ok(call(after, method, target, { body })), `${method} ${target}`).toEqual({ status: 403, body: { error: "revoked" } });
    }
    expect(after.registry.get(A)).toBeNull();
    await ok(call(after, "POST", "/api/phones/minted", { companion: true, device: null, body: { deviceId: A } }));
    expect((await register(after)).status).toBe(200);
  });
});

describe("abrupt restart after LEASED (Astra AS8)", () => {
  it("the old operation id answers 409, the targeted read is unknown, the poll is empty, nothing is re-offered and no activity row or result reaches the thread", async () => {
    const file = newDbFile();
    const before = makeRig(file);
    await register(before);
    const job = open(before);
    const offer = (await pollOnce(before)).jobs[0]!;
    const lease = (await ok(call(before, "POST", `/api/phones/self/jobs/${job.operationId}/lease`, { body: { offerId: offer.offerId } }))).body as any;
    expect(lease.active).toBe(true);
    // the old instance is dropped, shutdown() is never called
    before.db.close();
    const after = makeRig(file);
    expect((await ok(call(after, "POST", `/api/phones/self/jobs/${job.operationId}/result`, { body: { leaseToken: lease.leaseToken, ok: true, result: OK_RESULT } }))).status).toBe(409);
    expect((await ok(call(after, "GET", `/api/phones/self/jobs/${job.operationId}`))).body).toEqual({ handled: true, reason: "unknown" });
    const waiting = call(after, "GET", "/api/phones/self/jobs");
    after.advance(20_000);
    expect((await waiting)?.body).toEqual({ jobs: [] });
    expect(after.rows).toEqual([]);
    expect(before.rows).toEqual([]);
    expect(await settled(job.outcome)).toBe("pending");
  });
});

describe("POST /api/phones/ask-revoke (S32): the door's send", () => {
  const send = (rig: { revocations: AskRevocations }, body: unknown, over: { method?: string; companion?: boolean; read?: () => Promise<unknown> } = {}) =>
    askRevokeRoute({ method: over.method ?? "POST", companion: over.companion ?? true, readBody: over.read ?? (async () => body) }, rig.revocations);
  const fresh = () => ({ revocations: new AskRevocations(openDb(newDbFile())) });

  it("answers exactly 200 { ok: true }, which is the only answer the door dequeues on, and persists through", async () => {
    const rig = fresh();
    expect(await send(rig, { deviceId: A, through: 4 })).toEqual({ status: 200, body: { ok: true } });
    expect(rig.revocations.refuses(A, 4)).toBe(true);
    expect(rig.revocations.refuses(A, 5)).toBe(false);
  });
  it("keeps the maximum when a lower through arrives later", async () => {
    const rig = fresh();
    await send(rig, { deviceId: A, through: 9 });
    expect((await send(rig, { deviceId: A, through: 2 })).status).toBe(200);
    expect(rig.revocations.refuses(A, 9)).toBe(true);
    expect(rig.revocations.refuses(A, 10)).toBe(false);
  });
  it("is companion only", async () => {
    const rig = fresh();
    expect((await send(rig, { deviceId: A, through: 1 }, { companion: false })).status).toBe(403);
    expect(rig.revocations.refuses(A, 1)).toBe(false);
  });
  it("answers non-200 on a bad body, an unreadable body, a wrong method, and a failed write, and stores nothing", async () => {
    const rig = fresh();
    for (const bad of [null, {}, { deviceId: A }, { deviceId: A, through: -1 }, { deviceId: A, through: 1.5 }, { deviceId: A, through: "3" }, { deviceId: "a b", through: 1 }, { deviceId: A, through: 1, extra: true }, { deviceId: A, through: Number.MAX_SAFE_INTEGER + 1 }]) {
      expect((await send(rig, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await send(rig, null, { read: async () => { throw new Error("bad json"); } })).status).toBe(400);
    expect((await send(rig, { deviceId: A, through: 1 }, { method: "GET" })).status).toBe(405);
    expect(rig.revocations.refuses(A, 0)).toBe(false);
    const broken = { apply: () => { throw new Error("disk"); } } as unknown as AskRevocations;
    expect((await askRevokeRoute({ method: "POST", companion: true, readBody: async () => ({ deviceId: A, through: 1 }) }, broken)).status).toBe(500);
  });
  it("a jobs-style or ask mint through /api/phones/minted never deletes through", async () => {
    const rig = makeRig(newDbFile());
    const asks = new AskRevocations(rig.db);
    asks.apply(A, 6);
    await ok(call(rig, "POST", "/api/phones/minted", { companion: true, device: null, body: { deviceId: A, scope: "ask" } }));
    await ok(call(rig, "POST", "/api/phones/minted", { companion: true, device: null, body: { deviceId: A } }));
    expect(asks.refuses(A, 6)).toBe(true);
    expect(asks.refuses(A, 7)).toBe(false);
  });
});
