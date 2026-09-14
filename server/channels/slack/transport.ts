import { ChannelSendError } from "../durable-delivery.ts";
import { slackId } from "./event.ts";

export interface SlackTransport {
  verifyBot(): Promise<{ teamId: string; userId: string; botId: string }>;
  start(onEnvelope: (value: unknown, ack: () => Promise<void>) => void, onHealth: (state: "connected" | "disconnected" | "error") => void): Promise<void>;
  stop(): Promise<void>;
  sendText(input: { dmId: string; text: string; signal: AbortSignal }): Promise<{ channel: string; ts: string }>;
}
interface SDK {
  socket: { on(name: string, fn: (...args: unknown[]) => void): unknown; start(): Promise<unknown>; disconnect(): Promise<unknown> };
  web: { auth: { test(): Promise<unknown> }; chat: { postMessage(input: Record<string, unknown>): Promise<unknown> } };
}
export type SlackSDKFactory = (appToken: string, botToken: string, safeError: () => void) => Promise<SDK>;
const object = (x: unknown): Record<string, unknown> => x !== null && typeof x === "object" ? x as Record<string, unknown> : {};

const defaultFactory: SlackSDKFactory = async (appToken, botToken, safeError) => {
  const [{ SocketModeClient }, { WebClient, LogLevel }] = await Promise.all([import("@slack/socket-mode"), import("@slack/web-api")]);
  const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: safeError,
    getLevel: () => LogLevel.ERROR, setLevel: () => {}, setName: () => {} };
  const options = { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, timeout: 10000,
    maxRequestConcurrency: 1, allowAbsoluteUrls: false, logger };
  // Service owns reconnect backoff; no second retry loop hidden inside the SDK.
  return { socket: new SocketModeClient({ appToken, autoReconnectEnabled: false, logger, clientOptions: options }),
    web: new WebClient(botToken, options) } as unknown as SDK;
};

export class SlackSocketTransport implements SlackTransport {
  private sdk?: SDK;
  private generation = 0;
  private stopped = false;
  private onHealth?: (state: "connected" | "disconnected" | "error") => void;
  private options: { appToken: string; botToken: string; factory?: SlackSDKFactory };
  constructor(options: { appToken: string; botToken: string; factory?: SlackSDKFactory }) { this.options = options; }
  private async client() {
    if (!this.sdk) this.sdk = await (this.options.factory ?? defaultFactory)(this.options.appToken, this.options.botToken, () => this.onHealth?.("error"));
    return this.sdk;
  }
  async verifyBot() {
    const sdk = await this.client();
    try {
      const result = object(await sdk.web.auth.test());
      if (result.ok !== true || !slackId.safeParse(result.team_id).success || !slackId.safeParse(result.user_id).success || !slackId.safeParse(result.bot_id).success) throw new ChannelSendError("auth", false);
      return { teamId: String(result.team_id), userId: String(result.user_id), botId: String(result.bot_id) };
    } catch (e) { throw safeFailure(e, false); }
  }
  async start(onEnvelope: (value: unknown, ack: () => Promise<void>) => void, onHealth: (state: "connected" | "disconnected" | "error") => void) {
    if (this.stopped) throw new Error("Slack transport stopped");
    const generation = ++this.generation;
    const sdk = await this.client(); this.onHealth = onHealth;
    if (this.stopped || generation !== this.generation) return;
    sdk.socket.on("slack_event", raw => {
      if (this.stopped || generation !== this.generation) return;
      const e = object(raw);
      if (typeof e.ack !== "function") return;
      onEnvelope({ type: e.type, body: e.body }, async () => {
        if (this.stopped || generation !== this.generation) throw new Error("Slack acknowledgement expired");
        await (e.ack as () => Promise<void>)();
      });
    });
    for (const state of ["connected", "disconnected", "error"] as const) sdk.socket.on(state, () => {
      if (!this.stopped && generation === this.generation) onHealth(state);
    });
    try { await sdk.socket.start(); }
    catch (e) { throw safeFailure(e, false); }
    if (this.stopped || generation !== this.generation) await sdk.socket.disconnect();
  }
  async stop() { this.stopped = true; this.generation++; await this.sdk?.socket.disconnect(); }
  async sendText(input: { dmId: string; text: string; signal: AbortSignal }) {
    if (this.stopped || input.signal.aborted) throw new ChannelSendError("offline", false);
    if (!/^D[A-Z0-9]{1,79}$/.test(input.dmId) || !input.text || input.text.length > 4000) throw new ChannelSendError("invalid-request", false);
    const sdk = await this.client();
    if (this.stopped || input.signal.aborted) throw new ChannelSendError("offline", false);
    try {
      const result = object(await sdk.web.chat.postMessage({ channel: input.dmId, text: input.text,
        mrkdwn: false, parse: "none", unfurl_links: false, unfurl_media: false }));
      if (result.ok !== true) throw { data: result };
      if (result.channel !== input.dmId || typeof result.ts !== "string" || !/^\d+\.\d+$/.test(result.ts)) throw new ChannelSendError("invalid-request", true);
      return { channel: result.channel, ts: result.ts };
    } catch (e) { throw safeFailure(e, true); }
  }
}

function safeFailure(error: unknown, dispatched: boolean): ChannelSendError {
  if (error instanceof ChannelSendError) return error;
  const e = object(error), data = object(e.data), code = data.error;
  if (e.code === "slack_webapi_rate_limited_error" || code === "ratelimited" || code === "rate_limited") {
    const retry = Number(e.retryAfter);
    return new ChannelSendError("rate-limit", false, Number.isFinite(retry) && retry > 0 ? retry : 30);
  }
  if (["invalid_auth", "not_authed", "token_revoked", "account_inactive"].includes(String(code))) return new ChannelSendError("auth", false);
  if (["missing_scope", "not_in_channel", "channel_not_found", "restricted_action", "no_permission"].includes(String(code))) return new ChannelSendError("forbidden", false);
  if (["invalid_arguments", "no_text", "msg_too_long"].includes(String(code))) return new ChannelSendError("invalid-request", false);
  return new ChannelSendError("unavailable", dispatched);
}
