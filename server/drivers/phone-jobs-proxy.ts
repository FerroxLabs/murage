// Only scoped harness authority crosses into the model's MCP process.
// The phone-jobs MCP proxy (S13): lists exactly the phone tools the harness named in MURAGE_PHONE_TOOLS and forwards each call to
// /api/internal/device/call with the turn's `device` capability token. It decides nothing: the harness re-checks authority on every call.
import { request as httpRequest } from "node:http";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { createLineSplitter, writeMcpLine } from "../mcp-bridge.ts";
import { turnSecret, turnSecretWired } from "../turn-credential.ts";
import { PHONE_ACTIONS, PHONE_TOOL_NAMES, actionArgsSchema, type PhoneToolName } from "../../shared/phone-jobs-contract.ts";

const DESCRIPTIONS: Record<PhoneToolName, string> = {
  phone_calendar_read: "Read events from the owner's phone calendar between two times. The owner is asked on their phone each time.",
  phone_calendar_find_free_time: "Find free slots of a given length in the owner's phone calendar. The owner is asked on their phone each time.",
  phone_calendar_add: "Add an event to the owner's phone calendar. The owner is asked on their phone each time.",
  phone_calendar_change: "Change an event in the owner's phone calendar. The owner is asked on their phone each time.",
  phone_reminders_read: "Read the owner's phone reminders. The owner is asked on their phone each time.",
  phone_reminders_add: "Add a reminder on the owner's phone. The owner is asked on their phone each time.",
  phone_reminders_complete: "Mark a reminder on the owner's phone as done. The owner is asked on their phone each time.",
  phone_contacts_search: "Search the owner's phone contacts by name. The owner is asked on their phone each time.",
  phone_contacts_get: "Get one contact from the owner's phone by id. The owner is asked on their phone each time.",
  phone_location_get: "Get the owner's phone location. The owner is asked on their phone each time.",
  phone_alarm_set: "Set an alarm on the owner's phone. The owner is asked on their phone each time.",
  phone_timer_set: "Start a timer on the owner's phone. The owner is asked on their phone each time.",
  phone_text_compose: "Open a text message on the owner's phone for the owner to read and send. Nothing is sent for them.",
  phone_call_dial: "Open the owner's phone dialer with a number. The owner places the call.",
};

function inputSchemaOf(tool: PhoneToolName): Record<string, unknown> {
  try {
    const json = z.toJSONSchema(actionArgsSchema[PHONE_ACTIONS[tool].action], { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    delete json.$schema;
    return json;
  } catch {
    return { type: "object", additionalProperties: true };
  }
}

/** The tool names a launch asks for: the comma list, restricted to known tools, in catalog order, with no repeats. */
export function toolsFromEnv(value: string | undefined): PhoneToolName[] {
  const asked = new Set((value ?? "").split(",").map((name) => name.trim()).filter(Boolean));
  return PHONE_TOOL_NAMES.filter((name) => asked.has(name));
}

export function phoneToolDefinitions(names: readonly PhoneToolName[]): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return names.map((name) => ({ name, description: DESCRIPTIONS[name], inputSchema: inputSchemaOf(name) }));
}

/** One loopback POST with no clock; `signal` withdraws it. At most 4 MB back. */
function post(url: URL, token: string, body: string, signal: AbortSignal): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: "POST", signal, agent: false, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) { req.destroy(new Error("too large")); return; }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}

const UNAVAILABLE = "That phone tool is not available in this conversation.";

export async function runPhoneJobsProxy(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const base = new URL(env.MURAGE_CONTROL_URL!);
  if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || !turnSecretWired("MURAGE_CONTROL_TOKEN", env)) throw new Error("Missing phone authority");
  const url = new URL("/api/internal/device/call", base);
  const names = toolsFromEnv(env.MURAGE_PHONE_TOOLS);
  const tools = phoneToolDefinitions(names);
  const withdrawable = new Map<string, AbortController>();
  const key = (id: unknown) => JSON.stringify(id);
  const refusal = { isError: true, content: [{ type: "text", text: UNAVAILABLE }] };
  const call = async (rpc: { id: number | string; method?: string; params?: Record<string, unknown> }, withdrawn: AbortController) => {
    if (withdrawn.signal.aborted) return;
    let result: unknown;
    try {
      if (rpc.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "murage-phone-jobs", version: "1" } };
      else if (rpc.method === "ping") result = {};
      else if (rpc.method === "tools/list") result = { tools };
      else if (rpc.method === "tools/call") {
        const name = rpc.params?.name;
        // a name outside the launch's list never reaches the harness
        if (typeof name !== "string" || !names.includes(name as PhoneToolName)) result = refusal;
        else {
          const response = await post(url, turnSecret("MURAGE_CONTROL_TOKEN", env), JSON.stringify({ tool: name, args: rpc.params?.arguments ?? {} }), withdrawn.signal);
          const body = JSON.parse(response.body) as { ok?: unknown; text?: unknown };
          if (response.status !== 200 || typeof body.text !== "string") result = refusal;
          else result = { ...(body.ok === true ? {} : { isError: true }), content: [{ type: "text", text: body.text }] };
        }
      } else {
        await writeMcpLine(process.stdout, JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "method not found" } }));
        return;
      }
    } catch { result = refusal; }
    finally { if (withdrawable.get(key(rpc.id)) === withdrawn) withdrawable.delete(key(rpc.id)); }
    if (withdrawn.signal.aborted) return;
    await writeMcpLine(process.stdout, JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  };
  let queue = Promise.resolve();
  const splitter = createLineSplitter((line) => {
    let rpc: { id?: number | string; method?: string; params?: Record<string, unknown> };
    try { rpc = JSON.parse(line); } catch { return; }
    if (rpc.id === undefined) {
      if (rpc.method === "notifications/cancelled") withdrawable.get(key(rpc.params?.requestId))?.abort();
      return;
    }
    const withdrawn = new AbortController();
    withdrawable.set(key(rpc.id), withdrawn);
    const request = { ...rpc, id: rpc.id };
    queue = queue.then(() => call(request, withdrawn));
  }, 64 * 1024);
  for await (const chunk of process.stdin) splitter.push(chunk);
  splitter.flush();
  for (const withdrawn of withdrawable.values()) withdrawn.abort();
  await queue;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void runPhoneJobsProxy().catch(() => { process.exitCode = 1; });
