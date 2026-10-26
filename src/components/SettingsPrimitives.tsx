import { createContext, useContext, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Copy, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { advancedRegionId, type AdvancedSectionProps } from "@/lib/settings-cards";
import { useCopyFeedback } from "@/lib/copy-text";

export function Switch({
  checked,
  className,
  ...props
}: Omit<ComponentProps<"button">, "children" | "role" | "aria-checked"> & { checked: boolean }) {
  return (
    <button
      {...props}
      type="button"
      role="switch"
      aria-checked={checked}
      className={cn(
        "relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-40",
        // A 44px-tall hit area around the 24px track, for a finger.
        "before:absolute before:-inset-y-2.5 before:inset-x-0 before:content-['']",
        checked ? "bg-accent" : "bg-control",
        className,
      )}
    >
      <span
        className={cn(
          "absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white transition-all",
          checked ? "left-[21px]" : "left-[3px]",
        )}
      />
    </button>
  );
}

export function Card({
  title,
  subtitle,
  children,
}: {
  title?: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl bg-card p-4">
      {title && <div className="text-[15px] font-medium text-ink">{title}</div>}
      {subtitle && <div className={title ? "mt-0.5 text-[13px] leading-relaxed text-ink-secondary" : "text-[13px] leading-relaxed text-ink-secondary"}>{subtitle}</div>}
      {children && <div className={title || subtitle ? "mt-4" : undefined}>{children}</div>}
    </div>
  );
}

/** A command the user is meant to run, with one-click copy. */
export function CommandLine({ command }: { command: string }) {
  const { mark, copy } = useCopyFeedback();

  return (
    <div className="flex items-center gap-2 rounded-lg bg-inset px-3 py-2">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12px] text-ink">
        {command}
      </code>
      <button
        onClick={() => void copy(command)}
        aria-label={mark === "failed" ? t("copy.failed") : "Copy command"}
        title={mark === "failed" ? t("copy.failed") : undefined}
        className={`shrink-0 rounded p-1 hover:bg-raised hover:text-ink ${mark === "failed" ? "text-danger" : "text-ink-secondary"}`}
      >
        {mark === "copied" ? <Check size={13} className="text-success" /> : mark === "failed" ? <X size={13} /> : <Copy size={13} />}
      </button>
      {mark === "failed" && <span role="status" className="sr-only">{t("copy.failed")}</span>}
    </div>
  );
}

/** The one Advanced level of a Settings page (1.0.3 I0, SETTINGS-LANES.md): at the bottom of the page, one toggle,
 *  always labelled "Advanced", with a line naming what is inside. Controlled, so an opener can open it before it
 *  scrolls to an advanced anchor. A page renders at most one, and no <details> anywhere else in its body. */
export function AdvancedSection({ section, summary, open, onOpenChange, children }: AdvancedSectionProps) {
  const region = advancedRegionId(section);
  return (
    <section className="space-y-4" data-settings-advanced={section}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={region}
        onClick={() => onOpenChange(!open)}
        className="flex min-h-[52px] w-full items-center justify-between gap-3 rounded-xl border border-dashed border-hairline px-4 py-3 text-left text-[14px] text-ink-secondary hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
      >
        <span><span className="font-medium text-ink">{t("settings.l1.advancedPath")}</span> · {summary}</span>
        <ChevronDown size={16} aria-hidden className={cn("shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      <div id={region} role="region" aria-label={t("settings.l1.advancedPath")} hidden={!open} className="space-y-4">
        {open && children}
      </div>
    </section>
  );
}

// A page whose cards live in components that also hold an Advanced part (the messaging apps, Skills) hosts one slot:
// the page wraps its body in <AdvancedHost>, puts <AdvancedSlotTarget/> inside its AdvancedSection, and a card sends
// its Advanced part through <InAdvanced>. Closed Advanced mounts no target, so the part is not rendered; a card used
// outside a host renders its part inline.
const AdvancedSlotContext = createContext<{ slot: HTMLElement | null; setSlot: (element: HTMLElement | null) => void } | null>(null);

export function AdvancedHost({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const value = useMemo(() => ({ slot, setSlot }), [slot]);
  return <AdvancedSlotContext.Provider value={value}>{children}</AdvancedSlotContext.Provider>;
}

export function AdvancedSlotTarget() {
  const host = useContext(AdvancedSlotContext);
  return <div ref={host?.setSlot} className="space-y-4" />;
}

export function InAdvanced({ children }: { children: ReactNode }) {
  const host = useContext(AdvancedSlotContext);
  if (!host) return <>{children}</>;
  return host.slot ? createPortal(children, host.slot) : null;
}
