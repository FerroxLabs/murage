// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The owner's phone call routes (BOT-CALLS-1020 build item 5): `/api/phone-calls*`, answered for the desktop app only. A bot, an
// engine, a channel person, a browser tab or the web build gets 404. Nothing here ever returns or logs the Vapi key: status reports
// only whether one is held. Setup reads the owner's numbers and never dials.
import { phoneCallsSupported, phoneKeyPresent } from "./phone-secrets.ts";
import { APP_LANGUAGES, type PhoneCallSettings } from "./settings.ts";
import type { PhoneCallService } from "./service.ts";

export const PHONE_OWNER_PREFIX = "/api/phone-calls";
export type PhoneOwnerAnswer = { status: number; body: Record<string, unknown> };
export interface PhoneOwnerRequest { method: string; path: string; body?: unknown; desktop: boolean; botCredential: boolean }

const NOT_FOUND: PhoneOwnerAnswer = { status: 404, body: { error: "no such route" } };
const MAX_SECONDS = 60 * 60;

/** Owner settings from the screen, checked field by field; anything malformed is refused, never guessed. */
export function parseOwnerSettings(raw: unknown): PhoneCallSettings | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const line = (v: unknown) => {
    if (!v || typeof v !== "object") return null;
    const l = v as { on?: unknown; edits?: unknown };
    if (typeof l.on !== "boolean") return null;
    const edits: Record<string, string> = {};
    if (l.edits && typeof l.edits === "object") for (const [k, t] of Object.entries(l.edits as Record<string, unknown>)) {
      if (!(APP_LANGUAGES as readonly string[]).includes(k) || typeof t !== "string" || t.length > 300) return null;
      if (t.trim()) edits[k] = t.trim();
    }
    return { on: l.on, edits };
  };
  const aiLine = line(r.aiLine), notice = line(r.notice);
  const language = typeof r.language === "string" && (r.language === "auto" || (APP_LANGUAGES as readonly string[]).includes(r.language)) ? r.language : null;
  const maxSeconds = typeof r.maxSeconds === "number" && Number.isInteger(r.maxSeconds) && r.maxSeconds >= 30 && r.maxSeconds <= MAX_SECONDS ? r.maxSeconds : null;
  const voices: Record<string, string> = {};
  if (r.voices && typeof r.voices === "object") for (const [k, v] of Object.entries(r.voices as Record<string, unknown>)) {
    if (!(APP_LANGUAGES as readonly string[]).includes(k) || typeof v !== "string" || !/^[A-Za-z0-9._:-]{1,80}$/.test(v)) return null;
    voices[k] = v;
  }
  const phoneNumberId = typeof r.phoneNumberId === "string" && /^[A-Za-z0-9-]{1,80}$/.test(r.phoneNumberId) ? r.phoneNumberId : null;
  const ownerName = typeof r.ownerName === "string" && r.ownerName.trim().length <= 80 ? r.ownerName.trim() : null;
  if (!aiLine || !notice || !language || maxSeconds === null || typeof r.recordAudio !== "boolean" || !phoneNumberId || ownerName === null) return null;
  return { aiLine, notice, language, maxSeconds, voices, recordAudio: r.recordAudio, phoneNumberId, ownerName };
}

export async function phoneOwnerRoute(service: () => PhoneCallService, req: PhoneOwnerRequest): Promise<PhoneOwnerAnswer | null> {
  if (req.path !== PHONE_OWNER_PREFIX && !req.path.startsWith(`${PHONE_OWNER_PREFIX}/`)) return null;
  if (!req.desktop || req.botCredential) return NOT_FOUND;
  const { method, path } = req;
  if (path === `${PHONE_OWNER_PREFIX}/status` && method === "GET") {
    const supported = phoneCallsSupported(), keyPresent = phoneKeyPresent();
    if (!supported || !keyPresent) return { status: 200, body: { supported, keyPresent, active: null, olderScheduled: [] } };
    const s = service();
    return { status: 200, body: { supported, keyPresent, active: s.activeSettings(), olderScheduled: s.olderScheduled() } };
  }
  if (!phoneCallsSupported() || !phoneKeyPresent()) return { status: 409, body: { error: "not_set_up" } };
  if (path === `${PHONE_OWNER_PREFIX}/setup` && method === "POST") {
    try { return { status: 200, body: { numbers: (await service().numbers()).numbers } }; }
    catch (error) { return { status: 502, body: { error: (error as { code?: string }).code ?? "vendor_unavailable" } }; }
  }
  if (path === `${PHONE_OWNER_PREFIX}/settings` && method === "PUT") {
    const settings = parseOwnerSettings(req.body);
    if (!settings) return { status: 400, body: { error: "bad_settings" } };
    try { return { status: 200, body: { revision: await service().saveSettings(settings) } }; }
    catch (error) { return { status: 502, body: { error: (error as { code?: string }).code ?? "vendor_unavailable" } }; }
  }
  if (path === PHONE_OWNER_PREFIX && method === "GET") { const s = service(); await s.refreshOwnerCalls(); return { status: 200, body: { calls: s.recentOwnerCards(50) } }; }
  const action = method === "POST" ? path.match(/^\/api\/phone-calls\/([A-Za-z0-9_-]{1,80})\/(cancel|share)$/) : null;
  if (action) {
    if (action[2] === "cancel") {
      const status = await service().cancel(action[1]!);
      return status === "not_found" ? { status: 404, body: { error: "not_found" } } : { status: 200, body: { status } };
    }
    const text = service().sharedTranscript(action[1]!);
    return text === null ? { status: 404, body: { error: "not_found" } } : { status: 200, body: { attachment: { label: "call-transcript.txt", text } } };
  }
  return NOT_FOUND;
}
