// Tool-calling test for one local server + model (0.1.52 LM1, spec T1).
//
// A TypeScript port of the SeanBeast probe (0152-LOCAL-MODELS-PROBE-SEANBEAST.md)
// with the same seven checks:
//   1 chat.auto            OpenAI chat, tool_choice auto
//   2 chat.required        OpenAI chat, tool_choice required
//   3 chat.stream          streamed tool_call deltas
//   4 chat.roundtrip       tool result goes back, model answers from it
//   5 chat.manyTools       41 tools (agent-sized schema)
//   6 messages.toolUse     Anthropic /v1/messages tool_use (Claude Code path)
//   7 responses.functionCall OpenAI /v1/responses function_call (Codex path)
// and one plain-language outcome instead of diagnostics.
//
// It runs no tool loop and never executes the tools it offers: the "tools"
// here are inert schemas and the round trip feeds back a canned result.
//
// Every request goes to the server's own `…/v1` base with `redirect: "error"`,
// so the key cannot be forwarded to another origin. Response bodies are read
// with a size cap, and no server text is copied into the result: checks carry
// codes only, so a hostile or chatty server cannot put anything into the UI.
import {
  AGENT_MIN_CONTEXT_TOKENS,
  AGENT_RECOMMENDED_CONTEXT_TOKENS,
  type LocalContextReading,
  type LocalServerKind,
  type LocalToolCheck,
  type LocalToolCheckDetail,
  type LocalToolCheckName,
  type LocalToolFix,
  type LocalToolTestOutcome,
  type LocalToolTestResult,
} from "../shared/local-models.ts";

export interface LocalToolProbeInput {
  serverId: string;
  kind: LocalServerKind;
  /** `…/v1` base. */
  apiBase: string;
  apiKey: string;
  model: string;
  /** Loaded-context reading taken just before the test, when known. */
  context?: LocalContextReading;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Per request. Local models can be slow on a cold load. */
  requestTimeoutMs?: number;
  now?: () => number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const MAX_BODY_BYTES = 1 << 20;
const MAX_STREAM_BYTES = 4 << 20;
const MAX_STREAM_EVENTS = 10_000;

const WEATHER = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string" }, unit: { type: "string", enum: ["c", "f"] } },
      required: ["city"],
    },
  },
} as const;

/** 40 realistic filler tools, so check 5 sends an agent-sized schema (41 tools). */
const FILLER = Array.from({ length: 40 }, (_, i) => ({
  type: "function",
  function: {
    name: `workspace_tool_${i}`,
    description: `Workspace operation ${i}: reads, lists, searches or updates project files and records. Use only when the user explicitly asks for workspace operation ${i}. Returns a JSON object describing the outcome, including status, affected paths, revision identifiers and any warnings produced during the operation.`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative path to operate on." },
        query: { type: "string", description: "Optional search expression or filter." },
        limit: { type: "integer", description: "Maximum number of results to return." },
        dry_run: { type: "boolean", description: "When true, report what would change without changing anything." },
      },
      required: ["path"],
    },
  },
}));

const USER_MESSAGE = { role: "user", content: "What's the weather in Paris right now? Use the tool, do not guess." };

type CallFailure = "network" | "timeout" | "redirect-refused";
type CallResult =
  | { kind: "answer"; status: number; ms: number; json: unknown; text: string }
  | { kind: "stream"; status: number; ms: number; events: unknown[]; text: string }
  | { kind: "failed"; ms: number; detail: CallFailure };

async function readCapped(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    text += decoder.decode(value, { stream: true });
    if (bytes >= limit) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return text + decoder.decode();
}

function parseSse(text: string): unknown[] {
  const events: unknown[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      events.push(JSON.parse(data) as unknown);
    } catch {
      // A partial or non-JSON frame is ignored, as the script did.
    }
    if (events.length >= MAX_STREAM_EVENTS) break;
  }
  return events;
}

