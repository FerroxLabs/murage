// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The fresh-code step for an owner browser on a Cloud home. The shared api() helper hands every 403 here. A refusal with
// code "email_code" opens a small dialog (OwnerCodeDialog), asks the home to send a 6-digit code, waits for the owner to
// type it, trades it for a proof, and gives api() the headers to send the exact original request once more.
// Anywhere but a Cloud home page this does nothing, and any other answer passes through api() untouched.
//
// Wire (home-local): POST /api/cloud/owner-code/send {actToken} -> {challengeId, maskedEmail, resendIn}; 429 {error:"rate", retryIn, limit:"gap"|"day"}; 503 {code:"code_unavailable"}
//                    POST /api/cloud/owner-code/verify {actToken, challengeId, code} -> {proof:{payload,signature}}
//                    retry carries x-murage-owner-proof: base64url(JSON proof).
import { homeMeta } from "./cloud-home-meta";
import { uxCloud, type CloudUxKey } from "./cloud-ux-copy";

export const OWNER_PROOF_HEADER = "x-murage-owner-proof";
export const SEND_PATH = "/api/cloud/owner-code/send";
export const VERIFY_PATH = "/api/cloud/owner-code/verify";
/** A 429 says which limit it is: `limit: "day"` is the daily one, anything else is the short gap between codes. */
const dailyLimit = (body: unknown): boolean => record(body) && body.limit === "day";

export type OwnerCodeFailure = "cancelled" | "changed" | "unavailable" | "too_many";
/** What api() throws when the code step ends without a proof. status and body match the 403 the caller would have seen. */
export class OwnerCodeError extends Error {
  readonly status = 403;
  readonly body: Record<string, unknown>;
  constructor(readonly ownerCode: OwnerCodeFailure, message: string, body: Record<string, unknown> = {}) {
    super(message);
    this.name = "OwnerCodeError";
    this.body = body;
  }
}
const failure = (kind: OwnerCodeFailure, key: CloudUxKey, body?: Record<string, unknown>) => new OwnerCodeError(kind, uxCloud(key), body);

export interface EmailCodeRefusal { actToken: string; label?: string; labelArg?: string }
type Answer = { status: number; body: any };
export interface OwnerCodeDeps {
  post(path: string, body: unknown): Promise<Answer>;
  now(): number;
  onHomePage(): boolean;
}

/** True only on a page a Cloud home served (it writes the murage-home-id meta tag). */
export function onCloudHomePage(doc: Pick<Document, "querySelector"> | undefined = typeof document === "undefined" ? undefined : document): boolean {
  return doc !== undefined && homeMeta(doc).homeId !== null;
}

