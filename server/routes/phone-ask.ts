// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The share and ask routes (S34 targets, S36 share; S38 adds ask here). The module owns no state: every dependency is
// injected, and the caller (server/index.ts) has already proved the phone's ask envelope (phoneAskCaller).
import { createHash } from "node:crypto";
import { withoutAttachmentTagLines } from "../../src/lib/composer-attachments.ts";
import { botAvatarProfile } from "../../shared/bot-avatar.ts";
import { messageTooLargeRefusal } from "../../shared/message-limits.ts";
import { applyNotificationPreferences } from "../../shared/notification-preferences.ts";
import { buildNotification } from "../notify.ts";
import { askSchema, manifestSchema, SHARE_IMAGE_MIME_LIST, SHARE_LIMITS, TARGETS_RECENT_MAX, type AskCode, type ShareCode, type TargetsAnswer } from "../../shared/phone-ask-contract.ts";
import type { AskRevocations } from "../phones/ask-revocations.ts";
import { commitPhoneLine, PhoneCommitConflict } from "../phones/commit.ts";
import { readShareParts, ShareBodyError } from "../phones/multipart.ts";
import type { PhoneReceipts, PlannedFile } from "../phones/receipts.ts";
import { phoneTarget, type TargetBot } from "../phones/target.ts";
import type { SendRow, SendStore } from "../send-store.ts";

export interface AskRouteBot {
  id: string;
  name: string;
  threadId: string;
  avatarUrl?: unknown;
  avatarCrop?: unknown;
  sidebarHidden?: boolean;
  tasks?: Array<{ threadId: string; title: string; createdAt: number }>;
}

export interface AskTargetsDeps {
  /** shareAskOffered for this host right now. */
  offered(): boolean;
  revocations: Pick<AskRevocations, "refuses">;
  bots(): readonly AskRouteBot[];
  bot(id: string): AskRouteBot | null;
  /** isDirectOwnerThread for this store. */
  direct(botId: string, threadId: string): boolean;
  lastActivityAt(threadId: string): number | undefined;
  workspace(): string;
}

export interface AskRouteAnswer { status: number; body: unknown }

/**
 * GET /api/phones/self/targets: the bots and recent chats a phone's share or ask may land in. Every entry passes phoneTarget, the
 * one decision; a bot the owner hides is never listed. No message text, previews or counts. Pure and synchronous.
 */
export function phoneAskTargets(caller: { deviceId: string; generation: number } | null, deps: AskTargetsDeps): AskRouteAnswer {
  if (!deps.offered()) return { status: 404, body: { error: "no such route" } };
  if (!caller) return { status: 403, body: { error: "This route is for the phone's own runner." } };
  if (deps.revocations.refuses(caller.deviceId, caller.generation)) return { status: 403, body: { error: "revoked", code: "revoked" } };
  const allowed = (botId: string, threadId: string) => phoneTarget(
    { deviceId: caller.deviceId, generation: caller.generation, botId, threadId },
    { offered: deps.offered, revocations: deps.revocations as AskRevocations, bot: (id) => { const b = deps.bot(id); return b ? { hidden: b.sidebarHidden === true } : null; }, direct: deps.direct },
  ).ok;
  const bots: TargetsAnswer["bots"] = [];
  const recent: Array<TargetsAnswer["recent"][number] & { order: number }> = [];
  for (const bot of deps.bots()) {
    if (!allowed(bot.id, bot.threadId)) continue;
    bots.push({ id: bot.id, name: bot.name, avatar: botAvatarProfile(bot).avatarUrl ?? null, mainThreadId: bot.threadId });
    for (const task of bot.tasks ?? []) {
      if (!allowed(bot.id, task.threadId)) continue;
      recent.push({ botId: bot.id, threadId: task.threadId, title: task.title.slice(0, 200), at: deps.lastActivityAt(task.threadId) ?? task.createdAt, order: recent.length });
    }
  }
  recent.sort((a, b) => b.at - a.at || a.order - b.order);
  const body: TargetsAnswer = { workspace: deps.workspace(), bots, recent: recent.slice(0, TARGETS_RECENT_MAX).map(({ order: _order, ...row }) => row) };
  return { status: 200, body };
}

