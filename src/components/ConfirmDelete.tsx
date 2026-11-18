// Typed confirmation for the two actions that destroy work irreversibly.
//
// Deleting a bot removes its whole transcript, and deleting a room removes the
// conversation the team had in it. Both were a single click with no undo, while
// far smaller actions in this app already ask (ComputerPanel.tsx:748,
// LocalComputerSection.tsx:161). This closes that gap.
//
// The user types the NAME rather than the word "delete" on purpose: it confirms
// WHICH thing is going, not merely that they meant to click. Muscle memory can
// type "delete" on the wrong row; it cannot type the wrong name by accident.
import { useFocusTrap } from "@/lib/focus-trap";
import { LayerSurface } from "@/components/LayerSurface";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";

import { deletionConsequenceLines } from "@/lib/deletion-notes";
import { api } from "@/state/store";
import { BOX_FRAME, BoxBody, BoxFoot, BoxHead } from "./ui/BoxShell";

export function ConfirmDelete({
  name,
  kind,
  detail,
  title,
  items,
  preview,
  extraLine,
  onCancel,
  onConfirm,
}: {
  name: string;
  kind: string;
  detail: string;
  /** Heading override for a delete that is not one named thing (a bulk
   * delete names its count instead). Default: Delete {kind} "{name}"? */
  title?: string;
  /** Exactly what is going, one line each, when `name` alone cannot say it
   * (bulk delete). Shown in full, scrolling if long: the person must be able
   * to read every name before typing the confirmation. */
  items?: string[];
  /** What is being deleted, for the saved-files count and the backups line
   * (GET /api/deletion-preview). */
  preview?: { botId?: string; groupId?: string; threadId?: string };
  /** One more plain line under the detail (bulk archived delete: the addresses stay). */
  extraLine?: string;
  onCancel: () => void;
  /** A parked inbox's confirm token rides along only when the preview offered one. */
  onConfirm: (options?: { emailConfirm: string }) => void;
}) {
  // What is being deleted. The typed words, the preview and the one-shot guard all belong to it: a dialog that is handed another
  // target (even one with the same name) starts again from nothing.
  const target = preview ? JSON.stringify([preview.botId ?? "", preview.groupId ?? "", preview.threadId ?? ""]) : "";
  // Render-time adjustment: when the target changes (including a return to an earlier one) the typed value is dropped and a new
  // activation number starts, before anything is shown, so an old value is never exposed for even one render.
  const [act, setAct] = useState({ target, seq: 0, value: "" });
  if (act.target !== target) setAct({ target, seq: act.seq + 1, value: "" });
  const typed = act.target === target ? act.value : "";
  const setTyped = (value: string) => setAct({ target, seq: act.seq, value });
  const inputRef = useRef<HTMLInputElement>(null);
  const matches = typed.trim().toLowerCase() === name.trim().toLowerCase();
  const gated = Boolean(preview?.botId) && !preview?.threadId;
  const { counts, email, ready } = useDeletionPreview(preview);
  const canConfirm = matches && (!gated || ready);
  const sentFor = useRef<number | null>(null);
  const confirm = () => {
    if (sentFor.current === act.seq) return; // a double click or Enter plus a click sends one Delete per activation
    sentFor.current = act.seq;
    // Presence matters: forward any string token offered by the preview.
    if (gated && email && typeof email.confirm === "string") onConfirm({ emailConfirm: email.confirm });
    else onConfirm();
  };

  const dialogRef = useRef<HTMLDivElement>(null);
  const layer = useFocusTrap(dialogRef, true, { name: "confirm-delete", kind: "dialog", initialFocus: "input", onEscape: onCancel });

  return <LayerSurface handle={layer}><div
      // C5: this dialog autofocuses its "type the name to confirm" field, so a
      // software keyboard is always up while it is open. `inset-0` resolves
      // against the layout viewport, which iOS does not shrink, and would centre
      // the dialog in the full pre-keyboard height with the confirm button
      // behind the keys. See the overlay convention in styles.css.
      className="overlay-inset fixed inset-x-0 top-0 flex h-[var(--vvh,100dvh)] items-center justify-center bg-black/60 p-6"
      onClick={onCancel}
      role="presentation"
    >
      <div
        className={`${BOX_FRAME} max-h-[calc(var(--vvh,100dvh)-3rem)] w-full max-w-[420px] rounded-2xl border border-hairline/40 bg-panel`}
        onClick={(e) => e.stopPropagation()}
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-delete-title"
      >
        <BoxHead className="items-start justify-start px-6 pt-6">
          <AlertTriangle size={20} className="mt-0.5 shrink-0 text-danger" />
            <h2 id="confirm-delete-title" className="min-w-0 text-[15px] font-semibold text-ink">
              {title ?? <>Delete {kind} “{name}”?</>}
            </h2>
        </BoxHead>
        <BoxBody className="pl-14 pr-6">
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">{detail}</p>
            {preview && deletionConsequenceLines(counts?.savedFiles, counts?.messages, counts?.engines).map((line) => (
              <p key={line} className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{line}</p>
            ))}
            {gated && email && (
              <p data-testid="confirm-delete-email" className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{`This also removes ${email.address}.`}</p>
            )}
            {extraLine && <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{extraLine}</p>}
            {items && items.length > 0 && (
              <ul
                aria-label="What will be deleted"
                className="mt-2 rounded-lg border border-hairline/40 bg-app px-3 py-2 text-[12.5px] leading-relaxed text-ink"
              >
                {items.map((item, index) => (
                  <li key={`${index}-${item}`} className="truncate">{item}</li>
                ))}
              </ul>
            )}
        </BoxBody>

        {/* The name field stays by the Delete button, so its focus never scrolls the list away. */}
        <BoxFoot className="block px-6 pb-6 pt-4">
        <label className="block text-[12.5px] text-ink-secondary">
          Type <span className="font-medium text-ink">{name}</span> to confirm
          <input
            ref={inputRef}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && canConfirm) confirm(); }}
            className="mt-1.5 w-full rounded-lg border border-hairline/50 bg-app px-3 py-2 text-[13px] text-ink outline-none focus:border-accent"
            placeholder={name}
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg px-3.5 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
          >
            Cancel
          </button>
          <button
            onClick={confirm}
            disabled={!canConfirm}
            className="rounded-lg bg-danger px-3.5 py-2 text-[13px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            Delete {kind}
          </button>
        </div>
        </BoxFoot>
      </div>
    </div></LayerSurface>;
}

