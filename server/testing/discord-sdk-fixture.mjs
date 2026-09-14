// Test-only discord.js facade. No WebSocket or HTTP client exists here.
const trace = value => process.send?.({ kind: "discord-fixture", ...value });
const clients = new Set();
export const GatewayIntentBits = { DirectMessages: 4096 };
export const Partials = { Channel: 1 };
export class Client {
  listeners = new Map(); active = false;
  user = { id: "12" }; application = { id: "11" };
  constructor(options) {
    if (options.intents?.[0] !== 4096 || options.rest?.retries !== 0 || options.rest?.rejectOnRateLimit?.() !== true) throw new Error("Unsafe fixture SDK options");
  }
  on(name, fn) { this.listeners.set(name, fn); return this; }
  async login() { this.active = true; clients.add(this); trace({ op: "connect" }); this.listeners.get("clientReady")?.(); }
  async destroy() { this.active = false; clients.delete(this); trace({ op: "stop" }); }
  rest = {
    setToken() {},
    get: async path => { trace({ op: "verify" }); return path === "/users/@me" ? { id: "12", bot: true } : { id: "11" }; },
    post: async (path, options) => {
      const channel = /^\/channels\/(\d+)\/messages$/.exec(path)?.[1];
      if (!channel || options.body.allowed_mentions.parse.length || options.body.content.length > 2000) throw new Error("Invalid fixture send");
      trace({ op: "send", channel, text: options.body.content }); return { channel_id: channel, id: "99" };
    },
  };
}
process.on("message", message => {
  if (message?.kind !== "discord-fixture-event") return;
  for (const client of clients) if (client.active) {
    client.listeners.get("messageCreate")?.(message.body);
    trace({ op: "received", eventId: message.body.id });
  }
});
