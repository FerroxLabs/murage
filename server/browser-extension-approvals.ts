// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createPrivateWindowsDirectory, readPrivateWindowsJson, writePrivateWindowsJson } from "../electron/browser-extension-windows.mjs";
import type { ApprovalBus } from "./peer-approval.ts";
import type { BotRecord } from "./store.ts";
// A person decides in their own time (two minutes on a card); the tool call's own deadline is separate.
const MAX_WAIT_MS = 180000, MAX_SUMMARY = 12000;
export const BROWSER_EXTENSION_APPROVAL_TOOL = "browser_extension_action";
/** T22 (spec 2.8): a card the person has not answered stays answerable this long, even across a restart. */
export const CARD_LIFETIME_MS = 24 * 3600_000;
const MAX_RECORDS = 256, FILE_VERSION = 1, MAX_FILE_BYTES = 1024 * 1024;
const HEX = /^[a-f0-9]{64}$/;
/** What an approval is bound to. All six must match for the approval to be used; any difference means a fresh card. */
export type ApprovalBinding = {
  generation: number;
  /** The document the step runs in: tab, navigation epoch and origin. */
  documentEpoch: string;
  /** The control the step acts on (digest of its name, role and bound node). */
  targetDigest: string;
  /** Where the step sends: the form action or destination, and the operation (digest). */
  submissionDigest: string;
  /** What the step types or submits (digest). */
  payloadDigest: string;
  /** The whole trusted action, as the executor digests it. */
  actionDigest: string;
};
export type ApprovalKind = "site" | "action";
/** allow and deny are the person's answer inside the wait. waiting: the wait ran out, the card stays live. cancelled: no card is answerable. */
export type ApprovalState = "allow" | "deny" | "waiting" | "cancelled";
export type ContinuationInfo = { requestId: string; botId: string; threadId: string; bindingId: string; kind: ApprovalKind; decision: "allow" | "deny" };
type RecordStatus = "waiting" | "allowed" | "denied";
type DurableRecord = { requestId: string; threadId: string; messageId: string; botId: string; bindingId: string; kind: ApprovalKind; binding: ApprovalBinding; createdAt: number; expiresAt: number; status: RecordStatus; continued?: boolean };
export type ApprovalsOptions = {
  /** Where the continuation records live (inside browser-extension/, never backed up). Without it nothing is durable. */
  file?: string;
  now?: () => number;
  /** Is this binding still the one the card was raised for (same generation, not stopped)? Asked before an answer runs anything. */
  valid?: (record: { bindingId: string; botId: string; threadId: string; generation: number }) => boolean;
  /** Start the continuation turn. Return false when it could not start now (the bot is busy); it is retried by drain. */
  onContinue?: (info: ContinuationInfo) => boolean | void | Promise<boolean | void>;
};
const sameBinding = (a: ApprovalBinding, b: ApprovalBinding) => a.generation === b.generation && a.documentEpoch === b.documentEpoch && a.targetDigest === b.targetDigest
  && a.submissionDigest === b.submissionDigest && a.payloadDigest === b.payloadDigest && a.actionDigest === b.actionDigest;
