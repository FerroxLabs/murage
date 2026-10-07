// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure request/response shaping for the plan sign-in gateway.
//
// The ChatGPT plan backend (chatgpt.com/backend-api/codex, the endpoint
// Wayland and the Codex CLI use) speaks only the Responses API, streamed, with
// store off. Engines that speak chat completions (Qwen, Hermes, Grok API,
// Grok Build, OpenAI-compatible) reach it through the translation below; the
// Responses engines (Fuigo, Codex) get their body normalized. Wayland's note
// on that seam: `input`/`instructions`, `store:false`, stream, strip
// `max_output_tokens` (chatgptOAuth.ts, registerChatGptSubscription).

type Json = Record<string, unknown>;
const record = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const DEFAULT_INSTRUCTIONS = "You are a helpful assistant.";

/** Fields the plan backend refuses or that make no sense with store off. */
const RESPONSES_DROPPED = ["max_output_tokens", "max_tokens", "temperature", "top_p", "top_logprobs", "truncation", "metadata", "user", "safety_identifier", "previous_response_id", "background", "prompt_cache_retention", "conversation"];

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => record(part) && typeof part.text === "string" ? part.text : "").filter(Boolean).join("\n");
}

/** Normalize a Responses body for the ChatGPT plan backend. Returns the body
 * to send and whether the caller wanted a stream back. */
export function normalizeResponsesBody(body: Json): { request: Json; wantStream: boolean } {
  const wantStream = body.stream === true;
  const request: Json = { ...body };
  for (const field of RESPONSES_DROPPED) delete request[field];
  let input: unknown[] = typeof request.input === "string"
    ? [{ type: "message", role: "user", content: [{ type: "input_text", text: request.input }] }]
    : Array.isArray(request.input) ? [...request.input] : [];
  // The backend needs `instructions`; system turns become them.
  const system: string[] = [];
  input = input.filter(item => {
    if (record(item) && (item.type === "message" || item.type === undefined) && item.role === "system") { const words = textOf(item.content); if (words) system.push(words); return false; }
    return true;
  });
  const given = typeof request.instructions === "string" ? request.instructions.trim() : "";
  request.instructions = [given, ...system].filter(Boolean).join("\n\n") || DEFAULT_INSTRUCTIONS;
  // With store off the backend keeps nothing, so a replayed item that names
  // a stored id ("rs_...", "msg_...", "fc_...") is refused. Replay by content,
  // as the Codex CLI does: drop the ids, and drop reasoning items that carry
  // no encrypted content to replay.
  input = input.flatMap(item => {
    if (!record(item)) return [item];
    if (item.type === "item_reference") return [];
    if (item.type === "reasoning" && typeof item.encrypted_content !== "string") return [];
    const { id: _id, ...rest } = item;
    return [rest];
  });
  request.input = input;
  // Fuigo always asks for a "concise" reasoning summary, which GPT-5 family
  // models refuse; "auto" is what the Codex CLI sends.
  if (record(request.reasoning)) {
    const reasoning: Json = { ...request.reasoning };
    if (reasoning.summary === "concise") reasoning.summary = "auto";
    request.reasoning = reasoning;
    const include = Array.isArray(request.include) ? request.include.filter(entry => typeof entry === "string") : [];
    if (!include.includes("reasoning.encrypted_content")) request.include = [...include, "reasoning.encrypted_content"];
  }
  request.store = false;
  request.stream = true;
  return { request, wantStream };
}

