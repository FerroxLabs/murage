type ToolCall = {
  id: string;
  type: string;
  function: { name: string; arguments: string };
};

type AssistantMessage = {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
};

// Kept deterministic so a fixture can assert its whole HTTP envelope.
export function fakeLlamaCompletion(message: AssistantMessage, finishReason: "stop" | "tool_calls", model: string, usage?: { prompt_tokens: number }) {
  return {
    id: "chatcmpl-fake",
    object: "chat.completion",
    created: 0,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

export function fakeLlamaToolStream(toolCall: ToolCall, model: string) {
  return [
    {
      id: "chatcmpl-fake",
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...toolCall }] }, finish_reason: null }],
    },
    {
      id: "chatcmpl-fake",
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
  ];
}
