// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The server call table and the two engine tools (BOT-CALLS-1020 3b, 3c, 4). Engines see only an opaque Murage call id and the
// section-4 fields. The vendor id, monitor URLs, raw bodies, vendor error text and the transcript stay on the server: the
// vendor id lives in the call table and the owner's dashboard link; the transcript lives in owner-only call storage.
import { randomBytes } from "node:crypto";
import { PhoneCallError, type PhoneAdapter, type PhoneNumberInfo, type ProjectedCall } from "./vapi-adapter.ts";
import { phoneCallsSupported, phoneKeyPresent } from "./phone-secrets.ts";
import { resolveCallLanguage, resolveLanguage, type PhoneCallSettings, type RevisionStore } from "./settings.ts";
import { PHONE_TOOLS } from "../drivers/phone-tool-schemas.ts";
import { forgetAllPhoneTurns, forgetPhoneIntent, phoneAskContext } from "./phone-turns.ts";
import { ANALYSIS_GRACE_MS, type CallRow, type CallScope, type CallStore, type CallWriteOptions, type PhoneAdmissionDeps, type PhoneAskCard, type PhoneAskContext, type PhoneAskTurn, type PhoneCallContext, type PhoneDeleteOutcome, type PhoneOwnerCard, type PhoneRequestIdentity, type PhoneResultCard, type PhoneRetention, type ShippedCallStore, type ToolOutcome } from "./contracts.ts";
import { MemoryCallStore } from "./memory-store.ts";
import { phoneNumberAllowed } from "./number-policy.ts";
import { ownerRequest, reconcileAbandonedLegacy } from "./reconcile.ts";

export { phoneMount, servePhoneTool } from "./admission.ts";
export { MemoryCallStore } from "./memory-store.ts";
export type { CallRow, ShippedCallStore as CallStore, PhoneCallContext, PhoneMountInput, PhoneMountVerdict, PhoneToolClaim, ToolOutcome } from "./contracts.ts";

export { PHONE_TOOL_NAMES, PHONE_TOOLS, PHONE_TOOLS_ENV, PHONE_ENGINE_ABSENT } from "../drivers/phone-tool-schemas.ts";

export interface PhoneLog { (line: { call?: string; http?: number; code: string }): void }

const E164 = /^\+[1-9][0-9]{6,14}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const REFERENCE = /^[A-Za-z0-9-]{1,32}$/;
const BOOKING_ID = /^call_[0-9a-f]{24}$/;
const OUTCOMES = new Set(["done", "not_done", "no_answer", "voicemail", "busy", "failed"]);
const LIVE = new Set<CallRow["status"]>(["scheduled", "ringing", "in_progress"]);
const STARTED = new Set<CallRow["status"]>(["ringing", "in_progress", "ended"]);
const RELEASE_BUDGET = 4;
const DAY_MS = 24 * 60 * 60 * 1000;
const REASONS = new Set(["closed", "fully_booked", "needs_owner", "refused", "other", "phone_menu"]);
const OWNER_REFRESH_DEADLINE_MS = 2000;
/** CallRow.keeping before Keep's replacement row exists. */
const KEEP_PENDING = "pending";

function mapStatus(vendor: string | undefined, endedReason: string | undefined): CallRow["status"] {
  if (endedReason === "scheduled-call-deleted") return "cancelled";
  switch (vendor) {
    case "scheduled": return "scheduled";
    case "queued": case "ringing": return "ringing";
    case "in-progress": case "forwarding": return "in_progress";
    case "ended": return "ended";
    default: return "ringing";
  }
}

export class PhoneCallService {
  private readonly adapter: PhoneAdapter;
  private readonly revisions: RevisionStore;
  private readonly appLanguage: () => string;
  private readonly log: PhoneLog;
  private readonly rows: CallStore;
  /** Revisions a call is being started on right now: pinned before the vendor is asked, released once the row is stored. */
  private readonly starting = new Map<number, number>();
  private readonly releasing = new Set<number>();
  private ownerRefresh: Promise<void> | undefined;
  private upgradeFailed = false;
  private releaseCursor = 0;
  private terminalHook: ((row: CallRow) => CallWriteOptions["within"] | undefined) | undefined;
  /** fprod3 N7: the server's botFenced; a call a fenced bot places is refused before the vendor is asked */
  private botFenced: ((botId: string) => boolean) | undefined;
  // No parameter properties: the server runs under Node type stripping (strip-only mode), which refuses them at startup.
  constructor(adapter: PhoneAdapter, revisions: RevisionStore, appLanguage: () => string, log: PhoneLog = () => {}, rows: CallStore = new MemoryCallStore()) {
    this.adapter = adapter; this.revisions = revisions; this.appLanguage = appLanguage; this.log = log; this.rows = rows;
  }

  /** Dev and headless runs register no phone tools (section 1, 3a). */
  toolsToRegister(): typeof PHONE_TOOLS | readonly [] { return phoneCallsSupported() ? PHONE_TOOLS : []; }

  /** Revision ids still named by a call being started, scheduled or in progress (their assistants are not deleted). */
  revisionsInUse(): Set<number> {
    const used = new Set<number>(this.starting.keys());
    for (const r of this.rows.live()) used.add(r.revision);
    return used;
  }

  /** Save settings: new revision, new assistant; newest-save-wins; release assistants nobody names. */
  async saveSettings(settings: Parameters<RevisionStore["save"]>[0]): Promise<number> {
    // A pending approval belongs to the old settings. Require a fresh turn after any save.
    if (this.revisions.activeForCall().ok) forgetAllPhoneTurns();
    const rev = this.revisions.save(settings);
    const assistantId = await this.adapter.applySettings(rev);
    if (this.revisions.confirm(rev.number, assistantId) === "stale") {
      await this.adapter.deleteAssistant(assistantId).catch(() => {});
      this.revisions.forget(rev.number);
    }
    await this.releaseOldAssistants();
    return rev.number;
  }

