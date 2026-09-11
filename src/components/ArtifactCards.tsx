import { useEffect, useState } from "react";
import { api, useStore } from "@/state/store";
import { useDesktopSurface } from "@/lib/use-surface";
import { ArtifactCard, artifactNativeAction, downloadSavedArtifact, openFiles } from "./Files";
import type { Artifact } from "../../shared/artifacts";

/** IDs are supplied only by the server after registration; never parse paths
 * or prose into cards. Metadata reads do not fetch or execute file content. */
export function ArtifactCards({ ids }: { ids: string[] }) {
  const { dispatch } = useStore();
  const desktop = useDesktopSurface(), [artifacts, setArtifacts] = useState<Artifact[]>([]), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const key = [...new Set(ids.filter(id => /^[a-f0-9-]{36}$/.test(id)))].slice(0, 20).join(",");
  useEffect(() => {
    setArtifacts([]);
    if (desktop !== true || !key) return;
    const controller = new AbortController(); setError(null);
    void Promise.all(key.split(",").map(id => api(`/api/artifacts/${id}`, { signal: controller.signal }))).then(values => {
      if (!controller.signal.aborted) setArtifacts(values.map(value => value.artifact as Artifact));
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Saved files could not load."); });
    return () => controller.abort();
  }, [key, desktop]);
  const action = async (operation: () => Promise<void>) => {
    setBusy(true); setError(null); try { await operation(); } catch (reason) { setError(reason instanceof Error ? reason.message : "The file could not be opened."); } finally { setBusy(false); }
  };
  if (desktop !== true) return null;
  const native = artifactNativeAction();
  return <div className="mt-3 space-y-2" aria-label="Saved files">
    {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    {artifacts.map(artifact => <ArtifactCard key={artifact.id} artifact={artifact} busy={busy}
      onPreview={() => openFiles({ artifactId: artifact.id, botId: artifact.botId })}
      // Open here (F4-T3): the working file this version came from, in the
      // pane beside this chat, named by the identity the server registered.
      onOpenHere={() => dispatch({ type: "workspacePane", action: { type: "open", scope: { botId: artifact.botId, threadId: artifact.threadId }, relativePath: artifact.relativePath, mode: "preview" } })}
      onDownload={() => { void action(() => downloadSavedArtifact(artifact)); }}
      onNativeAction={native ? (file, operation) => action(() => native(file, operation)) : undefined} />)}
  </div>;
}