// ── S36: POST /api/phones/self/share ──────────────────────────────────────────────────────────────────────────────

/** Where a test (or nothing) may stop the share: the crash windows of design 5.3, and the yield after each stored item. */
export type ShareStage = "received" | "created" | "planned" | "item" | "saved";

export interface AskShareDeps {
  offered(): boolean;
  revocations: Pick<AskRevocations, "refuses">;
  /** The bot for phoneTarget: null when there is none; `hidden` when the owner hides it. */
  bot(id: string): TargetBot | null;
  direct(botId: string, threadId: string): boolean;
  /** The two store calls the new-chat path needs; createTask's fifth parameter is the reserved thread id. */
  store: {
    taskByThread(botId: string, threadId: string): unknown;
    createTask(botId: string, title: undefined, activate: boolean, channelProjectDesk: undefined, preparedThreadId: string): unknown;
  };
  sendStore: SendStore;
  receipts: PhoneReceipts;
  files: {
    /** The extension stored for a media type (image or document), or null. */
    ext(mime: string): string | null;
    saveImage(bytes: Buffer, mime: string, uploadId: string): Promise<{ path: string; mime: string; bytes: number }>;
    saveFile(chunks: AsyncIterable<Uint8Array>, name: string, mime: string, options: { uploadId: string }): Promise<{ path: string; mime: string; bytes: number }>;
    remove(path: string): void;
  };
  /** drainQueuedSends(): runs after the commit, and after a replayed commit. */
  drain(): void;
  now(): number;
  checkpoint?(stage: ShareStage, n?: number): void | Promise<void>;
}

const SHARE_ERRORS: Record<ShareCode, { status: number; error: string }> = {
  conflict: { status: 409, error: "This share was already sent a different way." },
  target_gone: { status: 409, error: "That bot or chat is no longer there." },
  too_large: { status: 413, error: "That share is too large." },
  unsupported_type: { status: 415, error: "That kind of file cannot be shared." },
  invalid: { status: 422, error: "That share could not be read." },
  revoked: { status: 401, error: "This phone no longer has access." },
};
const refuse = (code: ShareCode): AskRouteAnswer => ({ status: SHARE_ERRORS[code].status, body: { error: SHARE_ERRORS[code].error, code } });

const IMAGE_MIMES: ReadonlySet<string> = new Set<string>(SHARE_IMAGE_MIME_LIST);

