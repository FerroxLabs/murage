// Scripted ACP peer only. Records protocol; never starts MCP tools or a model.
import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const [scenario, dump, tool = "memory_search"] = process.argv.slice(2);
const previous = existsSync(dump) ? JSON.parse(readFileSync(dump, "utf8")) : [];
const observed = { scenario, definitions: [], decisions: [], alias: null };
const save = () => writeFileSync(dump, JSON.stringify([...previous, observed]));
const send = (...messages) => process.stdout.write(messages.map(message => JSON.stringify(message) + "\n").join(""));
let promptId, newId, session = "memory-fixture-session";
const result = (id, value) => ({ jsonrpc: "2.0", id, result: value });
function permission() {
  const current = observed.alias ?? "murage-memory";
  const alias = scenario === "old-alias" || scenario === "two-turns" && previous.length ? previous[0]?.alias ?? "murage-memory-00000000000000000000"
    : scenario === "wrong-alias" ? "murage-memory-00000000000000000000" : current;
  const identity = { version: scenario === "wrong-version" ? 2 : 1, namespace: scenario === "wrong-namespace" ? "builtin" : "mcp", name: `${alias}__${tool}` };
  const toolCall = { kind: "other", title: scenario === "question" ? "AskUserQuestion" : `Display ${current}__${tool}`, rawInput: { name: `${current}__${tool}` },
    ...(scenario === "missing-meta" ? {} : { _meta: { "fuigo/tool": identity } }) };
  const options = [{ optionId: "standing", kind: "allow_always" }, { optionId: "deny", kind: "reject_once" }];
  if (scenario !== "no-once") options.push({ optionId: scenario === "ambiguous-option" ? "standing" : "once", kind: "allow_once" });
  return { jsonrpc: "2.0", id: "memory-permission", method: "session/request_permission", params: {
    ...(scenario === "missing-session" ? {} : { sessionId: scenario === "wrong-session" ? "other-session" : session }), toolCall, options,
  } };
}
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.id === "memory-permission" && message.result) {
    observed.decisions.push(message.result); save();
    if (scenario === "before-prompt" && newId !== undefined) { send(result(newId, { sessionId: session })); newId = undefined; }
    else if (promptId !== undefined) send(result(promptId, { stopReason: "end_turn" }));
  } else if (message.method === "initialize") send(result(message.id, { protocolVersion: 1 }));
  else if (message.method === "session/load" || message.method === "session/new") {
    observed.definitions.push({ method: message.method, servers: message.params.mcpServers });
    observed.alias = message.params.mcpServers.find(server => server.name.startsWith("murage-memory"))?.name ?? null;
    if (message.method === "session/load") {
      session = message.params.sessionId; save();
      send(result(message.id, scenario === "load-fallback" ? null : {}));
    } else {
      save();
      if (scenario === "before-prompt") { newId = message.id; send(permission()); }
      else send(result(message.id, { sessionId: session }));
    }
  } else if (message.method === "session/prompt") {
    promptId = message.id;
    if (scenario === "after-result") { observed.lateRequest = true; save(); send(result(promptId, { stopReason: "end_turn" }), permission()); }
    else if (scenario === "after-cancel") send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: session, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Ready for cancellation" } } } });
    else if (scenario === "before-prompt") send(result(promptId, { stopReason: "end_turn" }));
    else send(permission());
  } else if (message.method === "session/cancel") { observed.lateRequest = true; save(); send(permission(), result(promptId, { stopReason: "cancelled" })); }
});