export const defaultDeps: OwnerCodeDeps = {
  async post(path, body) {
    const res = await fetch(path, { method: "POST", cache: "no-store", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  },
  now: () => Date.now(),
  onHomePage: () => onCloudHomePage(),
};

const record = (value: unknown): value is Record<string, any> => typeof value === "object" && value !== null && !Array.isArray(value);

export function readEmailCodeRefusal(status: number, body: unknown): EmailCodeRefusal | null {
  if (status !== 403 || !record(body) || body.code !== "email_code" || typeof body.actToken !== "string" || body.actToken === "") return null;
  return { actToken: body.actToken, ...(typeof body.label === "string" ? { label: body.label } : {}), ...(typeof body.labelArg === "string" ? { labelArg: body.labelArg } : {}) };
}

/** The words after "Enter it to": keyed by the label the home gave, generic for anything unknown. */
export function actSentence(label: string | undefined, labelArg: string | undefined): string {
  const key = `ux.cloud.ownerCode.act.${label ?? "other"}` as CloudUxKey;
  const text: string = (uxCloud(key) as string | undefined) ?? uxCloud("ux.cloud.ownerCode.act.other");
  const arg = labelArg && labelArg.trim() !== "" ? labelArg.trim().slice(0, 60) : uxCloud("ux.cloud.ownerCode.thisBot");
  return text.replace("{arg}", arg);
}

export function encodeProof(proof: { payload: string; signature: string }): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ payload: proof.payload, signature: proof.signature }));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── the dialog's state ─────────────────────────────────────────────────
export interface OwnerCodeSession {
  phase: "sending" | "ready" | "checking";
  maskedEmail: string;
  act: string;
  /** ms epoch before which "Send a new code" stays off. */
  resendAt: number;
  error: string;
}
let session: OwnerCodeSession | null = null;
const listeners = new Set<() => void>();
let controls: { submit(code: string): void; resend(): void; cancel(): void } | null = null;
const publish = (next: OwnerCodeSession | null) => { session = next; for (const listener of listeners) listener(); };
export const getOwnerCodeSession = (): OwnerCodeSession | null => session;
export function subscribeOwnerCode(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export const ownerCodeActions = {
  submit: (code: string) => controls?.submit(code),
  resend: () => controls?.resend(),
  cancel: () => controls?.cancel(),
};

async function sendCode(refusal: EmailCodeRefusal, deps: OwnerCodeDeps): Promise<{ challengeId: string; maskedEmail: string; resendIn: number }> {
  let answer: Answer;
  try { answer = await deps.post(SEND_PATH, { actToken: refusal.actToken }); } catch { throw failure("unavailable", "ux.cloud.ownerCode.couldNotSend"); }
  const { status, body } = answer;
  if (status === 200 && record(body) && typeof body.challengeId === "string" && body.challengeId !== "") {
    return { challengeId: body.challengeId, maskedEmail: typeof body.maskedEmail === "string" ? body.maskedEmail : "", resendIn: Number.isFinite(Number(body.resendIn)) ? Math.max(0, Number(body.resendIn)) : 30 };
  }
  if (status === 403 && record(body) && body.code === "fresh_auth_changed") throw failure("changed", "ux.cloud.ownerCode.changed", body);
  if (status === 429) throw dailyLimit(body) ? failure("too_many", "ux.cloud.ownerCode.tooMany") : failure("unavailable", "ux.cloud.ownerCode.couldNotSend");
  throw failure("unavailable", "ux.cloud.ownerCode.couldNotSend");
}

let queue: Promise<unknown> = Promise.resolve();
/** Runs the dialog and resolves to the x-murage-owner-proof header value. One flow at a time; a second refusal waits its turn. */
export function runOwnerCodeFlow(refusal: EmailCodeRefusal, deps: OwnerCodeDeps = defaultDeps): Promise<string> {
  const run = queue.then(() => flow(refusal, deps), () => flow(refusal, deps));
  queue = run.catch(() => undefined);
  return run;
}

async function flow(refusal: EmailCodeRefusal, deps: OwnerCodeDeps): Promise<string> {
  const act = actSentence(refusal.label, refusal.labelArg);
  let state: OwnerCodeSession = { phase: "sending", maskedEmail: "", act, resendAt: 0, error: "" };
  const update = (patch: Partial<OwnerCodeSession>) => { state = { ...state, ...patch }; publish(state); };
  publish(state);
  try {
    let sent = await sendCode(refusal, deps);
    update({ phase: "ready", maskedEmail: sent.maskedEmail, resendAt: deps.now() + sent.resendIn * 1000 });
    return await new Promise<string>((resolve, reject) => {
      controls = {
        cancel: () => reject(failure("cancelled", "ux.cloud.ownerCode.cancelled")),
        resend: () => {
          if (state.phase !== "ready" || deps.now() < state.resendAt) return;
          update({ phase: "sending", error: "" });
          sendCode(refusal, deps).then((next) => { sent = next; update({ phase: "ready", maskedEmail: next.maskedEmail || state.maskedEmail, resendAt: deps.now() + next.resendIn * 1000 }); }, (cause: unknown) => {
            if (cause instanceof OwnerCodeError && cause.ownerCode === "changed") { reject(cause); return; }
            update({ phase: "ready", error: cause instanceof Error ? cause.message : uxCloud("ux.cloud.ownerCode.couldNotSend") });
          });
        },
        submit: (code) => {
          if (state.phase !== "ready" || !/^\d{6}$/.test(code)) return;
          update({ phase: "checking", error: "" });
          deps.post(VERIFY_PATH, { actToken: refusal.actToken, challengeId: sent.challengeId, code }).then(({ status, body }) => {
            const proof = record(body) ? body.proof : undefined;
            if (status === 200 && record(proof) && typeof proof.payload === "string" && typeof proof.signature === "string") { resolve(encodeProof({ payload: proof.payload, signature: proof.signature })); return; }
            const reason = record(body) ? body.error : undefined;
            if (status === 400 && reason === "wrong") { update({ phase: "ready", error: uxCloud("ux.cloud.ownerCode.wrong") }); return; }
            if (status === 400 && reason === "expired") { update({ phase: "ready", error: uxCloud("ux.cloud.ownerCode.expired"), resendAt: 0 }); return; }
            if (status === 400 && reason === "locked") { update({ phase: "ready", error: uxCloud("ux.cloud.ownerCode.locked"), resendAt: 0 }); return; }
            if (status === 403 && record(body) && body.code === "fresh_auth_changed") { reject(failure("changed", "ux.cloud.ownerCode.changed", body)); return; }
            if (status === 429) { if (dailyLimit(body)) reject(failure("too_many", "ux.cloud.ownerCode.tooMany")); else update({ phase: "ready", error: uxCloud("ux.cloud.ownerCode.couldNotSend") }); return; }
            reject(failure("unavailable", "ux.cloud.ownerCode.unavailable"));
          }, () => reject(failure("unavailable", "ux.cloud.ownerCode.unavailable")));
        },
      };
    });
  } finally {
    controls = null;
    publish(null);
  }
}

function plainHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (typeof Headers !== "undefined" && headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...(headers as Record<string, string>) };
}
const hasProof = (headers: HeadersInit | undefined) => Object.keys(plainHeaders(headers)).some((name) => name.toLowerCase() === OWNER_PROOF_HEADER);

/**
 * api() calls this for every answer that is not ok. null means "not mine": api() carries on exactly as before. Otherwise it
 * resolves to the init for the one retry, or throws an OwnerCodeError whose message is plain words for the owner.
 * Nothing happens off a Cloud home page, for any status but 403, or for a 403 whose code is not ours.
 */
export async function ownerCodeRetryInit(init: RequestInit | undefined, status: number, body: unknown, deps: OwnerCodeDeps = defaultDeps): Promise<RequestInit | null> {
  if (status !== 403 || !record(body) || (body.code !== "email_code" && body.code !== "fresh_auth_changed")) return null;
  if (!deps.onHomePage()) return null;
  // The changed request: no new mail until the owner presses Allow again.
  if (body.code === "fresh_auth_changed") throw failure("changed", "ux.cloud.ownerCode.changed", body);
  // Only once: a retry that already carries a proof and is refused again is an ordinary refusal.
  if (hasProof(init?.headers)) return null;
  const refusal = readEmailCodeRefusal(status, body);
  if (!refusal) return null;
  const proof = await runOwnerCodeFlow(refusal, deps);
  return { ...init, headers: { ...plainHeaders(init?.headers), [OWNER_PROOF_HEADER]: proof } };
}