/** Chat completions request to a Responses request. */
export function chatToResponses(body: Json): { request: Json; wantStream: boolean; includeUsage: boolean; model: string } {
  const model = typeof body.model === "string" ? body.model : "";
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const instructions: string[] = [];
  const input: Json[] = [];
  for (const message of messages) {
    if (!record(message)) continue;
    const role = message.role;
    if (role === "system" || role === "developer") { const words = textOf(message.content); if (words) instructions.push(words); continue; }
    if (role === "tool") {
      input.push({ type: "function_call_output", call_id: String(message.tool_call_id ?? ""), output: typeof message.content === "string" ? message.content : textOf(message.content) });
      continue;
    }
    if (role === "assistant") {
      const words = textOf(message.content);
      if (words) input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: words }] });
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        if (!record(call) || !record(call.function)) continue;
        input.push({ type: "function_call", call_id: String(call.id ?? ""), name: String(call.function.name ?? ""), arguments: typeof call.function.arguments === "string" ? call.function.arguments : JSON.stringify(call.function.arguments ?? {}) });
      }
      continue;
    }
    // user (and anything unknown, read as the user's words)
    const parts: Json[] = [];
    if (typeof message.content === "string") parts.push({ type: "input_text", text: message.content });
    else if (Array.isArray(message.content)) for (const part of message.content) {
      if (!record(part)) continue;
      if (part.type === "text" && typeof part.text === "string") parts.push({ type: "input_text", text: part.text });
      else if (part.type === "image_url") {
        const url = record(part.image_url) ? part.image_url.url : part.image_url;
        if (typeof url === "string") parts.push({ type: "input_image", image_url: url, ...(record(part.image_url) && typeof part.image_url.detail === "string" ? { detail: part.image_url.detail } : {}) });
      }
    }
    if (parts.length) input.push({ type: "message", role: "user", content: parts });
  }
  const request: Json = { model, instructions: instructions.join("\n\n") || DEFAULT_INSTRUCTIONS, input, store: false, stream: true };
  const tools = (Array.isArray(body.tools) ? body.tools : []).flatMap(tool => record(tool) && tool.type === "function" && record(tool.function)
    ? [{ type: "function", name: tool.function.name, ...(typeof tool.function.description === "string" ? { description: tool.function.description } : {}), parameters: record(tool.function.parameters) ? tool.function.parameters : { type: "object", properties: {} }, strict: tool.function.strict === true }]
    : []);
  if (tools.length) {
    request.tools = tools;
    const choice = body.tool_choice;
    request.tool_choice = typeof choice === "string" ? choice : record(choice) && record(choice.function) ? { type: "function", name: choice.function.name } : "auto";
    if (typeof body.parallel_tool_calls === "boolean") request.parallel_tool_calls = body.parallel_tool_calls;
  }
  if (typeof body.reasoning_effort === "string" && body.reasoning_effort !== "none") request.reasoning = { effort: body.reasoning_effort };
  const format = record(body.response_format) ? body.response_format : null;
  if (format?.type === "json_schema" && record(format.json_schema)) request.text = { format: { type: "json_schema", name: format.json_schema.name ?? "response", schema: format.json_schema.schema ?? {}, strict: format.json_schema.strict === true } };
  else if (format?.type === "json_object") request.text = { format: { type: "json_object" } };
  return { request, wantStream: body.stream === true, includeUsage: record(body.stream_options) && body.stream_options.include_usage === true, model };
}

/** Parse Server-Sent Events text incrementally. */
export function createSseParser(onEvent: (data: Json) => void): { push(chunk: string): void; end(): void } {
  let buffer = "";
  const flush = (block: string) => {
    const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data || data === "[DONE]") return;
    try { const parsed = JSON.parse(data); if (record(parsed)) onEvent(parsed); } catch { /* a keep-alive or a torn frame */ }
  };
  return {
    push(chunk) {
      buffer += chunk;
      let index: number;
      while ((index = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(buffer.slice(index).match(/^\r?\n\r?\n/)![0].length + index);
        flush(block);
      }
    },
    end() { if (buffer.trim()) flush(buffer); buffer = ""; },
  };
}

type ChatUsage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };
function chatUsage(usage: unknown): ChatUsage | undefined {
  if (!record(usage)) return undefined;
  const prompt = Number(usage.input_tokens ?? 0), completion = Number(usage.output_tokens ?? 0);
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: Number(usage.total_tokens ?? prompt + completion) };
}