  /** Owner-path cleanup only (never on a turn, D5 P8d/P8b): nothing before the store migration is done, then at most
   * RELEASE_BUDGET superseded revisions per pass, each one indexed `revisionLive` probe, rotating so every unused assistant is
   * reached within ⌈R / RELEASE_BUDGET⌉ passes. A revision a call is being started on is never examined. */
  async releaseOldAssistants(signal?: AbortSignal): Promise<void> {
    if (this.rows.meta("migrated") !== "done") return;
    const all = this.revisions.releasable(new Set(this.starting.keys())).sort((a, b) => a.number - b.number);
    const from = all.findIndex(r => r.number > this.releaseCursor);
    const batch = (from < 0 ? all : [...all.slice(from), ...all.slice(0, from)]).slice(0, RELEASE_BUDGET);
    for (const r of batch) {
      if (signal?.aborted) return;
      this.releaseCursor = r.number;
      if (this.releasing.has(r.number) || this.rows.revisionLive(r.number)) continue;
      this.releasing.add(r.number);
      try { await ownerRequest(() => this.adapter.deleteAssistant(r.assistantId as string), signal); this.revisions.forget(r.number); }
      catch { /* Keep the revision eligible for a later cleanup attempt. */ }
      finally { this.releasing.delete(r.number); }
    }
  }

  /** D6a 3.2: the hand-off re-arm committed inside every write made by the single terminal write (SQLite only). */
  setTerminalHook(hook: ((row: CallRow) => CallWriteOptions["within"] | undefined) | undefined): void { this.terminalHook = hook; }

  /** Transcript retention (days; null keeps transcripts). Stored with the call table. */
  retention(): PhoneRetention {
    const v = this.rows.meta("retention");
    return v === "30" ? 30 : v === "90" ? 90 : null;
  }

  setRetention(retention: PhoneRetention): void { this.rows.setMeta("retention", String(retention)); }

  private pastRetention(row: CallRow): boolean {
    const days = this.retention();
    return days !== null && Date.now() - (row.endedAt ?? row.createdAt) > days * DAY_MS;
  }

  setBotFence(fenced: ((botId: string) => boolean) | undefined): void { this.botFenced = fenced; }

  async place(args: Record<string, unknown>, context: PhoneCallContext | string = {}): Promise<ToolOutcome> {
    const ctx = typeof context === "string" ? { botId: context } : context;
    if (!phoneKeyPresent()) return { ok: false, error: "not_set_up" };
    if (ctx.fenced?.()) return { ok: false, error: "refused" };
    const purpose = args.purpose === undefined ? "ask" : args.purpose;
    if (purpose !== "ask" && purpose !== "book" && purpose !== "cancel") return { ok: false, error: "vendor_refused" };
    if (purpose !== "cancel" && args.booking !== undefined) return { ok: false, error: "vendor_refused" };
    // I3: a cancel goes only to the booking's own number, for a booking this bot made; checked again in the insert section.
    const booking = purpose === "cancel" ? this.cancellable(args, ctx.botId) : undefined;
    if (purpose === "cancel" && !booking) return { ok: false, error: "no_such_booking" };
    const request = requestIdentity(args, booking);
    const { to, goal, when } = request;
    if (!E164.test(to) || !goal || goal.length > 500 || (when !== undefined && !ISO.test(when))) return { ok: false, error: "vendor_refused" };
    if (!phoneNumberAllowed(to)) return { ok: false, error: "number_not_allowed" };
    const identity = identityKey(request);
    // I5: one request, one call. A repeat of this owner message, or an identical live call of this bot, gets that call's result.
    const earlier = this.sameRequestRow(ctx, identity);
    if (earlier) return this.repeatResult(earlier);
    await this.reconcileAbandoned();
    // Never send another create while an earlier outcome is unknown, including after restart.
    const uncertain = this.rows.firstUncertain();
    if (uncertain) {
      const row = uncertain;
      try {
        const found = await this.adapter.reconcile?.(row.id);
        if (found) this.mergeLatest(row, found, true);
      } catch { /* keep the durable uncertainty */ }
      const sameRequest = (row.identity ?? identityKey(rowIdentity(row, request.language))) === identity;
      const fresh = this.rows.get(row.id) ?? row;
      if (fresh.status === "abandoned") { await this.reconcileAbandoned(); return { ok: false, error: "abandoned" }; }
      return sameRequest && fresh.vendorId ? { ok: true, value: engineResult(fresh) } : { ok: false, error: "not_confirmed" };
    }
    const active = this.revisions.activeForCall();
    if (!active.ok) return { ok: false, error: active.error };
    const revision = active.revision;
    const language = resolveLanguage(revision.settings, typeof args.language === "string" ? args.language : undefined, this.adapter.supportedLanguages, this.appLanguage(), to);
    const { details, limits } = request;
    const id = `call_${randomBytes(12).toString("hex")}`;
    // The revision is pinned in the same tick it is read, so a settings save while the vendor creates or schedules this call
    // never deletes the assistant the call names. The pin holds until the row is stored and the call table names it.
    this.starting.set(revision.number, (this.starting.get(revision.number) ?? 0) + 1);
    const intent: CallRow = { id, vendorId: "", revision: revision.number, assistantId: revision.assistantId as string, createdAt: Date.now(), status: "uncertain", language, to, goal, details, limits, when,
      purpose, identity, ...(booking ? { booking: booking.id } : {}), ...(ctx.intent ? { intent: ctx.intent } : {}), ...(ctx.botId ? { botId: ctx.botId } : {}) };
    let projected: ProjectedCall;
    try {
      // N7: the last check before any vendor request, after every await above
      if (ctx.fenced?.()) return { ok: false, error: "refused" };
      if (ctx.botId !== undefined && this.botFenced?.(ctx.botId)) return { ok: false, error: "not_set_up" };
      // One synchronous section, no await: the duplicate reads, the booking check, the booking claim and the intent insert.
      const repeat = this.sameRequestRow(ctx, identity);
      if (repeat) return { ok: true, value: engineResult(repeat) };
      if (booking) {
        const current = this.cancellable(args, ctx.botId);
        if (!current) return { ok: false, error: "no_such_booking" };
        this.rows.update({ ...current, cancel: { by: id, state: "pending" } });
      }
      this.rows.insert(intent); // synchronous durable commit before any provider request
      ctx.onIntent?.(id);
      try {
        projected = await this.adapter.start({ to, goal, details, limits, language, when, operationId: id, ...(booking?.reference ? { reference: booking.reference } : {}) }, revision);
      } catch (err) {
        // A definitive validation/authentication rejection created no call. A 5xx, timeout,
        // malformed response or lost response remains uncertain and retains its assistant.
        if (err instanceof PhoneCallError && [400, 401, 403, 404, 422].includes(err.httpStatus ?? 0)) {
          const fresh = this.rows.get(id) ?? intent;
          if (fresh.status === "uncertain") this.writeOutcome({ ...fresh, status: "ended", structured: { outcome: "failed" } });
        }
        const code = err instanceof PhoneCallError ? err.code : "vendor_unreachable";
        this.log({ call: id, http: err instanceof PhoneCallError ? err.httpStatus : undefined, code });
        return { ok: false, error: code };
      }
      let row: CallRow;
      try { row = this.mergeLatest(intent, { ...projected, status: when ? "scheduled" : projected.status }); } catch { return { ok: false, error: "vendor_unreachable" }; }
      if (row.status === "abandoned") { await this.reconcileAbandoned(); return { ok: false, error: "abandoned" }; }
      if (!row.vendorId) return { ok: false, error: "not_confirmed" };
      this.log({ call: id, code: "placed" });
      return { ok: true, value: { call: id, status: row.status, language, settings_revision: revision.number, ...(purpose !== "ask" ? { purpose } : {}), ...(booking ? { booking: booking.id } : {}) } };
    } finally {
      const left = (this.starting.get(revision.number) ?? 1) - 1;
      if (left > 0) this.starting.set(revision.number, left); else this.starting.delete(revision.number);
      // No cleanup here, ever: a save that landed during the start left this revision superseded, and the next owner pass
      // (save, cancel, refresh) releases it once no call names it. A turn's place() never scans or deletes assistants.
    }
  }

