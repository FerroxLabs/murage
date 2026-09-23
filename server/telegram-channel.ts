import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { normalizeTelegramUpdate } from "./telegram-update.ts";
import { TelegramTransportError, type TelegramTransport } from "./telegram-transport.ts";
import { formatTelegramHtml } from "./telegram-format.ts";
import { TelegramApprovals, type TelegramApprovalActions } from "./telegram-approvals.ts";

const identity = z.string().regex(/^[1-9]\d{0,15}$/).refine(value => Number.isSafeInteger(Number(value)));
const deliveryError = z.enum(["auth", "forbidden", "conflict", "rate-limit", "unavailable", "offline", "timeout", "invalid-request"]);
const recordSchema = z.object({ updateId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1), deliveryId: z.string(), prompt: z.string().max(5000), runId: z.string().max(200).optional(), state: z.enum(["accepted", "queued", "sending", "sent", "uncertain", "rejected", "cancelled"]), response: z.string().max(4096).optional(), sendAttempts: z.number().int().nonnegative().max(3).optional(), retryAt: z.number().finite().optional(), deliveryError: deliveryError.optional() }).strict();
const schema = z.object({ version: z.literal(1), botIdentityId: identity, targetBotId: z.string().min(1).max(180).optional(), enabled: z.boolean(), offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), binding: z.object({ senderId: identity, chatId: identity }).strict().nullable(), pairing: z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().finite() }).strict().nullable(), records: z.array(recordSchema).max(200) }).strict();
type State = z.infer<typeof schema>;
interface Options {
  file: string; transport: Pick<TelegramTransport, "getUpdates" | "sendMessage"> & Partial<Pick<TelegramTransport, "answerCallbackQuery" | "settleApprovalMessage" | "editQuestionMessage" | "sendAudio">>; botIdentityId: string; targetBotId: string;
  approvals?: TelegramApprovalActions;
  isCurrentTarget?: () => boolean;
  onVerifiedSender?: (senderId:string)=>void;
  enqueue: (input: { deliveryId: string; prompt: string; senderId: string }) => { id: string };
  runResult: (id: string) => { status: string; output?: string; error?: string } | null;
  /** Voice notes the run made (server/voice/voice-notes.ts), each handed out
   *  once; sent after the text reply. */
  voiceNotes?: (runId: string) => ChannelVoiceNote[];
  now?: () => number;
}
export interface ChannelVoiceNote { name: string; mime: string; bytes: Uint8Array; text: string; from: string }
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function fail(): never { throw new Error("Telegram channel state is invalid or unavailable; original data was preserved."); }