export class UpstreamStreamError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) { super(message); this.code = code; }
}
function failure(event: Json): UpstreamStreamError {
  const error = record(event.response) && record(event.response.error) ? event.response.error : record(event.error) ? event.error : event;
  return new UpstreamStreamError(typeof error.message === "string" ? error.message : "The model service ended the answer with an error.", typeof error.code === "string" ? error.code : undefined);
}

/** Responses stream events to chat completion chunks, one event at a time. */
export function createChatStreamTranslator(model: string, id: string, created: number, includeUsage: boolean) {
  const tools = new Map<string, { index: number; argsSent: boolean }>();
  let started = false, finished = false;
  const chunk = (delta: Json, finish: string | null = null, extra: Json = {}) => ({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
  const keyOf = (event: Json) => String(event.item_id ?? (record(event.item) ? event.item.id : undefined) ?? event.output_index ?? "");
  return {
    /** Chunks to emit for this event. Throws UpstreamStreamError on a failed answer. */
    push(event: Json): Json[] {
      const out: Json[] = [];
      if (!started) { started = true; out.push(chunk({ role: "assistant", content: "" })); }
      const type = event.type;
      if (type === "response.output_text.delta" && typeof event.delta === "string") out.push(chunk({ content: event.delta }));
      else if (type === "response.output_item.added" && record(event.item) && event.item.type === "function_call") {
        const index = tools.size;
        tools.set(keyOf(event), { index, argsSent: false });
        if (event.item.id !== undefined && String(event.item.id) !== keyOf(event)) tools.set(String(event.item.id), tools.get(keyOf(event))!);
        out.push(chunk({ tool_calls: [{ index, id: String(event.item.call_id ?? event.item.id ?? `call_${index}`), type: "function", function: { name: String(event.item.name ?? ""), arguments: "" } }] }));
      } else if (type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
        const tool = tools.get(keyOf(event)) ?? tools.get(String(event.output_index ?? ""));
        if (tool) { tool.argsSent = true; out.push(chunk({ tool_calls: [{ index: tool.index, function: { arguments: event.delta } }] })); }
      } else if (type === "response.output_item.done" && record(event.item) && event.item.type === "function_call") {
        const tool = tools.get(keyOf(event));
        if (tool && !tool.argsSent && typeof event.item.arguments === "string" && event.item.arguments) { tool.argsSent = true; out.push(chunk({ tool_calls: [{ index: tool.index, function: { arguments: event.item.arguments } }] })); }
      } else if (type === "response.completed" || type === "response.incomplete") {
        finished = true;
        const usage = record(event.response) ? chatUsage(event.response.usage) : undefined;
        const reason = tools.size ? "tool_calls" : type === "response.incomplete" ? "length" : "stop";
        out.push(chunk({}, reason, includeUsage && usage ? { usage } : {}));
      } else if (type === "response.failed" || type === "error") throw failure(event);
      return out;
    },
    get finished() { return finished; },
  };
}

/** Collect a whole Responses stream into the final response object. */
export function collectResponse(events: Json[]): Json {
  const items: Json[] = [];
  let completed: Json | null = null;
  for (const event of events) {
    if (event.type === "response.output_item.done" && record(event.item)) items.push(event.item);
    else if ((event.type === "response.completed" || event.type === "response.incomplete") && record(event.response)) completed = event.response;
    else if (event.type === "response.failed" || event.type === "error") throw failure(event);
  }
  if (!completed) throw new UpstreamStreamError("The model service stopped before the answer finished.");
  const output = Array.isArray(completed.output) && completed.output.length ? completed.output : items;
  return { ...completed, output };
}

/** A collected Responses answer as one chat completion. */
export function responseToChatCompletion(response: Json, model: string, id: string, created: number): Json {
  let content = "";
  const toolCalls: Json[] = [];
  for (const item of Array.isArray(response.output) ? response.output : []) {
    if (!record(item)) continue;
    if (item.type === "message" && Array.isArray(item.content)) content += item.content.map(part => record(part) && part.type === "output_text" && typeof part.text === "string" ? part.text : "").join("");
    else if (item.type === "function_call") toolCalls.push({ id: String(item.call_id ?? item.id ?? `call_${toolCalls.length}`), type: "function", function: { name: String(item.name ?? ""), arguments: typeof item.arguments === "string" ? item.arguments : "{}" } });
  }
  const usage = chatUsage(response.usage);
  return {
    id, object: "chat.completion", created, model,
    choices: [{ index: 0, message: { role: "assistant", content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls.length ? "tool_calls" : response.status === "incomplete" ? "length" : "stop" }],
    ...(usage ? { usage } : {}),
  };
}

/** The ChatGPT Responses stream, passed through block by block. Everything is
 * forwarded as it arrives, except that a `response.completed` carrying an empty
 * `output` gets the items this stream already finished
 * (`response.output_item.done`), as `collectResponse` does: engines that build
 * the reply from the completed response alone would otherwise read an empty
 * answer. A stream that ends with no terminal event gets an explicit
 * `response.failed` instead of a clean end, so the engine sees why. */
export function createResponsesPassthrough(write: (text: string) => void): { push(chunk: string): void; end(): void } {
  const items: Json[] = [];
  let buffer = "", terminal = false, seq = -1;
  const meta: Json = {};
  const fail = () => {
    terminal = true;
    const response = {
      id: typeof meta.id === "string" ? meta.id : "resp_upstream_ended",
      object: typeof meta.object === "string" ? meta.object : "response",
      created_at: typeof meta.created_at === "number" ? meta.created_at : Math.floor(Date.now() / 1000),
      model: typeof meta.model === "string" ? meta.model : "unknown",
      status: "failed",
      output: items,
      error: { code: "upstream_stream_ended", message: "The model service stopped before the answer finished." },
    };
    write(`event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", sequence_number: seq + 1, response })}\n\n`);
    seq += 1;
  };
  const forward = (block: string) => {
    const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
    let event: Json | null = null;
    if (data && data !== "[DONE]") { try { const parsed = JSON.parse(data); if (record(parsed)) event = parsed; } catch { event = null; } }
    if (data === "[DONE]" && !terminal) fail();
    if (event) {
      const type = event.type;
      if (typeof event.sequence_number === "number" && event.sequence_number > seq) seq = event.sequence_number;
      if (record(event.response)) for (const key of ["id", "object", "created_at", "model"]) if (event.response[key] !== undefined) meta[key] = event.response[key];
      if (type === "response.output_item.done" && record(event.item)) items.push(event.item);
      if (type === "response.completed" || type === "response.incomplete" || type === "response.failed" || type === "error") terminal = true;
      if ((type === "response.completed" || type === "response.incomplete") && record(event.response)
        && !(Array.isArray(event.response.output) && event.response.output.length) && items.length) {
        const rewritten = { ...event, response: { ...event.response, output: items } };
        const head = block.split(/\r?\n/).filter(line => !line.startsWith("data:"));
        write(`${[...head, `data: ${JSON.stringify(rewritten)}`].filter(line => line !== "").join("\n")}\n\n`);
        return;
      }
    }
    write(`${block}\n\n`);
  };
  return {
    push(chunk: string) {
      buffer += chunk;
      for (;;) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match) break;
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (block.trim()) forward(block);
      }
    },
    end() {
      // A tail with no closing blank line counts only when it is a whole JSON
      // event (or [DONE]); a cut-off fragment is dropped, never forwarded.
      const tail = buffer.trim();
      buffer = "";
      if (tail) {
        const data = tail.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
        let whole = data === "[DONE]";
        if (!whole && data) { try { whole = record(JSON.parse(data)); } catch { whole = false; } }
        if (whole) forward(tail);
      }
      if (!terminal) fail();
    },
  };
}
