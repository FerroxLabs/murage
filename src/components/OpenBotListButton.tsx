// The phone's way into the bot list, drawn INSIDE each main view's header row.
//
// It used to float over the chat column from App.tsx, absolutely positioned
// at `top: 0.75rem + inset`. That could only approximate the centre of a row
// it was not part of: on an iPhone and a Samsung the icon sat a few points
// above the bot's name while the ••• on the same row lined up. As the first
// item of the header's own `items-center` flex row it is centred with the
// avatar, the name and the ••• by construction.
//
// App.tsx owns the drawer, so it provides the state through context and every
// header renders <OpenBotListButton /> as its first item. Outside the provider
// (a header mounted on its own in a fixture, the calendar focus view) it
// renders nothing. `md:hidden` keeps it off the desktop, where the sidebar is
// always on screen.
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Menu } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

export interface BotListDrawerControl {
  /** Whether the drawer is open (the button's aria-expanded). */
  expanded: boolean;
  open: () => void;
  /** Only one main view is mounted at a time, so the one button on screen
   * owns this ref. */
  buttonRef: RefObject<HTMLButtonElement | null>;
  /** True once, right after the drawer closed on a pick or Escape: the button
   * a newly mounted view draws takes focus (see useBotListDrawer). */
  takeFocusReturn: () => boolean;
}

const BotListDrawerContext = createContext<BotListDrawerControl | null>(null);

/** How long a close's focus return waits for the view it opened to mount its
 * own button. Long enough for the effect-driven second commit (App.tsx drops
 * a Browser or VM workspace in an effect after the selection changes), short
 * enough that a button mounted by some later, unrelated change never grabs
 * focus. Any pointer or key press by the person ends it sooner. */
const FOCUS_RETURN_WINDOW_MS = 1000;

/** App.tsx's drawer state, and the focus return that goes with it.
 *
 * Closing the drawer by picking a row or pressing Escape sends focus back to
 * the "Open bot list" button. That cannot be a `.focus()` in the close
 * handler: the same click usually changes the view (bot chat to room, Team
 * map to a chat), and the button on screen at the click is the OLD view's,
 * about to unmount and drop focus to <body>. So closing raises a flag, and:
 *
 * - a button that MOUNTS while the flag is up focuses itself and lowers it.
 *   That covers a view swapped in the same commit (bot to room) and one
 *   swapped a commit later (a workspace App.tsx clears in an effect);
 * - a layout effect here focuses the button that is already on screen, for
 *   the pick that keeps the same view (bot to bot), where nothing remounts.
 *
 * The flag also drops after FOCUS_RETURN_WINDOW_MS or at the person's next
 * pointer or key press. Opening the drawer never moves focus.
 *
 * `enabled: false` (the calendar focus view) provides no control, so no
 * button is drawn. */
export function useBotListDrawer(enabled: boolean) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const [closeTick, setCloseTick] = useState(0);
  const openDrawer = useCallback(() => {
    returnFocus.current = false;
    setDrawerOpen(true);
  }, []);
  /** Close and send focus back to the bot-list button (a pick, or Escape). */
  const closeDrawer = useCallback(() => {
    returnFocus.current = true;
    setDrawerOpen(false);
    setCloseTick((tick) => tick + 1);
  }, []);
  const takeFocusReturn = useCallback(() => {
    if (!returnFocus.current) return false;
    returnFocus.current = false;
    return true;
  }, []);
  // The view the close committed with: focus its button if it is still up.
  useLayoutEffect(() => {
    if (drawerOpen || !returnFocus.current) return;
    buttonRef.current?.focus();
  }, [closeTick, drawerOpen]);
  // The window for a later-mounted button, ended early by the person.
  useEffect(() => {
    if (!closeTick) return;
    const end = () => {
      returnFocus.current = false;
    };
    const timer = setTimeout(end, FOCUS_RETURN_WINDOW_MS);
    document.addEventListener("pointerdown", end, true);
    document.addEventListener("keydown", end, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerdown", end, true);
      document.removeEventListener("keydown", end, true);
    };
  }, [closeTick]);
  const control = useMemo<BotListDrawerControl | null>(
    () => (enabled ? { expanded: drawerOpen, open: openDrawer, buttonRef, takeFocusReturn } : null),
    [enabled, drawerOpen, openDrawer, takeFocusReturn],
  );
  /** The drawer was closed by an effect (App's closeKey: something opened
   * over the chat) while focus was still inside it (Sidebar's onReturnFocus,
   * drawer-close.ts). The same return as closeDrawer's: the button on screen
   * now, or the one the next view mounts. */
  const returnDrawerFocus = useCallback(() => {
    returnFocus.current = true;
    buttonRef.current?.focus();
    setCloseTick((tick) => tick + 1);
  }, []);
  return { drawerOpen, setDrawerOpen, closeDrawer, returnDrawerFocus, control };
}

export function BotListDrawerProvider({ value, children }: { value: BotListDrawerControl | null; children: ReactNode }) {
  return <BotListDrawerContext.Provider value={value}>{children}</BotListDrawerContext.Provider>;
}

/** The button itself, without the context: what the tests click. */
export function BotListButton({ control, className }: { control: BotListDrawerControl; className?: string }) {
  return (
    <button
      type="button"
      ref={control.buttonRef}
      aria-label="Open bot list"
      title={t("nav.tip.openBotList")}
      aria-expanded={control.expanded}
      onClick={control.open}
      data-open-bot-list
      // What an overlay opened from the closed, inert drawer gives focus to
      // (return-focus.ts): one main view is mounted, so one button.
      data-focus-fallback=""
      className={cn("shrink-0 rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink md:hidden", className)}
    >
      <Menu size={18} />
    </button>
  );
}

/** The button as a view mounts it: it takes focus when it arrives right
 * after the drawer closed (useBotListDrawer). The ref is attached before this
 * layout effect runs, so it names this very button. */
function MountedBotListButton({ control, className }: { control: BotListDrawerControl; className?: string }) {
  const { buttonRef, takeFocusReturn } = control;
  useLayoutEffect(() => {
    if (takeFocusReturn()) buttonRef.current?.focus();
  }, [buttonRef, takeFocusReturn]);
  return <BotListButton control={control} className={className} />;
}

export function OpenBotListButton({ className }: { className?: string }) {
  const control = useContext(BotListDrawerContext);
  if (!control) return null;
  return <MountedBotListButton control={control} className={className} />;
}

/** For a main view with no header row of its own (the no-engines screen, the
 * loading state): a phone-only row at the top, below the status bar, that
 * carries the button and nothing else. */
export function PhoneBotListBar() {
  const control = useContext(BotListDrawerContext);
  if (!control) return null;
  return (
    <div className="flex shrink-0 items-center px-3 pt-[calc(0.75rem+env(safe-area-inset-top))] md:hidden">
      <MountedBotListButton control={control} />
    </div>
  );
}