type DeletionCounts = { savedFiles: number; messages: number | null; engines: string[] };
type DeletionEmail = { address: string; confirm?: string };
/** How long a Delete waits for its preview before it goes ahead without the email line. */
export const DELETION_PREVIEW_WAIT_MS = 3000;

type PreviewSnap = { key: string; counts: DeletionCounts | null; email: DeletionEmail | null; ready: boolean };
const NO_PREVIEW: PreviewSnap = { key: "", counts: null, email: null, ready: false };

/** The preview of a Delete: counts, plus the bot's email address when it has one. `ready` is true once the preview answered or
 * DELETION_PREVIEW_WAIT_MS passed; an answer after that never adds an address or a token. The result is stored with the query it
 * answered, and read only while the query is the same: asked about another target, it is empty and not ready at once. */
export function useDeletionPreview(preview: { botId?: string; groupId?: string; threadId?: string } | undefined): { counts: DeletionCounts | null; email: DeletionEmail | null; ready: boolean } {
  const query = preview ? new URLSearchParams(Object.entries(preview).filter((entry): entry is [string, string] => Boolean(entry[1]))).toString() : "";
  const [snap, setSnap] = useState<PreviewSnap>({ ...NO_PREVIEW, key: query });
  // Render-time adjustment: a new query (including a return to an earlier one) drops the stored answer before anything is shown.
  if (snap.key !== query) setSnap({ ...NO_PREVIEW, key: query });
  useEffect(() => {
    if (!query) return;
    let live = true;
    let waiting = true;
    const update = (patch: Partial<PreviewSnap>) => setSnap((prev) => ({ ...(prev.key === query ? prev : { ...NO_PREVIEW, key: query }), ...patch }));
    const timer = setTimeout(() => { waiting = false; if (live) update({ ready: true }); }, DELETION_PREVIEW_WAIT_MS);
    api(`/api/deletion-preview?${query}`).then((body: { savedFiles?: unknown; messages?: unknown; engines?: unknown; email?: unknown }) => {
      if (!live) return;
      const patch: Partial<PreviewSnap> = {};
      if (typeof body?.savedFiles === "number") patch.counts = { savedFiles: body.savedFiles, messages: typeof body.messages === "number" ? body.messages : null, engines: Array.isArray(body.engines) ? body.engines.filter((item): item is string => typeof item === "string") : [] };
      const found = body?.email as { address?: unknown; confirm?: unknown } | null | undefined;
      if (waiting && typeof found?.address === "string" && found.address) patch.email = { address: found.address, ...(typeof found.confirm === "string" ? { confirm: found.confirm } : {}) };
      if (waiting) { waiting = false; clearTimeout(timer); patch.ready = true; }
      update(patch);
    }).catch(() => {
      if (waiting) { waiting = false; clearTimeout(timer); if (live) update({ ready: true }); }
    });
    return () => { live = false; clearTimeout(timer); };
  }, [query]);
  if (!query) return { counts: null, email: null, ready: true };
  return snap.key === query ? { counts: snap.counts, email: snap.email, ready: snap.ready } : { counts: null, email: null, ready: false };
}

/** How many messages and saved files a Delete takes with it; null until known. */
export function useDeletionCounts(preview: { botId?: string; groupId?: string; threadId?: string } | undefined): DeletionCounts | null {
  return useDeletionPreview(preview).counts;
}
