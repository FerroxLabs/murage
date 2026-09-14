#!/usr/bin/env node
// Narrow Grok ACP/custom-model fixture. Refuses every non-loopback inference URL.
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
if (process.argv.includes("--version")) { console.log("grok 1.0.6 fixture"); process.exit(0); }
const home = process.env.GROK_HOME || join(process.env.HOME!, ".grok");
const calls: Array<{ method: string; params: any }> = [];
const dump = () => { if (process.env.FAKE_GROK_DUMP) writeFileSync(process.env.FAKE_GROK_DUMP, JSON.stringify({ argv: process.argv.slice(2), grokHome: home,
  nativeFallback: process.env.GROK_CODE_XAI_API_KEY ?? null, calls }, null, 2)); };
const out = (id: number, result: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const error = (id: number, message: string) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }) + "\n");
let selected = "", sessionId = "";
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line); if (m.id === undefined || !m.method) continue;
  calls.push({ method: m.method, params: m.params }); dump();
  if (m.method === "initialize") { out(m.id, { protocolVersion: 1, authMethods: [{ id: "cached_token" }] }); continue; }
  if (m.method === "authenticate") { if (process.env.MURAGE_GROK_PROVIDER_API_KEY) error(m.id, "Routed fixture must not authenticate with native session"); else out(m.id, {}); continue; }
  if (m.method === "session/new") {
    sessionId = randomUUID(); mkdirSync(join(home, "sessions"), { recursive: true }); writeFileSync(join(home, "sessions", sessionId + ".json"), "{}");
    out(m.id, { sessionId }); continue;
  }
  if (m.method === "session/load") {
    if (!/^[a-f0-9-]{36}$/.test(m.params.sessionId) || !existsSync(join(home, "sessions", m.params.sessionId + ".json"))) { out(m.id, null); continue; }
    sessionId = m.params.sessionId; out(m.id, { sessionId }); continue;
  }
  if (m.method === "session/set_model") {
    if (process.env.FAKE_GROK_REJECT_MODEL === "1") { error(m.id, "Unsupported selected model"); continue; }
    selected = m.params.modelId; out(m.id, {}); continue;
  }
  if (m.method === "session/prompt") {
    try {
      let text = "native fixture reply";
      if (process.env.MURAGE_GROK_PROVIDER_API_KEY) {
        const config = readFileSync(join(home, "config.toml"), "utf8");
        const string = (name: string) => { const match = new RegExp(`^${name} = (".*")$`, "m").exec(config); if (!match) throw new Error("Missing fixture config field"); return JSON.parse(match[1]); };
        if (!config.includes(`[model.${selected}]`) || string("env_key") !== "MURAGE_GROK_PROVIDER_API_KEY") throw new Error("Wrong selected slug or key binding");
        const base = new URL(string("base_url")); if (base.protocol !== "http:" || base.hostname !== "127.0.0.1") throw new Error("Only loopback fixture endpoints allowed");
        const response = await fetch(base.href.replace(/\/$/, "") + "/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${process.env.MURAGE_GROK_PROVIDER_API_KEY}` },
          body: JSON.stringify({ model: string("model"), messages: [{ role: "user", content: m.params.prompt.map((p: any) => p.text ?? "").join("\n") }] }) });
        if (!response.ok) throw new Error("Fixture provider rejected request");
        text = (await response.json() as any).choices[0].message.content;
      }
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } }) + "\n");
      out(m.id, { stopReason: "end_turn" });
    } catch { error(m.id, "Fixture provider request failed"); }
    continue;
  }
  out(m.id, {});
}
