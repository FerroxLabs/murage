import { useEffect, useRef, useState } from "react";
import { api, useStore } from "@/state/store";
import { Inbox } from "./Inbox";
import { openFiles } from "./Files";
import type { InboxLink } from "../../shared/inbox";

export function InboxDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const gate = useRef(false);
  const { state, dispatch } = useStore();
  const [error, setError] = useState<string>();
  useEffect(() => { dialog.current?.showModal(); }, []);
  const openSource = async (link: InboxLink) => {
    if (link.artifactId) { openFiles({ artifactId: link.artifactId }); onClose(); return; }
    if (gate.current) return;
    gate.current = true; setError(undefined);
    try {
      const bot = state.bots.find(item => item.threadId === link.threadId || item.tasks?.some(task => task.threadId === link.threadId));
      const group = state.groups.find(item => item.threadId === link.threadId || item.tasks?.some(task => task.threadId === link.threadId));
      if (bot) {
        const result = await api(`/api/bots/${bot.id}/tasks/${link.threadId}`, { method: "POST" });
        if (!result.bot || result.bot.threadId !== link.threadId) throw new Error("The source conversation could not be opened.");
        dispatch({ type: "taskSwitched", bot: result.bot });
        dispatch({ type: "select", id: bot.id });
      } else if (group) {
        const result = await api(`/api/groups/${group.id}/tasks/${link.threadId}`, { method: "POST" });
        if (!result.group || result.group.threadId !== link.threadId) throw new Error("The source conversation could not be opened.");
        dispatch({ type: "groupPatched", group: result.group });
        dispatch({ type: "select", id: group.id });
      } else throw new Error("This conversation is no longer available.");
      dispatch({ type: "focusMessage", threadId: link.threadId, messageId: link.messageId });
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not open this result. Try again."); }
    finally { gate.current = false; }
  };
  return <dialog ref={dialog} aria-label="Inbox" onCancel={onClose} onClose={onClose}
    className="m-auto h-[min(820px,90dvh)] max-h-[90dvh] w-[min(900px,calc(100vw-24px))] overflow-hidden rounded-2xl border border-hairline bg-panel p-0 text-ink shadow-2xl backdrop:bg-black/60">
    {error && <p role="alert" className="px-4 pt-3 text-[13px] text-danger">{error}</p>}
    <Inbox onOpen={link => { void openSource(link); }} onClose={onClose} refreshKey={state.routineRuns.length} />
  </dialog>;
}
