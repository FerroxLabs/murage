export interface WebhookMessageView {
  task: string;
  payload?: string;
}

const EVENT_DATA_OPEN = "[UNTRUSTED WEBHOOK EVENT DATA]\n";

/** Trusted task blocks, in the server's own precedence: the owner's configured
 * instructions win over a task named in the payload, which wins over the
 * default. The server only ever writes one of them. */
const TASK_MARKERS = [
  "USER-CONFIGURED WEBHOOK INSTRUCTIONS",
  "AUTHENTICATED WEBHOOK TASK",
  "DEFAULT WEBHOOK INSTRUCTIONS",
];

/** Convert the model-safe webhook prompt into the smaller view shown in chat.
 * The stored message stays untouched, preserving the trust boundary for model
 * context and follow-up turns. */
export function webhookMessageView(text: string): WebhookMessageView | null {
  // The task comes only from the text before the event data. Anyone holding
  // the webhook URL controls the event data, so a task block written inside
  // it must never become the task the chat shows.
  const eventStart = text.indexOf(EVENT_DATA_OPEN);
  if (eventStart < 0) return null;
  const trustedPrefix = text.slice(0, eventStart);
  let task = "";
  for (const marker of TASK_MARKERS) {
    const candidate = trustedPrefix.match(new RegExp(`\\[${marker}\\]\\n([\\s\\S]*?)\\n\\[\\/${marker}\\]`))?.[1]?.trim();
    if (candidate) {
      task = candidate;
      break;
    }
  }

  const eventData = text.match(/\[UNTRUSTED WEBHOOK EVENT DATA\]\n([\s\S]*?)\n\[\/UNTRUSTED WEBHOOK EVENT DATA\]/)?.[1];
  if (!task || !eventData) return null;

  const splitAt = eventData.indexOf("\n\n");
  const payload = (splitAt >= 0 ? eventData.slice(splitAt + 2) : "").trim();
  return { task, payload: payload || undefined };
}
