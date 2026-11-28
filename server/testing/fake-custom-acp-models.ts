#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

if (process.argv.includes("--version")) {
  console.log("custom-acp-models-fixture 1.0.0");
  process.exit(0);
}

const directory = process.env.FAKE_CUSTOM_ACP_DIRECTORY;
if (!directory) throw new Error("FAKE_CUSTOM_ACP_DIRECTORY is required");
mkdirSync(directory, { recursive: true });
const receiptPath = join(directory, "receipts.jsonl");
if (process.argv.includes("--dump-config")) {
  if (!process.env.FAKE_CUSTOM_DEEPSEEK || JSON.stringify(process.argv.slice(-3)) !== JSON.stringify(["--profile", "acp", "--dump-config"])) process.exit(2);
  appendFileSync(receiptPath, JSON.stringify({ method: "dump-config", args: process.argv.slice(-3) }) + "\n");
  console.log(process.env.FAKE_DSH_CONFIG ?? JSON.stringify([
    { id: "llm-deepseek", name: "@deepseek-ai/dsh-llm-deepseek-api-key", config: {} },
    { id: "acp", name: "@deepseek-ai/dsh-acp", config: { provider: "deepseek-official", model: "deepseek-v4-flash" } },
  ]));
  process.exit(0);
}
type Session = { model: string; variant: string };
const models = process.env.FAKE_CUSTOM_DEEPSEEK ? [
  { id: '["deepseek-official","deepseek-v4-flash"]', label: "DeepSeek-V4-Flash", variants: ["off", "low", "high", "max"] },
] : [
  { id: "glm-5.3", label: "GLM-5.3", variants: ["low", "max"] },
  { id: "glm-5.3-flash", label: "GLM-5.3-Flash", variants: ["medium", "high"] },
];
const sessions = new Map<string, Session>();

const pathFor = (sessionId: string) => join(directory, `${sessionId}.json`);
const save = (sessionId: string, session: Session) => {
  sessions.set(sessionId, session);
  writeFileSync(pathFor(sessionId), JSON.stringify(session));
};
const get = (sessionId: string) => {
  if (!sessions.has(sessionId) && /^[\w-]+$/.test(sessionId) && existsSync(pathFor(sessionId))) {
    sessions.set(sessionId, JSON.parse(readFileSync(pathFor(sessionId), "utf8")) as Session);
  }
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Unknown fixture session");
  return session;
};
const configOptions = (session: Session) => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: session.model,
    options: models.map((model) => ({ value: model.id, name: model.label, _meta: { copilotUsage: "2x" } })) },
  { id: "thinking", name: "Thinking level", category: "thought_level", type: "select", currentValue: session.variant,
    ...(process.env.FAKE_CUSTOM_NO_DEFAULT ? {} : { defaultValue: models.find(model => model.id === session.model)!.variants[0] }),
    options: models.find((model) => model.id === session.model)!.variants.map((variant) => ({ value: variant, name: variant === "max" ? "Max" : variant })) },
];
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const receipt = (value: object) => appendFileSync(receiptPath, `${JSON.stringify({ pid: process.pid, ...value })}\n`);
const parent = process.ppid;
const orphanWatch = setInterval(() => {
  if (process.ppid !== parent) process.exit(0);
  try { process.kill(parent, 0); } catch { process.exit(0); }
}, 500);
orphanWatch.unref();

