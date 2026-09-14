const trace = (value) => process.send?.({ kind: "slack-fixture", ...value });
const clients = new Set();
export const LogLevel = { ERROR: 3 };
export class SocketModeClient {
  listeners = new Map(); active = false;
  on(name, fn) { this.listeners.set(name, fn); return this; }
  async start() { this.active = true; clients.add(this); trace({ op: "connect" }); this.listeners.get("connected")?.(); }
  async disconnect() { this.active = false; clients.delete(this); trace({ op: "stop" }); this.listeners.get("disconnected")?.(); }
}
export class WebClient {
  auth = { test: async () => { trace({ op: "verify" }); return { ok: true, team_id: "TEAM", user_id: "UBOT", bot_id: "BOT" }; } };
  chat = { postMessage: async (input) => { trace({ op: "send", channel: input.channel, text: input.text }); return { ok: true, channel: input.channel, ts: "100.1" }; } };
}
process.on("message", message => {
  if (message?.kind !== "slack-fixture-event") return;
  for (const client of clients) if (client.active) client.listeners.get("slack_event")?.({
    type: "events_api", body: message.body, ack: async () => trace({ op: "ack", eventId: message.body.event_id }),
  });
});