/** A UUID v8 from SHA-256 of the device, the share id and the item number: a retry names the same stored file. */
export function shareUploadId(deviceId: string, shareId: string, n: number): string {
  const b = Buffer.from(createHash("sha256").update(`${deviceId}\n${shareId}\n${n}`, "utf8").digest().subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x80;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const x = b.toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The composer's own escape for a path inside a quoted attribute (src/lib/composer-attachments.ts escapeAttribute; a test pins the two). */
function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\t", "&#9;").replaceAll("\r", "&#13;").replaceAll("\n", "&#10;");
}

/** The incoming bytes are not the bytes the manifest named. */
class ShareMismatch extends Error {
  constructor() { super("an item differs from the manifest"); this.name = "ShareMismatch"; }
}

/** The share code for an error the request itself caused, or null for anything else (which is a fault, never a refusal). */
function refusalFor(e: unknown): ShareCode | null {
  if (e instanceof ShareBodyError) return e.code === "too_large" ? "too_large" : "invalid";
  if (e instanceof ShareMismatch) return "invalid";
  const status = e && typeof e === "object" ? (e as { status?: unknown }).status : undefined;
  if (status === 413) return "too_large";
  if (typeof status === "number" && status >= 400 && status < 500) return "invalid";
  return null;
}

/**
 * A refusal kept in a receipt is replayed to the credential it was made for. `revoked` is about that credential: a phone that has since
 * minted a newer generation (above the floor) must not be told 401 for good, which would loop it through re-mint and retry. It gets the
 * terminal `target_gone` instead (409), which the phone's outbox drops; the item can never land under its old receipt.
 */
function replayedRefusal<C extends string>(code: C, receiptGeneration: number, generation: number): C | "target_gone" {
  return code === "revoked" && generation > receiptGeneration ? "target_gone" : code;
}

/** Why a manifest failed: too many items is too_large, a media type outside the lists is unsupported_type, anything else is invalid. */
function manifestFault(issues: ReadonlyArray<{ code: string; path: ReadonlyArray<PropertyKey>; message: string }>): ShareCode {
  if (issues.some((i) => i.code === "too_big" && i.path.length === 1 && i.path[0] === "items")) return "too_large";
  if (issues.length > 0 && issues.every((i) => i.path.length === 3 && i.path[0] === "items" && i.path[2] === "mime" && i.message === "mime not offered")) return "unsupported_type";
  return "invalid";
}

/**
 * POST /api/phones/self/share (design 5.3). The caller has proved the ask envelope. Order: manifest and receipt, early target, reserve
 * the receipt and the chat, plan the files, stream and store each item, then one commit section and the drain. A retry of the same
 * share id, at any point, reuses what the first try reserved and stored. The answer never carries the phone's words.
 */
export async function phoneAskShare(
  caller: { deviceId: string; generation: number } | null,
  request: { contentType: string; body: AsyncIterable<Buffer> },
  deps: AskShareDeps,
): Promise<AskRouteAnswer> {
  if (!deps.offered()) return { status: 404, body: { error: "no such route" } };
  if (!caller) return { status: 403, body: { error: "This route is for the phone's own runner." } };
  const { deviceId, generation } = caller;
  if (deps.revocations.refuses(deviceId, generation)) return refuse("revoked");
  const checkpoint = async (stage: ShareStage, n?: number) => { await deps.checkpoint?.(stage, n); };
  const targetFor = (botId: string, threadId: string | "new") => () => phoneTarget(
    { deviceId, generation, botId, threadId },
    { offered: deps.offered, revocations: deps.revocations as AskRevocations, bot: deps.bot, direct: deps.direct },
  );

  const parts = readShareParts(request.body, request.contentType, { maxBytes: SHARE_LIMITS.doorMaxBytes, maxParts: SHARE_LIMITS.maxItems + 1 });
  const stored: NonNullable<SendRow["attachments"]> = [];
  let shareId: string | null = null;
  // A retry of the same share id stores under the same upload ids, so another attempt may have committed these very files while this one
  // failed. Re-read the receipt first: once it is committed the queued row owns them, and nothing here may delete them.
  const discard = () => {
    const files = stored.splice(0);
    try { if (shareId !== null && deps.receipts.get(deviceId, "share", shareId)?.state === "committed") return; } catch { return; }
    for (const f of files) { try { deps.files.remove(f.path); } catch { /* the planned list in the receipt still names it */ } }
  };
  try {
    // (a) the manifest and the receipt
    const first = await parts.next();
    if (first.done || first.value.name !== "manifest") return refuse("invalid");
    const parsed = manifestSchema.safeParse(first.value.json);
    if (!parsed.success) return refuse(manifestFault(parsed.error.issues));
    const m = parsed.data;
    shareId = m.shareId;
    let total = 0;
    for (const it of m.items) {
      total += it.bytes;
      if (it.bytes > (IMAGE_MIMES.has(it.mime) ? SHARE_LIMITS.imageMaxBytes : SHARE_LIMITS.fileMaxBytes)) return refuse("too_large");
    }
    if (total > SHARE_LIMITS.maxShareBytes) return refuse("too_large");
    const fingerprint = createHash("sha256").update(stable(m), "utf8").digest("hex");
    const prior = deps.receipts.get(deviceId, "share", m.shareId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) return refuse("conflict");
      if (prior.state === "refused" && prior.code) return refuse(replayedRefusal(prior.code, prior.generation, generation));
      if (prior.state === "committed" && prior.result) {
        try { deps.drain(); } catch { /* the next drain picks the line up */ }
        const row = deps.sendStore.byQueueId(m.botId, prior.result.queueId);
        return { status: 200, body: row?.messageId ? { state: "sent", threadId: prior.result.threadId, messageId: row.messageId } : { state: "sent", threadId: prior.result.threadId, queueId: prior.result.queueId } };
      }
    }

    // (b) the early target: a refused phone or a gone bot costs no file work
    const early = targetFor(m.botId, m.threadId)();
    if (!early.ok) return refuse(early.code);

    // (c) reserve, then create: the receipt picks the chat id before any task exists, so every retry meets the same one
    const receipt = deps.receipts.receive({ deviceId, kind: "share", id: m.shareId, fingerprint, generation, newTarget: m.threadId === "new", itemHashes: m.items.map((it) => it.sha256) });
    if (receipt.fingerprint !== fingerprint) return refuse("conflict");
    await checkpoint("received");
    const threadId = m.threadId === "new" ? receipt.allocatedThreadId : m.threadId;
    if (!threadId) return refuse("invalid");
    if (m.threadId === "new") {
      // no await between this check and the call: a concurrent retry sees the task, never makes a second one
      if (!deps.store.taskByThread(m.botId, threadId) && !deps.store.createTask(m.botId, undefined, false, undefined, threadId)) return refuse("target_gone");
    }
    await checkpoint("created");

    // (c2) the plan, written before the first byte of any item is saved
    const planned: PlannedFile[] = [];
    for (const it of m.items) {
      const ext = deps.files.ext(it.mime);
      if (!ext) return refuse("unsupported_type");
      planned.push({ n: it.n, uploadId: shareUploadId(deviceId, m.shareId, it.n), ext, kind: IMAGE_MIMES.has(it.mime) ? "image" : "file", mime: it.mime });
    }
    deps.receipts.plan(deviceId, "share", m.shareId, planned);
    await checkpoint("planned");

    // (d) stream each item: a picture is held (10 MiB at most) and stored as an image; a document streams to disk
    for (const [i, it] of m.items.entries()) {
      const step = await parts.next();
      if (step.done || step.value.name !== `item-${it.n}` || !("data" in step.value) || step.value.mime !== it.mime) { discard(); return refuse("invalid"); }
      const plan = planned[i]!;
      const hash = createHash("sha256");
      let count = 0;
      const counted = async function* (): AsyncGenerator<Buffer> {
        for await (const chunk of (step.value as { data: AsyncIterable<Buffer> }).data) {
          count += chunk.length;
          if (count > it.bytes) throw new ShareMismatch();
          hash.update(chunk);
          yield chunk;
        }
      };
      if (plan.kind === "image") {
        const chunks: Buffer[] = [];
        for await (const chunk of counted()) chunks.push(chunk);
        if (count !== it.bytes || hash.digest("hex") !== it.sha256) { discard(); return refuse("invalid"); }
        const saved = await deps.files.saveImage(Buffer.concat(chunks), it.mime, plan.uploadId);
        stored.push({ kind: "image", path: saved.path, mime: saved.mime });
      } else {
        const saved = await deps.files.saveFile(counted(), it.name, it.mime, { uploadId: plan.uploadId });
        stored.push({ kind: "file", path: saved.path, mime: saved.mime });
        if (count !== it.bytes || hash.digest("hex") !== it.sha256) { discard(); return refuse("invalid"); }
      }
      await checkpoint("item", it.n);
    }
    const rest = await parts.next();
    if (!rest.done) { discard(); return refuse("invalid"); }
    deps.receipts.setFiles(deviceId, "share", m.shareId, stored.length ? stored : null);
    await checkpoint("saved");

    // (e) the line: note, text, url, then the composer's tags for the files, joined by blank lines
    const tags = stored.map((f) => `<attached-${f.kind === "image" ? "image" : "file"} path="${escapeAttribute(f.path)}" />`);
    // The phone's own words never carry an attachment tag: only the tags below name a file.
    const message = [m.note, m.text, m.url].map((part) => withoutAttachmentTagLines(part ?? "")).concat(tags).map((part) => part.trim()).filter(Boolean).join("\n\n");
    if (!message) { discard(); return refuse("invalid"); }
    if (messageTooLargeRefusal(message)) { discard(); return refuse("too_large"); }
    // The queued row carries the pictures only (the drain refuses a stored file); a document travels as the path in the text.
    const images = stored.filter((f) => f.kind === "image");
    let outcome: ReturnType<typeof commitPhoneLine>;
    try {
      outcome = commitPhoneLine(
        { receipt, botId: m.botId, threadId, text: message, via: "share", files: images.length ? images : null },
        { target: targetFor(m.botId, threadId), sendStore: deps.sendStore, receipts: deps.receipts, deleteFiles: () => discard(), now: deps.now },
      );
    } catch (e) {
      if (e instanceof PhoneCommitConflict) { discard(); return refuse("conflict"); }
      throw e;
    }
    if (!outcome.ok) return refuse(replayedRefusal(outcome.code, deps.receipts.get(deviceId, "share", m.shareId)?.generation ?? receipt.generation, generation));
    try { deps.drain(); } catch { /* the line is committed; the next drain runs it */ }
    return { status: 200, body: { state: "sent", threadId: outcome.result.threadId, queueId: outcome.result.queueId } };
  } catch (e) {
    const code = refusalFor(e);
    if (code === null) throw e;
    discard();
    return refuse(code);
  } finally {
    try { await parts.return(undefined); } catch { /* the body is already done */ }
  }
}