  /** I5: the stored call answering this request: same owner message (any status), else an identical live call of the same bot. */
  private sameRequestRow(ctx: PhoneCallContext, identity: string): CallRow | undefined {
    if (ctx.botId === undefined) return undefined;
    return (ctx.intent ? this.rows.byIntent(ctx.botId, ctx.intent, identity) : undefined) ?? this.rows.liveByIdentity(ctx.botId, identity);
  }

  /** A repeat makes no create: it returns the stored call after the shipped result read. */
  private async repeatResult(row: CallRow): Promise<ToolOutcome> {
    const read = await this.result({ call: row.id });
    if (read.ok) return read;
    const fresh = this.rows.get(row.id);
    return fresh?.vendorId ? { ok: true, value: engineResult(fresh) } : read;
  }

  /** I3: the booking a cancel names, only when this bot may cancel it now. One primary-key read; never awaits. */
  private cancellable(args: Record<string, unknown>, botId: string | undefined): CallRow | undefined {
    if (typeof args.booking !== "string" || !BOOKING_ID.test(args.booking)) return undefined;
    const row = this.rows.get(args.booking);
    if (!row || row.purpose !== "book" || row.status !== "ended" || row.structured?.outcome !== "done" || !row.reference) return undefined;
    if (!row.botId || row.botId !== botId) return undefined;
    if (args.to !== undefined && (typeof args.to !== "string" || args.to.trim() !== row.to)) return undefined;
    const state = row.cancel?.state;
    // I4: cancelled and unclear are final; pending is free again only when its cancel row was never written.
    if (state === "cancelled" || state === "unclear") return undefined;
    if (state === "pending" && this.rows.get(row.cancel!.by)) return undefined;
    return row;
  }

