import { hostStoppedReason } from "../../shared/host-stop.ts";
import { folderTrustDisplayName } from "../../shared/folder-trust.ts";

/** The persisted message fields this pure projection needs. Keeping this
 * structural avoids pulling the renderer's TSX store into server tests. */
export interface TimelineMessage {
  id: string;
  role: "bot" | "user";
  kind: "text" | "options" | "activity" | "screen" | "connector" | "secret" | "routine.run" | "goal.run";
  text?: string;
  tool?: { name: string; ok?: boolean };
  png?: string;
  at: number;
}

export interface TimelineEvent {
  id: string;
  at: number;
  label: string;
  state: "running" | "complete" | "failed" | "observed";
  kind: "task" | "tool" | "screen" | "result";
}

/** Turn an already-persisted transcript into a compact, honest timeline. It
 * deliberately derives only from events the harness has recorded — this UI
 * never guesses that an action or result happened. */
export function timelineEvents(messages: TimelineMessage[]): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  let sawUserInput = false;
  for (const message of messages) {
    if (message.kind === "text" && message.role === "user" && message.text?.trim()) {
      events.push({
        id: message.id,
        at: message.at,
        label: sawUserInput ? "User input" : "Task started",
        state: "observed",
        kind: "task",
      });
      sawUserInput = true;
    } else if (message.kind === "activity" && message.tool) {
      // a host stop is neither a tool run nor a failure: the harness observed
      // the turn end, and says why — the neutral dot, never the red one
      const stoppedReason = hostStoppedReason(message.tool.name);
      if (stoppedReason) {
        events.push({ id: message.id, at: message.at, label: `Stopped — ${stoppedReason}`, state: "observed", kind: "tool" });
        continue;
      }
      // a folder-trust notice is observed the same way: not a run, not a failure
      const trustNotice = folderTrustDisplayName(message.tool.name);
      if (trustNotice) {
        events.push({ id: message.id, at: message.at, label: trustNotice, state: "observed", kind: "tool" });
        continue;
      }
      const failed = message.tool.ok === false || message.tool.name.startsWith("error:");
      events.push({
        id: message.id,
        at: message.at,
        label: failed ? message.tool.name.replace(/^error:\s*/i, "") : message.tool.name,
        // An activity is appended at tool start and patched with its outcome.
        // Until that patch arrives, do not imply that the action succeeded.
        state: failed ? "failed" : message.tool.ok === true ? "complete" : "running",
        kind: "tool",
      });
    } else if (message.kind === "screen") {
      events.push({ id: message.id, at: message.at, label: "Screen observed", state: "observed", kind: "screen" });
    } else if (message.kind === "text" && message.role === "bot" && message.text?.trim()) {
      events.push({ id: message.id, at: message.at, label: "Response recorded", state: "complete", kind: "result" });
    }
  }
  return events;
}
