import { join } from "node:path";
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
}
export class TelegramService {
  private channel?: TelegramChannel;
  private timer?: ReturnType<typeof setTimeout>;
  private connecting = false;
  private generation = 0;
  private identity?: string;
  private readonly options: TelegramServiceOptions;
  constructor(options: TelegramServiceOptions) { this.options = options; }
  status() { return { connecting: this.connecting, ...(this.channel?.status() ?? { enabled: false, paired: false, pending: 0, uncertain: 0, error: null }) }; }
  async pair(token: string, targetBotId: string) {
    if (this.connecting || this.channel?.status().enabled) throw new Error("Revoke the current Telegram connection before pairing again.");
    this.connecting = true;
    const generation = ++this.generation;
    try {
      const transport = this.options.transport?.(token) ?? new TelegramTransport({ token });
      const bot = await transport.getMe();
      if (generation !== this.generation) throw new Error("Telegram connection was cancelled.");
      this.identity = bot.id;
      this.channel = new TelegramChannel({ file: join(this.options.dataDir, "telegram", bot.id + ".json"),
        botIdentityId: bot.id, transport,
        approvals: this.options.approvals?.(targetBotId),
        enqueue: input => this.options.enqueue(bot.id, targetBotId, input), runResult: this.options.runResult });
      // Explicit pairing never resumes an old binding under a different target.
      if (this.channel.status().paired) this.channel.revoke();
      const pairing = this.channel.beginPairing();
      this.schedule(generation);
      return { ...pairing, username: bot.username, botIdentityId: bot.id };
    } finally { this.connecting = false; }
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
    ++this.generation;
    if (this.timer) clearTimeout(this.timer);
    this.channel?.revoke();
    if (this.identity) await this.options.revokeRuns(this.identity);
  }
  stop() { ++this.generation; if (this.timer) clearTimeout(this.timer); this.channel?.stop(); }
}
