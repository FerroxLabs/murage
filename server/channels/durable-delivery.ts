import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../atomic.ts";

const id = z.string().min(1).max(400).regex(/^[^\x00-\x1f\x7f]+$/);
const recordSchema = z.object({ deliveryId: id, prompt: z.string().max(6000), occurredAt: z.number().finite(),
  runId: id.optional(), state: z.enum(["accepted", "queued", "sending", "sent", "uncertain", "rejected", "cancelled", "needs-review"]),
  response: z.string().max(4000).optional(), attempts: z.number().int().min(0).max(3).default(0),
  retryAt: z.number().finite().optional(), messageId: id.optional(), error: z.string().max(60).optional(),
}).strict();
const schema = z.object({ version: z.literal(1), bindingKey: id, recipient: id,
  records: z.array(recordSchema).max(200), tombstones: z.array(z.object({ deliveryId: id, occurredAt: z.number().finite() }).strict()).max(10000),
}).strict();
type State = z.infer<typeof schema>;
export class ChannelSendError extends Error {
  public code: "auth" | "forbidden" | "rate-limit" | "invalid-request" | "offline" | "timeout" | "unavailable";
  public uncertain: boolean;
  public retryAfterSeconds?: number;
  constructor(code: ChannelSendError["code"], uncertain: boolean, retryAfterSeconds?: number) {
    super(code); this.code = code; this.uncertain = uncertain; this.retryAfterSeconds = retryAfterSeconds;
  }
}
export interface ChannelRuns {
  enqueue(input: { deliveryId: string; prompt: string }): { id: string };
  result(id: string): { status: string; output?: string; error?: string } | null;
}
interface Options {
  file: string; bindingKey: string; recipient: string; isCurrent: () => boolean;
  runs: ChannelRuns;
  send: (input: { recipient: string; text: string; signal: AbortSignal }) => Promise<{ recipient: string; messageId: string }>;
  now?: () => number;
}
const windowMs = 7 * 86400000;
const pending = (s: string) => ["accepted", "queued", "sending"].includes(s);