// ── S38: POST /api/phones/self/ask ────────────────────────────────────────────────────────────────────────────────

export interface AskAskDeps {
  offered(): boolean;
  revocations: Pick<AskRevocations, "refuses">;
  /** The bot for phoneTarget, with what the "done" push needs: its name, its main thread and its own notifications switch. */
  bot(id: string): (TargetBot & { name: string; threadId: string; notifications?: boolean }) | null;
  direct(botId: string, threadId: string): boolean;
  sendStore: SendStore;
  receipts: PhoneReceipts;
  /** The asking phone's push binding, and its host-only key secret. */
  push: { binding(deviceId: string): { bindingId: string } | null; keySecret(bindingId: string): string | null };
  /** cfg.notifications: the owner's preferences. */
  notificationPrefs(): unknown;
  /** drainQueuedSends(): runs after the commit, and after a replayed commit. */
  drain(): void;
  readBody(): Promise<unknown>;
  now(): number;
}

/** The ask's own text cap (plan S38); the shared schema allows more, and the door's 8 KiB body cap sits in front of both. */
export const ASK_TEXT_MAX_CHARS = 4000;

const ASK_ERRORS: Record<AskCode, { status: number; error: string }> = {
  conflict: { status: 409, error: "This ask was already sent a different way." },
  target_gone: { status: 409, error: "That bot is no longer there." },
  invalid: { status: 422, error: "That ask could not be read." },
  revoked: { status: 401, error: "This phone no longer has access." },
};
const refuseAsk = (code: AskCode): AskRouteAnswer => ({ status: ASK_ERRORS[code].status, body: { error: ASK_ERRORS[code].error, code } });

