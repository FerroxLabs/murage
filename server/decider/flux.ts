// Copyright OpenMausBot contributors
// SPDX-License-Identifier: Apache-2.0
//
// NOTICE: lifted from OpenMausBot (Apache-2.0), adapted for Murage and Flux Router.
//
// Flux Router decision backend: POST {base}/decide with a Bearer key and
// { model: "flux-decide", state, questions }. Flux answers 422 without the
// model field. Questions use `instructions` + `criteria`.
//
// Every answer is checked in parse.ts before anyone acts on it. Error bodies
// are never read: they can echo the request.
import { createHash } from "node:crypto";

import { FLUX_OPENAI_BASE } from "../flux-routing.ts";
import { fluxCallHeaders, isFluxUrl } from "../flux-memory-headers.ts";
import { parseDecideResponse } from "./parse.ts";
import type { BackendRequest, BackendResult, DeciderBackend, DeciderQuestion } from "./types.ts";

export const FLUX_DECIDE_BASE_URL = FLUX_OPENAI_BASE;
export const FLUX_DECIDE_MODEL = "flux-decide";
/** Ask Flux not to keep the text, as the browser checker does
 * (browser-action-checker-connection.ts NO_RETAIN_HEADER), and to leave the
 * memory features out of a routing call. The reply MUST echo
 * `x-flux-no-retain: applied` (see PRIVACY_ECHO_*): without it the answer is
 * discarded and content-bearing calls stop until a probe shows the echo. */
export const DECIDE_PRIVACY_HEADERS = Object.freeze({
  "x-flux-no-retain": "1",
  "x-flux-memory-capture": "off",
  "x-flux-memory-inject": "off",
}) as Readonly<Record<string, string>>;
export const PRIVACY_ECHO_HEADER = "x-flux-no-retain";
export const PRIVACY_ECHO_VALUE = "applied";
/** While latched, at most one synthetic probe per this interval. */
export const PRIVACY_PROBE_INTERVAL_MS = 30_000;
export const DECIDE_MAX_OPTIONS = 255;
export const DECIDE_MIN_LEVELS = 2;
export const DECIDE_MAX_LEVELS = 10;

/** Strict loopback host check, shared by HTTP admission and default-key
 * selection. Accepts `localhost`, `::1`, and a real dotted-quad IPv4 literal
 * in 127.0.0.0/8. A DNS name that merely starts with "127." is not loopback. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  return octets.every((n) => n <= 255) && octets[0] === 127;
}

export function isLoopbackUrl(value: string): boolean {
  try {
    return isLoopbackHostname(new URL(value).hostname);
  } catch {
    return false;
  }
}

/** The endpoint for a base URL, or null when the key must not be sent there:
 * https anywhere, plain http only to this machine (a test double). */
export function decideEndpoint(baseUrl?: string | null): URL | null {
  const root = (baseUrl?.trim() || FLUX_DECIDE_BASE_URL).replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(`${root}/decide`);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === "https:") return url;
  return url.protocol === "http:" && isLoopbackHostname(url.hostname) ? url : null;
}

/** Questions within the API's limits: 2–255 options, 2–10 levels. */
export function questionsFit(questions: Record<string, DeciderQuestion>): boolean {
  const entries = Object.entries(questions);
  if (!entries.length) return false;
  return entries.every(([, question]) => {
    if (question.type === "choice") {
      const count = Object.keys(question.options).length;
      return count >= 2 && count <= DECIDE_MAX_OPTIONS;
    }
    if (question.type === "score") return question.levels.length >= DECIDE_MIN_LEVELS && question.levels.length <= DECIDE_MAX_LEVELS;
    return true;
  });
}

type WireQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } };

export function decideRequestBody(state: unknown, questions: Record<string, DeciderQuestion>) {
  const wire: Record<string, WireQuestion> = {};
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === "choice") {
      wire[id] = { type: "choice", instructions: question.instructions, criteria: { ...question.options } };
    } else if (question.type === "score") {
      wire[id] = { type: "score", instructions: question.instructions, criteria: [...question.levels] };
    } else {
      const criteria = question.criteria?.yes || question.criteria?.no
        ? { ...(question.criteria.yes ? { true: question.criteria.yes } : {}), ...(question.criteria.no ? { false: question.criteria.no } : {}) }
        : undefined;
      wire[id] = { type: "noul", instructions: question.instructions, ...(criteria ? { criteria } : {}) };
    }
  }
  return { state, model: FLUX_DECIDE_MODEL, questions: wire };
}