  /** Refresh from the vendor and return only the section-4 fields. */
  async result(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutcome> {
    const row = typeof args.call === "string" ? this.rows.get(args.call) : undefined;
    if (!row) return { ok: false, error: "not_found" };
    if (row.status === "abandoned") { await this.reconcileAbandoned(signal, [row]); return { ok: false, error: "abandoned" }; }
    if (row.status === "uncertain") {
      try { const found = await ownerRequest(() => this.adapter.reconcile?.(row.id), signal); if (found) this.mergeLatest(row, found, true); } catch { /* retained */ }
      const fresh = this.rows.get(row.id);
      if (!fresh) return { ok: false, error: "not_found" };
      if (fresh.status === "abandoned") { await this.reconcileAbandoned(signal, [fresh]); return { ok: false, error: "abandoned" }; }
      return fresh.vendorId ? { ok: true, value: engineResult(fresh) } : { ok: false, error: "not_confirmed" };
    }
    if (row.status === "cancelled") return { ok: true, value: engineResult(row) };
    let projected: ProjectedCall;
    try { projected = await ownerRequest(() => this.adapter.result(row.vendorId), signal); } catch (err) {
      const code = err instanceof PhoneCallError ? err.code : "vendor_unreachable";
      this.log({ call: row.id, http: err instanceof PhoneCallError ? err.httpStatus : undefined, code });
      return { ok: false, error: code };
    }
    // Read the row again: an owner cancel may have gone through while the vendor answered (absorb() keeps a final status), or the
    // owner deleted it (nothing is written back). Assistant cleanup runs on the owner path only.
    const fresh = this.rows.get(row.id);
    if (!fresh) return { ok: false, error: "not_found" };
    this.absorb(fresh, projected);
    this.writeOutcome(fresh);
    return { ok: true, value: engineResult(fresh) };
  }

  /** The Ask card line (3f): number, goal, details, limits, schedule, resolved language, settings revision and max length; for a
   * cancel, the booking's business, number and time. With the turn's trusted intent, a repeat is marked `sameRequest` (I5).
   * Null when not callable, including a cancel this bot cannot make. */
  askPreview(args: Record<string, unknown>, context?: PhoneAskContext): PhoneAskCard | null {
    const active = this.revisions.activeForCall();
    if (!active.ok) return null;
    const purpose = args.purpose === undefined ? "ask" : args.purpose;
    if (purpose !== "ask" && purpose !== "book" && purpose !== "cancel") return null;
    const booking = purpose === "cancel" ? this.cancellable(args, context?.botId) : undefined;
    if (purpose === "cancel" && !booking) return null;
    const request = requestIdentity(args, booking);
    const str = (v: string, max: number) => v.trim().slice(0, max);
    const { language, wanted } = resolveCallLanguage(active.revision.settings, typeof args.language === "string" ? args.language : undefined, this.adapter.supportedLanguages, this.appLanguage(), str(request.to, 16));
    const time = booking && typeof booking.structured?.time === "string" && ISO.test(booking.structured.time) ? booking.structured.time : undefined;
    const same = context ? this.sameRequestRow(context, identityKey(request)) : undefined;
    return { ...(args.purpose !== undefined ? { purpose } : {}), ...(booking ? { booking: booking.id } : {}),
      to: str(request.to, 16), goal: str(request.goal, 500), details: str(request.details, 2000), limits: str(request.limits, 1000),
      ...(typeof args.when === "string" ? { when: str(args.when, 40) } : {}), language, settings_revision: active.revision.number,
      max_seconds: active.revision.settings.maxSeconds,
      ...(booking ? { cancelOf: { business: booking.goal.slice(0, 80), to: booking.to, ...(time ? { time } : {}) } } : {}),
      ...(wanted ? { languageFallback: { wanted, language } } : {}), ...(same ? { sameRequest: true as const } : {}) };
  }

  /** Owner Delete (X3). A live, unresolved or still-cancelling call is refused. Deleting revokes the phone-turn records of the row's
   * owner message, so a repeat of that message can never place the call again (I5). Settlement and retention are group B / F2. */
  deleteCall(id: string): PhoneDeleteOutcome {
    const row = this.rows.get(id);
    if (!row) return { ok: false, error: "not_found" };
    if (row.status === "uncertain") return { ok: false, error: "checking" };
    if (row.status === "scheduled" || row.status === "ringing" || row.status === "in_progress") return { ok: false, error: "live" };
    if (row.status === "abandoned" && row.abandonCancel !== "confirmed" && row.abandonCancel !== "not_found") return { ok: false, error: "checking" };
    if (row.cancel?.state === "pending" && this.rows.get(row.cancel.by)) return { ok: false, error: "cancel_pending" };
    if (row.purpose === "cancel" && row.booking && this.rows.get(row.booking)?.cancel?.state === "pending") return { ok: false, error: "cancel_pending" };
    if (!this.rows.delete(id)) return { ok: false, error: "not_found" };
    if (row.intent) forgetPhoneIntent(row.intent);
    return { ok: true };
  }

  private *archiveLive(botId?: string): IterableIterator<CallRow> {
    const rows = this.rows as ShippedCallStore & Partial<Pick<CallStore, "liveForBot" | "liveLegacy" | "meta">>;
    if (rows.meta?.("migrated") !== "done" || !rows.liveForBot || !rows.liveLegacy) {
      for (const row of rows.live()) if (row.botId === botId) yield row;
      return;
    }
    let after: string | undefined;
    while (true) {
      const page = botId === undefined ? rows.liveLegacy(50, after) : rows.liveForBot(botId, 50, after);
      yield* page;
      if (page.length < 50) return;
      after = page[page.length - 1].id;
    }
  }

  /** Archive: every live call of the bot is cancelled at the vendor. `confirmed` only when the cancel resolved or the call reads
   * ended or cancelled; a failed cancel whose call still reads scheduled, ringing or in progress, or cannot be read, is `unconfirmed`. */
  async cancelForBot(botId: string): Promise<{ call: string; status: "confirmed" | "unconfirmed" }[]> {
    const mine = this.archiveLive(botId);
    const live = await Promise.all(Array.from(mine, async (row) => {
      let status: CallRow["status"] | "not_found" = "not_found";
      try {
        // Until discovery names the vendor call, Archive cannot confirm a stop.
        if (row.status === "uncertain") await this.result({ call: row.id });
        if (this.rows.get(row.id)?.status !== "uncertain") status = await this.cancel(row.id);
      } catch { /* The owner can retry Archive after discovery. */ }
      const fresh = this.rows.get(row.id);
      const done = status === "cancelled" || status === "ended" || (status === "abandoned" && fresh?.abandonCancel === "confirmed");
      return { call: row.id, status: done ? "confirmed" as const : "unconfirmed" as const };
    }));
    // An abandoned call can still dial until its vendor stop is confirmed: pending discovery, or a DELETE attempted or failed.
    const seen = new Set(live.map((r) => r.call));
    const outstanding = (await this.unstoppedAbandoned({ botId })).filter((row) => !seen.has(row.id));
    const abandoned = await Promise.all(outstanding.map(async (row) =>
      ({ call: row.id, status: await this.stopAbandoned(row.id) ? "confirmed" as const : "unconfirmed" as const })));
    return [...live, ...abandoned];
  }

  /** Abandoned calls still lacking a confirmed stop, after one discovery and DELETE pass. */
  private async unstoppedAbandoned(scope: CallScope): Promise<CallRow[]> {
    await this.reconcileAbandoned(undefined, this.rows.abandoned(scope)).catch(() => {});
    return [...this.rows.unstopped(scope)];
  }

  /** Confirm an abandoned call's stop for Archive. Pending discovery stays unconfirmed. A recorded DELETE is never re-sent blind:
   * the call is read first; ended or deleted confirms it, and only a call that still reads live gets one more claimed DELETE. */
  private async stopAbandoned(id: string): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.status !== "abandoned") return false;
    if (row.abandonCancel === "confirmed" || row.abandonCancel === "not_found") return true;
    if (!row.vendorId) return false;
    const before = row.abandonCancel;
    let reads: CallRow["status"];
    try { const projected = await this.adapter.result(row.vendorId); reads = mapStatus(projected.status, projected.endedReason); } catch { return false; }
    const fresh = this.rows.get(id);
    if (!fresh || fresh.abandonCancel !== before) return fresh?.abandonCancel === "confirmed" || fresh?.abandonCancel === "not_found";
    if (reads === "ended" || reads === "cancelled") { this.writeOutcome({ ...fresh, abandonCancel: "confirmed" }); return true; }
    this.rows.put({ ...fresh, abandonCancel: "attempted" });
    try { await this.adapter.cancel(fresh.vendorId); } catch {
      this.rows.put({ ...(this.rows.get(id) ?? fresh), abandonCancel: "failed" });
      return false;
    }
    this.writeOutcome({ ...(this.rows.get(id) ?? fresh), abandonCancel: "confirmed" });
    return true;
  }

  /** Q6: legacy calls (no bot id) that are still live are not dialed while any bot is archived: a scheduled one is cancelled at the
   * vendor and held for the owner (Keep places it again, Cancel leaves it cancelled); an uncertain one is resolved by reading the
   * vendor first. A call already ringing or in progress is returned in `live` so the owner is told at once and can Stop it. */
  async holdLegacyCalls(): Promise<{ held: string[]; live: string[]; failed: string[] }> {
    const out = { held: [] as string[], live: [] as string[], failed: [] as string[] };
    for (const row of this.archiveLive()) {
      if (row.held) continue;
      let current = row;
      if (row.status === "uncertain" || row.status === "scheduled") {
        const checked = await this.result({ call: row.id }).catch(() => null);
        current = this.rows.get(row.id) ?? row;
        if (!checked?.ok && (current.status === "uncertain" || current.status === "scheduled")) {
          out.failed.push(row.id);
          continue;
        }
      }
      if (current.status === "ringing" || current.status === "in_progress") { out.live.push(row.id); continue; }
      if (current.status !== "scheduled") continue;
      const status = await this.cancel(row.id).catch(() => "not_found" as const);
      const fresh = this.rows.get(row.id);
      if (status === "cancelled" && fresh) {
        this.rows.put({ ...fresh, held: "held" });
        out.held.push(row.id);
      } else if (status === "ringing" || status === "in_progress") {
        out.live.push(row.id);
      } else if (status !== "ended") {
        out.failed.push(row.id);
      }
    }
    for (const row of await this.unstoppedAbandoned({})) if (!await this.stopAbandoned(row.id)) out.failed.push(row.id);
    return out;
  }

  /** Owner card choice for a held legacy call. Keep places it again from its own words (new row, normal path); Cancel keeps it cancelled.
   * Both claim the decision synchronously. Keep records its replacement call on the held row before the vendor is asked; a Cancel
   * during Keep makes place() refuse at its last fence, or stops that replacement, and is acknowledged only once the stop is
   * confirmed. Keep never overwrites a cancellation. */
  async decideHeld(id: string, choice: "keep" | "cancel"): Promise<ToolOutcome> {
    const row = this.rows.get(id);
    if (!row) return { ok: false, error: "not_found" };
    if (choice === "cancel") {
      if (row.held === "held") this.rows.put({ ...row, held: "cancelled" });
      else if (row.held !== "cancelled") return { ok: false, error: "not_found" };
      // A retried Cancel re-checks a replacement whose stop was not confirmed.
      const replacement = row.keeping;
      if (replacement && replacement !== KEEP_PENDING && !await this.stopReplacement(replacement)) return { ok: false, error: "not_confirmed" };
      return { ok: true, value: { call: id, held: "cancelled" } };
    }
    if (row.held !== "held" || row.keeping) return { ok: false, error: "not_found" };
    this.rows.put({ ...row, keeping: KEEP_PENDING });
    const mark = (call: string) => { const held = this.rows.get(id); if (held) this.rows.put({ ...held, keeping: call }); };
    let placed: ToolOutcome;
    try {
      placed = await this.place({ to: row.to, goal: row.goal, details: row.details, limits: row.limits, ...(row.when ? { when: row.when } : {}), language: row.language },
        { fenced: () => this.rows.get(id)?.held === "cancelled", onIntent: mark });
    } catch { placed = { ok: false, error: "vendor_unreachable" }; }
    const fresh = this.rows.get(id) ?? row;
    const recorded = fresh.keeping && fresh.keeping !== KEEP_PENDING ? fresh.keeping : undefined;
    const replacement = placed.ok ? String(placed.value.call) : recorded;
    if (fresh.held === "cancelled") {
      // Only the call this Keep created is stopped; place() can also answer with an earlier identical call it did not create.
      if (recorded) await this.stopReplacement(recorded);
      return { ok: false, error: "cancelled" };
    }
    if (placed.ok) { this.rows.put({ ...fresh, held: "kept", keeping: replacement }); return placed; }
    // A replacement that may still exist stays recorded, so Cancel can stop it and a second Keep cannot create another.
    const left = replacement ? this.rows.get(replacement) : undefined;
    if (!left || left.status === "ended") this.rows.put({ ...fresh, keeping: undefined });
    return placed;
  }

  /** True once the replacement call cannot dial: cancelled or ended at the vendor, or abandoned with a confirmed stop. */
  private async stopReplacement(call: string): Promise<boolean> {
    const status = await this.cancel(call).catch(() => "not_found" as const);
    if (status === "cancelled" || status === "ended") return true;
    if (status !== "abandoned") return false;
    await this.reconcileAbandoned().catch(() => {});
    return this.stopAbandoned(call);
  }

  /** Owner UI only; there is no cancel tool for engines. A cancel racing the call start leaves a clear final status. */
  async cancel(id: string): Promise<CallRow["status"] | "not_found"> {
    const row = this.rows.get(id);
    if (!row) return "not_found";
    if (row.status === "uncertain") {
      await this.result({ call: id });
      const fresh = this.rows.get(id);
      if (!fresh) return "not_found";
      if (fresh.status === "uncertain") {
        this.rows.put({ ...fresh, status: "abandoned" });
        await this.releaseOldAssistants();
        return "abandoned";
      }
      return this.cancel(id);
    }
    if (row.status === "cancelled" || row.status === "ended" || row.status === "abandoned") return row.status;
    let final: CallRow | undefined;
    try {
      await this.adapter.cancel(row.vendorId);
      // Read the row again so a result read that finished meanwhile keeps its fields; the cancel itself is confirmed.
      final = this.rows.get(id);
      if (final) final.status = "cancelled";
    } catch {
      // The call may have started already: read the real state and keep it, and tell the owner the cancel came too late.
      try {
        const projected = await this.adapter.result(row.vendorId);
        final = this.rows.get(id);
        if (final) { this.absorb(final, projected); if (STARTED.has(final.status)) final.cancelTooLate = true; }
      } catch { final = this.rows.get(id); }
    }
    // A row the owner deleted meanwhile is never written back.
    if (!final) return "not_found";
    this.writeOutcome(final);
    await this.releaseOldAssistants();
    return final.status;
  }

  /** Owner reads refresh at most the 50 displayed calls, with four vendor reads in flight.
   * Concurrent owner requests share a pass with a two-second application deadline,
   * including cleanup. Expiry returns cached cards and leaves the next poll free to retry.
   */
  async refreshOwnerCalls(): Promise<void> {
    if (this.ownerRefresh) return this.ownerRefresh;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OWNER_REFRESH_DEADLINE_MS);
    const refresh = this.refreshOwnerCallsOnce(controller.signal).finally(() => {
      clearTimeout(timer);
      if (this.ownerRefresh === refresh) this.ownerRefresh = undefined;
    });
    this.ownerRefresh = refresh;
    return refresh;
  }

  private async refreshOwnerCallsOnce(signal: AbortSignal): Promise<void> {
    // An old-template revision is saved again at most once per owner refresh (D5 5.8b); a current one makes no request.
    await this.upgradeTemplate();
    await this.reconcileAbandoned(signal);
    // Analysis can arrive after the first ended response. Incomplete ended cards remain
    // eligible within the same read/concurrency limits; cancelled and abandoned rows do not.
    const pending = this.rows.recent(50).filter(row =>
      row.status === "uncertain" || row.status === "scheduled" || row.status === "ringing" || row.status === "in_progress"
      || (row.status === "ended" && (!row.structured?.outcome || (!row.transcript && !row.transcriptCleared && !this.pastRetention(row)))));
    const refresh = async () => {
      for (let row = pending.shift(); row && !signal.aborted; row = pending.shift()) await this.result({ call: row.id }, signal);
    };
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, refresh));
    await this.settleLateAnalysis(signal);
    // Assistant cleanup belongs to the owner pass only (never a turn's result read), after the reads that may have ended calls.
    await this.releaseOldAssistants(signal);
  }

  /** I4: an ended call whose analysis never arrived is settled `unclear` once its durable `analysisDue` deadline passes, wherever
   * the row is in history (the key-table index, not the 50 displayed rows). One last read first; a late `done` still upgrades it. */
  private async settleLateAnalysis(signal?: AbortSignal): Promise<void> {
    for (const due of this.rows.analysisDue(Date.now(), 8)) {
      if (signal?.aborted) return;
      await this.refreshOne(due.id, signal);
      const fresh = this.rows.get(due.id);
      if (!fresh || fresh.status !== "ended" || fresh.structured?.outcome !== undefined) continue;
      this.writeOutcome({ ...fresh, structured: { ...fresh.structured, outcome: "unclear" } });
    }
  }

  /** D6a 3.3: the owner refresh's targeted read of one call, without the reconcile and cleanup passes `result` and the owner
   * refresh run. An uncertain row gets its search step; a live row or an ended row without a definite outcome (including a
   * settled `unclear` one, so a late `done` upgrades it) gets one status read. Writes go through the single terminal write. */
  async refreshOne(id: string, signal?: AbortSignal): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return;
    try {
      if (row.status === "uncertain") {
        const found = await ownerRequest(() => this.adapter.reconcile?.(row.id), signal);
        if (found) this.mergeLatest(row, found, true);
        return;
      }
      const outcome = row.structured?.outcome;
      if (!LIVE.has(row.status) && !(row.status === "ended" && (typeof outcome !== "string" || !OUTCOMES.has(outcome)))) return;
      const projected = await ownerRequest(() => this.adapter.result(row.vendorId), signal);
      const fresh = this.rows.get(id);
      if (!fresh) return;
      this.absorb(fresh, projected);
      this.writeOutcome(fresh);
    } catch { /* a failed read is a miss, never a result */ }
  }

  /** Owner UI: the latest calls as owner cards (newest first). Never handed to an engine. */
  recentOwnerCards(limit = 50): (NonNullable<ReturnType<PhoneCallService["ownerCard"]>> & { id: string })[] {
    const out: (NonNullable<ReturnType<PhoneCallService["ownerCard"]>> & { id: string })[] = [];
    for (const r of this.rows.recent(limit)) { const card = this.ownerCard(r.id); if (card) out.push({ ...card, id: r.id }); }
    return out;
  }

  /** "N scheduled calls use older settings": scheduled calls frozen on a revision older than the active one (3c). */
  olderScheduled(): { id: string; revision: number; to: string; when?: string }[] {
    const active = this.revisions.activeForCall();
    if (!active.ok) return [];
    return this.rows.scheduledOlderThan(active.revision.number, 50).map(r => ({ id: r.id, revision: r.revision, to: r.to, ...(r.when ? { when: r.when } : {}) }));
  }

  /** How many scheduled calls use older settings, capped: "500+" past 500 (one bounded index count). */
  olderScheduledCount(): number | "500+" {
    const active = this.revisions.activeForCall();
    if (!active.ok) return 0;
    const n = this.rows.countScheduledOlderThan(active.revision.number, 500);
    return n > 500 ? "500+" : n;
  }

  /** Owner UI: the active settings and revision number, or null before setup. */
  activeSettings(): { revision: number; settings: PhoneCallSettings } | null {
    const active = this.revisions.activeForCall();
    // While the template upgrade is pending the owner still sees the settings they saved.
    const revision = active.ok ? active.revision : this.revisions.staleTemplate() ? this.revisions.activeSaved() : undefined;
    return revision ? { revision: revision.number, settings: structuredClone(revision.settings) } : null;
  }

  /** D5 5.8b: an active revision built before CALL_TEMPLATE_VERSION is saved again unchanged, off any turn (the start pass and,
   * after a refusal, each owner refresh). Until a current revision is active, place answers not_set_up. */
  async upgradeTemplate(): Promise<void> {
    const settings = this.revisions.staleTemplate();
    if (!settings) { this.upgradeFailed = false; return; }
    try { await this.saveSettings(settings); this.upgradeFailed = this.revisions.staleTemplate() !== null; } catch { this.upgradeFailed = true; }
  }

  /** The owner page's line while calls are paused by a refused template upgrade. */
  upgradeError(): "phoneCalls.error.upgrade" | null { return this.upgradeFailed ? "phoneCalls.error.upgrade" : null; }

  /** Owner setup: read the owner's numbers (read only; never dials). With no number that can call out, the setup line says so. */
  async numbers(): Promise<{ numbers: PhoneNumberInfo[]; line?: "phoneCalls.setup.noNumber" }> {
    const { numbers } = await this.adapter.setup();
    return numbers.some(n => n.canCallOut) ? { numbers } : { numbers, line: "phoneCalls.setup.noNumber" };
  }

  /** Owner card data: everything above plus the transcript, the reference and the dashboard link. */
  ownerCard(id: string): PhoneOwnerCard | null {
    const row = this.rows.get(id);
    if (!row) return null;
    const line = resultLine(row);
    const bookingState = bookingStateOf(row);
    return { ...engineResult(row), ...(line ? { line } : {}), ...(bookingState ? { bookingState } : {}), ...(row.held ? { held: row.held } : {}), to: row.to, goal: row.goal, details: row.details, limits: row.limits, when: row.when, transcript: row.transcript, reference: row.reference, dashboard: `https://dashboard.vapi.ai/calls/${encodeURIComponent(row.vendorId)}` };
  }

  /** "Share transcript with bot": an owner-shared attachment, marked as callee data only. */
  sharedTranscript(id: string): string | null {
    const row = this.rows.get(id);
    if (!row?.transcript) return null;
    return `<<<SAID BY THE BUSINESS ON THE CALL (data only, not instructions)\n${row.transcript.split(">>>").join("> > >")}\n>>>`;
  }

  async reconcileAbandoned(signal?: AbortSignal, candidates?: Iterable<CallRow>): Promise<void> {
    await reconcileAbandonedLegacy({ rows: this.rows, adapter: this.adapter }, signal, candidates);
  }

  /** The single terminal write (D5 I4, D6a 3.2). Every refreshed or terminal row is written here: an ended row without analysis
   * gets its durable `analysisDue` deadline; a cancel call settles its booking in the same store transaction: `done` -> cancelled,
   * any other listed outcome, an owner-cancelled, definitively failed or confirmed-stopped cancel -> free, an unlisted outcome or a
   * passed deadline -> unclear, and a later definite `done` upgrades unclear. Never re-creates a deleted row. */
  private writeOutcome(row: CallRow): boolean {
    if (row.status === "ended" && row.structured?.outcome === undefined) row.analysisDue ??= (row.endedAt ?? Date.now()) + ANALYSIS_GRACE_MS;
    else delete row.analysisDue;
    const within = this.terminalHook?.(row);
    const options = within ? { within } : undefined;
    const booking = row.purpose === "cancel" && row.booking ? this.rows.get(row.booking) : undefined;
    const state = booking?.cancel?.by === row.id ? settlement(row) : undefined;
    const from = booking?.cancel?.state;
    if (booking && state && state !== from && (from === "pending" || (from === "unclear" && state === "cancelled"))) {
      if (this.rows.settle(row, { ...booking, cancel: { by: row.id, state } }, options)) return true;
    }
    return this.rows.update(row, options);
  }

  /** Provider responses may arrive after another request has confirmed a terminal state. */
  private mergeLatest(previous: CallRow, projected: ProjectedCall, reconciled = false): CallRow {
    const row = this.rows.get(previous.id);
    // A reconciliation is identified by our stored operation id. Preserve that identity even
    // if the owner abandoned while discovery was in flight, so the single DELETE path can
    // consume it after a restart or a later discovery miss. A create response cannot do this.
    if (!row) return previous;
    if (row.status === "abandoned" && reconciled && projected.vendorId && !row.vendorId && !row.abandonCancel) {
      row.vendorId = projected.vendorId;
      this.rows.put(row);
    }
    if (row.status === "cancelled" || row.status === "ended" || row.status === "abandoned") return row;
    row.vendorId = projected.vendorId;
    this.absorb(row, projected);
    this.writeOutcome(row);
    return row;
  }

  private absorb(row: CallRow, p: ProjectedCall): void {
    // A confirmed cancel is final, and a stale read never reopens an ended call.
    if (row.status === "cancelled" || row.status === "abandoned") return;
    const next = mapStatus(p.status, p.endedReason);
    if (row.status === "ended" && next !== "ended" && next !== "cancelled") return;
    row.status = next;
    if (p.endedReason) row.endedReason = p.endedReason;
    if (typeof p.cost === "number") row.cost = p.cost;
    if (p.startedAt && p.endedAt) { const s = (Date.parse(p.endedAt) - Date.parse(p.startedAt)) / 1000; if (Number.isFinite(s) && s >= 0) row.lengthSeconds = Math.round(s); }
    if (p.structured) row.structured = p.structured;
    if (p.endedAt && row.endedAt === undefined) { const t = Date.parse(p.endedAt); if (Number.isFinite(t)) row.endedAt = t; }
    // A transcript the retention prune cleared, or one already past retention, is never stored again.
    if (p.transcript && !row.transcriptCleared && !this.pastRetention(row)) row.transcript = p.transcript;
    const ref = p.structured?.reference;
    row.reference = typeof ref === "string" && REFERENCE.test(ref) ? ref : undefined;
  }

  /** Test and owner-UI seam: the call table row (never handed to engines). */
  _row(id: string): CallRow | undefined { return this.rows.get(id); }
}

