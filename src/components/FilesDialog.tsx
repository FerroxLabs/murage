import { useEffect, useRef, useState } from "react";
import { api, useStore } from "@/state/store";
import { Files, artifactNativeAction, type FilesOpenDetail } from "./Files";
import type { Artifact } from "../../shared/artifacts";
import { t } from "@/lib/i18n";

export function FilesDialog({ onClose, ...initial }: FilesOpenDetail & { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), gate = useRef(false);
  const { state, dispatch } = useStore(), [error, setError] = useState<string>();
  useEffect(() => { dialog.current?.showModal(); }, []);
  const source = async (artifact: Artifact) => {
    if (gate.current) return; gate.current = true; setError(undefined);
    try {
      const bot = state.bots.find(bot => bot.id === artifact.botId);
      if (!bot || !artifact.sourceConversationAvailable) throw new Error(t("files.sourceUnavailableRetained"));
      const group = state.groups.find(group => group.threadId === artifact.threadId || group.tasks?.some(task => task.threadId === artifact.threadId));
      if (group) {
        const result = await api(`/api/groups/${group.id}/tasks/${artifact.threadId}`, { method: "POST" });
        if (!result.group || result.group.threadId !== artifact.threadId) throw new Error(t("source.openError"));
        dispatch({ type: "groupPatched", group: result.group }); dispatch({ type: "select", id: group.id });
      } else {
        const result = await api(`/api/bots/${bot.id}/tasks/${artifact.threadId}`, { method: "POST" });
        if (!result.bot || result.bot.threadId !== artifact.threadId) throw new Error(t("source.openError"));
        dispatch({ type: "taskSwitched", bot: result.bot }); dispatch({ type: "select", id: bot.id });
      }
      onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : t("source.openError")); } finally { gate.current = false; }
  };
  const native = artifactNativeAction();
  // The folder shown belongs to whichever conversation Files is browsing now,
  // not the one it was opened from, so Show folder can never open another
  // conversation's workspace.
  const reveal = window.muragebox?.revealWorkspace ? (botId: string, threadId: string) => window.muragebox!.revealWorkspace!(botId, threadId) : undefined;
  return <dialog ref={dialog} aria-label={t("files.title")} onCancel={onClose} onClose={onClose} className="m-auto h-[min(900px,92dvh)] max-h-[92dvh] w-[min(1050px,calc(100vw-24px))] overflow-hidden rounded-2xl border border-hairline bg-panel p-0 text-ink shadow-2xl backdrop:bg-black/60">
    {error && <p role="alert" className="px-4 pt-3 text-[13px] text-danger">{error}</p>}
    <Files bots={state.bots} initialBotId={initial.botId} initialThreadId={initial.threadId} initialArtifactId={initial.artifactId} onClose={onClose} onSource={artifact => { void source(artifact); }}
      onRevealFolder={reveal ? scope => { void reveal(scope.botId, scope.threadId).catch(() => setError(t("files.workingFolderError"))); } : undefined}
      onNativeAction={native ? async (artifact, action) => { try { await native(artifact, action); } catch (reason) { setError(reason instanceof Error ? reason.message : t("files.nativeActionError")); } } : undefined} />
  </dialog>;
}
