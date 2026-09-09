import { useLayoutEffect, useRef, useState } from "react";
import { Keyboard, X } from "lucide-react";
import { filterShortcuts, shortcutKeys, shortcutPlatformIsMac } from "@/lib/keyboard-shortcuts";

export function KeyboardShortcutsDialog({ open, onClose, returnFocusRef }: {
  open: boolean; onClose: () => void; returnFocusRef?: { current: HTMLElement | null };
}) {
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const mac = shortcutPlatformIsMac();
  useLayoutEffect(() => {
    if (!open || !dialog.current) return;
    const element = dialog.current, previous = document.activeElement;
    setQuery(""); element.showModal(); input.current?.focus();
    return () => { element.close(); const target = returnFocusRef?.current ?? previous; if (target instanceof HTMLElement && target.isConnected) target.focus(); };
  }, [open, returnFocusRef]);
  if (!open) return null;
  const groups = filterShortcuts(query, mac);
  const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
  return <dialog ref={dialog} aria-labelledby="keyboard-shortcuts-title" className="m-auto max-h-[85dvh] overflow-hidden rounded-2xl border border-hairline/50 bg-panel p-0 text-ink backdrop:bg-black/60" style={{ width: "min(560px, calc(100% - 32px))" }}
    onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => event.stopPropagation()}
    onMouseDown={event => { const rect = event.currentTarget.getBoundingClientRect(); if (event.target === event.currentTarget && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) onClose(); }}>
    <div className="flex max-h-[85dvh] flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-hairline/40 p-4"><Keyboard size={20} className="text-ink-secondary" aria-hidden="true" /><h2 id="keyboard-shortcuts-title" className="flex-1 text-[17px] font-semibold">Keyboard shortcuts</h2><button type="button" aria-label="Close keyboard shortcuts" onClick={onClose} className={"rounded-lg p-2 text-ink-secondary hover:bg-control " + focus}><X size={18} /></button></header>
      <div className="shrink-0 p-4 pb-2"><input ref={input} aria-label="Search shortcuts" placeholder="Search actions or keys…" value={query} onChange={event => setQuery(event.target.value)} className={"min-h-11 w-full rounded-lg border border-hairline/50 bg-inset px-3 text-[14px] text-ink " + focus} /></div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4">
        {groups.length === 0 && <p role="status" className="py-5 text-[13px] text-ink-secondary">No shortcuts match “{query}”.</p>}
        {groups.map(group => <section key={group.title} aria-label={group.title}><h3 className="mb-1 text-[12px] font-semibold text-ink-secondary">{group.title}</h3><dl className="divide-y divide-hairline/30 rounded-lg bg-card px-3">{group.items.map(item => <div key={item.id} className="flex items-center justify-between gap-3 py-2.5"><dt className="min-w-0 text-[13px]">{item.description}<span className="mt-0.5 block text-[11px] text-ink-secondary">{item.context}</span></dt><dd className="flex shrink-0 flex-wrap justify-end gap-1">{shortcutKeys(item, mac).map((key, index) => <kbd key={index} aria-label={key === "⌘" ? "Command" : key} className="rounded border border-hairline/50 bg-control px-1.5 py-1 font-mono text-[11px] text-ink">{key}</kbd>)}</dd></div>)}</dl></section>)}
      </div>
      <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-hairline/40 px-4 py-3"><p className="text-[12px] text-ink-secondary">Common shortcuts; actions depend on context.</p><button type="button" onClick={onClose} className={"min-h-10 rounded-lg bg-control px-4 text-[13px] font-medium " + focus}>Done</button></footer>
    </div>
  </dialog>;
}
