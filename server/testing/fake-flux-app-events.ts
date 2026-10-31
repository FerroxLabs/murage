// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Test support: a scripted fake of Flux connected-app events v1 (contracts/app-events/v1), handed to the client as its
// fetch. Modelled on fake-flux-email.ts: each script matches a method and a path and answers once (or always); an
// unscripted call is recorded and answered 418, so a test can assert that nothing it did not expect was called. Nothing
// here reaches a network, and no Flux key exists in it.
//
// Two contract rules hold whatever is scripted:
//   - every error body is the D-11 envelope, with the status and retryable flag errors.json gives the code;
//   - POST /runs/{id}/reserve with a child ceiling other than the integer 0 is 422 child_ceiling_not_zero.
// `runProtocol()` adds a small stateful Flux for reserve/start/renew/get: first-start-only newlyStarted and
// Idempotency-Key replay (same key and body returns the recorded answer). Finish is not scripted: run settlement
// moved to AT-S2.
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { bodyDigest } from "../../shared/app-trigger-canonical.mjs";
import { FakeFlux, type FakeReply, type FakeRequest } from "./fake-flux-email.ts";

const FIXTURES = new URL("../../test/fixtures/flux-app-events-v1/", import.meta.url);
export const fixture = <T = unknown>(path: string): T => JSON.parse(readFileSync(new URL(path, FIXTURES), "utf8")) as T;

interface ErrorRow { code: string; httpStatus: number; retryable: boolean; class: string }
const ERRORS = new Map(fixture<ErrorRow[]>("errors.json").map(row => [row.code, row] as const));
const requestId = () => `ae_${createHash("sha256").update(randomUUID()).digest("hex").slice(0, 24)}`;

/** A D-11 error reply for a code from errors.json (status and retryable come from the fixture). */
export function appEventError(code: string, options: { retryAfterSec?: number } = {}): FakeReply {
  const row = ERRORS.get(code);
  if (!row) throw new Error(`not an errors.json code: ${code}`);
  const error: Record<string, unknown> = { code, retryable: row.retryable, requestId: requestId() };
  if (row.retryable && options.retryAfterSec !== undefined) error.retryAfterSec = options.retryAfterSec;
  return { status: row.httpStatus, body: { version: 1, error } };
}

/** GET /capabilities from the FINAL limits.json. */
export function capabilitiesReply(overrides: { contractRevision?: number; drop?: string[]; eventTypesListed?: number } = {}): FakeReply {
  const limits = { ...fixture<{ limits: Record<string, number> }>("limits.json").limits };
  for (const key of overrides.drop ?? []) delete limits[key];
  return { status: 200, body: { version: 1, contractRevision: overrides.contractRevision ?? 1, grantPurposes: ["home_enroll", "subscription_activate", "billing_bind"], limits, eventTypesListed: overrides.eventTypesListed ?? 3 } };
}

/** One claim item built from a DRAFT catalogue example (projection shape only). */
export function claimItemFromCatalog(eventType: "gmail.message.new" | "github.issue.opened" | "slack.channel.message", options: { deliveryId?: string; subscriptionId: string; sourceKey?: string; occurredAt?: string; deadlineAt?: string; catchUp?: boolean }) {
  const spec = fixture<{ example: { projection: { fields: Record<string, unknown>; resourceRefs: Array<{ kind: string; id: string }> }; sourceKey: string; occurredAt: string } }>(`catalog/${eventType}.json`);
  const projection = spec.example.projection;
  return {
    deliveryId: options.deliveryId ?? randomUUID(), subscriptionId: options.subscriptionId, eventType, sourceKey: options.sourceKey ?? spec.example.sourceKey,
    occurredAt: options.occurredAt ?? spec.example.occurredAt, deadlineAt: options.deadlineAt ?? "2099-01-01T00:00:00Z", catchUp: options.catchUp ?? false,
    digest: bodyDigest(projection), projection,
  };
}

const RESERVE = /^\/v1\/app-events\/runs\/([^/]+)\/reserve$/;

interface FakeRun { runId: string; state: "reserved" | "working" | "owner_wait" | "finished" | "lapsed"; revision: number; subscriptionId: string; deliveryIds: string[]; billingRef: string; startedAt: string | null; finishedAt: string | null; outcome: string | null }

export class FakeFluxAppEvents extends FakeFlux {
  readonly runs = new Map<string, FakeRun>();
  private readonly recorded = new Map<string, { digest: string; reply: { status: number; body: unknown } }>();

