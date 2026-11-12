// SPDX-License-Identifier: AGPL-3.0-or-later
// B4: what a Cloud customer reads when the router refuses a turn for credits or because the shared service stopped.
//
// Classified from the RAW answer (status, parsed body, headers), never from an SDK or engine message, and the customer
// never sees the router's own text, a manage link, a key id or a key name: every sentence here is ours, and the only
// value copied out of the answer is the reset date, re-formatted from a parsed timestamp. The shapes come from reading
// router code, with no live capture and an unknown streaming form, so any missing or odd field falls back to the plain
// "try again soon" sentence and never to raw text.
//
//   1. 402, provider_specific_fields.error === "key_budget_reached": this home's credits for the month are used.
//   2. 402 with the X-Flux-Hold-Reason header: the shared service stopped; not the customer's doing (checked first, so
//      a held service is never described as used-up credits).
//   3. 503 key_fence_unavailable: retryable and says nothing about credits.
// A 402 is never retried (server/drivers/retry.ts classifies it as quota, not transient).
import { cloudHomeCopy } from "./copy.ts";
import { FLUX_NOT_READY_COPY, FLUX_SERVICE_HOLD_COPY } from "../../shared/provider-error.ts";

export type FluxRefusalKind = "credits_used" | "service_hold" | "fence_unavailable" | "payment_other";

export interface FluxRefusal {
  kind: FluxRefusalKind;
  /** Customer copy. Fixed sentences plus, at most, a formatted reset date. */
  message: string;
  /** Only the fence answer is worth an automatic retry; a 402 never is. */
  retryable: boolean;
  /** For logs and alarms; never customer copy. Null for the ordinary "credits used" answer. */
  errorCode: string | null;
  /** The reset instant (ISO UTC) when the router sent a readable one. */
  resetsAt: string | null;
}

export interface RawRefusal {
  status?: unknown;
  /** The response body: parsed JSON, or the text of it. */
  body?: unknown;
  /** A Headers object, a plain record, or a list of [name, value] pairs. */
  headers?: unknown;
}

export const FLUX_REFUSAL_CODES = {
  creditsUsed: "cloud_credits_used",
  serviceHold: "cloud_flux_service_hold",
  fenceUnavailable: "cloud_flux_fence_unavailable",
  paymentOther: "cloud_flux_payment_unclassified",
} as const;

