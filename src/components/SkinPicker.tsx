// Three options in one row: Light, Dark, Automatic.
//
// The miniatures this control used to draw are gone on purpose. Their job was
// to let you judge four *characters* that a name could not convey; with two
// palettes that differ only by brightness the name conveys everything, and
// clicking an option makes the whole application the preview. Automatic cannot
// be drawn at all — any thumbnail for it is either a lie (it shows one palette)
// or a puzzle (a split the user has to decode) — and a control with two honest
// thumbnails and one that shrugs is worse than three plain labels.
import { useEffect, useState } from "react";
import { Sun, Moon, Contrast } from "lucide-react";
import {
  applyPreference,
  readPreference,
  resolveSkin,
  watchSystemSkin,
  type ThemePreference,
} from "@/lib/skins";
import { cn } from "@/lib/cn";

const OPTIONS: readonly { id: ThemePreference; label: string; Icon: typeof Sun }[] = [
  { id: "light", label: "Light", Icon: Sun },
  { id: "dark", label: "Dark", Icon: Moon },
  // Last, because it reads as "one, the other, or let the machine decide".
  { id: "auto", label: "Automatic", Icon: Contrast },
];

export function SkinPicker() {
  const [preference, setPreference] = useState<ThemePreference>(readPreference);
  // Only Automatic needs this, and it is the one fact the control cannot show:
  // which way Automatic currently resolves.
  const [resolved, setResolved] = useState(() => resolveSkin(readPreference()));

  // The same helper main.tsx registers at module scope. That one repaints the
  // app; this one keeps the caption line honest while Settings is open.
  useEffect(() => watchSystemSkin(setResolved), []);

  return (
    <div>
      {/* One border on the group rather than three on the segments, so the
          dividers are hairlines between cells and the outer edge is a single
          rounded rectangle — level and parallel by construction. */}
      <div
        role="radiogroup"
        aria-label="Appearance"
        className="grid grid-cols-3 overflow-hidden rounded-lg border border-hairline"
      >
        {OPTIONS.map(({ id, label, Icon }, index) => {
          const selected = id === preference;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={selected}
              // Arrow keys move the selection and Tab enters/leaves the group as
              // one stop — which is the whole reason these are radios rather
              // than three aria-pressed buttons.
              tabIndex={selected ? 0 : -1}
              onKeyDown={(event) => {
                const step =
                  event.key === "ArrowRight" || event.key === "ArrowDown"
                    ? 1
                    : event.key === "ArrowLeft" || event.key === "ArrowUp"
                      ? -1
                      : 0;
                if (step === 0) return;
                event.preventDefault();
                const at = (index + step + OPTIONS.length) % OPTIONS.length;
                setResolved(applyPreference(OPTIONS[at].id));
                setPreference(OPTIONS[at].id);
                // Selection follows focus in a radiogroup, so move focus too.
                event.currentTarget.parentElement?.querySelectorAll("button")[at]?.focus();
              }}
              onClick={() => {
                setResolved(applyPreference(id));
                setPreference(id);
              }}
              className={cn(
                "flex h-9 items-center justify-center gap-1.5 px-3 text-[13px] transition-colors",
                index > 0 && "border-l border-hairline",
                // The accent edge is an INSET ring, not a border: the group is
                // one clipped rectangle, so a real border on one cell would
                // shift its two neighbours by a pixel each.
                selected
                  ? "bg-control font-medium text-accent-text shadow-[inset_0_0_0_1px_var(--color-accent-border)]"
                  : "text-ink-secondary hover:bg-control/50",
              )}
            >
              <Icon size={14} className="shrink-0" aria-hidden="true" />
              {label}
            </button>
          );
        })}
      </div>
      {/* Rendered only for Automatic — the space is not reserved when the
          preference is explicit; the card is simply shorter. */}
      {preference === "auto" && (
        <p className="mt-2 text-[11px] text-ink-secondary">
          Following your system — currently {resolved === "dark" ? "Dark" : "Light"}.
        </p>
      )}
    </div>
  );
}