function failureOf(error: unknown, timeout: AbortSignal): CallFailure {
  if (timeout.aborted) return "timeout";
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  const message = `${error instanceof Error ? error.message : String(error)} ${cause instanceof Error ? cause.message : String(cause ?? "")}`;
  return /redirect/i.test(message) ? "redirect-refused" : "network";
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** HTTP error → code, from status and body text; the text itself is dropped. */
function httpDetail(status: number, text: string): LocalToolCheckDetail {
  if (/exceed_context_size|maximum context length|context length|context window|n_ctx|too many tokens|prompt is too long/i.test(text)) {
    return "context-exceeded";
  }
  if (/model/i.test(text) && /not found|does not exist|no such|unknown model/i.test(text)) return "model-not-found";
  if (/does not support tools|tool|function call|jinja|auto-tool-choice|tool-call-parser|tool_choice/i.test(text)) {
    return "tools-rejected";
  }
  if (status === 404 || status === 405 || status === 501) return "no-endpoint";
  return "http-error";
}

function inBandError(events: unknown[]): string | null {
  for (const event of events) {
    const error = record(event)?.error;
    if (error) return typeof error === "string" ? error : JSON.stringify(error);
  }
  return null;
}

interface ToolCallRead {
  pass: boolean;
  detail: LocalToolCheckDetail;
  argumentsType?: "string" | "object";
}

function readArguments(raw: unknown): { args: Record<string, unknown> | null; type?: "string" | "object" } {
  if (typeof raw === "string") {
    try {
      return { args: record(JSON.parse(raw)), type: "string" };
    } catch {
      return { args: null, type: "string" };
    }
  }
  return { args: record(raw), type: record(raw) ? "object" : undefined };
}

function checkWeatherCall(name: unknown, rawArguments: unknown): ToolCallRead {
  const { args, type } = readArguments(rawArguments);
  if (!args) return { pass: false, detail: "bad-arguments", ...(type ? { argumentsType: type } : {}) };
  const pass = name === "get_weather" && /paris/i.test(typeof args.city === "string" ? args.city : "");
  return { pass, detail: pass ? "ok" : "wrong-tool-call", ...(type ? { argumentsType: type } : {}) };
}

function chatToolCall(json: unknown): { read: ToolCallRead; call: Record<string, unknown> | null } {
  const choices = record(json)?.choices;
  const message = record(Array.isArray(choices) ? record(choices[0])?.message : null);
  const calls = message?.tool_calls;
  const call = Array.isArray(calls) ? record(calls[0]) : null;
  if (!call) return { read: { pass: false, detail: "text-instead-of-tool" }, call: null };
  const fn = record(call.function);
  return { read: checkWeatherCall(fn?.name, fn?.arguments), call };
}

function chatText(json: unknown): { text: string; hasToolCalls: boolean } {
  const choices = record(json)?.choices;
  const message = record(Array.isArray(choices) ? record(choices[0])?.message : null);
  const calls = message?.tool_calls;
  return {
    text: typeof message?.content === "string" ? message.content : "",
    hasToolCalls: Array.isArray(calls) && calls.length > 0,
  };
}

export async function runLocalToolProbe(input: LocalToolProbeInput): Promise<LocalToolTestResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const started = now();
  const base = input.apiBase.replace(/\/+$/, "");
  const checks: LocalToolCheck[] = [];

  const call = async (path: string, body: unknown, stream = false): Promise<CallResult> => {
    const t0 = now();
    const timeout = AbortSignal.timeout(input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
    const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetchImpl(base + path, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${input.apiKey}`,
          "x-api-key": input.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (input.signal?.aborted) throw error;
      return { kind: "failed", ms: now() - t0, detail: failureOf(error, timeout) };
    }
    try {
      const text = await readCapped(response, stream ? MAX_STREAM_BYTES : MAX_BODY_BYTES);
      if (stream && response.ok) return { kind: "stream", status: response.status, ms: now() - t0, events: parseSse(text), text };
      let json: unknown = null;
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        json = null;
      }
      return { kind: "answer", status: response.status, ms: now() - t0, json, text };
    } catch (error) {
      if (input.signal?.aborted) throw error;
      return { kind: "failed", ms: now() - t0, detail: failureOf(error, timeout) };
    }
  };

  const push = (name: LocalToolCheckName, result: CallResult, read?: ToolCallRead, extra: Partial<LocalToolCheck> = {}) => {
    if (result.kind === "failed") {
      checks.push({ name, status: "fail", detail: result.detail, ms: result.ms });
      return;
    }
    if (result.status < 200 || result.status >= 300) {
      checks.push({ name, status: "fail", detail: httpDetail(result.status, result.text), httpStatus: result.status, ms: result.ms });
      return;
    }
    const verdict = read ?? { pass: false, detail: "http-error" as const };
    checks.push({
      name,
      status: verdict.pass ? "pass" : "fail",
      detail: verdict.detail,
      httpStatus: result.status,
      ms: result.ms,
      ...(verdict.argumentsType ? { argumentsType: verdict.argumentsType } : {}),
      ...extra,
    });
  };

  const model = input.model;

  // 1. OpenAI chat, non-streaming, tool_choice auto
  const auto = await call("/chat/completions", { model, messages: [USER_MESSAGE], tools: [WEATHER], tool_choice: "auto" });
  const autoCall = auto.kind === "answer" && auto.status === 200 ? chatToolCall(auto.json) : null;
  push("chat.auto", auto, autoCall?.read);
  const firstCall = autoCall?.call ?? null;

  // 2. tool_choice required
  const required = await call("/chat/completions", {
    model,
    messages: [{ role: "user", content: "Tell me about Paris weather." }],
    tools: [WEATHER],
    tool_choice: "required",
  });
  push("chat.required", required, required.kind === "answer" && required.status === 200 ? chatToolCall(required.json).read : undefined);

  // 3. streaming tool call deltas (Ollama sends whole calls in one chunk, LM
  //    Studio and llama.cpp send argument pieces; both concatenate the same)
  const streamed = await call("/chat/completions", { model, stream: true, messages: [USER_MESSAGE], tools: [WEATHER] }, true);
  let streamRead: ToolCallRead | undefined;
  if (streamed.kind === "stream") {
    const bandError = inBandError(streamed.events);
    if (bandError) {
      streamRead = { pass: false, detail: httpDetail(200, bandError) };
    } else {
      let name = "";
      let args = "";
      for (const event of streamed.events) {
        const choices = record(event)?.choices;
        const delta = record(Array.isArray(choices) ? record(choices[0])?.delta : null);
        const calls = delta?.tool_calls;
        if (!Array.isArray(calls)) continue;
        for (const piece of calls) {
          const fn = record(record(piece)?.function);
          if (typeof fn?.name === "string") name += fn.name;
          if (typeof fn?.arguments === "string") args += fn.arguments;
          else if (record(fn?.arguments)) args += JSON.stringify(fn!.arguments);
        }
      }
      streamRead = name || args ? checkWeatherCall(name, args) : { pass: false, detail: "text-instead-of-tool" };
    }
  }
  push("chat.stream", streamed, streamRead);

  // 4. tool result round trip
  if (firstCall) {
    const fn = record(firstCall.function) ?? {};
    const replayed = {
      ...firstCall,
      type: "function",
      function: { ...fn, arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}) },
    };
    const callId = typeof firstCall.id === "string" && firstCall.id ? firstCall.id : "call_murage_probe";
    const roundTrip = await call("/chat/completions", {
      model,
      tools: [WEATHER],
      messages: [
        USER_MESSAGE,
        { role: "assistant", content: null, tool_calls: [{ ...replayed, id: callId }] },
        { role: "tool", tool_call_id: callId, content: JSON.stringify({ city: "Paris", temp_c: 17, conditions: "light rain" }) },
      ],
    });
    let read: ToolCallRead | undefined;
    if (roundTrip.kind === "answer" && roundTrip.status === 200) {
      const { text, hasToolCalls } = chatText(roundTrip.json);
      const pass = /17|rain/i.test(text) && !hasToolCalls;
      read = { pass, detail: pass ? "ok" : hasToolCalls ? "wrong-tool-call" : "text-instead-of-tool" };
    }
    push("chat.roundtrip", roundTrip, read);
  } else {
    checks.push({ name: "chat.roundtrip", status: "skipped", detail: "no-first-call" });
  }

  // 5. large tool schema (41 tools)
  const many = await call("/chat/completions", { model, messages: [USER_MESSAGE], tools: [...FILLER, WEATHER] });
  const manyUsage = many.kind === "answer" ? record(record(many.json)?.usage) : null;
  const promptTokens = typeof manyUsage?.prompt_tokens === "number" ? manyUsage.prompt_tokens : undefined;
  push(
    "chat.manyTools",
    many,
    many.kind === "answer" && many.status === 200 ? chatToolCall(many.json).read : undefined,
    promptTokens !== undefined ? { promptTokens } : {},
  );

  // 6. Anthropic Messages API with tools (Claude Code path)
  const messages = await call("/messages", {
    model,
    max_tokens: 1024,
    messages: [USER_MESSAGE],
    tools: [{ name: "get_weather", description: WEATHER.function.description, input_schema: WEATHER.function.parameters }],
  });
  let messagesRead: ToolCallRead | undefined;
  if (messages.kind === "answer" && messages.status === 200) {
    const content = record(messages.json)?.content;
    const toolUse = Array.isArray(content) ? content.map(record).find((block) => block?.type === "tool_use") : null;
    messagesRead = toolUse ? checkWeatherCall(toolUse.name, toolUse.input) : { pass: false, detail: "text-instead-of-tool" };
  }
  push("messages.toolUse", messages, messagesRead);

  // 7. OpenAI Responses API with function tools (Codex path)
  const responses = await call("/responses", {
    model,
    input: USER_MESSAGE.content,
    tools: [{ type: "function", name: "get_weather", description: WEATHER.function.description, parameters: WEATHER.function.parameters }],
  });
  let responsesRead: ToolCallRead | undefined;
  if (responses.kind === "answer" && responses.status === 200) {
    const output = record(responses.json)?.output;
    const fnCall = Array.isArray(output) ? output.map(record).find((item) => item?.type === "function_call") : null;
    // Same bar as the SeanBeast script: the right function was called.
    responsesRead = fnCall
      ? { pass: fnCall.name === "get_weather", detail: fnCall.name === "get_weather" ? "ok" : "wrong-tool-call" }
      : { pass: false, detail: "text-instead-of-tool" };
  }
  push("responses.functionCall", responses, responsesRead);

  const { outcome, fix } = classifyLocalToolTest(checks, input.kind, input.context);
  const byName = new Map(checks.map((check) => [check.name, check]));
  return {
    serverId: input.serverId,
    apiBase: base,
    model,
    outcome,
    checks,
    surfaces: {
      chat: byName.get("chat.auto")?.status === "pass",
      responses: byName.get("responses.functionCall")?.status === "pass",
      messages: byName.get("messages.toolUse")?.status === "pass",
    },
    ...(input.context ? { context: input.context } : {}),
    ...(fix ? { fix } : {}),
    testedAt: started,
    durationMs: now() - started,
  };
}

const UNREACHABLE: ReadonlySet<LocalToolCheckDetail> = new Set(["network", "timeout", "redirect-refused"]);

function contextFix(kind: LocalServerKind): LocalToolFix {
  const target = AGENT_RECOMMENDED_CONTEXT_TOKENS;
  switch (kind) {
    case "ollama":
      return { kind: "ollama-context-copy", value: `OLLAMA_CONTEXT_LENGTH=${target}` };
    case "llamacpp":
      return { kind: "server-flag", value: `-c ${target}` };
    case "vllm":
      return { kind: "server-flag", value: `--max-model-len ${target}` };
    case "sglang":
      return { kind: "server-flag", value: `--context-length ${target}` };
    default:
      return { kind: "raise-context", value: String(target) };
  }
}

function toolsFix(kind: LocalServerKind): LocalToolFix | undefined {
  switch (kind) {
    case "llamacpp":
      return { kind: "server-flag", value: "--jinja" };
    case "vllm":
      return { kind: "server-flag", value: "--enable-auto-tool-choice --tool-call-parser <parser>" };
    case "sglang":
      return { kind: "server-flag", value: "--tool-call-parser <parser>" };
    case "ollama":
    case "lmstudio":
      return { kind: "pick-tool-model" };
    default:
      return undefined;
  }
}

/** The one plain outcome for a set of checks. Exported for tests. */
export function classifyLocalToolTest(
  checks: readonly LocalToolCheck[],
  kind: LocalServerKind,
  context?: LocalContextReading,
): { outcome: LocalToolTestOutcome; fix?: LocalToolFix } {
  const byName = new Map(checks.map((check) => [check.name, check]));
  const pass = (name: LocalToolCheckName) => byName.get(name)?.status === "pass";
  const detail = (name: LocalToolCheckName) => byName.get(name)?.detail;

  const answered = checks.some((check) => check.status !== "skipped" && !UNREACHABLE.has(check.detail));
  if (!answered) return { outcome: "unreachable" };
  if (detail("chat.auto") === "model-not-found") return { outcome: "model-not-found" };
  const window = context?.contextWindow;
  const overflowed = checks.some((check) => check.detail === "context-exceeded");
  if ((window !== undefined && window < AGENT_MIN_CONTEXT_TOKENS) || overflowed) {
    return { outcome: "context-too-small", fix: contextFix(kind) };
  }
  const coreChat: LocalToolCheckName[] = ["chat.auto", "chat.stream", "chat.roundtrip", "chat.manyTools"];
  if (coreChat.every(pass)) return { outcome: "tools-work" };
  if (pass("chat.auto") || pass("chat.required") || pass("chat.stream")) return { outcome: "tools-partial" };
  const autoDetail = detail("chat.auto");
  if (autoDetail === "text-instead-of-tool" || autoDetail === "wrong-tool-call" || autoDetail === "bad-arguments") {
    const fix = kind === "llamacpp" ? toolsFix(kind) : { kind: "pick-tool-model" as const };
    return { outcome: "text-instead-of-tools", ...(fix ? { fix } : {}) };
  }
  const fix = toolsFix(kind);
  return { outcome: "server-rejects-tools", ...(fix ? { fix } : {}) };
}