for await (const line of createInterface({ input: process.stdin })) {
  let message: { id?: number | string; method?: string; params?: Record<string, any> };
  try { message = JSON.parse(line); } catch { continue; }
  if (message.id === undefined || !message.method) continue;
  const { id, method } = message;
  const params = message.params ?? {};
  const respond = (result: unknown) => send({ jsonrpc: "2.0", id, result });
  try {
    if (method === "initialize") {
      respond({ protocolVersion: 1, agentInfo: { name: "custom-acp-models-fixture", version: "1.0.0" },
        agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } }, authMethods: [] });
    } else if (method === "session/new") {
      const sessionId = process.env.FAKE_CUSTOM_FIXED_ID ?? randomUUID();
      const session = { model: models[0].id, variant: "low" };
      save(sessionId, session);
      receipt({ method, sessionId, ...session });
      if (process.env.FAKE_CUSTOM_NEW_UPDATE) {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { sessionId, configOptions: configOptions(session) } }) + "\n"
          + JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId,
            update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "ACP_FALLBACK_ONE_WRITE", description: "Fallback session command" }] } } }) + "\n");
      } else respond({ sessionId, configOptions: configOptions(session) });
    } else if (method === (process.env.FAKE_CUSTOM_DEEPSEEK ? "session/resume" : "session/load")) {
      const session = get(params.sessionId);
      receipt({ method, sessionId: params.sessionId, ...session });
      if (process.env.FAKE_CUSTOM_LOAD_UPDATE) {
        const stale = configOptions(session);
        session.variant = "max";
        save(params.sessionId, session);
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { configOptions: stale } }) + "\n"
          + JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId,
            update: { sessionUpdate: "config_option_update", configOptions: configOptions(session) } } }) + "\n");
      } else respond({ configOptions: configOptions(session) });
    } else if (method === "session/set_config_option") {
      const session = get(params.sessionId);
      if (params.configId === "model") {
        // ACP-EFFORT fixture: a replacement session whose model pin is refused
        if (process.env.FAKE_CUSTOM_FAIL_MODEL_ON_NEW_SESSION && existsSync(receiptPath) && readFileSync(receiptPath, "utf8").split("\n").filter(line => line.includes('"method":"session/new"')).length >= 2) throw new Error("fixture refused the model pin on the replacement session");
        const chosen = models.find((model) => model.id === params.value);
        if (!chosen) throw new Error(`Unknown fixture model ${params.value}`);
        session.model = chosen.id;
        session.variant = chosen.variants[0];
      } else if (params.configId === "thinking") {
        if (!models.find((model) => model.id === session.model)!.variants.includes(params.value)) {
          throw new Error(`Unsupported fixture thinking level ${params.value}`);
        }
        if (process.env.FAKE_CUSTOM_SET_ERROR) throw new Error("fixture refused the thinking change");
        // ACP-EFFORT fixtures: the answer may fail to carry the requested value, or a notification may move it right after the answer
        if (!process.env.FAKE_CUSTOM_NO_CONFIRM) session.variant = params.value;
      } else throw new Error(`Unknown fixture config ${params.configId}`);
      save(params.sessionId, session);
      receipt({ method, sessionId: params.sessionId, configId: params.configId, value: params.value, ...session });
      if (process.env.FAKE_CUSTOM_LATE_CHANGE && params.configId === "thinking") {
        const answer = configOptions(session);
        session.variant = process.env.FAKE_CUSTOM_LATE_CHANGE;
        save(params.sessionId, session);
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { configOptions: answer } }) + "\n"
          + JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId,
            update: { sessionUpdate: "config_option_update", configOptions: configOptions(session) } } }) + "\n");
      } else respond({ configOptions: configOptions(session) });
    } else if (method === "fixture/change_thinking") {
      const session = get(params.sessionId);
      session.variant = params.value;
      save(params.sessionId, session);
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: {} }) + "\n"
        + JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId,
          update: { sessionUpdate: "config_option_update", configOptions: configOptions(session) } } }) + "\n");
    } else if (method === "session/prompt") {
      const session = get(params.sessionId);
      const marker = [...JSON.stringify(params.prompt).matchAll(/ACP_PICKER_[A-Z0-9_]+/g)].at(-1)?.[0] ?? "auxiliary";
      receipt({ method, sessionId: params.sessionId, marker, promptText: JSON.stringify(params.prompt), ...session });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `fixture:${marker}:${session.model}:${session.variant}` } } } });
      respond({ stopReason: "end_turn" });
    } else if (method === "session/close" || method === "authenticate") {
      respond({});
    } else {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unsupported fixture method ${method}` } });
    }
  } catch (error) {
    send({ jsonrpc: "2.0", id, error: { code: -32602, message: String(error) } });
  }
}
