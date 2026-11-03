export interface WebhookMessageView {
  task: string;
  payload?: string;
}

/** The event data of a webhook run: the metadata lines and the payload, split at the first blank line. */
export interface WebhookEventData {
  metadata: string;
  payload: string;
}

const EVENT_DATA_OPEN = "[UNTRUSTED WEBHOOK EVENT DATA]\n";

/** Trusted task blocks of a stored (pre-1.0.15) message, in the server's own
 * precedence: the owner's configured instructions win over a task named in the
 * payload, which wins over the default. The server only ever wrote one of them. */
const LEGACY_TASK_MARKERS = [
  "USER-CONFIGURED WEBHOOK INSTRUCTIONS",
  "AUTHENTICATED WEBHOOK TASK",
  "DEFAULT WEBHOOK INSTRUCTIONS",
];

/** The server's event fence (webhooks.ts eventPrompt, browser-untrusted.ts fencePageText). */
const EVENT_FENCE_OPEN = /^<<page-content id=([0-9a-f]{16}) origin=webhook kind=webhook-event>>$/gm;

function block(text: string, marker: string): string {
  return text.match(new RegExp(`\\[${marker}\\]\\n([\\s\\S]*?)\\n\\[\\/${marker}\\]`))?.[1]?.trim() ?? "";
}

/** The fence stores `<<` and `>>` as `‹‹` and `››`; the chat shows the sender's text as sent. */
function unescapeMarkers(text: string): string {
  return text.replace(/‹‹/g, "<<").replace(/››/g, ">>");
}

function splitEvent(eventData: string): WebhookEventData {
  const splitAt = eventData.indexOf("\n\n");
  return splitAt >= 0
    ? { metadata: eventData.slice(0, splitAt), payload: eventData.slice(splitAt + 2).trim() }
    : { metadata: eventData, payload: "" };
}

/** The trusted prefix and the event body of a fenced webhook prompt. The sender's text inside the fence is
 * marker-escaped, so the last opener line is the server's own; its closer must end the message. */
function fenced(text: string): { prefix: string; body: string } | null {
  let last: RegExpExecArray | null = null;
  for (const match of text.matchAll(EVENT_FENCE_OPEN)) last = match as RegExpExecArray;
  if (!last) return null;
  const closer = `\n<<end page-content id=${last[1]}>>`;
  const bodyStart = last.index + last[0].length + 1;
  const closeAt = text.lastIndexOf(closer);
  if (closeAt < bodyStart - 1 || text.slice(closeAt + closer.length).trim()) return null;
  return { prefix: text.slice(0, last.index), body: closeAt >= bodyStart ? text.slice(bodyStart, closeAt) : "" };
}

/** The event data of a webhook prompt, new fence or stored bracket, or null for any other message. */
export function webhookEventData(text: string): WebhookEventData | null {
  const fence = fenced(text);
  if (fence) {
    const parts = splitEvent(fence.body);
    return { metadata: unescapeMarkers(parts.metadata), payload: unescapeMarkers(parts.payload) };
  }
  const legacy = text.match(/\[UNTRUSTED WEBHOOK EVENT DATA\]\n([\s\S]*?)\n\[\/UNTRUSTED WEBHOOK EVENT DATA\]/)?.[1];
  return legacy === undefined ? null : splitEvent(legacy);
}

/** The one instruction block the server wrote, read from the start of the prefix only: a webhook task that quotes an
 * owner or default bracket is still shown whole. */
function fencedTask(prefix: string): string {
  const task = prefix.match(/^<<webhook-task id=([0-9a-f]{16})>>\n([\s\S]*?)\n<<end webhook-task id=\1>>/)?.[2]?.trim();
  if (task) return unescapeMarkers(task);
  for (const marker of ["USER-CONFIGURED WEBHOOK INSTRUCTIONS", "DEFAULT WEBHOOK INSTRUCTIONS"]) {
    if (prefix.startsWith(`[${marker}]\n`)) return block(prefix, marker);
  }
  return "";
}

/** Convert the model-facing webhook prompt into the smaller view shown in chat.
 * The stored message stays untouched, preserving the trust boundary for model
 * context and follow-up turns. */
export function webhookMessageView(text: string): WebhookMessageView | null {
  // The task comes only from the text before the event data. Anyone holding
  // the webhook URL controls the event data, so a task block written inside
  // it must never become the task the chat shows.
  const fence = fenced(text);
  let task = "";
  let eventData: string | undefined;
  if (fence) {
    task = fencedTask(fence.prefix);
    eventData = fence.body;
  } else {
    const eventStart = text.indexOf(EVENT_DATA_OPEN);
    if (eventStart < 0) return null;
    const trustedPrefix = text.slice(0, eventStart);
    for (const marker of LEGACY_TASK_MARKERS) {
      const candidate = block(trustedPrefix, marker);
      if (candidate) {
        task = candidate;
        break;
      }
    }
    eventData = text.match(/\[UNTRUSTED WEBHOOK EVENT DATA\]\n([\s\S]*?)\n\[\/UNTRUSTED WEBHOOK EVENT DATA\]/)?.[1];
  }
  if (!task || !eventData) return null;

  const payload = splitEvent(eventData).payload;
  const shown = fence ? unescapeMarkers(payload) : payload;
  return { task, payload: shown || undefined };
}
