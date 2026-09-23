// A message a view names by id — the pinned message, mostly — that may be
// older than the page this client holds (upstream #1527). Held: it is used as
// is. Not held: one row is read from the page route's `around=` window, the
// same read the Inbox uses for a request card, and kept only for that id.
import { useEffect, useState } from "react";
import { api, type Message } from "@/state/store";

export function useMessageById(threadId: string, messageId: string | undefined, held: readonly Message[]): Message | undefined {
  const local = messageId ? held.find((message) => message.id === messageId) : undefined;
  const [remote, setRemote] = useState<{ key: string; message: Message } | null>(null);
  const key = `${threadId}:${messageId ?? ""}`;
  useEffect(() => {
    if (!messageId || local) return;
    const controller = new AbortController();
    api(`/api/threads/${threadId}/messages?around=${encodeURIComponent(messageId)}&limit=1`, { signal: controller.signal })
      .then((page: { messages?: Message[] }) => {
        const found = page.messages?.find((message) => message.id === messageId);
        if (found && !controller.signal.aborted) setRemote({ key: `${threadId}:${messageId}`, message: found });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [threadId, messageId, Boolean(local)]);
  return local ?? (remote?.key === key ? remote.message : undefined);
}
