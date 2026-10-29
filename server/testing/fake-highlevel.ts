// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test support: a scripted fake of the HighLevel API and of the broker's lease source, modelled on
// server/testing/fake-flux-email.ts. Nothing here reaches a network: FakeHighLevel is handed to HighLevelClient as its
// fetch. Each script matches a method and a path pattern and answers once (or always); an unscripted call is recorded
// and answered 418, so a test can assert that nothing it did not expect was sent. Canned shapes follow OpenMausBot
// server/testing/fake-highlevel.ts, including the noise fields the real API adds.
import { HIGHLEVEL_TOOL_NAMES, HIGHLEVEL_TOOLKIT, type HighLevelCeiling, type NativeGrant } from "../../shared/highlevel.ts";
import { accessRoleBinding } from "../bot-access-role.ts";
import { InternalCapabilities, type InternalCapability } from "../internal-capabilities.ts";
import type { HighLevelAccessBot } from "../highlevel/access.ts";
import { HighLevelActions, type ActionReview } from "../highlevel/actions.ts";
import { HighLevelClient, type HighLevelConnectionView, type HighLevelLease, type HighLevelLeaseRequest, type HighLevelLeaseSource } from "../highlevel/client.ts";
import { HighLevelHost, HighLevelTurnSignals } from "../highlevel/host.ts";

export type FakeReply =
  | { status: number; body?: unknown; headers?: Record<string, string>; bytes?: number }
  | "reset"
  | "timeout"
  | ((request: FakeRequest) => FakeReply | Promise<FakeReply>);

export interface FakeRequest { method: string; path: string; query: URLSearchParams; headers: Record<string, string>; body: unknown; host: string; redirect?: string }
interface Script { method: string; path: RegExp; reply: FakeReply; times: number }

export const FAKE_LOCATION_ID = "loc_fixture_01";
export const FAKE_COMPANY_ID = "co_fixture_01";

export class FakeHighLevel {
  readonly requests: FakeRequest[] = [];
  readonly unexpected: FakeRequest[] = [];
  private readonly scripts: Script[] = [];
  /** When set, a bearer not in this set gets 401 Invalid JWT, the way an expired token is answered. */
  validTokens: Set<string> | null = null;

