import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Copy, Info, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { sw } from "@/lib/settings-words";
import { setSettingsMode, type SettingsMode } from "@/lib/settings-mode";
import { advancedRegionId, type AdvancedSectionProps } from "@/lib/settings-cards";
import { noteAdvancedFoldOpened } from "@/lib/settings-mode";
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
        onClick={() => { if (!open) noteAdvancedFoldOpened(); onOpenChange(!open); }}
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

/** SIMPLE-COPY 0.1: the longer help of a card, behind one text button (never a <details>, which the settings files ban).
 *  Closed in Simple, open in Advanced (the button stays, so both modes show the same card). The region is mounted only
 *  while open, so closed text never reaches the page text, search highlight or a word count. Toggling never changes the
 *  Settings mode, and a person's own choice in Simple survives a trip to Advanced and back. */
export function HowThisWorks({ id, mode, children }: { id: string; mode?: SettingsMode; children: ReactNode }) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = mode === "advanced" || localOpen;
  return (
    <div className="mt-3">
      <button
        type="button"
        data-how-this-works
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setLocalOpen((value) => !value)}
        className="inline-flex min-h-8 items-center gap-1.5 rounded-md px-1 text-[12.5px] text-ink-secondary hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-md:min-h-11"
      >
        <Info size={14} aria-hidden />
        {sw("settings.howThisWorks")}
      </button>
      {open && (
        <div id={id} role="region" aria-label={sw("settings.howThisWorks")} data-how-this-works-region className="mt-2 space-y-2 text-[12.5px] leading-relaxed text-ink-secondary">
          {children}
        </div>
      )}
    </div>
  );
}

/** SIMPLE-COPY 0.2: the steps, fields and connection buttons of a messaging app behind one secondary button in Simple.
 *  The region opens by itself while setup is under way (`forceOpen`) and when the person presses the button; it never
 *  closes itself while open. Advanced shows the children with no button. While closed, the card's landing mark sits on
 *  the button (`controlAnchor`), so a card anchor never points at an unmounted field. Pressing the button on a fresh
 *  card puts the cursor in the first field. */
