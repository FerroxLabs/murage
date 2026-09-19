import type { Message } from "@/state/store";

const FALLBACK_LABELS: Array<[RegExp, string]> = [
  [/\b(?:bash|shell|terminal|exec|command|run_command)\b/i, "Running a command"],
  [/\b(?:read|read_file|view|open_file)\b/i, "Reading a file"],
  [/\b(?:write|write_file|create_file)\b/i, "Writing a file"],
  [/\b(?:edit|apply_patch|replace|str_replace)\b/i, "Editing a file"],
  [/\b(?:web_search|search_web)\b/i, "Searching the web"],
  [/\b(?:web_fetch|fetch_url|read_page)\b/i, "Reading a page"],
  [/\b(?:grep|glob|find|search)\b/i, "Searching"],
  [/\b(?:screenshot|screen_capture)\b/i, "Looking at the screen"],
  [/\b(?:click|type|keypress|press|scroll|computer)\b/i, "Using the computer"],
  [/\b(?:open_url|navigate)\b/i, "Opening a page"],
  [/\b(?:list_bots|list_agents)\b/i, "Checking who's around"],
  [/\bdelegate_bot\b/i, "Handing off a task"],
  [/\b(?:ask_bot|send_message)\b/i, "Asking a teammate"],
];

function sentenceCase(value: string): string {
  const trimmed = value.trim().replace(/[.\s]+$/, "");
  if (!trimmed) return "Thinking";
  return `${trimmed[0].toUpperCase()}${trimmed.slice(1)}`;
}

/**
 * The one quiet line shown while an agent is working. This follows t3code's
 * live-activity model: thinking before a tool starts, then the current verb.
 * The server-provided narration is authoritative; fallbacks cover older
 * messages and third-party drivers that only report a tool name.
 */
export function liveActivityLabel(message?: Message): string {
  if (
    message?.kind !== "activity" ||
    !message.tool ||
    message.tool.ok !== undefined ||
    message.comm
  ) {
    return "Thinking";
  }

  if (message.tool.spoken?.trim()) return sentenceCase(message.tool.spoken);

  const toolName = message.tool.name.replace(/^mcp__[^_]+__/, "").split(":", 1)[0] ?? "";
  for (const [pattern, label] of FALLBACK_LABELS) {
    if (pattern.test(toolName)) return label;
  }
  return "Working";
}

/** What `liveActivityLabel` says when no tool is running and nothing is
 * waiting: the model is working on its own. */
export const THINKING_LABEL = "Thinking";

/** Whether the model is thinking right now: no answer text streaming and no
 * tool or wait to name instead. */
export function modelStillThinking(activityLabel: string, answering: boolean): boolean {
  return !answering && activityLabel === THINKING_LABEL;
}

/** The working line beside the mascot. One place says "Thinking" at a time:
 * while the live thinking row is shown and the model is still thinking, the
 * row carries it (with the elapsed time) and this line is empty; once answer
 * text streams, this says so instead of "Thinking". A running tool's verb or
 * a wait always wins. */
export function turnStatusLabel(activityLabel: string, state: { answering: boolean; thinkingRow: boolean }): string {
  if (activityLabel !== THINKING_LABEL) return activityLabel;
  if (state.answering) return "Answering";
  return state.thinkingRow ? "" : THINKING_LABEL;
}