const HOLD_HEADER = "x-flux-hold-reason";
const BUDGET_CODE = "key_budget_reached";
const FENCE_CODE = "key_fence_unavailable";
const MAX_DEPTH = 5;

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function parseBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  const text = body.trim();
  if (!text || text.length > 65_536 || !/^[\[{]/.test(text)) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

/** The first `provider_specific_fields` object anywhere near the top of the body. */
function specificFields(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (!isRecord(value) || depth > MAX_DEPTH) return undefined;
  if (isRecord(value.provider_specific_fields)) return value.provider_specific_fields;
  for (const item of Object.values(value)) {
    const found = specificFields(item, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** True when an `error`, `code`, `type` or `error_code` string anywhere in the body is exactly `code`. */
function namesCode(value: unknown, code: string, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  if (typeof value === "string") return depth === 0 && value === code;
  if (Array.isArray(value)) return value.some(item => namesCode(item, code, depth + 1));
  if (!isRecord(value)) return false;
  for (const [name, item] of Object.entries(value)) {
    if (typeof item === "string" && (name === "error" || name === "code" || name === "type" || name === "error_code") && item === code) return true;
    if (typeof item === "object" && namesCode(item, code, depth + 1)) return true;
  }
  return false;
}

function hasHoldHeader(headers: unknown): boolean {
  const present = (text: unknown) => typeof text === "string" && text.trim().length > 0;
  try {
    if (headers && typeof (headers as Headers).get === "function") return present((headers as Headers).get(HOLD_HEADER));
    if (Array.isArray(headers)) return headers.some(pair => Array.isArray(pair) && typeof pair[0] === "string" && pair[0].toLowerCase() === HOLD_HEADER && present(pair[1]));
    if (isRecord(headers)) return Object.entries(headers).some(([name, value]) => name.toLowerCase() === HOLD_HEADER && present(Array.isArray(value) ? value[0] : value));
  } catch { /* an unreadable header set is no evidence */ }
  return false;
}

/** A readable reset instant, re-serialised (so nothing the router wrote is passed on), or null. */
function resetInstant(fields: Record<string, unknown> | undefined): string | null {
  const raw = fields?.resets_at;
  if (typeof raw !== "string" || raw.length > 64) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", timeZone: "UTC" });

/** "You've used this month's credits. They come back on {date}." plus how to carry on, when the home offers a sign-in engine. */
export function creditsUsedMessage(options: { resetsAt?: string | null; carryOn?: boolean } = {}): string {
  const at = options.resetsAt ? new Date(options.resetsAt) : null;
  const when = at && !Number.isNaN(at.getTime()) ? `They come back on ${DATE_FORMAT.format(at)}.` : "They come back when your month resets.";
  return `You've used this month's credits. ${when}${options.carryOn === false ? "" : ` ${cloudHomeCopy.creditsCarryOn}`}`;
}

export const SERVICE_HOLD_MESSAGE = FLUX_SERVICE_HOLD_COPY;
/** The approved Cloud copy for a Flux turn refused with a 402, 401 or 403 that is not a used-up month or a held service (Flux alerts on its own side). */
export const TRY_AGAIN_SOON_MESSAGE = FLUX_NOT_READY_COPY;
const UNFUNDED_CODE = "cloud_home_unfunded";
export const FENCE_UNAVAILABLE_MESSAGE = "That did not go through. Please try again in a moment.";

export interface ClassifyOptions {
  /** The home offers an engine the customer can sign in to (Claude Code, Codex). Defaults to true on a Cloud home. */
  carryOn?: boolean;
  /** The caller knows this answer came from the router, so an unrecognised 402 gets the plain fallback instead of null. */
  fromRouter?: boolean;
  /** The caller is the Fuigo engine: on a Cloud home it only talks to Flux, so a 401 or 403 is Flux's too. */
  owned?: boolean;
}

/**
 * Classify a raw refusal. Null means "not one of ours": the caller keeps whatever it did before (a customer's own provider
 * keeps its own wording). Never returns router text.
 */
export function classifyFluxRefusal(raw: RawRefusal, options: ClassifyOptions = {}): FluxRefusal | null {
  const status = typeof raw.status === "number" ? raw.status : undefined;
  if (status !== 402 && status !== 503 && status !== 401 && status !== 403) return null;
  const body = parseBody(raw.body);
  if (status === 401 || status === 403) {
    // Flux's own refusal of this home's key (including cloud_home_unfunded): the one approved line, no code, no log line of ours.
    return options.fromRouter || options.owned || namesCode(body, UNFUNDED_CODE) || specificFields(body)?.error === UNFUNDED_CODE
      ? { kind: "payment_other", message: TRY_AGAIN_SOON_MESSAGE, retryable: false, errorCode: null, resetsAt: null } : null;
  }
  const carryOn = options.carryOn ?? true;
  if (status === 402) {
    if (hasHoldHeader(raw.headers)) {
      return { kind: "service_hold", message: SERVICE_HOLD_MESSAGE, retryable: false, errorCode: FLUX_REFUSAL_CODES.serviceHold, resetsAt: null };
    }
    const fields = specificFields(body);
    if (fields?.error === BUDGET_CODE) {
      const resetsAt = resetInstant(fields);
      return { kind: "credits_used", message: creditsUsedMessage({ resetsAt, carryOn }), retryable: false, errorCode: null, resetsAt };
    }
    return options.fromRouter || options.owned || namesCode(body, UNFUNDED_CODE) || specificFields(body)?.error === UNFUNDED_CODE
      ? { kind: "payment_other", message: TRY_AGAIN_SOON_MESSAGE, retryable: false, errorCode: FLUX_REFUSAL_CODES.paymentOther, resetsAt: null }
      : null;
  }
  if (namesCode(body, FENCE_CODE) || (specificFields(body)?.error === FENCE_CODE)) {
    return { kind: "fence_unavailable", message: FENCE_UNAVAILABLE_MESSAGE, retryable: true, errorCode: FLUX_REFUSAL_CODES.fenceUnavailable, resetsAt: null };
  }
  return null;
}

/** The same classification for an engine's error object: `error.data` carries `http_status` and, where the engine passes them
 *  on, the body fields and headers. A shape that cannot be read classifies as null (or the plain fallback when `fromRouter`). */
export function classifyFluxRefusalFromRpcError(error: unknown, options: ClassifyOptions = {}): FluxRefusal | null {
  const data = isRecord(error) ? error.data : undefined;
  if (!isRecord(data)) return null;
  const body = data.body ?? data.response ?? data;
  return classifyFluxRefusal({ status: data.http_status ?? data.status, body, headers: data.headers ?? data.response_headers }, options);
}

/** Journal line for an operator alarm: the code and the kind only, never any text from the answer. */
export function fluxRefusalLogLine(refusal: FluxRefusal): string | null {
  return refusal.errorCode ? `Cloud model service refusal errorCode=${refusal.errorCode} kind=${refusal.kind}` : null;
}

/** On a Cloud home only: log the alarm line for the answers that are our side. */
export function reportFluxRefusal(refusal: FluxRefusal, env: NodeJS.ProcessEnv = process.env): void {
  if (env.MURAGE_CLOUD_ROLE !== "home") return;
  const line = fluxRefusalLogLine(refusal);
  if (line) console.error(line);
}
