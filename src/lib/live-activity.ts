import type { Message } from "@/state/store";
import { delegationToolKind } from "../../shared/delegation-tool";

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
  // A hand-off is never a file or command, whatever the engine calls it.
  const delegation = delegationToolKind(toolName);
  if (delegation) return delegation === "delegate" ? "Handing off a task" : delegation === "ask" ? "Asking a teammate" : "Messaging a teammate";
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

/** Other ways to say the same working label. The key is the engine-neutral
 * label (it comes from the tool's class, not from any one engine's event
 * names), so every engine rotates alike. Text the server narrates itself is
 * not in this table, so it is never reworded. */
const ALTERNATES: Record<string, string[]> = {
  Thinking: ["Working it out", "Weighing it up", "Mulling it over"],
  Working: ["Getting on with it", "On it", "Making progress"],
  Answering: ["Writing it up", "Putting it together"],
  "Running a command": ["Running it", "Waiting on the command", "Checking what it prints"],
  "Reading a file": ["Looking through the file", "Reading it over", "Taking in the file"],
  "Writing a file": ["Putting the file together", "Saving the words", "Drafting the file"],
  "Editing a file": ["Making the change", "Tidying the file", "Working on the edit"],
  "Searching the web": ["Looking around the web", "Following leads", "Searching the web"],
  "Reading a page": ["Reading the page", "Taking in the page", "Skimming it"],
  Searching: ["Looking around", "Hunting it down", "Following the trail"],
  "Looking at the screen": ["Taking in the screen", "Checking the display", "Seeing what is there"],
  "Using the computer": ["Working the screen", "Clicking around", "Driving the desktop"],
  "Opening a page": ["Loading the page", "Heading there", "Opening it up"],
};

/** The phrases a working label may rotate through; the first is the label itself. */
export function liveActivityPhrases(label: string): string[] {
  const alternates = Object.hasOwn(ALTERNATES, label) ? ALTERNATES[label]! : [];
  return [...new Set([label, ...alternates])];
}

/** Which phrase shows after `ticks` rotations. */
export function phraseAt(phrases: string[], ticks: number): string {
  if (phrases.length === 0) return "";
  return phrases[((ticks % phrases.length) + phrases.length) % phrases.length]!;
}

export const PHRASE_ROTATE_MS = 7000;
