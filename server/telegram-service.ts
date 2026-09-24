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
  onVerifiedSender?: (connectionId:string,senderId:string)=>void;
  enqueue: (connectionId: string, targetBotId: string, input: { deliveryId: string; prompt: string; senderId: string }) => { id: string };
  runResult: (id: string) => { status: string; output?: string; error?: string } | null;
  voiceNotes?: (runId: string) => import("./telegram-channel.ts").ChannelVoiceNote[];
  revokeRuns: (connectionId: string) => Promise<void>;
  transport?: (token: string) => TelegramTransport;
  approvals?: (targetBotId: string) => TelegramApprovalActions;
  isCurrentTarget?: (targetBotId: string) => boolean;
}
const connectionSchema = z.object({ version: z.literal(1), botIdentityId: z.string().regex(/^[1-9]\d{0,15}$/), targetBotId: z.string().min(1).max(180), enabled: z.boolean(), paused: z.boolean().optional() }).strict();
type Connection = z.infer<typeof connectionSchema>;
type ResumeState = "idle" | "verifying" | "active" | "retry" | "pair-required" | "blocked";
/** A replacement token was refused before anything was saved (the config route answers 409). */
export class TelegramTokenRefusal extends Error {
  readonly status = 409;
  constructor(message: string) { super(message); this.name = "TelegramTokenRefusal"; }
}
const TOKEN_REJECTED = "Telegram rejected the saved bot token. Paste a new token for this same bot from BotFather to reconnect. Your pairing is saved.";
const WRONG_BOT = "This token belongs to a different Telegram bot. Your saved token and pairing were not changed. Paste the token for the paired bot, or revoke before pairing a different bot.";
const REPLACEMENT_REJECTED = "Telegram rejected the new token too. Copy the current token for this bot from BotFather and try again. Your pairing is saved.";
const REPLACEMENT_UNCHECKED = "Could not check the new token with Telegram. Your saved token and pairing were not changed; try again when Telegram is reachable.";
const NOT_A_TOKEN = "That is not a Telegram bot token. Your saved token and pairing were not changed.";
const CHANGED = "The Telegram connection changed while the new token was being checked. Nothing was saved; review the connection and try again.";
const NOT_REPLACEABLE = "Revoke Telegram before changing its token or target.";
export class TelegramService {
  private channel?: TelegramChannel;
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private connecting = false;
  private generation = 0;
  private identity?: string;
  private connection?: Connection;
  private verifyingTarget?: string;
  private resumeState: ResumeState = "idle";
  private resumeMessage: string | null = null;
  private resumeFailures = 0;
  private nextRetryAt: number | null = null;
  private receiverConflict = false;
  private tokenRejected = false;
  private readonly options: TelegramServiceOptions;
  constructor(options: TelegramServiceOptions) { this.options = options; }
  /** The paired owner's chat and account (server/stop-line.ts). */
  ownerRecipients(): string[] { return this.channel?.ownerRecipients() ?? []; }
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
      isCurrentTarget: () => this.options.isCurrentTarget?.(connection.targetBotId) !== false,
      approvals: this.options.approvals?.(connection.targetBotId),
      onVerifiedSender:senderId=>this.options.onVerifiedSender?.(connection.botIdentityId,senderId),
      enqueue: input => this.options.enqueue(connection.botIdentityId, connection.targetBotId, input), runResult: this.options.runResult, voiceNotes: this.options.voiceNotes });
  }
  status() {
    const status = this.channel?.status() ?? { enabled: false, paired: false, pending: 0, uncertain: 0, error: null, nextRetryAt: null };
    const active = this.resumeState === "active";
    return { ...status, connecting: this.connecting, enabled: active && status.enabled, paired: active && status.paired,
      pending: active ? status.pending : 0, resumeState: this.resumeState, resumeMessage: this.resumeMessage, nextRetryAt: active ? status.nextRetryAt : this.nextRetryAt,
      canResume: !this.connecting && Boolean(this.connection?.enabled && !this.connection.paused) && (this.resumeState === "retry" || (this.resumeState === "blocked" && this.receiverConflict)),
      canReplaceToken: !this.connecting && Boolean(this.connection?.enabled && !this.connection.paused) && this.resumeState === "blocked" && this.tokenRejected,
      requiresRevoke: Boolean(this.connection?.enabled && this.resumeState !== "pair-required") };
  }
  /** Resume a previously authorized binding, never infer a replacement target. */
  async resume(token: string, targetBotId: string) {
    if (this.connecting || this.resumeState === "active" || this.connection?.paused) return false;
    this.receiverConflict = false; this.tokenRejected = false;
    this.connecting = true; this.resumeState = "verifying"; this.resumeMessage = null;
    const generation = ++this.generation, controller = new AbortController(); this.controller = controller;
    let verifying = false;
    try {
      const connection = this.readConnection(); this.connection = connection;
      if (!connection) { this.resumeState = "pair-required"; this.resumeMessage = "Pair once to reconnect this saved token. Pairings from older Murage versions need this one-time step."; return false; }
      this.identity = connection.botIdentityId;
      if (!connection.enabled) { this.resumeState = "idle"; return false; }
      if (connection.paused) { this.resumeState = "blocked"; this.resumeMessage = "The paired Chief changed. Revoke this connection, then pair the current workspace Chief."; return false; }
      if (connection.targetBotId !== targetBotId || this.options.isCurrentTarget?.(targetBotId) === false) {
        this.resumeState = "blocked"; this.resumeMessage = "The paired Murage bot changed or is unavailable. Revoke this connection, then pair the intended bot.";
        await this.revalidateTarget(); return false;
      }
      const transport = this.options.transport?.(token) ?? new TelegramTransport({ token });
      verifying = true; const bot = await transport.getMe(controller.signal); verifying = false;
      if (generation !== this.generation) return false;
      if (bot.id !== connection.botIdentityId) { this.resumeState = "blocked"; this.resumeMessage = "This token belongs to a different Telegram bot. Revoke the old connection before pairing it."; return false; }
      if (this.options.isCurrentTarget?.(targetBotId) === false) { await this.revalidateTarget(); return false; }
      const channel = this.makeChannel(connection, transport); this.channel = channel;
      const disposition = channel.resumeDisposition();
      if (disposition !== "paired") {
        channel.stop(); this.resumeState = disposition === "revoked" ? "idle" : "pair-required";
        this.resumeMessage = disposition === "revoked" ? null : disposition === "pending" ? "Pairing was not completed. Create a new pairing code." : "Pair once to confirm the Murage bot for this saved connection. Older pairings need this one-time step.";
        return false;
      }
      this.resumeFailures = 0; this.nextRetryAt = null; this.resumeState = "active"; this.schedule(generation); return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      const retry = verifying && (!(error instanceof TelegramTransportError) || ["offline", "timeout", "unavailable", "rate-limit"].includes(error.code));
      this.resumeState = retry ? "retry" : "blocked";
      this.tokenRejected = verifying && error instanceof TelegramTransportError && error.code === "auth";
      this.resumeMessage = retry ? "Could not reconnect to Telegram. Your pairing is saved; retry when your connection is available."
        : this.tokenRejected ? TOKEN_REJECTED : "Telegram could not verify the saved connection. Check the token or restore the connection data before pairing again.";
      if (retry) this.scheduleResume(generation, token, targetBotId, error instanceof TelegramTransportError && error.code === "rate-limit" ? error.retryAfterSeconds : undefined);
      return false;
    } finally { if (generation === this.generation) { this.connecting = false; this.controller = undefined; } }
  }
  async pair(token: string, targetBotId: string) {
    if (this.connecting || this.resumeState === "active" || this.status().requiresRevoke) throw new Error("Revoke the current Telegram connection before pairing again.");
    if (this.options.isCurrentTarget?.(targetBotId) === false) throw new Error("Pair the current workspace Chief.");
    this.verifyingTarget = targetBotId;
    this.connecting = true; this.resumeMessage = null;
    const generation = ++this.generation, controller = new AbortController(); this.controller = controller;
    try {
      const transport = this.options.transport?.(token) ?? new TelegramTransport({ token });
      const bot = await transport.getMe(controller.signal);
      if (generation !== this.generation) throw new Error("Telegram connection was cancelled.");
      if (this.options.isCurrentTarget?.(targetBotId) === false) throw new Error("The workspace Chief changed during pairing. Pair again.");
      this.identity = bot.id;
      const connection: Connection = { version: 1, botIdentityId: bot.id, targetBotId, enabled: true };
      this.channel = this.makeChannel(connection, transport);
      // Explicit re-pairing cancels old authority; restarting never does this.
      if (this.channel.status().paired) { this.channel.revoke(); await this.options.revokeRuns(bot.id); }
      if (generation !== this.generation) throw new Error("Telegram connection was cancelled.");
      if (this.options.isCurrentTarget?.(targetBotId) === false) throw new Error("The workspace Chief changed during pairing. Pair again.");
      const pairing = this.channel.beginPairing();
      try { this.saveConnection(connection); } catch (error) { this.channel.revoke(); throw error; }
      this.resumeFailures = 0; this.nextRetryAt = null; this.resumeState = "active"; this.schedule(generation);
      return { ...pairing, username: bot.username, botIdentityId: bot.id };
    } finally { if (generation === this.generation) { this.connecting = false; this.controller = undefined; this.verifyingTarget = undefined; } }
  }
  /** Replace a token Telegram rejected with a token for the SAME bot, then resume the saved pairing.
   * `commit` persists the token and runs only after getMe proves the paired bot identity. Nothing is
   * saved, revoked or re-paired on any refusal; a paused (Chief-changed) connection is never eligible. */
  async replaceToken(token: string, targetBotId: string, commit: () => void): Promise<boolean> {
    const connection = this.connection;
    if (!connection || !this.status().canReplaceToken) throw new TelegramTokenRefusal(NOT_REPLACEABLE);
    if (connection.targetBotId !== targetBotId || this.options.isCurrentTarget?.(targetBotId) === false) {
      await this.revalidateTarget();
      throw new TelegramTokenRefusal("The paired Chief changed or is unavailable. Revoke this connection, then pair the current workspace Chief.");
    }
    const generation = ++this.generation, controller = new AbortController();
    this.connecting = true; this.resumeState = "verifying"; this.resumeMessage = null; this.controller = controller;
    const current = () => generation === this.generation && this.connection === connection;
    const refuse = (message: string) => {
      if (!current()) return new TelegramTokenRefusal(CHANGED);
      this.resumeState = "blocked"; this.resumeMessage = message; return new TelegramTokenRefusal(message);
    };
    try {
      let bot: { id: string };
      try { bot = await (this.options.transport?.(token) ?? new TelegramTransport({ token })).getMe(controller.signal); }
      catch (error) {
        const code = error instanceof TelegramTransportError ? error.code : "offline";
        throw refuse(code === "auth" ? REPLACEMENT_REJECTED : code === "invalid-config" ? NOT_A_TOKEN : REPLACEMENT_UNCHECKED);
      }
      if (!current()) throw new TelegramTokenRefusal(CHANGED);
      if (bot.id !== connection.botIdentityId) throw refuse(WRONG_BOT);
      if (this.options.isCurrentTarget?.(targetBotId) === false) { await this.revalidateTarget(); throw new TelegramTokenRefusal(CHANGED); }
      try { commit(); } catch (error) { refuse(TOKEN_REJECTED); throw error; }
    } finally { if (generation === this.generation) { this.connecting = false; this.controller = undefined; } }
    this.channel?.stop(); // retire the channel instance bound to the rejected token; resume() re-verifies and reopens the same binding
    return this.resume(token, targetBotId);
  }
  /** A roster change removes authority immediately and never chooses a replacement. */
  async revalidateTarget() {
    const target = this.verifyingTarget ?? (this.connection?.enabled ? this.connection.targetBotId : undefined);
    if (!target || this.options.isCurrentTarget?.(target) !== false || this.connection?.paused) return;
    this.stop(); this.verifyingTarget = undefined;
    this.resumeState = "blocked";
    this.resumeMessage = "The paired Chief changed or is unavailable. Revoke this connection, then pair the current workspace Chief.";
    try {
      if (this.connection?.enabled) {
        this.connection = { ...this.connection, paused: true };
        this.saveConnection(this.connection);
      }
    } catch (error) {
      this.resumeMessage = "Telegram is stopped, but the Chief-change pause could not be saved. Restore write access, then revoke before restarting Murage.";
      throw error;
    } finally {
      if (this.identity) await this.options.revokeRuns(this.identity);
    }
  }
  private retryDelay(seconds?: number) {
    const delay = seconds === undefined ? Math.min(30, 1.5 * 2 ** Math.min(this.resumeFailures++, 4)) : seconds;
    this.nextRetryAt = Date.now() + delay * 1000;
    return delay * 1000;
  }
  private scheduleResume(generation: number, token: string, targetBotId: string, retryAfterSeconds?: number) {
    const delay = this.retryDelay(retryAfterSeconds);
    this.timer = setTimeout(() => { if (generation === this.generation) void this.resume(token, targetBotId); }, delay);
    this.timer.unref();
  }
  private schedule(generation: number) {
    const status = this.channel?.status();
    const delay = status?.nextRetryAt === null || status?.nextRetryAt === undefined ? 1500 : Math.max(0, status.nextRetryAt - Date.now());
    this.timer = setTimeout(async () => {
      if (generation !== this.generation) return;
      await this.channel?.pollOnce();
      const current = this.channel?.status();
      if (generation !== this.generation || !current?.enabled) return;
      if (["auth", "forbidden", "conflict"].includes(current.error ?? "")) {
        this.receiverConflict = current.error === "conflict";
        this.tokenRejected = current.error === "auth";
        this.resumeState = "blocked";
        this.resumeMessage = current.error === "conflict" ? "Another app is receiving this Telegram bot's messages, so Murage paused. Stop that app, then use Retry now to reconnect. Your pairing is saved." : current.error === "auth" ? TOKEN_REJECTED : "Telegram rejected this connection. Check access or revoke before pairing again.";
        return;
      }
      this.schedule(generation);
    }, delay);
    this.timer.unref();
  }
  async revoke() {
    this.receiverConflict = false; this.tokenRejected = false;
    ++this.generation; this.connecting = false; this.controller?.abort(); this.controller = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.resumeState = "idle"; this.resumeMessage = null; this.nextRetryAt = null;
    let failed = false;
    try { const connection = this.connection ?? this.readConnection(); if (connection) { this.identity = connection.botIdentityId; this.saveConnection({ ...connection, enabled: false, paused: false }); } } catch { failed = true; }
    try { this.channel?.revoke(); } catch { failed = true; this.channel?.stop(); }
    if (this.identity) await this.options.revokeRuns(this.identity);
    if (failed) { this.resumeState = "blocked"; this.resumeMessage = "Telegram stopped, but its saved connection could not be fully revoked. Restore access to the saved data and try Revoke again."; throw new Error(this.resumeMessage); }
  }
  stop() { ++this.generation; this.receiverConflict = false; this.tokenRejected = false; this.connecting = false; this.controller?.abort(); if (this.timer) clearTimeout(this.timer); this.channel?.stop(); this.resumeState = "idle"; this.nextRetryAt = null; }
}