/**
 * POST /api/phones/self/ask (design 5.4). One line, born from the phone, into the bot's main thread. Same order as the share: body,
 * receipt, target, one commit section, the drain. The answer is status only: ids and a notify flag, never any words from the bot.
 */
export async function phoneAskAsk(caller: { deviceId: string; generation: number } | null, deps: AskAskDeps): Promise<AskRouteAnswer> {
  if (!deps.offered()) return { status: 404, body: { error: "no such route" } };
  if (!caller) return { status: 403, body: { error: "This route is for the phone's own runner." } };
  const { deviceId, generation } = caller;
  if (deps.revocations.refuses(deviceId, generation)) return refuseAsk("revoked");
  let raw: unknown;
  try { raw = await deps.readBody(); } catch { return refuseAsk("invalid"); }
  const parsed = askSchema.safeParse(raw);
  if (!parsed.success || parsed.data.text.length > ASK_TEXT_MAX_CHARS) return refuseAsk("invalid");
  const { askId, botId } = parsed.data;
  // A line of the ask that is an attachment tag is dropped; an ask that was only tags says nothing.
  const text = withoutAttachmentTagLines(parsed.data.text).trim();
  if (!text) return refuseAsk("invalid");
  const fingerprint = createHash("sha256").update(stable({ botId, text: parsed.data.text }), "utf8").digest("hex");
  const targetFor = (threadId: string) => () => phoneTarget(
    { deviceId, generation, botId, threadId },
    { offered: deps.offered, revocations: deps.revocations as AskRevocations, bot: deps.bot, direct: deps.direct },
  );
  const answer = (threadId: string, queueId: string): AskRouteAnswer => {
    const bot = deps.bot(botId);
    let notify = false;
    try {
      const binding = deps.push.binding(deviceId);
      if (bot && binding && deps.push.keySecret(binding.bindingId)) {
        // The frame is only asked whether it would be sent; a fixed word stands in for the bot's reply, which does not exist yet.
        const frame = buildNotification("done", { id: botId, name: bot.name, threadId: bot.threadId, ...(bot.notifications === false ? { notifications: false } : {}) }, threadId, "Finished");
        notify = frame !== null && applyNotificationPreferences(frame, deps.notificationPrefs(), new Date(deps.now())) !== null;
      }
    } catch { notify = false; }
    const row = deps.sendStore.byQueueId(botId, queueId);
    return { status: 200, body: { state: "sent", askId, threadId, id: row?.messageId ?? queueId, notify } };
  };

  const prior = deps.receipts.get(deviceId, "ask", askId);
  if (prior) {
    if (prior.fingerprint !== fingerprint) return refuseAsk("conflict");
    if (prior.state === "refused" && prior.code) return refuseAsk(replayedRefusal(prior.code, prior.generation, generation));
    if (prior.state === "committed" && prior.result) {
      try { deps.drain(); } catch { /* the next drain picks the line up */ }
      return answer(prior.result.threadId, prior.result.queueId);
    }
  }
  const bot = deps.bot(botId);
  const early = targetFor(bot?.threadId ?? "")();
  if (!early.ok) return refuseAsk(early.code);
  const threadId = bot!.threadId;
  const receipt = deps.receipts.receive({ deviceId, kind: "ask", id: askId, fingerprint, generation });
  if (receipt.fingerprint !== fingerprint) return refuseAsk("conflict");
  let outcome: ReturnType<typeof commitPhoneLine>;
  try {
    outcome = commitPhoneLine(
      { receipt, botId, threadId, text, via: "ask-intent", files: null },
      { target: targetFor(threadId), sendStore: deps.sendStore, receipts: deps.receipts, deleteFiles: () => {}, now: deps.now },
    );
  } catch (e) {
    if (e instanceof PhoneCommitConflict) return refuseAsk("conflict");
    throw e;
  }
  if (!outcome.ok) return refuseAsk(replayedRefusal(outcome.code, receipt.generation, generation));
  try { deps.drain(); } catch { /* the line is committed; the next drain runs it */ }
  return answer(outcome.result.threadId, outcome.result.queueId);
}
