// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Tester feedback, the desktop half (UX lane L-FB). The "?" panel's "Tell us what was confusing" posts to
// POST /api/feedback (feedback-routes.ts); this module checks the body against the allowlist, adds the install id, app
// version and OS, and sends it to the control plane's POST /v1/owner-feedback within 10 seconds.
//
// What is sent: the screen's name, its settings page, its gates and controls, one of three fixed sentences, app version,
// OS, surface and a random install id. Every text field must equal a value in shared/feedback-fixed.json, the same tables
// the form builds from, so owner text, a name, a record id, a path or an email has no field to travel in, whoever calls
// this route. The schema is strict at every level, so a field that is not in the contract is refused, never dropped; the
// control plane holds the same tables and refuses the same way.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import fixed from "../shared/feedback-fixed.json" with { type: "json" };
import { writeFileAtomic } from "./atomic.ts";
import { TEXT_RULES } from "./redact.ts";

export const FEEDBACK_DEADLINE_MS = 10_000;
export const FEEDBACK_MAX_BODY_BYTES = 16 * 1024;

// ── the contract (handoffs/HANDOFF-1012-UX-L-FB.md; L4A's FeedbackForm.tsx sends it) ──
const id = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9:._-]+$/);
const oneOf = (values: readonly string[]) => z.string().refine((value) => values.includes(value));
const FIXED_TITLES = new Map(Object.entries(fixed.titles));
const FIXED_GATES = new Map(Object.entries(fixed.gates));
const FIXED_CONTROLS = new Map(Object.entries(fixed.controls));

export const feedbackStateSchema = z.strictObject({
  page: oneOf(fixed.pages).optional(),
  gates: z.array(
    z.strictObject({ id: id(80), reason: z.string() }).refine((gate) => FIXED_GATES.get(gate.id) === gate.reason),
  ).max(20).optional(),
});

export const feedbackRequestSchema = z.strictObject({
  surface: z.enum(["desktop", "phone", "cloud"]),
  screen: id(80),
  title: z.string(),
  state: feedbackStateSchema,
  controls: z.array(
    z.strictObject({ id: id(80), label: z.string(), address: z.string() }).refine((control) => {
      const known = FIXED_CONTROLS.get(control.id);
      return known?.label === control.label && known.address === control.address;
    }),
  ).max(60),
  words: oneOf(fixed.words),
  createdAt: z.iso.datetime(),
}).refine((request) => FIXED_TITLES.get(request.screen) === request.title);
export type FeedbackRequest = z.infer<typeof feedbackRequestSchema>;

export type FeedbackReason = "offline" | "timeout" | "rate_limited" | "refused" | "unavailable" | "too_long";
export type FeedbackResult = { sent: true } | { sent: false; reason: FeedbackReason };

// ── what the server adds ──
export type FeedbackOs = "macos" | "windows" | "linux";
export function feedbackOs(platform: NodeJS.Platform = process.platform): FeedbackOs {
  return platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux";
}

/** The same rule as the control plane's: a release number, with a short release-candidate tag at most. */
const APP_VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[a-z]{1,8}\.?\d{0,4})?$/;
export function feedbackAppVersion(raw: string | undefined = process.env.MURAGE_APP_VERSION): string {
  const value = (raw ?? "").trim();
  return APP_VERSION.test(value) ? value : "dev";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** A random id kept in the data folder (classified in data-dir-inventory.ts, never backed up). It identifies nothing but
 *  this install's notes; the control plane keeps only a peppered hash of it. Made again when missing or unreadable. */
export function feedbackInstallId(dataDir: string): string {
  const path = join(dataDir, "feedback-install-id");
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (UUID.test(existing)) return existing;
  } catch {
    // missing or unreadable: make one
  }
  const fresh = randomUUID();
  try {
    writeFileAtomic(path, `${fresh}\n`, { mode: 0o600 });
  } catch {
    // a read-only data folder still sends feedback; the id is just new next time
  }
  return fresh;
}

/** Where the control plane is. The packaged app uses production; MURAGE_CONTROL_PLANE_URL may name staging (qualification
 *  and the L4A packaged check) and nothing else, so a stray variable cannot send a report to some other host. */
export const FEEDBACK_ORIGINS = Object.freeze({
  prod: "https://accounts.murage.ai",
  staging: "https://murage-control-plane-staging.sean-874.workers.dev",
});
export function feedbackEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.MURAGE_CONTROL_PLANE_URL ?? "").trim().replace(/\/+$/, "");
  const known: readonly string[] = Object.values(FEEDBACK_ORIGINS);
  const origin = known.includes(configured) ? configured : FEEDBACK_ORIGINS.prod;
  return `${origin}/v1/owner-feedback`;
}

// ── scrubbing (first pass; the control plane scrubs again) ──
const REDACTED = /«redacted \d+ chars»/g;
export const REMOVED = "[removed]";
/** Private-key blocks go first and whole, header and all; a header with no footer takes the rest of the field with it.
 *  redact.ts masks only a closed block (its job is logs); a half-pasted key in feedback is still a key. */
