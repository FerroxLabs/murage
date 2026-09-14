import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../../atomic.ts";
import { ChannelSendError, DurableDelivery, type ChannelRuns } from "../durable-delivery.ts";
import { normalizeDiscordMessage, discordBindingSchema, discordId, discordPrompt, type DiscordBinding } from "./event.ts";
import type { DiscordTransport } from "./transport.ts";

const chosenSchema = z.object({ applicationId: discordId, ownerUserId: discordId, chiefBotId: z.string().min(1).max(180) }).strict();
export type DiscordChosen = z.infer<typeof chosenSchema>;
const connectionSchema = z.object({ version: z.literal(1), chosen: chosenSchema, enabled: z.boolean(), paused: z.boolean(),
  identity: z.object({ applicationId: discordId, botUserId: discordId }).strict(),
  binding: discordBindingSchema.nullable(), pairing: z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().finite() }).strict().nullable(),
}).strict().superRefine((c, ctx) => {
  const b = c.binding;
  if (c.identity.applicationId !== c.chosen.applicationId || (b && (b.applicationId !== c.chosen.applicationId ||
      b.ownerUserId !== c.chosen.ownerUserId || b.chiefBotId !== c.chosen.chiefBotId || b.botUserId !== c.identity.botUserId)))
    ctx.addIssue({ code: "custom", message: "Discord binding identity mismatch" });
});
type Connection = z.infer<typeof connectionSchema>;
interface Options {
  dataDir: string; chosen: DiscordChosen; transport: () => DiscordTransport;
  isCurrentChief: (botId: string) => boolean;
  runs: (binding: DiscordBinding) => ChannelRuns;
  revokeRuns: (connectionId: string) => Promise<void>;
  now?: () => number;
}
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export class DiscordService {
  private connection?: Connection;
  private transport?: DiscordTransport;
  private ledger?: DurableDelivery;
  private generation = 0;
  private live = false;
  private authorised = false;
  private timer?: ReturnType<typeof setTimeout>;
  private retryFailures = 0;
  private state: "idle" | "verifying" | "pairing" | "connected" | "retry" | "blocked" = "idle";
  private error: string | null = null;
  private nextRetryAt: number | null = null;
  private connecting = false;
  private options: Options;
  constructor(options: Options) { this.options = { ...options, chosen: chosenSchema.parse(options.chosen) }; }
  private now() { return this.options.now?.() ?? Date.now(); }
  private file() { return join(this.options.dataDir, "channels", "discord", "connection.json"); }
  private save(next: Connection) {
    const valid = connectionSchema.parse(next);
    mkdirSync(join(this.options.dataDir, "channels", "discord"), { recursive: true, mode: 0o700 });
    this.validateFile();
    writeFileAtomic(this.file(), JSON.stringify(valid), { mode: 0o600 }); this.connection = valid;
  }
  private validateFile() {
    try { const s = lstatSync(this.file()); if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > 16384) throw new Error("Invalid Discord connection file"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  private read() {
    this.validateFile();
    try { return connectionSchema.parse(JSON.parse(readFileSync(this.file(), "utf8"))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("Discord connection data needs recovery; original data preserved."); }
  }
  status() { return { state: this.state, paired: Boolean(this.connection?.binding), enabled: this.live,
    error: this.error, nextRetryAt: this.nextRetryAt, ...(this.ledger?.status() ?? { pending: 0, uncertain: 0, rejected: 0, needsReview: 0 }) }; }
  isCurrent(binding: DiscordBinding) {
    return this.authorised && this.connection?.enabled === true && !this.connection.paused &&
      this.connection.binding?.connectionId === binding.connectionId &&
      JSON.stringify(this.connection.binding) === JSON.stringify(binding) && this.options.isCurrentChief(binding.chiefBotId);
  }
  async pair() {
    if (this.connecting || this.live || this.read()?.enabled) throw new Error("Revoke the current Discord connection before pairing");
    if (!this.options.isCurrentChief(this.options.chosen.chiefBotId)) throw new Error("Discord pairs only with current Chief");
    const generation = ++this.generation; this.connecting = true; this.state = "verifying";
    try {
      this.transport = this.options.transport();
      const identity = await this.transport.verifyBot();
      if (generation !== this.generation) { await this.transport.stop(); throw new Error("Discord pairing cancelled"); }
      if (identity.applicationId !== this.options.chosen.applicationId || !this.options.isCurrentChief(this.options.chosen.chiefBotId)) throw new Error("Discord identity or Chief mismatch");
      const code = randomBytes(32).toString("hex"), expiresAt = this.now() + 600000;
      this.save({ version: 1, chosen: this.options.chosen, identity, enabled: true, paused: false, binding: null, pairing: { hash: digest(code), expiresAt } });
      this.live = true; this.authorised = true; this.state = "pairing";
      await this.start(generation);
      return { code, expiresAt };
    } catch {
      await this.transport?.stop().catch(() => {});
      if (generation === this.generation) { this.live = false; this.authorised = false; this.state = "blocked"; this.error = "pairing-failed"; }
      throw new Error("Discord pairing could not complete");
    }
    finally { this.connecting = false; }
  }
  async resume() {
    if (this.connecting || this.live) return;
    const generation = ++this.generation; this.connecting = true; this.state = "verifying";
    try {
      const saved = this.read(); this.connection = saved;
      if (!saved?.enabled) { this.state = "idle"; return; }
      if (saved.paused || JSON.stringify(saved.chosen) !== JSON.stringify(this.options.chosen) || !this.options.isCurrentChief(saved.chosen.chiefBotId)) { await this.pause(); return; }
      if (!saved.binding) { this.state = "blocked"; this.error = "pair-required"; return; }
      await this.transport?.stop();
      if (generation !== this.generation) return;
      this.transport = this.options.transport();
      const identity = await this.transport.verifyBot();
      if (generation !== this.generation) { await this.transport.stop(); return; }
      if (JSON.stringify(identity) !== JSON.stringify(saved.identity)) { await this.transport.stop(); this.authorised = false; this.state = "blocked"; this.error = "identity-mismatch"; return; }
      if (!this.options.isCurrentChief(saved.chosen.chiefBotId)) { await this.pause(); return; }
      this.live = true; this.authorised = true; this.makeLedger(saved.binding); await this.start(generation);
    } catch (e) {
      await this.transport?.stop().catch(() => {});
      if (generation === this.generation) {
        this.live = false;
        if (e instanceof ChannelSendError && ["unavailable", "offline", "timeout", "rate-limit"].includes(e.code)) this.retry(e.retryAfterSeconds);
        else { this.authorised = false; this.state = "blocked"; this.error = "connection-recovery-required"; }
      }
    } finally { this.connecting = false; }
  }
  private makeLedger(binding: DiscordBinding) {
    this.ledger = new DurableDelivery({ file: join(this.options.dataDir, "channels", "discord", binding.connectionId + ".json"),
      bindingKey: digest(JSON.stringify(binding)), recipient: binding.dmId, isCurrent: () => this.live && this.isCurrent(binding),
      runs: this.options.runs(binding), now: this.options.now,
      send: async ({ recipient, text, signal }) => {
        if (!this.live || !this.isCurrent(binding) || !this.transport) throw new ChannelSendError("forbidden", false);
        const sent = await this.transport.sendText({ dmId: recipient, text, signal });
        return { recipient: sent.channel, messageId: sent.messageId };
      } });
  }
  private async start(generation: number) {
    const transport = this.transport!;
    await transport.start(raw => {
      void this.receive(raw, generation).catch(async () => {
        if (generation !== this.generation) return;
        await this.stop().catch(() => {}); this.state = "blocked"; this.error = "intake-failed";
      });
    }, state => {
      if (generation !== this.generation) return;
      if (state === "connected") { this.live = true; this.schedule(generation); this.state = this.connection?.binding ? "connected" : "pairing"; this.error = null; this.retryFailures = 0; this.nextRetryAt = null; }
      else if (state === "disconnected") { this.live = false; this.state = "retry"; this.error = "gateway-reconnecting"; }
      else if (state === "blocked") {
        void this.stop().catch(() => {}).finally(() => { this.state = "blocked"; this.error = "gateway-blocked"; });
      }
      else this.error = "transport-error";
    });
    if (generation !== this.generation) { await transport.stop(); return; }
    this.schedule(generation);
  }
  private async receive(raw: unknown, generation: number) {
    if (generation !== this.generation || !this.live || !this.connection) return;
    if (!this.options.isCurrentChief(this.connection.chosen.chiefBotId)) { await this.pause(); return; }
    const c = this.connection;
    const message = normalizeDiscordMessage(raw, { ...c.chosen, botUserId: c.identity.botUserId });
    if (!message) { return; }
    if (!c.binding) {
      if (!c.pairing || c.pairing.expiresAt <= this.now() || !/^\/pair [a-f0-9]{64}$/.test(message.text) || digest(message.text.slice(6)) !== c.pairing.hash) { return; }
      const binding = discordBindingSchema.parse({ ...c.chosen, botUserId: c.identity.botUserId, dmId: message.dmId, connectionId: randomUUID() });
      this.save({ ...c, binding, pairing: null }); this.makeLedger(binding); this.state = "connected";
    } else if (message.dmId !== c.binding.dmId) { return; }
    const pairedNow = !c.binding;
    this.ledger!.accept({ deliveryId: message.deliveryId, occurredAt: message.occurredAt,
      ...(pairedNow ? { prompt: "", response: "Discord is paired with Murage. Send a message here to chat with your Chief. Review approvals in Murage." } : discordPrompt(message.text)) });
    // Gateway has no per-message ACK. Durable receipt precedes model work.
    if (generation === this.generation) queueMicrotask(() => { void this.tick().catch(() => { this.error = "delivery-failed"; }); });
  }
  async tick() {
    if (!this.live) return;
    if (!this.connection || !this.options.isCurrentChief(this.connection.chosen.chiefBotId)) { await this.pause(); return; }
    await this.ledger?.drain();
  }
  private schedule(generation: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.tick().catch(() => { this.error = "delivery-failed"; }).finally(() => { if (generation === this.generation && this.live) this.schedule(generation); }); }, 1000);
    this.timer.unref?.();
  }
  private retry(seconds?: number) {
    if (this.state === "retry") return;
    if (this.state === "blocked" || this.connection?.paused) return;
    clearTimeout(this.timer);
    if (++this.retryFailures > 5) { this.state = "blocked"; this.error = "retry-limit"; return; }
    this.state = "retry"; this.nextRetryAt = this.now() + Math.max(1, seconds ?? Math.min(30, 2 ** this.retryFailures)) * 1000;
    const generation = this.generation;
    this.timer = setTimeout(() => { if (generation === this.generation) void this.resume(); }, this.nextRetryAt - this.now()); this.timer.unref?.();
  }
  async stop() { this.live = false; this.authorised = false; this.generation++; clearTimeout(this.timer); this.ledger?.stop(); this.state = "idle"; await this.transport?.stop(); }
  async pause() {
    await this.disable(false);
  }
  async revoke() {
    await this.disable(true);
  }
  private async disable(revoke: boolean) {
    let failed = false;
    try { await this.stop(); } catch { failed = true; }
    this.state = revoke ? "idle" : "blocked"; this.error = revoke ? null : "chief-changed";
    try { this.connection ??= this.read(); } catch { failed = true; }
    try { if (this.connection) this.save({ ...this.connection, ...(revoke ? { enabled: false, pairing: null } : {}), paused: true }); } catch { failed = true; }
    try { this.ledger?.revoke(); } catch { failed = true; }
    try { if (this.connection?.binding) await this.options.revokeRuns(this.connection.binding.connectionId); } catch { failed = true; }
    if (failed) { this.state = "blocked"; this.error = "revoke-recovery-required"; throw new Error("Discord stopped; saved revocation needs recovery."); }
  }
}