/** Section 4: the only thing the engine gets. Any value outside its type or list is dropped. No free text from the call. */
export function engineResult(row: CallRow): PhoneResultCard {
  const out: PhoneResultCard = { call: row.id, status: row.status, language: row.language, settings_revision: row.revision };
  // An ask keeps the shipped section-4 shape; book and cancel name their purpose.
  if (row.purpose === "book" || row.purpose === "cancel") out.purpose = row.purpose;
  if (row.purpose === "cancel" && row.booking) out.booking = row.booking;
  const sd = row.structured ?? {};
  if (typeof sd.outcome === "string" && OUTCOMES.has(sd.outcome)) out.outcome = sd.outcome;
  if (out.outcome && out.outcome !== "done" && typeof sd.reason === "string" && REASONS.has(sd.reason)) out.reason = sd.reason;
  out.has_reference = typeof row.reference === "string";
  if (typeof sd.time === "string" && ISO.test(sd.time) && Number.isFinite(Date.parse(sd.time))) out.time = sd.time;
  if (typeof row.lengthSeconds === "number") out.length_seconds = row.lengthSeconds;
  if (typeof row.cost === "number") out.cost = { amount: row.cost, currency: "USD" };
  return out;
}

/** I5: the normalised request. For a cancel, `to` is the booking's own number and `booking` its id. */
export function requestIdentity(args: Record<string, unknown>, booking?: CallRow): PhoneRequestIdentity {
  const purpose = args.purpose === "book" || args.purpose === "cancel" ? args.purpose : "ask";
  return {
    purpose, ...(booking ? { booking: booking.id } : {}),
    to: booking ? booking.to : typeof args.to === "string" ? args.to.trim() : "",
    goal: typeof args.goal === "string" ? args.goal.trim() : "",
    details: typeof args.details === "string" ? args.details.slice(0, 2000) : "",
    limits: typeof args.limits === "string" ? args.limits.slice(0, 1000) : "",
    ...(typeof args.when === "string" ? { when: args.when } : {}),
    ...(typeof args.language === "string" ? { language: args.language } : {}),
  };
}

