import type { PermissionAction } from "../permission-approvals.ts";
import { ChannelSendError } from "../durable-delivery.ts";
import { slackId } from "./event.ts";

export interface SlackTransport {
  onPermissionAction?(receive: (event: PermissionAction) => void): void;
  sendPermission?(input: { dmId: string; text: string; approveId: string; denyId: string; signal: AbortSignal }): Promise<{ channel: string; ts: string }>;
  settlePermission?(input: { dmId: string; messageId: string; text: string; signal: AbortSignal }): Promise<void>;
  verifyBot(): Promise<{ teamId: string; userId: string; botId: string }>;
  start(onEnvelope: (value: unknown, ack: () => Promise<void>) => void, onHealth: (state: "connected" | "disconnected" | "error") => void): Promise<void>;
  stop(): Promise<void>;
  sendText(input: { dmId: string; text: string; signal: AbortSignal }): Promise<{ channel: string; ts: string }>;
}
interface SDK {
  socket: { on(name: string, fn: (...args: unknown[]) => void): unknown; start(): Promise<unknown>; disconnect(): Promise<unknown> };
  web: { auth: { test(): Promise<unknown> }; chat: { update?(input: Record<string, unknown>): Promise<unknown>; postMessage(input: Record<string, unknown>): Promise<unknown> } };
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
  private identity?: { teamId: string; userId: string; botId: string };
  private permissionReceive?: (event: PermissionAction) => void;
  onPermissionAction(receive: (event: PermissionAction) => void) { this.permissionReceive = receive; }
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
      return this.identity = { teamId: String(result.team_id), userId: String(result.user_id), botId: String(result.bot_id) };
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
      if (e.type === "interactive") {
        let acknowledgement: Promise<void> | undefined;
        const ack = () => acknowledgement ??= Promise.resolve().then(() => (e.ack as () => Promise<void>)());
        void ack().then(() => {
          if (this.stopped || generation !== this.generation || !this.permissionReceive || !this.identity) return;
          const body = object(e.body), user = object(body.user), channel = object(body.channel), message = object(body.message);
          const container = object(body.container), action = object(Array.isArray(body.actions) && body.actions.length === 1 ? body.actions[0] : null);
          if (body.type !== "block_actions" || !slackId.safeParse(body.api_app_id).success || object(body.team).id !== this.identity.teamId ||
            message.user !== this.identity.userId || message.bot_id !== this.identity.botId ||
            typeof user.id !== "string" || !slackId.safeParse(user.id).success ||
            typeof channel.id !== "string" || !/^D[A-Z0-9]{1,79}$/.test(channel.id) ||
            typeof message.ts !== "string" || !/^\d+\.\d+$/.test(message.ts) ||
            container.type !== "message" || container.channel_id !== channel.id || container.message_ts !== message.ts ||
            action.type !== "button" || typeof action.action_id !== "string" || !/^murage:[a-f0-9]{48}:[ad]$/.test(action.action_id)) return;
          this.permissionReceive({ provider: "slack", applicationId: String(body.api_app_id), teamId: this.identity.teamId, userId: user.id,
            channelId: channel.id, messageId: message.ts, actionId: action.action_id, ack });
        }).catch(() => { if (!this.stopped && generation === this.generation) onHealth("error"); });
        return;
      }
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
  async sendPermission(input: { dmId: string; text: string; approveId: string; denyId: string; signal: AbortSignal }) {
    if (!/^murage:[a-f0-9]{48}:a$/.test(input.approveId) || input.denyId !== input.approveId.slice(0, -1) + "d") throw new ChannelSendError("invalid-request", false);
    return this.permissionMessage(input, [{ type: "section", text: { type: "plain_text", text: input.text, emoji: false } },
      { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Approve once" }, style: "primary", action_id: input.approveId },
        { type: "button", text: { type: "plain_text", text: "Deny" }, style: "danger", action_id: input.denyId }] }]);
  }
  async settlePermission(input: { dmId: string; messageId: string; text: string; signal: AbortSignal }) {
    if (!/^\d+\.\d+$/.test(input.messageId)) throw new ChannelSendError("invalid-request", false);
    await this.permissionMessage(input, [{ type: "section", text: { type: "plain_text", text: input.text, emoji: false } }], input.messageId);
  }
  private async permissionMessage(input: { dmId: string; text: string; signal: AbortSignal }, blocks: unknown[], messageId?: string) {
    if (this.stopped || input.signal.aborted) throw new ChannelSendError("offline", false);
    if (!/^D[A-Z0-9]{1,79}$/.test(input.dmId) || !input.text || input.text.length > 3000) throw new ChannelSendError("invalid-request", false);
    const sdk = await this.client();
    if (this.stopped || input.signal.aborted) throw new ChannelSendError("offline", false);
    if (messageId && !sdk.web.chat.update) throw new ChannelSendError("unavailable", false);
    try {
      // Blocks render the exact plain text. Escape the fallback so notifications cannot interpret mentions.
      const text = input.text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      const payload = { channel: input.dmId, text, blocks, mrkdwn: false, parse: "none", link_names: false, unfurl_links: false, unfurl_media: false };
      const result = object(messageId ? await sdk.web.chat.update!({ ...payload, ts: messageId }) : await sdk.web.chat.postMessage(payload));
      if (result.ok !== true) throw { data: result };
      if (result.channel !== input.dmId || typeof result.ts !== "string" || !/^\d+\.\d+$/.test(result.ts) || (messageId && result.ts !== messageId)) throw new ChannelSendError("invalid-request", true);
      return { channel: result.channel, ts: result.ts };
    } catch (error) { throw safeFailure(error, true); }
  }
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
