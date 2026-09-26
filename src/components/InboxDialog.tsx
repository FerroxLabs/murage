import { useEffect, useRef, useState } from "react";
import { useStore } from "@/state/store";
import { openInboxLink } from "@/lib/open-inbox-link";
import { Inbox } from "./Inbox";
import { openFiles } from "./Files";
import type { InboxLink, InboxView } from "../../shared/inbox";
import { t } from "@/lib/i18n";

export function InboxDialog({ onClose, initialView }: { onClose: () => void; initialView?: InboxView }) {
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
      await openInboxLink(link, state, dispatch);
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("inbox.openResultError")); }
    finally { gate.current = false; }
  };
  return <dialog ref={dialog} aria-label={t("inbox.title")} onCancel={onClose} onClose={onClose}
    className="m-auto h-[min(820px,90dvh)] max-h-[90dvh] w-[min(900px,calc(100vw-24px))] overflow-hidden rounded-2xl border border-hairline bg-panel p-0 text-ink shadow-2xl backdrop:bg-black/60">
    {error && <p role="alert" className="px-4 pt-3 text-[13px] text-danger">{error}</p>}
    <Inbox initialView={initialView} onOpen={link => { void openSource(link); }} onClose={onClose} refreshKey={state.routineRuns.length}
      onOpenBackups={() => { onClose(); dispatch({ type: "toggleAppSettings", open: true, section: "backups" }); }} />
  </dialog>;
}
