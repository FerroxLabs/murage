// Fixture-only transparent tee around the real agents proxy. Never record
// environment, bearer headers, call arguments or raw tool/provider text.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

export const EXPECTED_TOOLS = [
  "list_bots", "ask_bot", "delegate_bot", "check_delegation", "wait_delegation",
  "create_bot", "request_credential", "list_routines", "propose_routine",
  "propose_routine_action", "skills_list", "skill_manage",
];

export function isProofPermissionCard(message) {
  return message?.kind === "options" && typeof message.card?.requestId === "string"
    && typeof message.card.tool === "string" && !message.card.answered;
}

// Pinned Fuigo1.0.4 stamps this canonical envelope from its registered
// toolset. SearchTool only discovers this fixture's MCP definitions; UseTool
// is allowed only for the exact harmless read or approval-bound fixture ask.
export function permittedProofPermission(toolCall, phase, targetId) {
  const meta = toolCall?._meta?.["fuigo/tool"];
  const input = toolCall?.rawInput;
  if (meta?.version !== 1 || !input || typeof input !== "object" || Array.isArray(input)) return null;
  if (phase !== "read" && phase !== "approval") return null;
  if (meta.name === "search_tool" && input.variant === "SearchTool"
    && Object.keys(input).every(key => ["variant", "query", "limit"].includes(key))
    && typeof input.query === "string" && input.query.length <= 400
    && /agents|list_bots|ask_bot/.test(input.query)
    && (input.limit == null || (Number.isInteger(input.limit) && input.limit > 0 && input.limit <= 255))) return "search_tool";
  if (meta.name !== "use_tool" || input.variant !== "UseTool"
    || !Object.keys(input).every(key => ["variant", "tool_name", "tool_input"].includes(key))) return null;
  const args = input.tool_input;
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  if (input.tool_name === "agents__list_bots" && Object.keys(args).length === 0) return "list_bots";
  if (phase === "approval" && input.tool_name === "agents__ask_bot"
    && Object.keys(args).length === 2 && args.bot_id === targetId
    && args.message === "Fixture approval cancellation proof") return "ask_bot";
  return null;
}

export async function runProxy({ realPath, evidencePath, phasePath }) {
  const record = (entry) => appendFileSync(evidencePath, JSON.stringify(entry) + "\n", { mode: 0o600 });
  const pending = new Map();
  const child = spawn(process.execPath, [realPath], { env: process.env, stdio: ["pipe", "pipe", "ignore"] });
  record({ type: "proxy_start", pid: process.pid, childPid: child.pid });
  const input = createInterface({ input: process.stdin });
  const output = createInterface({ input: child.stdout });
  const stop = () => child.kill("SIGTERM");
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  child.stdin.on("error", () => record({ type: "proxy_input_error" }));

  input.on("line", (line) => {
    let request;
    try { request = JSON.parse(line); }
    catch { record({ type: "invalid_request" }); return; }
    if (request.method === "tools/call") {
      let phase;
      try { phase = readFileSync(phasePath, "utf8").trim(); } catch { phase = ""; }
      const name = request.params?.name;
      const allowed = phase === "read" ? name === "list_bots"
        : phase === "approval" && (name === "ask_bot" || name === "list_bots");
      if (!allowed) {
        record({ type: "unexpected_call" });
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id,
          result: { isError: true, content: [{ type: "text", text: "This isolated proof permits only the requested Murage tool." }] } }) + "\n");
        return;
      }
      record({ type: "call", name });
    }
    if (request.id !== undefined) {
      pending.set(JSON.stringify(request.id), { method: request.method, name: request.params?.name });
    }
    child.stdin.write(line + "\n");
  });
  input.on("close", () => child.stdin.end());

  output.on("line", (line) => {
    let response;
    try { response = JSON.parse(line); } catch { record({ type: "invalid_response" }); }
    const key = response?.id === undefined ? undefined : JSON.stringify(response.id);
    const request = key === undefined ? undefined : pending.get(key);
    if (key !== undefined) pending.delete(key);
    if (request?.method === "tools/list") {
      const tools = Array.isArray(response.result?.tools) ? response.result.tools : [];
      const names = tools.map((tool) => tool?.name);
      record({ type: "catalog", names: names.filter((name) => EXPECTED_TOOLS.includes(name)),
        unexpectedCount: names.filter((name) => !EXPECTED_TOOLS.includes(name)).length });
    } else if (request?.method === "tools/call") {
      const result = { type: "result", name: request.name,
        isError: Boolean(response?.error || response?.result?.isError) };
      if (request.name === "list_bots") {
        const text = (response?.result?.content ?? []).filter((item) => item?.type === "text" && typeof item.text === "string")
          .map((item) => item.text).join("\n");
        result.peers = [...text.matchAll(/\[id: ([\w-]{1,128}), model:/g)].map((match) => ({ id: match[1] }));
      }
      record(result);
    }
    process.stdout.write(line + "\n");
  });

  return await new Promise((resolve) => {
    child.once("error", () => { record({ type: "proxy_spawn_error" }); });
    child.once("close", (code) => {
      input.close(); output.close();
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGINT", stop);
      record({ type: "proxy_exit", pid: process.pid, childPid: child.pid, code });
      process.exitCode = code ?? 1;
      resolve(code ?? 1);
    });
  });
}