export class TelegramChannel {
  private state: State;
  private readonly options: Options;
  private generation = 0;
  private stopped = false;
  private controller?: AbortController;
  private polling?: Promise<void>;
  private pollError: string | null = null;
  private pollRetryAt: number | null = null;
  private pollFailures = 0;
  private deliveryFailure = false;
  private approvals?: TelegramApprovals;
  private expiryNoticeSent = false;
  constructor(options: Options) {
    if (!identity.safeParse(options.botIdentityId).success || !z.string().min(1).max(180).safeParse(options.targetBotId).success) fail();
    this.options = options;
    if (options.approvals && options.transport.answerCallbackQuery) this.approvals = new TelegramApprovals(options.approvals, {
      sendMessage: input => options.transport.sendMessage(input),
      answerCallbackQuery: input => options.transport.answerCallbackQuery!(input),
      ...(options.transport.settleApprovalMessage ? { settleApprovalMessage: input => options.transport.settleApprovalMessage!(input) } : {}),
      ...(options.transport.editQuestionMessage ? { editQuestionMessage: input => options.transport.editQuestionMessage!(input) } : {}),
    }, options.now);
    this.state = { version: 1, botIdentityId: options.botIdentityId, targetBotId: options.targetBotId, enabled: false, offset: 0, binding: null, pairing: null, records: [] };
    try {
      const stat = lstatSync(options.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) fail();
      const parsed = schema.safeParse(JSON.parse(readFileSync(options.file, "utf8")));
      if (!parsed.success || parsed.data.botIdentityId !== options.botIdentityId) fail();
      this.state = parsed.data;
      const seen = new Set<number>();
      for (const record of this.state.records) {
        if (seen.has(record.updateId) || record.deliveryId !== this.deliveryId(record.updateId)) fail();
        seen.add(record.updateId);
      }
      if (this.state.records.some(record => record.state === "sending")) this.mutate(state => { for (const record of state.records) if (record.state === "sending") record.state = "uncertain"; });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail(); }
    if(this.state.binding)this.options.onVerifiedSender?.(this.state.binding.senderId);
  }
  private deliveryId(id: number) { return `telegram:${this.options.botIdentityId}:${id}`; }
  private mutate(update: (state: State) => void) {
    const next = structuredClone(this.state); update(next);
    const bytes = JSON.stringify(schema.parse(next));
    if (Buffer.byteLength(bytes) > 4 * 1024 * 1024) fail();
    mkdirSync(dirname(this.options.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.options.file, bytes, { mode: 0o600 }); this.state = next;
  }
  beginPairing() {
    if (this.state.binding) throw new Error("Revoke the existing Telegram pairing first.");
    if (this.stopped) throw new Error("Telegram channel is stopped.");
    this.expiryNoticeSent = false;
    const code = randomBytes(32).toString("hex"), expiresAt = (this.options.now?.() ?? Date.now()) + 600000;
    this.mutate(state => { state.targetBotId = this.options.targetBotId; state.enabled = true; state.pairing = { hash: digest(code), expiresAt }; });
    return { code, expiresAt };
  }
  resumeDisposition(): "paired" | "revoked" | "legacy" | "target-changed" | "pending" {
    if (!this.state.enabled) return "revoked";
    if (!this.state.targetBotId) return "legacy";
    if (this.state.targetBotId !== this.options.targetBotId) return "target-changed";
    return this.state.binding ? "paired" : "pending";
  }
  status() {
    const delivery = [...this.state.records].reverse().find(record => record.deliveryError !== undefined);
    const deliveryRetryAt = this.state.records.reduce<number | null>((earliest, record) => record.retryAt === undefined ? earliest : earliest === null ? record.retryAt : Math.min(earliest, record.retryAt), null);
    const providerRetryAt = this.state.records.reduce<number | null>((earliest, record) => record.deliveryError !== "rate-limit" || record.retryAt === undefined ? earliest : earliest === null ? record.retryAt : Math.min(earliest, record.retryAt), null);
    return { enabled: this.state.enabled && !this.stopped, paired: Boolean(this.state.binding), pairingExpiresAt: this.state.pairing?.expiresAt ?? null,
      pairingExpired: Boolean(this.state.pairing && (this.options.now?.() ?? Date.now()) >= this.state.pairing.expiresAt),
      pending: this.state.records.filter(record => ["accepted", "queued", "sending"].includes(record.state)).length,
      uncertain: this.state.records.filter(record => record.state === "uncertain").length, rejected: this.state.records.filter(record => record.state === "rejected").length,
      error: this.pollError, deliveryError: delivery?.deliveryError ?? null, deliveryRetryAt,
      nextRetryAt: this.pollRetryAt ?? providerRetryAt };
  }
  revoke() {
    this.approvals?.clear();
    this.generation++; this.controller?.abort();
    this.mutate(state => { state.enabled = false; state.binding = null; state.pairing = null; for (const record of state.records) record.state = record.state === "sending" ? "uncertain" : ["accepted", "queued"].includes(record.state) ? "cancelled" : record.state; });
  }
  stop() { this.approvals?.clear(); this.stopped = true; this.generation++; this.controller?.abort(); }
  pollOnce(): Promise<void> {
    if (this.polling) return this.polling;
    if (this.stopped || !this.state.enabled || this.state.targetBotId !== this.options.targetBotId) return Promise.resolve();
    const generation = this.generation, controller = new AbortController(); this.controller = controller;
    const active = () => !this.stopped && this.state.enabled && generation === this.generation && !controller.signal.aborted && this.options.isCurrentTarget?.() !== false;
    this.deliveryFailure = false;
    this.polling = this.poll(active, controller.signal).then(completed => {
      if (active() && completed !== false) { this.pollError = null; this.pollRetryAt = null; this.pollFailures = 0; }
    }).catch(error => {
      if (!active() || this.deliveryFailure) return;
      this.pollError = error instanceof TelegramTransportError ? error.code : "channel-operation-failed";
      if (error instanceof TelegramTransportError && ["offline", "timeout", "unavailable", "rate-limit"].includes(error.code)) {
        const failures = ++this.pollFailures;
        const seconds = error.code === "rate-limit" && error.retryAfterSeconds !== undefined ? error.retryAfterSeconds : Math.min(30, 1.5 * 2 ** Math.min(failures - 1, 4));
        this.pollRetryAt = (this.options.now?.() ?? Date.now()) + seconds * 1000;
      }
    }).finally(() => { this.polling = undefined; if (this.controller === controller) this.controller = undefined; });
    return this.polling;
  }
  private async poll(active: () => boolean, signal: AbortSignal): Promise<void | false> {
    await this.drain(active, signal);
    if (!active()) return;
    const updates = await this.options.transport.getUpdates({ offset: this.state.offset, limit: 100, timeoutSeconds: 0, signal });
    if (!active()) return;
    if (updates.length > 100) fail();
    for (const raw of updates.sort((a, b) => a.update_id - b.update_id)) {
      if (!active()) return;
      const update = normalizeTelegramUpdate(raw);
      if (update.updateId < this.state.offset) continue;
      if (update.updateId >= Number.MAX_SAFE_INTEGER) fail();
      if (update.kind === "callback") {
        if (this.state.binding) await this.approvals?.answer(update, this.state.binding, active, signal);
        if (!active()) return;
        this.mutate(state => { state.offset = update.updateId + 1; });
        continue;
      }
      const message = update.kind === "message" && update.chatType === "private" && !update.forwarded ? update : null;
      if (message && !this.state.binding && this.state.pairing && (this.options.now?.() ?? Date.now()) >= this.state.pairing.expiresAt
        && /^\/pair [a-f0-9]{64}$/.test(message.text) && digest(message.text.slice(6)) === this.state.pairing.hash) {
        this.mutate(state => { state.offset = update.updateId + 1; });
        if (!this.expiryNoticeSent) {
          this.expiryNoticeSent = true;
          await this.options.transport.sendMessage({ chatId: message.chatId, text: "This pairing code expired. In Murage, open Settings → Channels → Telegram and create a new pairing code. No messages have been sent to your bot.", signal });
        }
        continue;
      }
      if (message && !this.state.binding && this.state.pairing && (this.options.now?.() ?? Date.now()) < this.state.pairing.expiresAt && /^\/pair [a-f0-9]{64}$/.test(message.text) && digest(message.text.slice(6)) === this.state.pairing.hash) {
        const records = this.state.records.filter(record => !["sent", "cancelled"].includes(record.state));
        if (records.length >= 200) { this.pollError = "pending-limit"; return false; }
        this.mutate(state => {
          state.binding = { senderId: message.senderId, chatId: message.chatId }; state.pairing = null; state.offset = update.updateId + 1;
          state.records = records;
          state.records.push({ updateId: update.updateId, deliveryId: this.deliveryId(update.updateId), prompt: "", state: "accepted", response: "Telegram is paired with Murage. Before chatting, link this channel account in Murage Settings → Memory. Then send your message again." });
        });
        this.options.onVerifiedSender?.(message.senderId);
        continue;
      }
      if (message && this.state.binding?.senderId === message.senderId && this.state.binding.chatId === message.chatId && !this.state.records.some(record => record.updateId === update.updateId)) {
        // The owner tapped "Reply with text" on a question: this message is
        // that answer (0.1.52 ASK3), never a new prompt for the bot.
        if (this.approvals && await this.approvals.captureText(message, this.state.binding, active, signal)) {
          if (!active()) return;
          this.mutate(state => { state.offset = update.updateId + 1; });
          continue;
        }
        const records = this.state.records.filter(record => !["sent", "cancelled"].includes(record.state));
        if (records.length >= 200) { this.pollError = "pending-limit"; return false; }
        const approval = /^\/(?:approve|deny|allow|reject|pair)(?:\s|$)/i.test(message.text) || /^(?:approve|deny|allow|reject|yes|no)$/i.test(message.text.trim());
        this.mutate(state => { state.records = records; state.records.push({ updateId: update.updateId, deliveryId: this.deliveryId(update.updateId), prompt: approval ? "" : `[UNTRUSTED TELEGRAM CHANNEL MESSAGE]\n${message.text}\n[/UNTRUSTED TELEGRAM CHANNEL MESSAGE]`, state: "accepted", ...(approval ? { response: "Review approvals in the Murage app. Telegram messages cannot approve actions." } : {}) }); });
      }
      this.mutate(state => { state.offset = update.updateId + 1; });
    }
    await this.drain(active, signal);
    if (active() && this.state.binding) await this.approvals?.publish(this.state.binding, active, signal);
  }
  /** Best effort, after the text went: a note that cannot be sent is still
   *  in the Murage chat and in Files, so a failure is logged, not retried. */
  private async sendVoiceNotes(runId: string | undefined, chatId: string, signal: AbortSignal) {
    if (!runId || !this.options.voiceNotes || !this.options.transport.sendAudio) return;
    for (const note of this.options.voiceNotes(runId)) {
      try {
        await this.options.transport.sendAudio({ chatId, bytes: note.bytes, mime: note.mime, fileName: note.name, title: `Voice note from ${note.from}`, performer: note.from, signal });
      } catch (error) {
        console.warn(`[telegram] a voice note could not be sent: ${error instanceof TelegramTransportError ? error.code : "failed"}`);
      }
    }
  }
  private async drain(active: () => boolean, signal: AbortSignal) {
    for (const original of [...this.state.records]) {
      if (!active() || !this.state.binding) return;
      let record = this.state.records.find(item => item.updateId === original.updateId)!;
      if (record.state === "accepted" && !record.response) {
        let run:{id:string};
        try{run=this.options.enqueue({ deliveryId: record.deliveryId, prompt: record.prompt, senderId:this.state.binding.senderId });}
        catch(error){
          if(!(error instanceof Error)||!/^HUMAN_(?:LINK_REQUIRED|BINDING_REVOKED)/.test(error.message))throw error;
          this.mutate(state=>{state.records.find(item=>item.updateId===record.updateId)!.response="Link this channel account to yourself or another person in Murage Memory settings, then send your message again.";});
          continue;
        }
        if (!active()) return;
        this.mutate(state => { const item = state.records.find(item => item.updateId === record.updateId)!; item.runId = run.id; item.state = "queued"; });
        record = this.state.records.find(item => item.updateId === record.updateId)!;
      }
      if (record.state === "queued" && !record.response) {
        const result = this.options.runResult(record.runId!);
        if (!active()) return;
        if (!result || !["completed", "failed", "cancelled", "blocked", "stopped"].includes(result.status)) continue;
        const response = (result.output || (result.error ? "The task failed. Review details in Murage." : `Task ${result.status}.`)).slice(0, 4096);
        this.mutate(state => { state.records.find(item => item.updateId === record.updateId)!.response = response; });
        record = this.state.records.find(item => item.updateId === record.updateId)!;
      }
      if (!record.response || !["accepted", "queued"].includes(record.state) || !active() || (record.retryAt !== undefined && (this.options.now?.() ?? Date.now()) < record.retryAt)) continue;
      const chatId = this.state.binding.chatId;
      this.mutate(state => { state.records.find(item => item.updateId === record.updateId)!.state = "sending"; });
      try {
        await this.options.transport.sendMessage({ chatId, text: formatTelegramHtml(record.response), parseMode: "HTML", signal });
        if (!active()) return;
        this.mutate(state => { const item = state.records.find(item => item.updateId === record.updateId)!; item.state = "sent"; delete item.retryAt; delete item.deliveryError; });
        await this.sendVoiceNotes(record.runId, chatId, signal);
      } catch (error) {
        if (active()) this.mutate(state => {
          const item = state.records.find(item => item.updateId === record.updateId)!;
          const attempts = (item.sendAttempts ?? 0) + 1;
          if (error instanceof TelegramTransportError && !error.uncertain && attempts < 3 && ["rate-limit", "unavailable", "offline", "timeout"].includes(error.code)) {
            item.state = "queued"; item.sendAttempts = attempts;
            const known = deliveryError.safeParse(error.code); item.deliveryError = known.success ? known.data : "invalid-request";
            const seconds = error.code === "rate-limit" && error.retryAfterSeconds !== undefined ? error.retryAfterSeconds : Math.min(30, 1.5 * 2 ** (attempts - 1));
            item.retryAt = (this.options.now?.() ?? Date.now()) + seconds * 1000;
          } else if (error instanceof TelegramTransportError && !error.uncertain) {
            item.state = "rejected"; item.sendAttempts = attempts;
            const known = deliveryError.safeParse(error.code); item.deliveryError = known.success ? known.data : "invalid-request";
            delete item.retryAt;
          } else {
            item.state = "uncertain";
            delete item.deliveryError;
            if (error instanceof TelegramTransportError) {
              const known = deliveryError.safeParse(error.code);
              if (known.success) item.deliveryError = known.data;
            }
          }
        });
        if (active()) this.deliveryFailure = true;
        throw error;
      }
    }
  }
}