function readBinding(value: unknown): ApprovalBinding | undefined {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== "object" || !Number.isSafeInteger(v.generation) || (v.generation as number) < 1 || typeof v.documentEpoch !== "string" || !v.documentEpoch || v.documentEpoch.length > 600) return undefined;
  if (![v.targetDigest, v.submissionDigest, v.payloadDigest, v.actionDigest].every(item => typeof item === "string" && HEX.test(item))) return undefined;
  return { generation: v.generation as number, documentEpoch: v.documentEpoch, targetDigest: v.targetDigest as string, submissionDigest: v.submissionDigest as string, payloadDigest: v.payloadDigest as string, actionDigest: v.actionDigest as string };
}
export type BrowserExtensionApprovalRequest = {
  bot: Pick<BotRecord, "id" | "name" | "color">;
  threadId: string;
  bindingId: string;
  generation: number;
  /** Digest of the trusted action, including profile, document epoch and observed target. */
  digest: string;
  /** Executor-produced, redacted human description, never model-authored instructions. */
  summary: string;
  /** What a push notification may say. Never typed text or field values. */
  pushSummary?: string;
  signal?: AbortSignal;
  waitMs?: number;
  scope?: "site" | "action";
  /** T22: with a binding, a wait that runs out leaves the card live (durable) instead of dismissing it. */
  binding?: ApprovalBinding;
  kind?: ApprovalKind;
  /** D1: the card is for a step Murage asks about every time, in every mode (deleting, or a send to a recipient the owner never named). */
  cardKind?: "delete" | "newRecipient";
};
type Pending = {
  threadId: string; bindingId: string; generation: number; digest: string; botId: string;
  requestId: string; messageId: string; finish: (allow: boolean, user: boolean) => void;
};
/** Owner response routes alone may call resolve. This class never auto-approves. */
export class BrowserExtensionApprovals {
  private readonly bus: ApprovalBus;
  private pending = new Map<string, Pending>();
  private readonly options: ApprovalsOptions;
  private records = new Map<string, DurableRecord>();
  /** A damaged or unrecognised file: nothing in it is trusted and every card it might have covered is dismissed. */
  private unreadable = false;
  /** Action cards saved by an earlier run. Their digests were keyed by that run's secret, so no action of this run can match them. */
  private restored = new Set<string>();
  private firing = new Set<Promise<void>>();
  constructor(bus: ApprovalBus, options: ApprovalsOptions = {}) { this.bus = bus; this.options = options; this.load(); }
  private now() { return this.options.now?.() ?? Date.now(); }
  /** Plain request: true only when the person allowed it inside the wait. */
  request(input: BrowserExtensionApprovalRequest): Promise<boolean> { return this.ask(input).then(state => state === "allow"); }
  ask(input: BrowserExtensionApprovalRequest): Promise<ApprovalState> {
    const waitMs = input.waitMs ?? 45000;
    // A binding that would not read back from the file is not durable: the wait ends as it always did.
    const durable = input.binding && this.options.file ? readBinding(input.binding) : undefined;
    if (input.signal?.aborted) return Promise.resolve("cancelled");
    if (durable) {
      const same = [...this.records.values()].find(record => record.status === "waiting" && record.bindingId === input.bindingId && record.kind === (input.kind ?? "action") && sameBinding(record.binding, durable) && record.expiresAt > this.now());
      if (same) return Promise.resolve("waiting");
    }
    if (![input.threadId, input.bindingId, input.bot.id].every(value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)) || !Number.isSafeInteger(input.generation) || input.generation < 1 || !/^[a-f0-9]{64}$/.test(input.digest) || typeof input.summary !== "string" || !input.summary.trim() || input.summary.length > MAX_SUMMARY || !Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > MAX_WAIT_MS) return Promise.resolve("cancelled");
    if (this.pending.size >= 256 || (durable && this.records.size >= MAX_RECORDS)) return Promise.resolve("cancelled");
    // A restart gives approval digests a new secret, so a card from before it can never match this step. Close it and say why on the new one.
    let summary = input.summary;
    if (durable && (input.kind ?? "action") === "action") {
      const old = [...this.records.values()].filter(record => this.restored.has(record.requestId) && record.bindingId === input.bindingId && record.kind === "action" && !sameBinding(record.binding, durable));
      if (old.length) {
        for (const record of old) { this.restored.delete(record.requestId); this.forget(record, true); }
        summary = `Murage restarted since an earlier request on this task, so that one was closed. Please answer this new one.\n${summary}`;
        if (summary.length > MAX_SUMMARY) summary = input.summary;
      }
    }
    // Every call owns a distinct card and continuation, including identical actions.
    const requestId = "browser-" + randomUUID();
    const message = this.bus.store.appendMessage(input.threadId, {
      role: "bot", kind: "options",
      from: { botId: input.bot.id, name: input.bot.name, color: input.bot.color },
      card: { title: input.scope === "site" ? `${input.bot.name} wants to use this site` : `${input.bot.name} needs your approval`, subtitle: summary,
        options: ["Allow", "Deny"], requestId, tool: BROWSER_EXTENSION_APPROVAL_TOOL, ...(input.pushSummary ? { pushBody: input.pushSummary.slice(0, 300) } : {}), ...(input.cardKind && input.scope !== "site" ? { browserCardKind: input.cardKind } : {}),
        held: input.scope === "site" ? "Allow remembers site access for this browser task. You can revoke it in Browser settings. Sending, purchasing and other changes have separate approvals." : "Allow applies to this action once. Site access does not approve actions. Text marked \"From the page\" was written by the website, not by Murage or the bot." + (input.cardKind ? " Murage asks every time for this, in every mode." : "") },
    });
    return new Promise<ApprovalState>(resolve => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const aborted = () => finish(false, false);
      const finish = (allow: boolean, user: boolean, waiting = false) => {
        if (settled) return;
        settled = true; this.pending.delete(requestId); clearTimeout(timer);
        input.signal?.removeEventListener("abort", aborted);
        // Missing/changed cards cannot authorize the waiting operation.
        const current = this.bus.store.messagesFor(input.threadId).find(candidate => candidate.id === message.id)?.card;
        const deliver = !!current && current.requestId === requestId && current.tool === BROWSER_EXTENSION_APPROVAL_TOOL && !current.answered && !current.dismissed;
        if (waiting) {
          // The wait ran out. The call returns WAITING; the card stays live and a private record keeps it answerable (spec 2.8).
          if (!deliver || !durable) { resolve("cancelled"); return; }
          const at = this.now();
          this.records.set(requestId, { requestId, threadId: input.threadId, messageId: message.id, botId: input.bot.id, bindingId: input.bindingId, kind: input.kind ?? "action", binding: durable, createdAt: at, expiresAt: at + CARD_LIFETIME_MS, status: "waiting" });
          if (!this.save()) { this.records.delete(requestId); this.dismiss(input.threadId, message.id); resolve("cancelled"); return; }
          resolve("waiting"); return;
        }
        try {
          if (deliver) this.bus.store.patchMessage(input.threadId, message.id, { card: { ...current, answered: user ? (allow ? "allow" : "deny") : "unavailable", dismissed: !user } });
          resolve(!deliver ? "cancelled" : !user ? "cancelled" : allow ? "allow" : "deny");
        } catch { resolve("cancelled"); }
      };
      this.pending.set(requestId, { threadId: input.threadId, bindingId: input.bindingId, generation: input.generation, digest: input.digest, botId: input.bot.id, requestId, messageId: message.id, finish: (allow, user) => finish(allow, user) });
      timer = setTimeout(() => (durable ? finish(false, false, true) : finish(false, false)), waitMs); timer.unref?.();
      input.signal?.addEventListener("abort", aborted, { once: true });
      if (input.signal?.aborted) { aborted(); return; }
      try { this.bus.onApproval?.(input.bot.id, input.threadId, requestId, message.id); } catch { /* Notification failure grants no authority. */ }
    });
  }
  resolve(threadId: string, requestId: string, behavior: string | undefined): boolean {
    if (behavior !== "allow" && behavior !== "deny") return false;
    const pending = this.pending.get(requestId);
    if (pending) { if (pending.threadId !== threadId) return false; pending.finish(behavior === "allow", true); return true; }
    return this.answerLater(threadId, requestId, behavior);
  }
  /** Is this card live, in memory or saved? */
  knows(requestId: string): boolean { return this.pending.has(requestId) || this.records.has(requestId); }
  /** The owner answers a card whose call has already returned WAITING (or that survived a restart). */
  private answerLater(threadId: string, requestId: string, behavior: "allow" | "deny"): boolean {
    const record = this.records.get(requestId);
    if (!record || record.threadId !== threadId || record.status !== "waiting") return false;
    const card = this.cardOf(record);
    if (!card || card.answered || card.dismissed) { this.forget(record, true); return false; }
    // Expired, or the binding is not the one the card was raised for: the card closes and nothing runs.
    let valid = false;
    try { valid = this.now() < record.expiresAt && (this.options.valid?.({ bindingId: record.bindingId, botId: record.botId, threadId: record.threadId, generation: record.binding.generation }) ?? true); } catch { valid = false; }
    if (!valid) { this.forget(record, true); return false; }
    try { this.bus.store.patchMessage(record.threadId, record.messageId, { card: { ...card, answered: behavior, dismissed: false } }); } catch { this.forget(record, true); return false; }
    record.status = behavior === "allow" ? "allowed" : "denied";
    if (!this.save()) { this.forget(record, true); return false; }
    this.fire(record);
    return true;
  }
  /** The first matching action uses the approval; it works once. Anything that differs in any binding field does not match. */
  consume(query: { bindingId: string; kind: ApprovalKind; binding: ApprovalBinding }): boolean {
    for (const record of [...this.records.values()]) {
      if (record.status !== "allowed" || record.bindingId !== query.bindingId || record.kind !== query.kind) continue;
      if (this.now() >= record.expiresAt) { this.forget(record, true); continue; }
      const card = this.cardOf(record);
      if (!card || card.answered !== "allow" || card.dismissed) { this.forget(record, false); continue; }
      if (!sameBinding(record.binding, query.binding)) continue;
      let valid = false;
      try { valid = this.options.valid?.({ bindingId: record.bindingId, botId: record.botId, threadId: record.threadId, generation: record.binding.generation }) ?? true; } catch { valid = false; }
      this.forget(record, false);
      return valid;
    }
    return false;
  }
  /** Stop, Never, Revoke and End task: every waiting card and unused approval of the binding ends. */
  /** True while a card of this binding is on screen and unanswered. */
  hasWaiting(bindingId: string): boolean {
    for (const pending of this.pending.values()) if (pending.bindingId === bindingId) return true;
    for (const record of this.records.values()) if (record.bindingId === bindingId && record.status === "waiting") return true;
    return false;
  }
  cancelBinding(bindingId: string): void {
    for (const pending of [...this.pending.values()]) if (pending.bindingId === bindingId) pending.finish(false, false);
    for (const record of [...this.records.values()]) if (record.bindingId === bindingId) this.forget(record, true);
  }
  cancelThread(threadId: string): void {
    for (const pending of [...this.pending.values()]) if (pending.threadId === threadId) pending.finish(false, false);
    for (const record of [...this.records.values()]) if (record.threadId === threadId) this.forget(record, true);
  }
  /** Close every card past its 24 hours. Called on a timer. */
  sweep(): number {
    let count = 0;
    for (const record of [...this.records.values()]) if (this.now() >= record.expiresAt) { this.forget(record, true); count++; }
    return count;
  }
  /** Start continuations that could not start when the answer came (the bot was busy). Each runs at most once. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.firing]);
    for (const record of [...this.records.values()]) if (record.status !== "waiting" && !record.continued && this.now() < record.expiresAt) this.fire(record);
    await Promise.allSettled([...this.firing]);
  }
  private fire(record: DurableRecord): void {
    const hook = this.options.onContinue;
    if (!hook || record.continued) return;
    // Consume before dispatch: a lost response or a restart never replays the continuation.
    record.continued = true; this.save();
    const info: ContinuationInfo = { requestId: record.requestId, botId: record.botId, threadId: record.threadId, bindingId: record.bindingId, kind: record.kind, decision: record.status === "allowed" ? "allow" : "deny" };
    const done = (async () => {
      let started: boolean | void = true;
      try { started = await hook(info); } catch { started = true; }
      if (started === false) { record.continued = false; this.save(); }
      else if (record.status === "denied") { this.records.delete(record.requestId); this.save(); }
    })();
    this.firing.add(done); void done.finally(() => this.firing.delete(done));
  }
  /** Startup only. A card with a live saved record stays answerable; every other browser card is closed. */
  dismissStale(): number {
    const threads = new Set<string>();
    for (const owner of [...this.bus.store.bots, ...this.bus.store.groups]) { threads.add(owner.threadId); for (const task of owner.tasks ?? []) threads.add(task.threadId); }
    let count = 0;
    for (const record of [...this.records.values()]) if (this.now() >= record.expiresAt) { this.forget(record, true); count++; }
    for (const threadId of threads) for (const message of this.bus.store.messagesFor(threadId)) {
      const card = message.card;
      if (card?.tool !== BROWSER_EXTENSION_APPROVAL_TOOL || !card.requestId || card.answered || card.dismissed || this.pending.has(card.requestId)) continue;
      const record = this.records.get(card.requestId);
      if (record && !this.unreadable && record.messageId === message.id && record.threadId === threadId && record.status === "waiting") continue;
      if (this.bus.store.patchMessage(threadId, message.id, { card: { ...card, answered: "unavailable", dismissed: true } })) count++;
    }
    return count;
  }
  private cardOf(record: DurableRecord) {
    const card = this.bus.store.messagesFor(record.threadId).find(message => message.id === record.messageId)?.card;
    return card && card.requestId === record.requestId && card.tool === BROWSER_EXTENSION_APPROVAL_TOOL ? card : undefined;
  }
  private dismiss(threadId: string, messageId: string) {
    try {
      const card = this.bus.store.messagesFor(threadId).find(message => message.id === messageId)?.card;
      if (card && !card.answered && !card.dismissed) this.bus.store.patchMessage(threadId, messageId, { card: { ...card, answered: "unavailable", dismissed: true } });
    } catch { /* a card that cannot be closed still authorizes nothing: the record is gone */ }
  }
  private forget(record: DurableRecord, closeCard: boolean) {
    this.records.delete(record.requestId);
    if (closeCard) this.dismiss(record.threadId, record.messageId);
    this.save();
  }
  private load(): void {
    const file = this.options.file; if (!file) return;
    try {
      const win = process.platform === "win32";
      let stat: fs.Stats;
      try { stat = fs.lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES || (!win && (stat.uid !== process.getuid?.() || (stat.mode & 0o077)))) throw new Error("unsafe_file");
      const root = (win ? readPrivateWindowsJson(file) : JSON.parse(fs.readFileSync(file, "utf8"))) as { version?: unknown; records?: unknown } | null;
      if (!root || typeof root !== "object" || Array.isArray(root) || root.version !== FILE_VERSION || !Array.isArray(root.records) || root.records.length > MAX_RECORDS) throw new Error("invalid_file");
      const loaded = new Map<string, DurableRecord>();
      for (const raw of root.records as Record<string, unknown>[]) {
        const binding = readBinding(raw?.binding);
        if (!raw || typeof raw !== "object" || !binding || ![raw.requestId, raw.threadId, raw.messageId, raw.botId, raw.bindingId].every(v => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(v))
          || (raw.kind !== "site" && raw.kind !== "action") || !["waiting", "allowed", "denied"].includes(raw.status as string)
          || !Number.isSafeInteger(raw.createdAt) || !Number.isSafeInteger(raw.expiresAt) || (raw.expiresAt as number) - (raw.createdAt as number) > CARD_LIFETIME_MS || (raw.continued !== undefined && raw.continued !== true)) throw new Error("invalid_record");
        loaded.set(raw.requestId as string, { requestId: raw.requestId as string, threadId: raw.threadId as string, messageId: raw.messageId as string, botId: raw.botId as string, bindingId: raw.bindingId as string,
          kind: raw.kind as ApprovalKind, binding, createdAt: raw.createdAt as number, expiresAt: raw.expiresAt as number, status: raw.status as RecordStatus, ...(raw.continued ? { continued: true } : {}) });
      }
      this.records = loaded;
      this.restored = new Set([...loaded.values()].filter(record => record.kind === "action").map(record => record.requestId));
    } catch { this.records = new Map(); this.unreadable = true; }
  }
  /** False when the file could not be written: the caller then treats the card as not durable. */
  private save(): boolean {
    const file = this.options.file; if (!file) return true;
    try {
      const content = { version: FILE_VERSION, records: [...this.records.values()] };
      const win = process.platform === "win32";
      if (win) createPrivateWindowsDirectory(path.dirname(file)); else fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      if (win) { writePrivateWindowsJson(file, content); this.unreadable = false; return true; }
      const temp = `${file}.${randomUUID()}.tmp`;
      try { fs.writeFileSync(temp, JSON.stringify(content), { mode: 0o600, flag: "wx" }); fs.renameSync(temp, file); }
      finally { fs.rmSync(temp, { force: true }); }
      this.unreadable = false; return true;
    } catch { return false; }
  }
}
