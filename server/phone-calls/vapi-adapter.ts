// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The vendor-neutral adapter interface (BOT-CALLS-1020 3e) and the Vapi adapter (sections 2, 3b, 3c, 3d, 8).
// Every vendor response goes through an allowlist projection at parse time: the `monitor` object (listenUrl, controlUrl) and
// any unknown field are dropped before anything is stored, logged or returned. Vendor text never leaves this file: errors are
// a fixed list of codes.
import { PHONE_KEY_ORIGIN, _heldPhoneKeyForSend } from "./phone-secrets.ts";
import { buildOpening, callTemplate, type PhoneCallSettings, type Revision } from "./settings.ts";

export type PhoneErrorCode = "abandoned" | "not_confirmed" | "not_set_up" | "settings_pending" | "vendor_refused" | "vendor_unreachable" | "not_found" | "cancelled";
export class PhoneCallError extends Error {
  readonly code: PhoneErrorCode;
  readonly httpStatus?: number;
  // No parameter properties: the server runs under Node type stripping (strip-only mode).
  constructor(code: PhoneErrorCode, httpStatus?: number) { super(code); this.code = code; if (httpStatus !== undefined) this.httpStatus = httpStatus; }
}

export interface CallRequest { operationId?: string; to: string; goal: string; details: string; limits: string; language: string; when?: string }
/** The allowlisted shape every adapter returns. Nothing else about a vendor call exists past the adapter. */
export interface ProjectedCall {
  vendorId: string;
  status?: string;
  endedReason?: string;
  createdAt?: string;
  startedAt?: string;
  endedAt?: string;
  cost?: number;
  structured?: Record<string, unknown>;
  transcript?: string;
}
export interface PhoneNumberInfo { id: string; number: string; canCallOut: boolean }
export type SettingKey = "aiLine" | "notice" | "language" | "maxSeconds" | "voice" | "recordAudio" | "schedule" | "monitorOff" | "noWebhook" | "endCallOnly";

export interface PhoneAdapter {
  readonly vendor: string;
  readonly supportedLanguages: readonly string[];
  /** Per setting: does this adapter apply it on every call (3e)? */
  readonly capabilities: Readonly<Record<SettingKey, boolean>>;
  setup(): Promise<{ numbers: PhoneNumberInfo[] }>;
  applySettings(revision: Revision): Promise<string>;
  deleteAssistant(assistantId: string): Promise<void>;
  start(request: CallRequest, revision: Revision): Promise<ProjectedCall>;
  reconcile?(operationId: string): Promise<ProjectedCall | undefined>;
  status(vendorId: string): Promise<ProjectedCall>;
  result(vendorId: string): Promise<ProjectedCall>;
  cancel(vendorId: string): Promise<void>;
}

export const ALL_SETTINGS: readonly SettingKey[] = ["aiLine", "notice", "language", "maxSeconds", "voice", "recordAudio", "schedule", "monitorOff", "noWebhook", "endCallOnly"];

/** Fail closed (3e): a call starts only when the adapter applies every owner setting plus the hygiene. */
export function assertAdapterHonoursAll(adapter: PhoneAdapter): void {
  for (const key of ALL_SETTINGS) if (adapter.capabilities[key] !== true) throw new PhoneCallError("vendor_refused");
}

// ---- HTTP: one origin, HTTPS only, redirects refused, key added at send time. ----

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; redirect: "error" }) => Promise<{ status: number; json(): Promise<unknown> }>;

