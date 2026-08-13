// Chips for what is attached to the next message, shown above the input.
// A long paste collapses into a card of its first lines instead of
// flooding the composer with a wall of text.
import { ClipboardPaste, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { pasteSummary, type Attachment } from "@/lib/composer-attachments";

export function ComposerAttachments({
  items,
  onRemove,
}: {
  items: Attachment[];
  onRemove: (id: string) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-2">
      {items.map((a) => (
        <PasteChip key={a.id} text={a.text} onRemove={() => onRemove(a.id)} />
      ))}
    </div>
  );
}

function PasteChip({ text, onRemove }: { text: string; onRemove: () => void }) {
  return (
    <div
      title={text.slice(0, 4000)}
      className={cn(
        "group relative w-[172px] rounded-xl border border-hairline/40 bg-raised px-2.5 py-2",
        "transition-colors hover:border-hairline",
      )}
    >
      <div className="relative h-[76px] overflow-hidden">
        <pre className="whitespace-pre-wrap break-words font-mono text-[10.5px] leading-[1.45] text-ink-secondary">
          {text.slice(0, 400)}
        </pre>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-b from-transparent to-raised" />
      </div>
      <div className="mt-1 text-[10.5px] text-ink-secondary/70">{pasteSummary(text)}</div>
      <div className="mt-1 flex items-center gap-1">
        <ClipboardPaste size={11} className="text-ink-secondary/70" />
        <span className="rounded border border-hairline/60 px-1 py-px text-[9.5px] font-medium tracking-wide text-ink-secondary">
          PASTED
        </span>
      </div>
      <button
        onClick={onRemove}
        aria-label="Remove pasted text"
        className="absolute -right-1.5 -top-1.5 hidden size-5 items-center justify-center rounded-full border border-hairline/60 bg-panel text-ink-secondary hover:text-ink group-hover:flex"
      >
        <X size={11} />
      </button>
    </div>
  );
}