const PEM_OPEN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const PEM_CLOSE = /-----END [A-Z ]*PRIVATE KEY-----/g;
function removePemBlocks(input: string): string {
  let out = "";
  let pos = 0;
  for (;;) {
    PEM_OPEN.lastIndex = pos;
    const open = PEM_OPEN.exec(input);
    if (!open) break;
    PEM_CLOSE.lastIndex = open.index + open[0].length;
    const close = PEM_CLOSE.exec(input);
    if (!close) return `${out}${input.slice(pos, open.index)}${REMOVED}`;
    out += `${input.slice(pos, open.index)}${REMOVED}`;
    pos = close.index + close[0].length;
  }
  return out + input.slice(pos);
}
/** Every rule at every length: redactSecretsInText skips text under 8 characters, and `?key=ab` is a whole credential. */
export function scrubFeedbackText(value: string): string {
  if (!value) return value;
  let out = removePemBlocks(value);
  for (const [, rule] of TEXT_RULES) out = rule(out);
  return out.replace(REDACTED, REMOVED);
}

/** An id shaped like a secret (id characters do not exclude `ghp_...`) is replaced whole; "removed" still passes the id rules. */
export const REMOVED_ID = "removed";
export const scrubFeedbackId = (value: string): string => (scrubFeedbackText(value) === value ? value : REMOVED_ID);

/** The contract's limits, applied again after the scrub, which can lengthen text ("?key=a" becomes "?key=[removed]"). */
const clip = (value: string, max: number) => (value.length > max ? value.slice(0, max) : value);

export function scrubbedRequest(input: FeedbackRequest): FeedbackRequest {
  const s = input.state;
  return {
    ...input,
    screen: scrubFeedbackId(input.screen),
    title: clip(scrubFeedbackText(input.title), 120),
    words: clip(scrubFeedbackText(input.words), 2_000),
    state: {
      ...(s.page === undefined ? {} : { page: clip(scrubFeedbackText(s.page), 80) }),
      ...(s.gates === undefined ? {} : { gates: s.gates.map((g) => ({ id: scrubFeedbackId(g.id), reason: clip(scrubFeedbackText(g.reason), 200) })) }),
    },
    controls: input.controls.map((c) => ({
      id: scrubFeedbackId(c.id),
      label: clip(scrubFeedbackText(c.label), 120),
      address: clip(scrubFeedbackText(c.address), 200),
    })),
  };
}

/** The outbound body, checked against the contract once more and against the control plane's 16 KB cap. */
export function outboundBody(payload: FeedbackRequest & { installId: string; appVersion: string; os: FeedbackOs }): string | null {
  if (!feedbackRequestSchema.safeParse(stripAdded(payload)).success) return null;
  const text = JSON.stringify(payload);
  return Buffer.byteLength(text, "utf8") <= FEEDBACK_MAX_BODY_BYTES ? text : null;
}
function stripAdded(payload: Record<string, unknown>): Record<string, unknown> {
  const { installId: _i, appVersion: _a, os: _o, ...rest } = payload;
  return rest;
}

// ── the send ──
export interface FeedbackRelayDeps {
  fetch?: typeof fetch;
  installId: () => string;
  appVersion?: string;
  os?: FeedbackOs;
  endpoint?: string;
  deadlineMs?: number;
}

async function readSmallJSON(response: Response, maxBytes: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; }
}

export function reasonForStatus(status: number): FeedbackReason {
  if (status === 429) return "rate_limited";
  if (status >= 400 && status < 500) return "refused";
  return "unavailable";
}

const ACCEPTED = z.object({ ok: z.literal(true), id: z.string().min(1).max(64) });

/** Send one checked item. Never throws: every failure is a reason the form can show, and the owner's draft stays. */
export async function relayFeedback(input: FeedbackRequest, deps: FeedbackRelayDeps): Promise<FeedbackResult> {
  const deadlineMs = deps.deadlineMs ?? FEEDBACK_DEADLINE_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(0, deadlineMs));
  try {
    const payload = {
      installId: deps.installId(),
      appVersion: deps.appVersion ?? feedbackAppVersion(),
      os: deps.os ?? feedbackOs(),
      ...scrubbedRequest(input),
    };
    const text = outboundBody(payload);
    if (text === null) return { sent: false, reason: "too_long" };
    const response = await (deps.fetch ?? fetch)(deps.endpoint ?? feedbackEndpoint(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: text,
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { sent: false, reason: reasonForStatus(response.status) };
    }
    // Only the control plane's own answer counts as sent: a proxy's 200 page is not a stored item.
    const answer = await readSmallJSON(response, 4_096);
    return ACCEPTED.safeParse(answer).success ? { sent: true } : { sent: false, reason: "unavailable" };
  } catch {
    return { sent: false, reason: timedOut ? "timeout" : "offline" };
  } finally {
    clearTimeout(timer);
  }
}