/** The stored, indexed form of a request identity. */
export function identityKey(r: PhoneRequestIdentity): string {
  return JSON.stringify([r.purpose, r.booking ?? "", r.to, r.goal, r.details, r.limits, r.when ?? "", r.language ?? ""]);
}

/** A row stored before identities: its request as placed, with the language only when the new request names one. */
function rowIdentity(row: CallRow, language: string | undefined): PhoneRequestIdentity {
  return { purpose: row.purpose ?? "ask", ...(row.booking ? { booking: row.booking } : {}), to: row.to, goal: row.goal, details: row.details,
    limits: row.limits, ...(row.when !== undefined ? { when: row.when } : {}), ...(language !== undefined ? { language: row.language } : {}) };
}

/** The owner card's result line, as a phoneCalls copy key (section 5.9). Settlement lines beyond these are group B's. */
function resultLine(row: CallRow): string | undefined {
  if (row.cancelTooLate && (row.status === "ringing" || row.status === "in_progress")) return "phoneCalls.result.alreadyStarted";
  if (row.status !== "ended") return undefined;
  const outcome = row.structured?.outcome;
  if (outcome === undefined) return undefined;
  if (typeof outcome !== "string" || !OUTCOMES.has(outcome)) return "phoneCalls.result.unclear";
  if (outcome !== "done") return "phoneCalls.result.couldnt";
  if (row.purpose === "book") return "phoneCalls.result.booked";
  if (row.purpose === "cancel") return "phoneCalls.result.cancelled";
  return undefined;
}