export async function phoneVendorFetch(fetchImpl: FetchLike, method: string, path: string, body?: unknown): Promise<unknown> {
  if (!/^\/[A-Za-z0-9/_-]*$/.test(path) || path.includes("//")) throw new PhoneCallError("vendor_refused");
  const url = new URL(path, PHONE_KEY_ORIGIN);
  if (url.origin !== PHONE_KEY_ORIGIN || url.protocol !== "https:") throw new PhoneCallError("vendor_refused");
  const key = _heldPhoneKeyForSend(url.origin);
  if (!key) throw new PhoneCallError("not_set_up");
  let res: { status: number; json(): Promise<unknown> };
  try {
    res = await fetchImpl(url.href, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error" });
  } catch {
    throw new PhoneCallError("vendor_unreachable");
  }
  // A redirect is refused even if a fetch implementation surfaced it instead of throwing.
  if (res.status >= 300 && res.status < 400) throw new PhoneCallError("vendor_refused", res.status);
  if (res.status === 404) throw new PhoneCallError("not_found", 404);
  if (res.status >= 400) throw new PhoneCallError(res.status >= 500 ? "vendor_unreachable" : "vendor_refused", res.status); // body never read
  try { return await res.json(); } catch { return {}; }
}

// ---- Allowlist projection (3b). ----

const str = (v: unknown, max = 200): string | undefined => (typeof v === "string" && v.length <= max ? v : undefined);

export function projectVapiCall(raw: unknown): ProjectedCall {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PhoneCallError("vendor_refused");
  const r = raw as Record<string, unknown>;
  const vendorId = str(r.id);
  if (!vendorId) throw new PhoneCallError("vendor_refused");
  const out: ProjectedCall = { vendorId };
  const status = str(r.status, 40); if (status) out.status = status;
  const ended = str(r.endedReason, 80); if (ended) out.endedReason = ended;
  for (const k of ["createdAt", "startedAt", "endedAt"] as const) { const v = str(r[k], 40); if (v) out[k] = v; }
  if (typeof r.cost === "number" && Number.isFinite(r.cost)) out.cost = r.cost;
  const analysis = r.analysis && typeof r.analysis === "object" ? (r.analysis as Record<string, unknown>) : undefined;
  if (analysis?.structuredData && typeof analysis.structuredData === "object" && !Array.isArray(analysis.structuredData)) {
    const sd = analysis.structuredData as Record<string, unknown>;
    const kept: Record<string, unknown> = {};
    for (const k of ["outcome", "reason", "reference", "time"]) if (typeof sd[k] === "string") kept[k] = sd[k];
    out.structured = kept;
  }
  const artifact = r.artifact && typeof r.artifact === "object" ? (r.artifact as Record<string, unknown>) : undefined;
  const transcript = str(artifact?.transcript, 200_000) ?? str(r.transcript, 200_000);
  if (transcript) out.transcript = transcript;
  return out;
}

// ---- Bodies. ----

export const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    outcome: { type: "string", enum: ["done", "not_done", "no_answer", "voicemail", "busy", "failed"] },
    reason: { type: "string", enum: ["closed", "fully_booked", "needs_owner", "refused", "other"] },
    reference: { type: "string" },
    time: { type: "string" },
  },
} as const;
const MONITOR_OFF = { listenEnabled: false, controlEnabled: false } as const;
// One clear default voice per language (section 2), Azure neural voices as in Vapi's multilingual guide (docs.vapi.ai/customization/
// multilingual, read 2026-11-05). "multilingual-auto" is Vapi's documented automatic Azure pick, used only for a language with no default.
export const DEFAULT_VOICES: Readonly<Record<string, string>> = {
  en: "en-US-AriaNeural", de: "de-DE-KatjaNeural", es: "es-ES-ElviraNeural", fr: "fr-FR-DeniseNeural",
  hi: "hi-IN-SwaraNeural", ja: "ja-JP-NanamiNeural", "pt-br": "pt-BR-FranciscaNeural", zh: "zh-CN-XiaoxiaoNeural",
};
const AUTO_VOICE = "multilingual-auto";
// Deepgram language codes for our app languages (pt-br is spelled pt-BR there).
const DEEPGRAM_LANGUAGE: Readonly<Record<string, string>> = { "pt-br": "pt-BR" };

function voiceFor(settings: PhoneCallSettings, language: string): Record<string, string> {
  return { provider: "azure", voiceId: settings.voices[language] ?? DEFAULT_VOICES[language] ?? AUTO_VOICE };
}
function transcriberFor(settings: PhoneCallSettings, language: string): Record<string, string> {
  const fixed = DEEPGRAM_LANGUAGE[language] ?? language;
  return settings.language === "auto" ? { provider: "deepgram", model: "nova-3", language: "multi" } : { provider: "deepgram", model: "nova-3", language: fixed };
}

/** One immutable assistant per revision. Monitoring off, no `server`, end-call only, the section-4 analysis schema. */
export function vapiAssistantBody(revision: Revision): Record<string, unknown> {
  const s = revision.settings;
  return {
    name: `Murage caller r${revision.number}`,
    model: { provider: "openai", model: "gpt-4o", messages: [{ role: "system", content: callTemplate(s) }], tools: [{ type: "endCall" }] },
    maxDurationSeconds: s.maxSeconds,
    artifactPlan: { recordingEnabled: s.recordAudio },
    monitorPlan: { ...MONITOR_OFF },
    analysisPlan: { structuredDataPlan: { enabled: true, schema: ANALYSIS_SCHEMA } },
  };
}

export function vapiCallBody(request: CallRequest, revision: Revision): Record<string, unknown> {
  const s = revision.settings;
  const opening = buildOpening(s, request.language);
  const overrides: Record<string, unknown> = {
    firstMessageMode: opening.firstMessageMode,
    maxDurationSeconds: s.maxSeconds,
    artifactPlan: { recordingEnabled: s.recordAudio },
    voice: voiceFor(s, request.language),
    transcriber: transcriberFor(s, request.language),
    monitorPlan: { ...MONITOR_OFF },
    variableValues: { goal: request.goal, details: request.details, limits: request.limits, language: request.language },
  };
  if (opening.firstMessage !== undefined) overrides.firstMessage = opening.firstMessage;
  const body: Record<string, unknown> = { assistantId: revision.assistantId, phoneNumberId: s.phoneNumberId, customer: { number: request.to }, assistantOverrides: overrides };
  if (request.operationId) body.name = request.operationId;
  if (request.when) body.schedulePlan = { earliestAt: request.when };
  return body;
}