function refusal(status: number): BackendResult {
  if (status === 401) return { ok: false, reason: "rejected", status };
  // The decide capability is not enabled for this account (yet): same as off.
  if (status === 403 || status === 404) return { ok: false, reason: "disabled", status };
  if (status === 429) return { ok: false, reason: "rate_limited", status };
  if (status === 529 || status === 503) return { ok: false, reason: "overloaded", status };
  return { ok: false, reason: "http_error", status };
}

/** True only when a 403 body names `paid_plan_required`. Reads at most 4 KB,
 * keeps nothing else from it (error bodies can echo the request). */
async function isPlanRefusal(response: Response): Promise<boolean> {
  try {
    const raw = (await response.text()).slice(0, 4_096);
    const find = (value: unknown, depth: number): boolean => {
      if (typeof value === "string") return value === "paid_plan_required";
      if (depth > 3 || !value || typeof value !== "object") return false;
      return Object.values(value).some((inner) => find(inner, depth + 1));
    };
    return find(JSON.parse(raw), 0);
  } catch {
    return false;
  }
}

/** In-memory privacy latch. Set when a decision response lacks the no-retain
 * echo; while set, no request carrying room text is sent. Tied to the endpoint
 * and key it was set for, so a change of either clears it. */
let latch: { signature: string; lastProbeAt: number } | null = null;

function latchSignature(endpoint: URL, key: string): string {
  return `${endpoint.href}|${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

export function privacyLatched(): boolean {
  return latch !== null;
}

export function resetPrivacyLatch(): void {
  latch = null;
}

/** Flux gets its memory headers and the whole privacy set (privacy last, so the
 * echo contract always holds). Any other host gets only the no-retain request
 * its echo is checked against: x-flux-memory-* names Flux's memory and never
 * leaves for a host that is not Flux. */
function decideHeaders(endpoint: URL): Record<string, string> {
  if (isFluxUrl(endpoint)) return { ...fluxCallHeaders("decider"), ...DECIDE_PRIVACY_HEADERS };
  return { [PRIVACY_ECHO_HEADER]: DECIDE_PRIVACY_HEADERS[PRIVACY_ECHO_HEADER]! };
}
const echoApplied = (response: Response) => response.headers.get(PRIVACY_ECHO_HEADER) === PRIVACY_ECHO_VALUE;
const PRIVACY_FAILED: BackendResult = { ok: false, reason: "privacy_contract_failed" };

/** A request with no room content at all: it only asks whether the echo is back. */
async function probePrivacyContract(endpoint: URL, request: BackendRequest): Promise<boolean> {
  try {
    const response = await request.fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${request.key}`, "content-type": "application/json", accept: "application/json", ...decideHeaders(endpoint) },
      body: JSON.stringify(decideRequestBody({ probe: "privacy-contract" }, { answer: { type: "choice", instructions: "Which option is first?", options: { a: "Option A.", b: "Option B." } } })),
      signal: request.signal,
      redirect: "error",
    });
    const applied = response.ok && echoApplied(response);
    await response.body?.cancel().catch(() => undefined);
    return applied;
  } catch {
    return false;
  }
}

async function decide(request: BackendRequest): Promise<BackendResult> {
  const endpoint = decideEndpoint(request.baseUrl);
  if (!endpoint || !questionsFit(request.questions)) return { ok: false, reason: "misconfigured" };
  const signature = latchSignature(endpoint, request.key);
  if (latch && latch.signature !== signature) latch = null;
  if (latch) {
    const now = Date.now();
    if (now - latch.lastProbeAt < PRIVACY_PROBE_INTERVAL_MS) return PRIVACY_FAILED;
    latch.lastProbeAt = now;
    if (!(await probePrivacyContract(endpoint, request))) return PRIVACY_FAILED;
    latch = null;
  }
  let response: Response;
  try {
    response = await request.fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${request.key}`, "content-type": "application/json", accept: "application/json", ...decideHeaders(endpoint) },
      body: JSON.stringify(decideRequestBody(request.state, request.questions)),
      signal: request.signal,
      // Never replay the key to wherever a redirect points.
      redirect: "error",
    });
  } catch {
    // The caller tells a timeout or a Stop from a dead network by its own signals.
    return { ok: false, reason: "unreachable" };
  }
  if (!response.ok) {
    if (response.status === 403 && (await isPlanRefusal(response))) return { ok: false, reason: "plan_required", status: 403 };
    await response.body?.cancel().catch(() => undefined);
    return refusal(response.status);
  }
  if (!echoApplied(response)) {
    // The text may already have been kept: discard the answer and stop sending text.
    await response.body?.cancel().catch(() => undefined);
    latch = { signature, lastProbeAt: Date.now() };
    return PRIVACY_FAILED;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const parsed = parseDecideResponse(body, request.questions);
  return parsed.ok ? parsed : { ok: false, reason: "malformed" };
}

export const fluxBackend: DeciderBackend = { id: "flux", decide };
