// "Use as reference" (0.1.52 F5-T4, IMG-SEED). Adds the image shown to the
// next message of its own conversation as an attached image. It never
// generates or bills: the owner still sends the message and approves any
// paid image request. Offered only while that conversation's composer is
// open, so an image never lands in another conversation's draft.
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Check, ImagePlus } from "lucide-react";

import { addImageReference, composerReferenceTarget, subscribeComposerReferenceTargets, type ReferenceRequester } from "@/lib/image-reference";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { ImageReferenceSource } from "../../shared/media-assets";

type State = { kind: "idle" } | { kind: "busy" } | { kind: "added" } | { kind: "error"; message: string };

/** Whether a composer that can receive this image is open. */
export function useReferenceTargetAvailable(threadId?: string): boolean {
  const snapshot = () => composerReferenceTarget(threadId) !== undefined;
  // The app renders on the client only; the same registry answers both.
  return useSyncExternalStore(subscribeComposerReferenceTargets, snapshot, snapshot);
}

export function referenceErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : "";
  return message ? message.slice(0, 300) : t("imageReference.failed");
}

/** The app's authenticated call. Imported when the action is used, not when
 * an image renders: the shared image surface must stay loadable without the
 * renderer store (its tests render it in plain node). */
const appRequest: ReferenceRequester = async (path, init) => (await import("@/state/store")).api(path, init);

export function UseAsReferenceButton({ source, threadId, botId, name, request = appRequest, className, statusClassName }: {
  source: ImageReferenceSource | null;
  /** The image's own conversation when the caller knows it (Files). A chat
   * image omits it: the conversation on screen is asked, and the harness
   * refuses unless that conversation holds the image. */
  threadId?: string;
  botId?: string;
  name: string;
  /** Overridden in tests; defaults to the app's authenticated call. */
  request?: ReferenceRequester;
  className?: string;
  statusClassName?: string;
}) {
  const available = useReferenceTargetAvailable(threadId);
  const [state, setState] = useState<State>({ kind: "idle" });
  // a different image starts fresh
  const identity = source ? JSON.stringify(source) : "";
  useEffect(() => { setState({ kind: "idle" }); }, [identity]);

  const onClick = useCallback(async () => {
    if (!source || state.kind === "busy") return;
    setState({ kind: "busy" });
    try {
      const result = await addImageReference({ source, ...(threadId ? { threadId } : {}), ...(botId ? { botId } : {}) }, request);
      setState(result.status === "added" ? { kind: "added" } : { kind: "error", message: t("imageReference.openConversation") });
    } catch (error) {
      setState({ kind: "error", message: referenceErrorMessage(error) });
    }
  }, [source, threadId, botId, request, state.kind]);

  if (!source || !available) return null;
  const added = state.kind === "added";
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <button
        type="button"
        onClick={() => void onClick()}
        disabled={state.kind === "busy"}
        aria-label={added ? t("imageReference.addedLabel", { name }) : t("imageReference.useLabel", { name })}
        title={t("imageReference.useTitle")}
        data-image-reference-action={state.kind}
        className={cn("inline-flex items-center gap-1.5 whitespace-nowrap disabled:opacity-60", className)}
      >
        {added ? <Check size={15} aria-hidden="true" /> : <ImagePlus size={15} aria-hidden="true" />}
        <span>{added ? t("imageReference.added") : t("imageReference.use")}</span>
      </button>
      <span role={state.kind === "error" ? "alert" : "status"} aria-live="polite" className={cn("min-w-0 truncate text-[11px]", statusClassName)} title={state.kind === "error" ? state.message : undefined}>
        {state.kind === "error" ? state.message : added ? t("imageReference.addedStatus") : ""}
      </span>
    </span>
  );
}
