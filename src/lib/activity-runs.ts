// Grouping a transcript's tool chips into runs.
//
// A bot working through a task emits one chip per tool call, and a long
// stretch of them buries the thing you actually came to read: what the bot
// SAID. Consecutive finished steps fold into a single row that names them;
// text between two stretches breaks the run, so the bot's words always
// separate one run from the next.
import type { Message } from "@/state/store";

export type TranscriptItem =
  | { kind: "message"; message: Message }
  | { kind: "run"; id: string; messages: Message[] };

/** A step that may be folded away: finished, a real tool, and not a
 * bot⇄bot chip (those are navigation, not work) or a failed turn (that
 * renders as an error). A step still running stays out, so live progress
 * is never hidden behind a fold. */
function foldable(message: Message): boolean {
  const tool = message.tool;
  if (message.kind !== "activity" || !tool) return false;
  if (message.comm) return false;
  if (tool.ok !== true) return false;
  return !tool.name.startsWith("error:");
}

export function groupActivityRuns(messages: Message[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let run: Message[] = [];
  const flush = () => {
    // one step on its own is cheaper to read than a fold that hides it
    if (run.length > 1) items.push({ kind: "run", id: `run:${run[0].id}`, messages: run });
    else for (const message of run) items.push({ kind: "message", message });
    run = [];
  };
  for (const message of messages) {
    if (foldable(message)) {
      const first = run[0];
      if (
        first &&
        (first.role !== message.role ||
          first.from?.botId !== message.from?.botId ||
          new Date(first.at).toDateString() !== new Date(message.at).toDateString())
      ) {
        flush();
      }
      run.push(message);
      continue;
    }
    flush();
    items.push({ kind: "message", message });
  }
  flush();
  return items;
}

const MAX_NAMES = 3;

/** The one line a folded run has to earn its place with: how much work it
 * was, which tools did it, and whether anything failed — the last being the
 * only reason you would open it. */
export function describeRun(messages: Message[]): string {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const name = message.tool?.name ?? "";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const names = [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));
  const shown = names.slice(0, MAX_NAMES).join(", ");
  const rest = names.length > MAX_NAMES ? ` +${names.length - MAX_NAMES} more` : "";
  const failed = messages.filter((message) => message.tool?.ok === false).length;
  return `${messages.length} steps · ${shown}${rest}${failed ? ` · ${failed} failed` : ""}`;
}