  constructor() {
    super();
    // The contract's reserve refusal comes before any script: a non-zero child ceiling never reaches a reply.
    const inner = this.fetch;
    (this as { fetch: typeof fetch }).fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      if ((init?.method ?? "GET").toUpperCase() === "POST" && RESERVE.test(url.pathname)) {
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>; } catch { /* a malformed body is refused below */ }
        if (body.childCreates !== 0 || body.childHandoffs !== 0) {
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[name.toLowerCase()] = value;
          this.requests.push({ method: "POST", path: url.pathname, query: url.searchParams, headers, body, host: url.host });
          const reply = appEventError("child_ceiling_not_zero") as { status: number; body: unknown };
          return new Response(JSON.stringify(reply.body), { status: reply.status });
        }
      }
      return inner(input, init);
    }) as typeof fetch;
  }

  private view(run: FakeRun, extra: Record<string, unknown> = {}) {
    return { version: 1, runId: run.runId, state: run.state, revision: run.revision, subscriptionId: run.subscriptionId, deliveryIds: [...run.deliveryIds], billingRef: run.billingRef,
      leaseExpiresAt: run.state === "finished" ? null : "2099-01-01T00:00:00Z", startedAt: run.startedAt, finishedAt: run.finishedAt, outcome: run.outcome, ...extra };
  }

  /** Idempotency-Key replay (README "Mutations and idempotency"): same key and digest returns the recorded 2xx. */
  private idempotent(request: FakeRequest, answer: () => { status: number; body: unknown }): FakeReply {
    const key = request.headers["idempotency-key"];
    if (!key || !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(key)) return appEventError("idempotency_key_required");
    const scope = `${request.method} ${request.path} ${key.toLowerCase()}`;
    const digest = bodyDigest(request.body);
    const prior = this.recorded.get(scope);
    if (prior) return prior.digest === digest ? prior.reply : appEventError("idempotency_conflict");
    const reply = answer();
    if (reply.status >= 200 && reply.status < 300) this.recorded.set(scope, { digest, reply });
    return reply;
  }

  /** A stateful run protocol for every run id (always scripts; add scripts before this to inject failures first). */
  runProtocol(): this {
    const runOf = (request: FakeRequest) => this.runs.get(request.path.split("/")[4]!);
    this.always("POST", RESERVE, request => this.idempotent(request, () => {
      const runId = request.path.split("/")[4]!;
      const body = request.body as { subscriptionId: string; deliveryIds: string[]; billingRef: string };
      const existing = this.runs.get(runId);
      if (existing) return { status: 201, body: this.view(existing) };
      const run: FakeRun = { runId, state: "reserved", revision: 1, subscriptionId: body.subscriptionId, deliveryIds: [...body.deliveryIds], billingRef: body.billingRef, startedAt: null, finishedAt: null, outcome: null };
      this.runs.set(runId, run);
      return { status: 201, body: this.view(run) };
    }));
    // README: "POST /runs/{run_id}/start replays always return newlyStarted: false", so a replay is answered from the
    // run's current view, never from the recorded first answer.
    this.always("POST", /\/runs\/[^/]+\/start$/, request => {
      const run = runOf(request);
      if (!run) return appEventError("not_found");
      if (run.state !== "reserved") return { status: 200, body: this.view(run, { newlyStarted: false }) };
      run.state = "working"; run.revision++; run.startedAt = "2026-10-29T00:00:00Z";
      return { status: 200, body: this.view(run, { newlyStarted: true }) };
    });
    this.always("POST", /\/runs\/[^/]+\/renew$/, request => this.idempotent(request, () => {
      const run = runOf(request);
      if (!run) return appEventError("not_found") as { status: number; body: unknown };
      if ((request.body as { expectedRevision?: number }).expectedRevision !== run.revision) return appEventError("revision_conflict") as { status: number; body: unknown };
      run.revision++;
      return { status: 200, body: this.view(run) };
    }));
    this.always("GET", /\/runs\/[^/]+$/, request => {
      const run = runOf(request);
      return run ? { status: 200, body: this.view(run) } : appEventError("not_found");
    });
    return this;
  }

  /** Answer the next claim with these deliveries (and the ack of that claim with what it was sent). */
  claimOnce(deliveries: unknown[], options: { claimId?: string } = {}): string {
    const claimId = options.claimId ?? randomUUID();
    this.on("POST", /\/deliveries\/claim$/, { status: 200, body: { version: 1, claimId, leaseExpiresAt: "2099-01-01T00:00:00Z", deliveries, more: false } });
    return claimId;
  }

  /** Every ack is answered with exactly the receipts it carried. */
  ackEcho(): this {
    this.always("POST", /\/deliveries\/ack$/, request => {
      const body = request.body as { claimId: string; receipts: Array<{ deliveryId: string; disposition: string }> };
      return { status: 200, body: { version: 1, claimId: body.claimId, acked: body.receipts.length, receipts: body.receipts } };
    });
    return this;
  }
}
