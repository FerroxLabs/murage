import { join } from "node:path";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { TelegramTransportError } from "./telegram-transport.ts";
import { TelegramChannel } from "./telegram-channel.ts";
import { TelegramTransport } from "./telegram-transport.ts";
import type { TelegramApprovalActions } from "./telegram-approvals.ts";

/** Owns polling lifetime, not credentials or execution authority. */
interface TelegramServiceOptions {
  dataDir: string;
  enqueue: (connectionId: string, targetBotId: string, input: { deliveryId: string; prompt: string }) => { id: string };
  runResult: (id: string) => { status: string; output?: string; error?: string } | null;
  revokeRuns: (connectionId: string) => Promise<void>;
  transport?: (token: string) => TelegramTransport;
  approvals?: (targetBotId: string) => TelegramApprovalActions;
  isCurrentTarget?: (targetBotId: string) => boolean;
}
const connectionSchema = z.object({ version: z.literal(1), botIdentityId: z.string().regex(/^[1-9]\d{0,15}$/), targetBotId: z.string().min(1).max(180), enabled: z.boolean() }).strict();
type Connection = z.infer<typeof connectionSchema>;
type ResumeState = "idle" | "verifying" | "active" | "retry" | "pair-required" | "blocked";
export class TelegramService {
  private channel?: TelegramChannel;
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private connecting = false;
  private generation = 0;
  private identity?: string;
  private connection?: Connection;
  private resumeState: ResumeState = "idle";
  private resumeMessage: string | null = null;
  private readonly options: TelegramServiceOptions;
  constructor(options: TelegramServiceOptions) { this.options = options; }
  private connectionFile() { return join(this.options.dataDir, "telegram", "connection.json"); }
  private readConnection(): Connection | undefined {
    try {
      const stat = lstatSync(this.connectionFile());
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) throw new Error("invalid connection");
      return connectionSchema.parse(JSON.parse(readFileSync(this.connectionFile(), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("Telegram connection data needs recovery. Original data was preserved.");
    }
  }
  private saveConnection(connection: Connection) {
    mkdirSync(join(this.options.dataDir, "telegram"), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.connectionFile(), JSON.stringify(connectionSchema.parse(connection)), { mode: 0o600 });
    this.connection = connection;
  }
  private makeChannel(connection: Connection, transport: TelegramTransport) {
    return new TelegramChannel({ file: join(this.options.dataDir, "telegram", connection.botIdentityId + ".json"),
      botIdentityId: connection.botIdentityId, targetBotId: connection.targetBotId, transport,
      approvals: this.options.approvals?.(connection.targetBotId),
      enqueue: input => this.options.enqueue(connection.botIdentityId, connection.targetBotId, input), runResult: this.options.runResult });
  }
  status() {
    const status = this.channel?.status() ?? { enabled: false, paired: false, pending: 0, uncertain: 0, error: null };
    const active = this.resumeState === "active";
    return { ...status, connecting: this.connecting, enabled: active && status.enabled, paired: active && status.paired,
      pending: active ? status.pending : 0, resumeState: this.resumeState, resumeMessage: this.resumeMessage,
      requiresRevoke: Boolean(this.connection?.enabled && this.resumeState !== "pair-required") };
  }
  /** Resume a previously authorized binding, never infer a replacement target. */
  async resume(token: string, targetBotId: string) {
    if (this.connecting || this.resumeState === "active") return false;
    this.connecting = true; this.resumeState = "verifying"; this.resumeMessage = null;
    const generation = ++this.generation, controller = new AbortController(); this.controller = controller;
    let verifying = false;
    try {
      const connection = this.readConnection(); this.connection = connection;
      if (!connection) { this.resumeState = "pair-required"; this.resumeMessage = "Pair once to reconnect this saved token. Pairings from older Murage versions need this one-time step."; return false; }
      this.identity = connection.botIdentityId;
      if (!connection.enabled) { this.resumeState = "idle"; return false; }
      if (connection.targetBotId !== targetBotId || this.options.isCurrentTarget?.(targetBotId) === false) {
        this.resumeState = "blocked"; this.resumeMessage = "The paired Murage bot changed or is unavailable. Revoke this connection, then pair the intended bot."; return false;
      }
      const transport = this.options.transport?.(token) ?? new TelegramTransport({ token });
      verifying = true; const bot = await transport.getMe(controller.signal); verifying = false;
      if (generation !== this.generation) return false;
      if (bot.id !== connection.botIdentityId) { this.resumeState = "blocked"; this.resumeMessage = "This token belongs to a different Telegram bot. Revoke the old connection before pairing it."; return false; }
      if (this.options.isCurrentTarget?.(targetBotId) === false) { this.resumeState = "blocked"; this.resumeMessage = "The paired Murage bot changed during reconnection. Revoke this connection and pair again."; return false; }
      const channel = this.makeChannel(connection, transport); this.channel = channel;
      const disposition = channel.resumeDisposition();
      if (disposition !== "paired") {
        channel.stop(); this.resumeState = disposition === "revoked" ? "idle" : "pair-required";
        this.resumeMessage = disposition === "revoked" ? null : disposition === "pending" ? "Pairing was not completed. Create a new pairing code." : "Pair once to confirm the Murage bot for this saved connection. Older pairings need this one-time step.";
        return false;
      }
      this.resumeState = "active"; this.schedule(generation); return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      const retry = verifying && (!(error instanceof TelegramTransportError) || ["offline", "timeout", "unavailable", "rate-limit"].includes(error.code));
      this.resumeState = retry ? "retry" : "blocked";
      this.resumeMessage = retry ? "Could not reconnect to Telegram. Your pairing is saved; retry when your connection is available."
        : "Telegram could not verify the saved connection. Check the token or restore the connection data before pairing again.";
      return false;
    } finally { if (generation === this.generation) { this.connecting = false; this.controller = undefined; } }
  }
  async pair(token: string, targetBotId: string) {
    if (this.connecting || this.resumeState === "active" || this.status().requiresRevoke) throw new Error("Revoke the current Telegram connection before pairing again.");
    this.connecting = true; this.resumeMessage = null;
    const generation = ++this.generation, controller = new AbortController(); this.controller = controller;
    try {
      const transport = this.options.transport?.(token) ?? new TelegramTransport({ token });
      const bot = await transport.getMe(controller.signal);
      if (generation !== this.generation) throw new Error("Telegram connection was cancelled.");
      this.identity = bot.id;
      const connection: Connection = { version: 1, botIdentityId: bot.id, targetBotId, enabled: true };
      this.channel = this.makeChannel(connection, transport);
      // Explicit re-pairing cancels old authority; restarting never does this.
      if (this.channel.status().paired) { this.channel.revoke(); await this.options.revokeRuns(bot.id); }
      if (generation !== this.generation) throw new Error("Telegram connection was cancelled.");
      const pairing = this.channel.beginPairing();
      try { this.saveConnection(connection); } catch (error) { this.channel.revoke(); throw error; }
      this.resumeState = "active"; this.schedule(generation);
      return { ...pairing, username: bot.username, botIdentityId: bot.id };
    } finally { if (generation === this.generation) { this.connecting = false; this.controller = undefined; } }
  }
  private schedule(generation: number) {
    this.timer = setTimeout(async () => {
      if (generation !== this.generation) return;
      await this.channel?.pollOnce();
      if (generation === this.generation && this.channel?.status().enabled) this.schedule(generation);
    }, 1500);
    this.timer.unref();
  }
  async revoke() {
    ++this.generation; this.connecting = false; this.controller?.abort(); this.controller = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.resumeState = "idle"; this.resumeMessage = null;
    let failed = false;
    try { const connection = this.connection ?? this.readConnection(); if (connection) { this.identity = connection.botIdentityId; this.saveConnection({ ...connection, enabled: false }); } } catch { failed = true; }
    try { this.channel?.revoke(); } catch { failed = true; this.channel?.stop(); }
    if (this.identity) await this.options.revokeRuns(this.identity);
    if (failed) { this.resumeState = "blocked"; this.resumeMessage = "Telegram stopped, but its saved connection could not be fully revoked. Restore access to the saved data and try Revoke again."; throw new Error(this.resumeMessage); }
  }
  stop() { ++this.generation; this.connecting = false; this.controller?.abort(); if (this.timer) clearTimeout(this.timer); this.channel?.stop(); this.resumeState = "idle"; }
}
