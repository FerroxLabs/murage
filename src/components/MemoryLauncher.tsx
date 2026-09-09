import { useEffect, useId, useRef, useState } from "react";
import { Brain, X } from "lucide-react";
import { MemorySettings } from "./MemorySettings";

/** One bot-scoped memory surface, opened from either the toolbar or profile. */
export function MemoryLauncher({ botId, botName, compact = false }: { botId: string; botName: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  useEffect(() => { setOpen(false); }, [botId]);
  return <>
    <button type="button" onClick={() => setOpen(true)} aria-label={`Open memory for ${botName}`} title="Memory"
      className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-2 focus-visible:outline-focus">
      <Brain size={18} aria-hidden="true" />
      <span className={compact ? "@max-md/chathead:hidden" : undefined}>{compact ? "Memory" : "Open memory"}</span>
    </button>
    <dialog ref={dialog} aria-labelledby={titleId} onCancel={() => setOpen(false)} onClose={() => setOpen(false)}
      className="m-auto max-h-[90dvh] w-[min(760px,calc(100vw-24px))] overflow-y-auto rounded-2xl border border-hairline bg-card p-0 text-ink shadow-2xl backdrop:bg-black/60">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-hairline bg-card p-4">
        <h2 id={titleId} className="min-w-0 truncate text-[17px] font-semibold">{botName} · Memory</h2>
        <button type="button" autoFocus onClick={() => setOpen(false)} aria-label="Close memory" className="rounded-lg p-2 hover:bg-raised focus-visible:outline-2 focus-visible:outline-focus"><X size={18} /></button>
      </div>
      {open && <div className="p-4"><MemorySettings key={botId} botId={botId} onNavigate={() => setOpen(false)} /></div>}
    </dialog>
  </>;
}