/** The booking state a terminal cancel call settles (I4); undefined while its outcome is still owed. */
function settlement(row: CallRow): "cancelled" | "free" | "unclear" | undefined {
  if (row.status === "cancelled") return "free";
  if (row.status === "abandoned") return row.abandonCancel === "confirmed" || row.abandonCancel === "not_found" ? "free" : undefined;
  if (row.status !== "ended") return undefined;
  const outcome = row.structured?.outcome;
  if (outcome === undefined) return undefined;
  if (outcome === "done") return "cancelled";
  return typeof outcome === "string" && OUTCOMES.has(outcome) ? "free" : "unclear";
}

/** D6a 3.1: a call is final once nothing about it can still change: cancelled, stopped after abandon, or ended with an outcome
 * (an unlisted outcome is final as unclear; an ended call still waiting for its analysis is not). */
export function isFinal(row: CallRow): boolean {
  if (row.status === "cancelled") return true;
  if (row.status === "abandoned") return row.abandonCancel === "confirmed" || row.abandonCancel === "not_found";
  return row.status === "ended" && row.structured?.outcome !== undefined;
}

/** A booking's state, from its own `cancel` field (no extra read). */
function bookingStateOf(row: CallRow): PhoneOwnerCard["bookingState"] {
  if (row.purpose !== "book" || row.status !== "ended" || row.structured?.outcome !== "done" || !row.reference) return undefined;
  switch (row.cancel?.state) {
    case "pending": return "cancelling";
    case "cancelled": return "cancelled";
    case "unclear": return "unclear";
    default: return "booked";
  }
}

/** The production Ask preview (index.ts registers it): a card only for a turn the phone mount recorded, with its trusted owner
 *  message, for a bot that may phone. Tool input never supplies the bot or the intent. */
export function trustedAskPreview(service: () => PhoneCallService | null, deps: PhoneAdmissionDeps, args: Record<string, unknown>, turn?: PhoneAskTurn): PhoneAskCard | null {
  const context = phoneAskContext(turn);
  if (!context || !deps.botMayPhone(context.botId)) return null;
  return service()?.askPreview(args, context) ?? null;
}