/** New adapters' local receipt ledger; Telegram's existing ledger is deliberately unchanged. */
export class DurableDelivery {
  private state: State;
  private stopped = false;
  private controller = new AbortController();
  private draining?: Promise<void>;
  private options: Options;
  constructor(options: Options) {
    this.options = options;
    this.state = schema.parse({ version: 1, bindingKey: options.bindingKey, recipient: options.recipient, records: [], tombstones: [] });
    try {
      this.checkFile();
      this.state = schema.parse(JSON.parse(readFileSync(options.file, "utf8")));
      if (this.state.bindingKey !== options.bindingKey || this.state.recipient !== options.recipient) throw new Error();
      const ids = [...this.state.records, ...this.state.tombstones].map(r => r.deliveryId);
      if (new Set(ids).size !== ids.length) throw new Error();
      if (this.state.records.some(r => r.state === "sending")) this.mutate(s => { for (const r of s.records) if (r.state === "sending") r.state = "uncertain"; });
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Channel receipt data is invalid; original data preserved."); }
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private checkFile() {
    const stat = lstatSync(this.options.file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) throw new Error("Invalid channel receipt file");
  }
  private mutate(change: (state: State) => void) {
    const next = structuredClone(this.state); change(next);
    const bytes = JSON.stringify(schema.parse(next));
    if (Buffer.byteLength(bytes) > 4 * 1024 * 1024) throw new Error("Channel receipt size limit");
    try { this.checkFile(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    mkdirSync(dirname(this.options.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.options.file, bytes, { mode: 0o600 }); this.state = next;
  }
  private active() { return !this.stopped && !this.controller.signal.aborted && this.options.isCurrent(); }
  accept(input: { deliveryId: string; prompt: string; occurredAt: number; response?: string }): "accepted" | "duplicate" {
    if (!this.active()) throw new Error("Channel binding is not current");
    if (this.state.records.some(r => r.deliveryId === input.deliveryId) || this.state.tombstones.some(r => r.deliveryId === input.deliveryId)) return "duplicate";
    if (!Number.isFinite(input.occurredAt) || input.occurredAt < this.now() - windowMs || input.occurredAt > this.now() + 300000) throw new Error("Channel event is outside the admission window");
    this.mutate(s => {
      s.tombstones = s.tombstones.filter(r => r.occurredAt >= this.now() - windowMs);
      const settled = s.records.filter(r => ["sent", "cancelled"].includes(r.state));
      for (const r of settled) if (r.occurredAt >= this.now() - windowMs) s.tombstones.push({ deliveryId: r.deliveryId, occurredAt: r.occurredAt });
      s.records = s.records.filter(r => !["sent", "cancelled"].includes(r.state));
      if (s.records.length >= 200 || s.tombstones.length >= 10000) throw new Error("Channel pending receipt limit");
      s.records.push({ ...input, attempts: 0, state: "accepted" });
    });
    return "accepted";
  }
  status() {
    return { pending: this.state.records.filter(r => pending(r.state)).length,
      uncertain: this.state.records.filter(r => r.state === "uncertain").length,
      rejected: this.state.records.filter(r => r.state === "rejected").length,
      needsReview: this.state.records.filter(r => r.state === "needs-review").length };
  }
  stop() { this.stopped = true; this.controller.abort(); }
  revoke() {
    this.stop();
    this.mutate(s => { for (const r of s.records) if (pending(r.state)) r.state = r.state === "sending" ? "uncertain" : "cancelled"; });
  }
  drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = this.work().finally(() => { this.draining = undefined; });
    return this.draining;
  }
  private async work() {
    for (const original of [...this.state.records]) {
      if (!this.active()) return;
      const lookup = () => this.state.records.find(r => r.deliveryId === original.deliveryId)!;
      const change = (fn: (r: State["records"][number]) => void) => this.mutate(s => fn(s.records.find(r => r.deliveryId === original.deliveryId)!));
      let r = lookup();
      if (r.state === "accepted" && r.response === undefined) {
        if (this.state.records.filter(x => x.state === "queued" && x.response === undefined).length >= 3) continue;
        // enqueue must return a retained receipt on retry across the cross-file crash window.
        const run = this.options.runs.enqueue({ deliveryId: r.deliveryId, prompt: r.prompt });
        if (!this.active()) return;
        change(x => { x.runId = run.id; x.state = "queued"; }); r = lookup();
      }
      if (r.state === "queued" && r.response === undefined) {
        const result = this.options.runs.result(r.runId!);
        if (!this.active()) return;
        if (!result) { change(x => { x.state = "needs-review"; x.error = "run-receipt-missing"; }); continue; }
        if (!["completed", "failed", "cancelled", "blocked", "stopped"].includes(result.status)) continue;
        change(x => { x.response = (result.output || "Task ended. Review its result in Murage.").slice(0, 4000); }); r = lookup();
      }
      if (r.response === undefined || !["accepted", "queued"].includes(r.state) || (r.retryAt ?? 0) > this.now()) continue;
      if (!this.active()) return;
      change(x => { x.state = "sending"; x.attempts++; });
      try {
        const sent = await this.options.send({ recipient: this.options.recipient, text: r.response, signal: this.controller.signal });
        if (!this.active()) return;
        if (sent.recipient !== this.options.recipient || !id.safeParse(sent.messageId).success) throw new ChannelSendError("invalid-request", true);
        change(x => { x.state = "sent"; x.messageId = sent.messageId; delete x.retryAt; delete x.error; });
      } catch (error) {
        if (!this.active()) return;
        change(x => {
          x.error = error instanceof ChannelSendError ? error.code : "send-uncertain";
          if (error instanceof ChannelSendError && !error.uncertain) {
            if (x.attempts < 3 && ["rate-limit", "offline", "timeout", "unavailable"].includes(error.code)) {
              x.state = "queued"; x.retryAt = this.now() + Math.max(1, error.retryAfterSeconds ?? 2 ** x.attempts) * 1000;
            } else x.state = "rejected";
          } else x.state = "uncertain";
        });
      }
    }
  }
}