  on(method: string, path: RegExp, reply: FakeReply, times = 1): this { this.scripts.push({ method, path, reply, times }); return this; }
  always(method: string, path: RegExp, reply: FakeReply): this { return this.on(method, path, reply, Number.POSITIVE_INFINITY); }
  /** Put a one-shot reply ahead of every standing script. */
  first(method: string, path: RegExp, reply: FakeReply): this { this.scripts.unshift({ method, path, reply, times: 1 }); return this; }
  calls(method?: string, path?: RegExp): FakeRequest[] {
    return this.requests.filter((request) => (!method || request.method === method) && (!path || path.test(request.path)));
  }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[name.toLowerCase()] = value;
    const request: FakeRequest = {
      method: (init?.method ?? "GET").toUpperCase(), path: url.pathname, query: url.searchParams, headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined, host: url.host, redirect: init?.redirect,
    };
    this.requests.push(request);
    const bearer = /^Bearer (.+)$/u.exec(headers.authorization ?? "")?.[1];
    if (this.validTokens && (!bearer || !this.validTokens.has(bearer))) return json(401, { statusCode: 401, message: "Invalid JWT" });
    const script = this.scripts.find((item) => item.times > 0 && item.method === request.method && item.path.test(request.path));
    if (!script) { this.unexpected.push(request); return json(418, { error: "unscripted" }); }
    script.times--;
    let reply = script.reply;
    while (typeof reply === "function") reply = await reply(request);
    if (reply === "reset") throw new TypeError("fetch failed: socket hang up");
    if (reply === "timeout") {
      const signal = init?.signal;
      return new Promise<Response>((_, reject) => {
        if (signal?.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    if (reply.bytes !== undefined) {
      // A body of exactly this many bytes, streamed in 64 KiB chunks, with no length header to trust.
      let left = reply.bytes;
      const chunk = new Uint8Array(64 * 1024).fill(0x20);
      const stream = new ReadableStream<Uint8Array>({ pull(controller) { if (left <= 0) { controller.close(); return; } const size = Math.min(left, chunk.length); left -= size; controller.enqueue(chunk.subarray(0, size)); } });
      return new Response(stream, { status: reply.status, headers: reply.headers });
    }
    const body = reply.body === undefined ? null : typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return new Response(reply.status === 204 || (reply.status >= 300 && reply.status < 400 && body === null) ? null : body, { status: reply.status, headers: reply.headers });
  }) as typeof fetch;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ---- canned replies ---------------------------------------------------------------------------------------------------

export const rateLimited = (retryAfterSeconds: number, extra: Record<string, string> = {}): FakeReply =>
  ({ status: 429, body: { message: "Too many requests" }, headers: { "retry-after": String(retryAfterSeconds), "x-ratelimit-remaining": "0", ...extra } });
export const serverError = (status = 503): FakeReply => ({ status, body: { message: `fixture ${status}` } });
export const expiredToken: FakeReply = { status: 401, body: { statusCode: 401, message: "Invalid JWT" } };
export const missingScope: FakeReply = { status: 401, body: { statusCode: 401, message: "The token is not authorized for this scope." } };
export const malformedSuccess: FakeReply = { status: 200, body: "{not json", headers: { "content-type": "application/json" } };
export const redirectTo = (location: string): FakeReply => ({ status: 302, headers: { location } });
export const oversized = (bytes: number): FakeReply => ({ status: 200, bytes, headers: { "content-type": "application/json" } });

export const RAW_CONTACT = (id: string, extra: Record<string, unknown> = {}) => ({
  id, locationId: FAKE_LOCATION_ID, firstName: "Ada", lastName: "Lovelace", name: "Ada Lovelace", email: "ada@fixture.test",
  emailLowerCase: "ada@fixture.test", phone: "+15550001234", companyName: "Analytical Engines", tags: ["vip", "newsletter"], source: "web form",
  assignedTo: "user_1", dateAdded: "2026-01-02T03:04:05.000Z", dateUpdated: "2026-02-03T04:05:06.000Z", address1: "1 Engine Row", city: "London", country: "GB",
  dnd: false, dndSettings: { Email: { status: "inactive" } }, type: "lead", attributionSource: { url: "https://x.test", ip: "10.0.0.1" },
  customFields: [{ id: "cf_lead", value: "Referral" }],
  ...extra,
});

/** Standing answers for the ordinary reads and changes, so a test scripts only what it is about. */
export function scriptCrm(fake: FakeHighLevel): FakeHighLevel {
  return fake
    .always("POST", /^\/contacts\/search$/u, { status: 200, body: { contacts: [RAW_CONTACT("contact_1")], total: 1 } })
    .always("GET", /^\/locations\/[^/]+\/customFields$/u, { status: 200, body: { customFields: [{ id: "cf_lead", name: "Lead source", fieldKey: "contact.lead_source", dataType: "TEXT" }] } })
    .always("GET", /^\/contacts\/[^/]+\/notes$/u, { status: 200, body: { notes: [{ id: "note_1", body: "Called back" }] } })
    .always("POST", /^\/contacts\/[^/]+\/notes$/u, { status: 201, body: { note: { id: "note_new", body: "fixture" } } })
    .always("POST", /^\/contacts\/[^/]+\/tags$/u, { status: 201, body: { tags: ["vip", "fixture"] } })
    .always("GET", /^\/contacts\/[^/]+$/u, { status: 200, body: { contact: RAW_CONTACT("contact_1") } })
    .always("GET", /^\/opportunities\/pipelines$/u, { status: 200, body: { pipelines: [{ id: "pipe_1", name: "Sales", stages: [{ id: "stage_new", name: "New", position: 0 }] }] } })
    .always("GET", /^\/locations\/[^/]+$/u, { status: 200, body: { location: { id: FAKE_LOCATION_ID, name: "Fixture Dental", timezone: "Europe/London" } } });
}

// ---- the broker's lease source ------------------------------------------------------------------------------------------

export interface FakeRotation { connectionId: string; fromVersion: number; reason: HighLevelLeaseRequest["reason"] }

/** Stands in for the broker: answers lease requests from its own token state, refreshing (a rotation) when the token
 * is inside the 60 s margin or the request says the last one expired. It records every lease and rotation request. */
export class FakeLeaseSource implements HighLevelLeaseSource {
  readonly views = new Map<string, HighLevelConnectionView>();
  readonly tokens = new Map<string, { accessToken: string; version: number; providerExpiresAt: number }>();
  readonly leaseRequests: HighLevelLeaseRequest[] = [];
  readonly rotations: FakeRotation[] = [];
  /** Every token this source ever issued and has not replaced, for FakeHighLevel.validTokens. */
  readonly live = new Set<string>();
  /** When set, a lease answer waits for this before it is returned (the broker has recorded the rotation as sent). */
  hold: Promise<void> | null = null;
  /** Hand back a lease for this connection instead (a broker bug or a reconnect to another sign-in). */
  substitute: Partial<HighLevelLease> | null = null;
  now: () => number;

  constructor(options: { now?: () => number } = {}) { this.now = options.now ?? Date.now; }

  add(view: Partial<HighLevelConnectionView> & { connectionId: string }, token: { expiresInMs?: number } = {}): HighLevelConnectionView {
    const full: HighLevelConnectionView = { locationId: FAKE_LOCATION_ID, companyId: FAKE_COMPANY_ID, locationName: "Fixture Dental", epoch: 1, state: "connected", ...view };
    this.views.set(full.connectionId, full);
    const accessToken = `hl_access_${full.connectionId}_v1`;
    this.tokens.set(full.connectionId, { accessToken, version: 1, providerExpiresAt: this.now() + (token.expiresInMs ?? 24 * 60 * 60_000) });
    this.live.add(accessToken);
    return full;
  }

  /** Runs on every status read, e.g. to press Stop during asynchronous call setup. */
  onConnection: (() => void) | null = null;

  async connection(connectionId: string): Promise<HighLevelConnectionView | undefined> {
    this.onConnection?.();
    const view = this.views.get(connectionId);
    return view ? { ...view } : undefined;
  }

  async lease(request: HighLevelLeaseRequest): Promise<HighLevelLease> {
    this.leaseRequests.push({ ...request });
    const view = this.views.get(request.connectionId);
    const token = this.tokens.get(request.connectionId);
    if (!view || !token || (view.state !== "connected" && view.state !== "degraded") || view.epoch !== request.connectionEpoch) throw new Error("not leasable");
    if (request.reason === "expired" || token.providerExpiresAt - this.now() < 60_000) {
      this.rotations.push({ connectionId: request.connectionId, fromVersion: token.version, reason: request.reason });
      this.live.delete(token.accessToken);
      token.version += 1;
      token.accessToken = `hl_access_${request.connectionId}_v${token.version}`;
      token.providerExpiresAt = this.now() + 24 * 60 * 60_000;
      this.live.add(token.accessToken);
    }
    if (this.hold) await this.hold;
    return {
      leaseId: `lease_${this.leaseRequests.length}`, requestId: request.requestId, connectionId: view.connectionId, connectionEpoch: view.epoch,
      locationId: view.locationId, companyId: view.companyId, credentialVersion: token.version, accessToken: token.accessToken,
      providerExpiresAt: token.providerExpiresAt, discardAt: this.now() + 60_000,
      ...this.substitute,
    };
  }
}

// ---- a whole host against the fakes ---------------------------------------------------------------------------------------

export const FAKE_CONNECTION_ID = "hl_conn_1";

/** A HighLevel host wired to FakeHighLevel and FakeLeaseSource, with one live owner turn (bot_1, thread_1, gen_1).
 * Sleeps are manual when `manualSleep`: they wait until release() (or Stop) so a test can act mid-wait. stop() does
 * what index.ts revokeInternalGeneration does for HighLevel: revoke the turn's capability and fire its signal. */
export function highLevelHarness(options: { manualSleep?: boolean; ceiling?: HighLevelCeiling; deadlineMs?: number; tokenExpiresInMs?: number } = {}) {
  let now = 1_800_000_000_000;
  const clock = () => now;
  const sleeps: Array<{ ms: number; release: () => void }> = [];
  const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
    const release = () => { now += ms; resolve(); };
    if (!options.manualSleep) { release(); return; }
    sleeps.push({ ms, release });
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
  const capabilities = new InternalCapabilities({ now: clock });
  const signals = new HighLevelTurnSignals();
  const bot: HighLevelAccessBot = { id: "bot_1", name: "Sales bot", composio: true };
  const grant = (ceiling: HighLevelCeiling = options.ceiling ?? "propose", accountId = FAKE_CONNECTION_ID): NativeGrant =>
    ({ toolkit: HIGHLEVEL_TOOLKIT, accountId, tools: [...HIGHLEVEL_TOOL_NAMES], botId: bot.id, revision: 1, ceiling });
  const saveAccess = (grants = [grant()], revision = 1) => { bot.highlevelAccess = { revision, roleBinding: accessRoleBinding(bot), grants }; };
  saveAccess();
  const leases = new FakeLeaseSource({ now: clock });
  leases.add({ connectionId: FAKE_CONNECTION_ID }, { expiresInMs: options.tokenExpiresInMs });
  const api = new FakeHighLevel();
  const client = new HighLevelClient({ leases, fetch: api.fetch, now: clock, sleep, deadlineMs: options.deadlineMs ?? 50 });
  const actions = new HighLevelActions({ now: clock });
  const reviews: ActionReview[] = [];
  const host = new HighLevelHost({ capabilities, signals, bot: (id) => (id === bot.id ? bot : undefined), leases, client, actions, onReview: (_claim, review) => { reviews.push(review); } });
  const turn = (generation = "gen_1", extra: Partial<InternalCapability> = {}, threadId = "thread_1"): InternalCapability => {
    capabilities.begin(bot.id, threadId, generation);
    const token = capabilities.mint({ botId: bot.id, threadId, generation, kind: "highlevel", depth: 0, skillAuthoring: false, ...extra });
    return capabilities.resolve(`Bearer ${token}`)!;
  };
  const claim = turn();
  return {
    get now() { return now; }, advance: (ms: number) => { now += ms; },
    sleeps, releaseSleeps: () => { for (const entry of sleeps.splice(0)) entry.release(); },
    capabilities, signals, bot, grant, saveAccess, leases, api, client, actions, reviews, host, claim, turn,
    stop: (generation = claim.generation, threadId = "thread_1") => { capabilities.revokeGeneration(threadId, generation); signals.turnEnded(generation); },
    /** Releases manual sleeps until `promise` settles (bounded). */
    settle: async <T>(promise: Promise<T>): Promise<T> => {
      for (let i = 0; i < 200; i++) {
        const done = await Promise.race([promise.then((value) => ({ value })), new Promise<null>((resolve) => setImmediate(() => resolve(null)))]);
        if (done) return done.value;
        for (const entry of sleeps.splice(0)) entry.release();
      }
      throw new Error("call never settled");
    },
    approveNext: async () => {
      await until(() => reviews.length > 0);
      const review = reviews.shift()!;
      actions.approve(review.actionId, review.reviewDigest);
      return review;
    },
  };
}

/** Lets pending promises run until `ready` holds (bounded). */
export async function until(ready: () => boolean, rounds = 500): Promise<void> {
  for (let i = 0; i < rounds && !ready(); i++) await new Promise((resolve) => setImmediate(resolve));
  if (!ready()) throw new Error("condition never held");
}