export function SetupArea({ id, mode, label, forceOpen = false, controlAnchor, arrivalAnchor, focusFirst = true, children }: {
  id: string; mode: SettingsMode; label: string; forceOpen?: boolean; controlAnchor?: string; arrivalAnchor?: string | null; focusFirst?: boolean; children: ReactNode;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const pressed = useRef(false);
  const region = useRef<HTMLDivElement>(null);
  const open = mode === "advanced" || localOpen || forceOpen;
  // SIMPLE-COPY A10: the shell's arrival anchor (a search result or a link) names this card, so the area opens itself and
  // the cursor lands in its first field, exactly as if the person had pressed the button. Opens only; never closes.
  useEffect(() => {
    if (!controlAnchor || arrivalAnchor !== controlAnchor) return;
    pressed.current = true;
    setLocalOpen(true);
  }, [arrivalAnchor, controlAnchor]);
  // The cursor waits (3 seconds at most) for the first field that is not disabled: a card whose status is still loading
  // renders its fields disabled, and a later render of the card lands the cursor once they are ready. Any key or click
  // of the owner's own ends the wait, so the cursor never jumps away from where they went.
  const waitingSince = useRef(0);
  const settling = useRef(false);
  const releaseWait = useCallback(() => { waitingSince.current = 0; pressed.current = false; }, []);
  useEffect(() => {
    if (!open || !pressed.current || !focusFirst) return;
    if (!waitingSince.current) waitingSince.current = Date.now();
    if (Date.now() - waitingSince.current > 3000) { releaseWait(); return; }
    const field = region.current?.querySelector<HTMLElement>("input:not([disabled]), select:not([disabled]), textarea:not([disabled])");
    if (!field) return;
    field.focus();
    if (settling.current) return;
    // Stay pending for a short moment (another card's first status may take the cursor as it lands), then settle.
    settling.current = true;
    const stop = () => { settling.current = false; releaseWait(); document.removeEventListener("keydown", stop, true); document.removeEventListener("pointerdown", stop, true); window.clearTimeout(timer); };
    const timer = window.setTimeout(stop, 800);
    document.addEventListener("keydown", stop, true);
    document.addEventListener("pointerdown", stop, true);
  });
  if (mode === "advanced") return <>{children}</>;
  return (
    <div className="mt-3">
      {!open && (
        <button
          type="button"
          data-setup-area-button
          {...(controlAnchor ? { "data-setting-control": controlAnchor } : {})}
          aria-expanded={false}
          aria-controls={id}
          onClick={() => { pressed.current = true; setLocalOpen(true); }}
          className="min-h-9 rounded-lg border border-hairline/40 px-3 py-2 text-[12px] text-ink hover:bg-raised-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-md:min-h-11"
        >
          {label}
        </button>
      )}
      {open && (
        <div ref={region} id={id} role="group" aria-label={label} data-setup-area-region>
          {children}
        </div>
      )}
    </div>
  );
}

/** The "Set in Advanced" button that takes a person to a card only Advanced shows. It flips Advanced mode on, then
 *  scrolls to the named heading once it has rendered. */
export function SetInAdvancedButton({ anchor }: { anchor: string }) {
  return (
    <button
      type="button"
      data-set-in-advanced-button={anchor}
      onClick={() => {
        setSettingsMode("advanced");
        let tries = 0;
        const timer = window.setInterval(() => {
          const target = document.getElementById(anchor);
          if (target || ++tries > 15) {
            window.clearInterval(timer);
            target?.scrollIntoView?.({ block: "start" });
            // The target is a heading or a note: give it a tab stop of its own so the cursor follows the scroll.
            if (target && !target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
            target?.focus?.({ preventScroll: true });
          }
        }, 100);
      }}
      className="min-h-8 rounded-md px-1.5 text-[12.5px] font-medium text-ink underline underline-offset-2 hover:bg-control/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-md:min-h-11"
    >
      {sw("settings.mode.setInAdvanced")}
    </button>
  );
}

// A page whose cards live in components that also hold an Advanced part (the messaging apps, Skills) hosts one slot:
// the page wraps its body in <AdvancedHost>, puts <AdvancedSlotTarget/> inside its AdvancedSection, and a card sends
// its Advanced part through <InAdvanced>. Closed Advanced mounts no target, so the part is not rendered; a card used
// outside a host renders its part inline.
// A page whose registry cards each own one part of such a component (Messaging apps: the Slack card and its private
// setup card) names its slots: <AdvancedSlotTarget name="slack-setup"/> receives <InAdvanced slot="slack-setup">.
const AdvancedSlotContext = createContext<{ slots: Record<string, HTMLElement | null>; setSlot: (name: string, element: HTMLElement | null) => void } | null>(null);

export function AdvancedHost({ children }: { children: ReactNode }) {
  const [slots, setSlots] = useState<Record<string, HTMLElement | null>>({});
  const setSlot = useCallback((name: string, element: HTMLElement | null) => setSlots((current) => (current[name] === element ? current : { ...current, [name]: element })), []);
  const value = useMemo(() => ({ slots, setSlot }), [slots, setSlot]);
  return <AdvancedSlotContext.Provider value={value}>{children}</AdvancedSlotContext.Provider>;
}

export function AdvancedSlotTarget({ name = "", className = "space-y-4" }: { name?: string; className?: string }) {
  const host = useContext(AdvancedSlotContext);
  const setSlot = host?.setSlot;
  const ref = useCallback((element: HTMLElement | null) => setSlot?.(name, element), [setSlot, name]);
  return <div ref={ref} className={className} />;
}

/** PartsHost cards and named Advanced slots share the same forwarding component. */
export function InAdvanced({ children, part, slot = "" }: { children: ReactNode; part?: string; slot?: string }) {
  const cards = useContext(PartsContext);
  const host = useContext(AdvancedSlotContext);
  if (cards) return part ? <Part id={part}>{children}</Part> : null;
  if (!host) return <>{children}</>;
  const target = host.slots[slot] ?? null;
  return target ? createPortal(children, target) : null;
}

// A page whose cards are made of pieces of one stateful component (Memory, Models and engines, Search/images/dictation)
// hosts the component once and gives every card a slot: the page wraps its body in <PartsHost>, each card renders
// <PartSlot id="<registry id>"/>, and the component sends each piece to its card with <Part id="<registry id>"> (or
// <InAdvanced part="...">). A card Simple leaves out mounts no slot, so its piece is not rendered; a piece used outside
// a host (the same component inside a bot's page) renders inline. Inside a host a piece with no card renders nowhere,
// and the page's control-survival test names it.
const PartsContext = createContext<{ targets: Record<string, HTMLElement | null>; setTarget: (id: string, element: HTMLElement | null) => void } | null>(null);

export function PartsHost({ children }: { children: ReactNode }) {
  const [targets, setTargets] = useState<Record<string, HTMLElement | null>>({});
  const setTarget = useCallback((id: string, element: HTMLElement | null) => setTargets((previous) => (previous[id] === element ? previous : { ...previous, [id]: element })), []);
  const value = useMemo(() => ({ targets, setTarget }), [targets, setTarget]);
  return <PartsContext.Provider value={value}>{children}</PartsContext.Provider>;
}

/** `card`: draws the card's surface around pieces that have none of their own; an empty slot draws nothing. */
export function PartSlot({ id, card = false }: { id: string; card?: boolean }) {
  const host = useContext(PartsContext);
  const setTarget = host?.setTarget;
  const ref = useCallback((element: HTMLElement | null) => setTarget?.(id, element), [setTarget, id]);
  return <div ref={ref} data-part-slot={id} className={card ? "min-w-0 space-y-4 rounded-xl bg-card p-4 empty:hidden" : "min-w-0 space-y-4 empty:hidden"} />;
}

export function Part({ id, children }: { id: string; children: ReactNode }) {
  const host = useContext(PartsContext);
  if (!host) return <>{children}</>;
  const target = host.targets[id];
  return target ? createPortal(children, target) : null;
}
