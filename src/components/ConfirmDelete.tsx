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
import { EMAIL_OWNER_COPY } from "../../shared/email-copy.ts";
import { api } from "@/state/store";
import { BOX_FRAME, BoxBody, BoxFoot, BoxHead } from "./ui/BoxShell";

export function ConfirmDelete({
  name,
  kind,
  detail,
  title,
  items,
  preview,
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
  onCancel: () => void;
  /** `emailConfirm` is the server's token for the address line the owner was shown (restore park r3.1 section 6); it is sent as the
   * DELETE body `{ emailConfirm }`. Absent when there is no parked address or the preview did not answer in time. */
  onConfirm: (options?: { emailConfirm: string }) => void;
}) {
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const matches = typed.trim().toLowerCase() === name.trim().toLowerCase();
  const { counts, email, pending } = useDeletionPreview(preview);
  const emailConfirm = email?.confirm ?? null;
  const confirm = () => { if (emailConfirm) onConfirm({ emailConfirm }); else onConfirm(); };
  const canConfirm = matches && !pending;

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
            {email && <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary" data-testid="confirm-delete-email">{EMAIL_OWNER_COPY.deleteAlsoRemoves(email.address)}</p>}
            {preview && deletionConsequenceLines(counts?.savedFiles, counts?.messages, counts?.engines).map((line) => (
              <p key={line} className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{line}</p>
            ))}
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
/** The parked address a bot's delete would also remove, with the server's confirmation token when it issued one (a live address has none). */
export type DeletionEmail = { address: string; confirm: string | null };
/** Confirm waits for the preview this long (restore park r3.1 section 6.6); after it the delete goes ahead with no line and no token. */
export const PREVIEW_WAIT_MS = 3000;

/** GET /api/deletion-preview. For a bot, `pending` is true until the preview answers (or fails) or PREVIEW_WAIT_MS pass; an `email` that
 *  arrives after the wait is dropped, so the owner never confirms a Remove they were not shown. */
export function useDeletionPreview(preview: { botId?: string; groupId?: string; threadId?: string } | undefined): { counts: DeletionCounts | null; email: DeletionEmail | null; pending: boolean } {
  const [counts, setCounts] = useState<DeletionCounts | null>(null);
  const [email, setEmail] = useState<DeletionEmail | null>(null);
  const [answered, setAnswered] = useState(false), [timedOut, setTimedOut] = useState(false);
  const query = preview ? new URLSearchParams(Object.entries(preview).filter((entry): entry is [string, string] => Boolean(entry[1]))).toString() : "";
  const forBot = Boolean(preview?.botId);
  useEffect(() => {
    if (!query) return;
    let live = true, late = false;
    const timer = forBot ? setTimeout(() => { late = true; if (live) setTimedOut(true); }, PREVIEW_WAIT_MS) : undefined;
    api(`/api/deletion-preview?${query}`).then((body: { savedFiles?: unknown; messages?: unknown; engines?: unknown; email?: { address?: unknown; confirm?: unknown } | null }) => {
      if (!live) return;
      if (typeof body?.savedFiles === "number") setCounts({ savedFiles: body.savedFiles, messages: typeof body.messages === "number" ? body.messages : null, engines: Array.isArray(body.engines) ? body.engines.filter((item): item is string => typeof item === "string") : [] });
      const address = body?.email?.address;
      if (forBot && !late && typeof address === "string" && address !== "") setEmail({ address, confirm: typeof body.email?.confirm === "string" && body.email.confirm !== "" ? body.email.confirm : null });
    }).catch(() => {}).finally(() => { if (live) setAnswered(true); });
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [query, forBot]);
  return { counts, email, pending: forBot && !answered && !timedOut };
}

/** How many messages and saved files a Delete takes with it; null until known. */
export function useDeletionCounts(preview: { botId?: string; groupId?: string; threadId?: string } | undefined): DeletionCounts | null {
  return useDeletionPreview(preview).counts;
}
