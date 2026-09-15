const trace = (value) => process.send?.({ kind: "slack-fixture", ...value });
const clients = new Set();
let messageSequence = 1;
export const LogLevel = { ERROR: 3 };
export class SocketModeClient {
  listeners = new Map(); active = false;
  on(name, fn) { this.listeners.set(name, fn); return this; }
  async start() { this.active = true; clients.add(this); trace({ op: "connect" }); this.listeners.get("connected")?.(); }
  async disconnect() { this.active = false; clients.delete(this); trace({ op: "stop" }); this.listeners.get("disconnected")?.(); }
}
export class WebClient {
  auth = { test: async () => { trace({ op: "verify" }); return { ok: true, team_id: "TEAM", user_id: "UBOT", bot_id: "BOT" }; } };
  chat = { postMessage: async (input) => { const ts = `100.${messageSequence++}`; trace({ op: "send", channel: input.channel, messageId: ts, text: input.text, blocks: input.blocks }); return { ok: true, channel: input.channel, ts }; },
    update: async input => { trace({ op: "edit", channel: input.channel, messageId: input.ts, text: input.text, blocks: input.blocks }); return { ok: true, channel: input.channel, ts: input.ts }; } };
}
process.on("message", message => {
  if (message?.kind === "slack-fixture-action") {
    for (const client of clients) if (client.active) client.listeners.get("slack_event")?.({
      type: "interactive", body: message.body, ack: async () => trace({ op: "action-ack", eventId: message.eventId }),
    });
    return;
  }
  if (message?.kind !== "slack-fixture-event") return;
  for (const client of clients) if (client.active) client.listeners.get("slack_event")?.({
    type: "events_api", body: message.body, ack: async () => trace({ op: "ack", eventId: message.body.event_id }),
  });
});