/** Read back what is about to be sent (3e): every owner setting, the schedule and the hygiene must be present, else refuse. */
export function verifyCallBody(body: Record<string, unknown>, request: CallRequest, revision: Revision): void {
  const o = body.assistantOverrides as Record<string, unknown> | undefined;
  const s = revision.settings;
  const opening = buildOpening(s, request.language);
  const ok = !!o && body.assistantId === revision.assistantId && !!revision.assistantId
    && o.firstMessageMode === opening.firstMessageMode && o.firstMessage === opening.firstMessage
    && o.maxDurationSeconds === s.maxSeconds
    && (o.artifactPlan as Record<string, unknown>)?.recordingEnabled === s.recordAudio
    && (o.monitorPlan as Record<string, unknown>)?.listenEnabled === false && (o.monitorPlan as Record<string, unknown>)?.controlEnabled === false
    && (o.variableValues as Record<string, unknown>)?.language === request.language
    && !("server" in body) && !("server" in o)
    && (request.when ? (body.schedulePlan as Record<string, unknown>)?.earliestAt === request.when : !("schedulePlan" in body));
  if (!ok) throw new PhoneCallError("vendor_refused");
}

export const VAPI_LANGUAGES = ["en", "de", "es", "fr", "hi", "ja", "pt-br", "zh", "it", "nl", "ko", "ru", "pl", "tr", "vi", "id"] as const;

export class VapiAdapter implements PhoneAdapter {
  readonly vendor = "vapi";
  readonly supportedLanguages = VAPI_LANGUAGES;
  readonly capabilities = Object.fromEntries(ALL_SETTINGS.map((k) => [k, true])) as Record<SettingKey, boolean>;
  private readonly fetchImpl: FetchLike;
  constructor(fetchImpl: FetchLike) { this.fetchImpl = fetchImpl; }

  async setup(): Promise<{ numbers: PhoneNumberInfo[] }> {
    const raw = await phoneVendorFetch(this.fetchImpl, "GET", "/phone-number");
    const list = Array.isArray(raw) ? raw : [];
    const numbers: PhoneNumberInfo[] = [];
    for (const n of list) {
      if (!n || typeof n !== "object") continue;
      const r = n as Record<string, unknown>;
      const id = str(r.id); const number = str(r.number, 32);
      if (!id || !number) continue;
      // The no-cost Vapi numbers take incoming calls only.
      numbers.push({ id, number, canCallOut: r.provider !== "vapi" });
    }
    return { numbers };
  }

  async applySettings(revision: Revision): Promise<string> {
    const raw = await phoneVendorFetch(this.fetchImpl, "POST", "/assistant", vapiAssistantBody(revision));
    const id = raw && typeof raw === "object" ? str((raw as Record<string, unknown>).id) : undefined;
    if (!id) throw new PhoneCallError("vendor_refused");
    return id;
  }

  async deleteAssistant(assistantId: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(assistantId)) throw new PhoneCallError("vendor_refused");
    await phoneVendorFetch(this.fetchImpl, "DELETE", `/assistant/${assistantId}`);
  }

  async start(request: CallRequest, revision: Revision): Promise<ProjectedCall> {
    assertAdapterHonoursAll(this);
    const body = vapiCallBody(request, revision);
    verifyCallBody(body, request, revision);
    return projectVapiCall(await phoneVendorFetch(this.fetchImpl, "POST", "/call", body));
  }

  /** Vapi's documented name field correlates a lost create response. Absence is never proof of failure. */
  async reconcile(operationId: string): Promise<ProjectedCall | undefined> {
    const raw = await phoneVendorFetch(this.fetchImpl, "GET", "/call");
    if (!Array.isArray(raw)) return undefined;
    const matches = raw.filter(r => r && typeof r === "object" && r.name === operationId);
    return matches.length === 1 ? projectVapiCall(matches[0]) : undefined;
  }

  async status(vendorId: string): Promise<ProjectedCall> { return this.result(vendorId); }

  async result(vendorId: string): Promise<ProjectedCall> {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(vendorId)) throw new PhoneCallError("not_found");
    return projectVapiCall(await phoneVendorFetch(this.fetchImpl, "GET", `/call/${vendorId}`));
  }

  /** Deletes the scheduled call so it never rings (ended reason scheduled-call-deleted). Pinned in fixtures. */
  async cancel(vendorId: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(vendorId)) throw new PhoneCallError("not_found");
    await phoneVendorFetch(this.fetchImpl, "DELETE", `/call/${vendorId}`);
  }
}
