// Read a bot's reply aloud: what is read, how the control reads, and the
// toggle every reply bubble shares (1:1 chats, rooms, and the phone's action
// sheet), so the rules cannot drift between them.
//
// The speaker (src/lib/tts) is a window-wide singleton: speak() stops whatever
// was playing, so reading one message ends the last. A call starting stops it
// too (startCall in src/lib/call.ts calls speaker.stop()).
import type { Speaker } from "./tts";

/** Said once in place of every code block or tool output in a reply. */
export const CODE_OMITTED = "Code omitted.";

/** A fenced block (``` or ~~~, closed or running to the end) and tool output. */
const FENCED = /(^|\n)[ ]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ ]{0,3}\2(?:`|~)*[ \t]*(?=\n|$)|$)/g;
const TOOL_OUTPUT = /<(tool[_-](?:output|result))>[\s\S]*?(?:<\/\1>|$)/g;

const INDENTED = /^(?: {4}|\t)\S/;
const LIST_ITEM = /^\s{0,3}(?:[-*+]|\d+[.)])\s/;

/** Runs of 4-space or tab indented lines that open a block (start of the text
 *  or after a blank line, and not under a list item) are indented code. */
function omitIndentedCode(text: string, omit: () => string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const before = out.length ? out[out.length - 1] : "";
    const opens = INDENTED.test(lines[i]) && (out.length === 0 || before.trim() === "") && !listAbove(out);
    if (!opens) {
      out.push(lines[i]);
      i += 1;
      continue;
    }
    let end = i;
    // the block runs over indented lines and blank lines that lead to more
    for (let j = i; j < lines.length; j += 1) {
      if (INDENTED.test(lines[j])) end = j;
      else if (lines[j].trim() !== "") break;
    }
    out.push(omit());
    i = end + 1;
  }
  return out.join("\n");
}

/** Is the nearest non-blank line above a list item (so an indented line is its continuation)? */
function listAbove(out: string[]): boolean {
  for (let k = out.length - 1; k >= 0; k -= 1) {
    if (out[k].trim() === "") continue;
    return LIST_ITEM.test(out[k]) || /^\s+\S/.test(out[k]) && listAbove(out.slice(0, k));
  }
  return false;
}

/** The reply as it should be heard: prose in full, code and tool output left
 *  out (fenced or indented), with a single "Code omitted." wherever the first
 *  one was. */
export function readAloudText(text: string): string {
  let noted = false;
  const omit = (): string => {
    if (noted) return "";
    noted = true;
    return CODE_OMITTED;
  };
  const withoutFences = text.replace(TOOL_OUTPUT, () => omit()).replace(FENCED, (_match, lead: string) => lead + omit());
  return omitIndentedCode(withoutFences, omit)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Only a written reply is read: not an activity line, a card or a tool chip. */
export function canReadAloud(message: { kind?: string; text?: string }): boolean {
  return message.kind === "text" && Boolean(message.text?.trim());
}

export function readAloudLabel({ playing, ready }: { playing: boolean; ready: boolean }): string {
  if (playing) return "Stop";
  if (!ready) return "Pick a voice in this bot's settings to read aloud";
  return "Read aloud";
}

export interface ReadAloudTarget {
  text: string;
  botId?: string;
  messageId: string;
  /** The bot's own voice. */
  voiceId?: string;
}

/** True while this exact message is the one being read. */
export function isReading(speech: { status: string; messageId?: string }, messageId: string): boolean {
  return speech.status !== "idle" && speech.messageId === messageId;
}

/** Stop if this message is playing; otherwise read it (which stops any other). */
export function toggleReadAloud(sp: Pick<Speaker, "state" | "speak" | "stop">, target: ReadAloudTarget): void {
  if (isReading(sp.state, target.messageId)) return sp.stop();
  const spoken = readAloudText(target.text);
  if (!spoken) return;
  void sp.speak(spoken, { botId: target.botId, messageId: target.messageId, voiceId: target.voiceId });
}
