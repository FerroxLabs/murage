import { ChannelSendError } from "../durable-delivery.ts";
import { discordId } from "./event.ts";

type Health = "connected" | "disconnected" | "error" | "blocked";
export interface DiscordTransport {
  verifyBot(): Promise<{ applicationId: string; botUserId: string }>;
  start(receive: (event: unknown) => void, health: (state: Health) => void): Promise<void>;
  stop(): Promise<void>;
  sendText(input: { dmId: string; text: string; signal: AbortSignal }): Promise<{ channel: string; messageId: string }>;
}
interface SDK {
  on(name: string, callback: (...args: any[]) => void): unknown;
  login(token: string): Promise<unknown>;
  destroy(): Promise<void>;
  user: { id: string } | null;
  application: { id: string } | null;
  rest: { get(path: string): Promise<unknown>; post(path: string, options: { body: Record<string, unknown>; signal: AbortSignal }): Promise<unknown> };
}
export type DiscordSDKFactory = (token: string) => Promise<SDK>;
export const discordClientOptions = () => ({ intents: [4096], partials: [1],
  rest: { retries: 0, rejectOnRateLimit: () => true, timeout: 10000 },
  allowedMentions: { parse: [] as string[], repliedUser: false },
});
const defaultFactory: DiscordSDKFactory = async token => {
  const { Client, GatewayIntentBits, Partials } = await import("discord.js");
  const client = new Client({ ...discordClientOptions(), intents: [GatewayIntentBits.DirectMessages], partials: [Partials.Channel], allowedMentions: { parse: [], repliedUser: false } });
  client.rest.setToken(token);
  return client as unknown as SDK;
};
const object = (value: unknown): Record<string, any> => value !== null && typeof value === "object" ? value as Record<string, any> : {};
export function discordPreview(text: string): string {
  if (text.length <= 2000) return text;
  const suffix = "\n… Full response in Murage.";
  let head = text.slice(0, 2000 - suffix.length);
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return head + suffix;
}
function safeFailure(error: unknown, dispatched: boolean): ChannelSendError {
  if (error instanceof ChannelSendError) return error;
  const e = object(error), status = e.status;
  if (status === 429 || e.name === "RateLimitError") {
    const seconds = e.name === "RateLimitError"
      ? Math.max(Number(e.timeToReset) || 0, Number(e.retryAfter) || 0, Number(e.sublimitTimeout) || 0) / 1000
      : Number(object(e.rawError).retry_after);
    return new ChannelSendError("rate-limit", false, Number.isFinite(seconds) && seconds > 0 ? seconds : 30);
  }
  if (status === 401) return new ChannelSendError("auth", false);
  if (status === 403 || status === 404) return new ChannelSendError("forbidden", false);
  if (status === 400) return new ChannelSendError("invalid-request", false);
  return new ChannelSendError("unavailable", dispatched);
}
export class DiscordGatewayTransport implements DiscordTransport {
  private options: { botToken: string; factory?: DiscordSDKFactory };
  private sdk?: Promise<SDK>;
  private identity?: { applicationId: string; botUserId: string };
  private stopped = false;
  private started = false;
  private generation = 0;
  constructor(options: { botToken: string; factory?: DiscordSDKFactory }) { this.options = options; }
  private client() { return this.sdk ??= (this.options.factory ?? defaultFactory)(this.options.botToken); }
  async verifyBot() {
    if (this.stopped) throw new ChannelSendError("offline", false);
    const sdk = await this.client();
    try {
      const user = object(await sdk.rest.get("/users/@me"));
      const app = object(await sdk.rest.get("/oauth2/applications/@me"));
      if (user.bot !== true || !discordId.safeParse(user.id).success || !discordId.safeParse(app.id).success) throw new ChannelSendError("auth", false);
      if (this.stopped) throw new ChannelSendError("offline", false);
      return this.identity = { applicationId: app.id, botUserId: user.id };
    } catch (error) { throw safeFailure(error, false); }
  }
  async start(receive: (raw: unknown) => void, health: (state: Health) => void) {
    if (this.stopped || this.started || !this.identity) throw new ChannelSendError("offline", false);
    this.started = true; const generation = ++this.generation, sdk = await this.client();
    const active = () => !this.stopped && generation === this.generation;
    if (!active()) return;
    sdk.on("clientReady", () => {
      if (!active()) return;
      health(sdk.user?.id === this.identity?.botUserId && sdk.application?.id === this.identity?.applicationId ? "connected" : "blocked");
    });
    sdk.on("messageCreate", message => {
      if (!active()) return;
      receive({ ...this.identity, id: message.id, dmId: message.channelId, channelType: message.channel?.type,
        authorId: message.author?.id, authorBot: message.author?.bot, guildId: message.guildId ?? null,
        webhookId: message.webhookId ?? null, type: message.type, content: message.content, occurredAt: message.createdTimestamp,
        attachments: message.attachments?.size, components: message.components?.length,
        forwarded: message.reference?.type === 1 || (message.messageSnapshots?.size ?? 0) > 0 });
    });
    sdk.on("shardDisconnect", event => { if (active()) health([4004, 4010, 4011, 4012, 4013, 4014].includes(event?.code) ? "blocked" : "disconnected"); });
    sdk.on("shardReconnecting", () => { if (active()) health("disconnected"); });
    sdk.on("shardResume", () => { if (active()) health("connected"); });
    sdk.on("error", () => { if (active()) health("error"); });
    try { await sdk.login(this.options.botToken); } catch (error) { throw safeFailure(error, false); }
    if (!active()) await sdk.destroy();
  }
  async stop() { this.stopped = true; this.generation++; if (this.sdk) await (await this.sdk).destroy(); }
  async sendText(input: { dmId: string; text: string; signal: AbortSignal }) {
    if (this.stopped || input.signal.aborted) throw new ChannelSendError("offline", false);
    if (!discordId.safeParse(input.dmId).success || !input.text) throw new ChannelSendError("invalid-request", false);
    const sdk = await this.client();
    if (this.stopped || input.signal.aborted) throw new ChannelSendError("offline", false);
    try {
      const result = object(await sdk.rest.post(`/channels/${input.dmId}/messages`, { signal: input.signal,
        body: { content: discordPreview(input.text), allowed_mentions: { parse: [], replied_user: false }, tts: false, flags: 4 } }));
      if (result.channel_id !== input.dmId || !discordId.safeParse(result.id).success) throw new ChannelSendError("invalid-request", true);
      return { channel: result.channel_id as string, messageId: result.id as string };
    } catch (error) { throw safeFailure(error, true); }
  }
}
