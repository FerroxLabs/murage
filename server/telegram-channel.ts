import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { normalizeTelegramUpdate } from "./telegram-update.ts";
import { TelegramTransportError, type TelegramTransport } from "./telegram-transport.ts";

const identity = z.string().regex(/^[1-9]\d{0,15}$/).refine(value => Number.isSafeInteger(Number(value)));
const recordSchema = z.object({ updateId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1), deliveryId: z.string(), prompt: z.string().max(5000), runId: z.string().max(200).optional(), state: z.enum(["accepted", "queued", "sending", "sent", "uncertain", "cancelled"]), response: z.string().max(4096).optional() }).strict();
const schema = z.object({ version: z.literal(1), botIdentityId: identity, enabled: z.boolean(), offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), binding: z.object({ senderId: identity, chatId: identity }).strict().nullable(), pairing: z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().finite() }).strict().nullable(), records: z.array(recordSchema).max(200) }).strict();
type State = z.infer<typeof schema>;
interface Options {
  file: string; transport: Pick<TelegramTransport, "getUpdates" | "sendMessage">; botIdentityId: string;
  enqueue: (input: { deliveryId: string; prompt: string }) => { id: string };
  runResult: (id: string) => { status: string; output?: string; error?: string } | null;
  now?: () => number;
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function fail(): never { throw new Error("Telegram channel state is invalid or unavailable; original data was preserved."); }

export class TelegramChannel {
  private state: State;
  private readonly options: Options;
  private generation = 0;
  private stopped = false;
  private controller?: AbortController;
  private polling?: Promise<void>;
  private error: string | null = null;
  constructor(options: Options) {
    if (!identity.safeParse(options.botIdentityId).success) fail();
    this.options = options;
    this.state = { version: 1, botIdentityId: options.botIdentityId, enabled: false, offset: 0, binding: null, pairing: null, records: [] };
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
    const code = randomBytes(32).toString("hex"), expiresAt = (this.options.now?.() ?? Date.now()) + 600000;
    this.mutate(state => { state.enabled = true; state.pairing = { hash: digest(code), expiresAt }; });
    return { code, expiresAt };
  }
  status() {
    return { enabled: this.state.enabled && !this.stopped, paired: Boolean(this.state.binding), pairingExpiresAt: this.state.pairing?.expiresAt ?? null,
      pending: this.state.records.filter(record => ["accepted", "queued", "sending"].includes(record.state)).length,
      uncertain: this.state.records.filter(record => record.state === "uncertain").length, error: this.error };
  }
  revoke() {
    this.generation++; this.controller?.abort();
    this.mutate(state => { state.enabled = false; state.binding = null; state.pairing = null; for (const record of state.records) record.state = record.state === "sending" ? "uncertain" : ["accepted", "queued"].includes(record.state) ? "cancelled" : record.state; });
  }
  stop() { this.stopped = true; this.generation++; this.controller?.abort(); }
  pollOnce(): Promise<void> {
    if (this.polling) return this.polling;
    if (this.stopped || !this.state.enabled) return Promise.resolve();
    const generation = this.generation, controller = new AbortController(); this.controller = controller;
    const active = () => !this.stopped && this.state.enabled && generation === this.generation && !controller.signal.aborted;
    this.polling = this.poll(active, controller.signal).catch(error => {
      this.error = error instanceof TelegramTransportError ? error.code : "channel-operation-failed";
    }).finally(() => { this.polling = undefined; if (this.controller === controller) this.controller = undefined; });
    return this.polling;
  }
  private async poll(active: () => boolean, signal: AbortSignal) {
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
      const message = update.kind === "message" && update.chatType === "private" && !update.forwarded ? update : null;
      if (message && !this.state.binding && this.state.pairing && (this.options.now?.() ?? Date.now()) < this.state.pairing.expiresAt && /^\/pair [a-f0-9]{64}$/.test(message.text) && digest(message.text.slice(6)) === this.state.pairing.hash) {
        this.mutate(state => { state.binding = { senderId: message.senderId, chatId: message.chatId }; state.pairing = null; state.offset = update.updateId + 1; });
        continue;
      }
      if (message && this.state.binding?.senderId === message.senderId && this.state.binding.chatId === message.chatId && !this.state.records.some(record => record.updateId === update.updateId)) {
        const records = this.state.records.filter(record => !["sent", "cancelled"].includes(record.state));
        if (records.length >= 200) { this.error = "pending-limit"; return; }
        const approval = /^\/(?:approve|deny|allow|reject|pair)(?:\s|$)/i.test(message.text) || /^(?:approve|deny|allow|reject|yes|no)$/i.test(message.text.trim());
        this.mutate(state => { state.records = records; state.records.push({ updateId: update.updateId, deliveryId: this.deliveryId(update.updateId), prompt: approval ? "" : `[UNTRUSTED TELEGRAM CHANNEL MESSAGE]\n${message.text}\n[/UNTRUSTED TELEGRAM CHANNEL MESSAGE]`, state: "accepted", ...(approval ? { response: "Review approvals in the Murage app. Telegram messages cannot approve actions." } : {}) }); });
      }
      this.mutate(state => { state.offset = update.updateId + 1; });
    }
    await this.drain(active, signal);
  }
  private async drain(active: () => boolean, signal: AbortSignal) {
    for (const original of [...this.state.records]) {
      if (!active() || !this.state.binding) return;
      let record = this.state.records.find(item => item.updateId === original.updateId)!;
      if (record.state === "accepted" && !record.response) {
        const run = this.options.enqueue({ deliveryId: record.deliveryId, prompt: record.prompt });
        if (!active()) return;
        this.mutate(state => { const item = state.records.find(item => item.updateId === record.updateId)!; item.runId = run.id; item.state = "queued"; });
        record = this.state.records.find(item => item.updateId === record.updateId)!;
      }
      if (record.state === "queued") {
        const result = this.options.runResult(record.runId!);
        if (!active()) return;
        if (!result || !["completed", "failed", "cancelled", "blocked", "stopped"].includes(result.status)) continue;
        const response = (result.output || (result.error ? "The task failed. Review details in Murage." : `Task ${result.status}.`)).slice(0, 4096);
        this.mutate(state => { state.records.find(item => item.updateId === record.updateId)!.response = response; });
        record = this.state.records.find(item => item.updateId === record.updateId)!;
      }
      if (!record.response || !["accepted", "queued"].includes(record.state) || !active()) continue;
      const chatId = this.state.binding.chatId;
      this.mutate(state => { state.records.find(item => item.updateId === record.updateId)!.state = "sending"; });
      try {
        await this.options.transport.sendMessage({ chatId, text: record.response, signal });
        if (!active()) return;
        this.mutate(state => { state.records.find(item => item.updateId === record.updateId)!.state = "sent"; });
      } catch (error) {
        if (active()) this.mutate(state => { state.records.find(item => item.updateId === record.updateId)!.state = "uncertain"; });
        throw error;
      }
    }
  }
}
