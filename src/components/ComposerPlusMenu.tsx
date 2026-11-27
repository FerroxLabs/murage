// The phone composer's round + (see Composer.tsx). On a phone the composer is
// the + beside one pill holding the field and the mic, so
// the controls that sit in the desktop composer's lower row live here instead:
// Attach a file, Finish together (rooms) and the approval level. Nothing is
// removed, it is one tap further.
//
// The list is the chat header's menu (ChatHeaderMenu): WAI-ARIA menu button,
// arrows/Home/End, Escape and Tab close and return focus to the + button. The
// approval level opens the SAME level menu the desktop chip opens
// (PermissionModeMenu), above the + button, with Escape, Tab and an outside press
// closing it and focus going back to the + button.
//
// On a phone (the level sheet's own test: a narrow viewport that is not the
// desktop app) the + opens a bottom sheet instead (1.0.20): Camera, Photos and
// Files, then Finish together and the approval level. Anywhere else the menu
// above is unchanged.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { inPhoneSheet } from "@/components/phone/sheet-layer";
import { ComposerPlusSheet, composerSourceRows, type ComposerPlusSheetRow, type ComposerPlusSources } from "@/components/phone/ComposerPlusSheet";
import { useNarrowViewport } from "@/lib/media-query";
import { useDesktopSurface } from "@/lib/use-surface";
import { Hand, Paperclip, Plus, Target } from "lucide-react";

import { ChatHeaderMenu, type HeaderMenuItem } from "./ChatHeaderMenu";

export interface ComposerPlusApproval {
  /** The current level as the chip words it: "Ask", "Auto", "Full access". */
  current: string;
  /** The level cannot be changed right now (the bot is working). */
  disabled?: boolean;
  /** The level menu; `done` closes it and returns focus to the + button. */
  renderMenu: (done: () => void) => ReactNode;
  /** The icon of the current level. */
  icon?: ReactNode;
}

export interface ComposerPlusMenuProps {
  onAttach: () => void;
  attachDisabled?: boolean;
  /** The phone sheet's three pickers; each starts its input from the tap itself. */
  sources?: ComposerPlusSources;
  /** Finish together: present in a room only. */
  goal?: { on: boolean; disabled?: boolean; onToggle: () => void };
  approval?: ComposerPlusApproval;
}

/** The one test for "the + opens a sheet": the level sheet's own. A narrowed desktop window keeps the menu. */
export function usePhonePlusSheet(): boolean {
  const narrow = useNarrowViewport();
  const desktop = useDesktopSurface();
  return narrow && desktop === false;
}

export function composerPlusItems({ onAttach, attachDisabled, goal, approval }: ComposerPlusMenuProps, openApproval: () => void): HeaderMenuItem[] {
  return [
    {
      id: "attach",
      label: "Attach a file",
      icon: <Paperclip size={16} />,
      disabled: attachDisabled,
      onSelect: onAttach,
    },
    ...(goal
      ? [{
          id: "goal",
          label: "Finish together",
          description: "The team keeps working until the goal is complete",
          icon: <Target size={16} />,
          checked: goal.on,
          disabled: goal.disabled,
          onSelect: goal.onToggle,
        } satisfies HeaderMenuItem]
      : []),
    ...(approval
      ? [{
          id: "approval",
          label: "Approval level",
          description: approval.current,
          icon: approval.icon ?? <Hand size={16} />,
          disabled: approval.disabled,
          onSelect: openApproval,
        } satisfies HeaderMenuItem]
      : []),
  ];
}

/** The sheet's rows: the three sources, then the menu's own Finish together and Approval level (same words, same actions). */
export function composerPlusSheetRows(props: ComposerPlusMenuProps & { sources: ComposerPlusSources }, openApproval: () => void): ComposerPlusSheetRow[] {
  const rest = composerPlusItems(props, openApproval)
    .filter((item) => item.id !== "attach")
    .map((item): ComposerPlusSheetRow => ({
      id: item.id,
      label: item.label,
      description: item.description,
      icon: item.icon,
      disabled: item.disabled,
      pressed: item.checked,
      onPress: item.onSelect,
    }));
  return [...composerSourceRows(props.sources, props.attachDisabled), ...rest];
}

export function ComposerPlusMenu(props: ComposerPlusMenuProps) {
  const { approval } = props;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const sheetMode = usePhonePlusSheet() && props.sources !== undefined;
  const closeApproval = () => {
    setApprovalOpen(false);
    triggerRef.current?.focus();
  };
  const closeSheet = () => {
    setSheetOpen(false);
  };
  // After the sheet has left the page (its focus trap has let go), focus goes back to the +: a phone does not always focus a button it was tapped on.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (sheetOpen) { wasOpen.current = true; return; }
    if (wasOpen.current) { wasOpen.current = false; triggerRef.current?.focus(); }
  }, [sheetOpen]);
  const items = composerPlusItems(props, () => setApprovalOpen(true));

  useEffect(() => {
    if (!approvalOpen) return;
    panelRef.current?.querySelector<HTMLElement>('[role="menuitemradio"]:not(:disabled)')?.focus();
    // A phone sheet holds its own keys: Tab moves inside it, Escape is its Close.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "Tab") return;
      if (inPhoneSheet(event.target)) return;
      event.preventDefault();
      setApprovalOpen(false);
      triggerRef.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !panelRef.current?.contains(event.target) && !inPhoneSheet(event.target)) setApprovalOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [approvalOpen]);

  return (
    <div className="relative flex shrink-0 items-center" data-composer-plus-root>
      {sheetMode && props.sources ? (
        <>
          <button
            ref={triggerRef}
            type="button"
            aria-label="Message options"
            title="Message options"
            aria-haspopup="dialog"
            aria-expanded={sheetOpen}
            data-composer-plus=""
            onClick={() => setSheetOpen((open) => !open)}
            className="flex size-11 items-center justify-center rounded-full bg-raised text-ink hover:bg-raised-hover focus-visible:outline-2 focus-visible:outline-focus"
          >
            <Plus size={22} aria-hidden="true" />
          </button>
          {sheetOpen && <ComposerPlusSheet rows={composerPlusSheetRows({ ...props, sources: props.sources }, () => setApprovalOpen(true))} onClose={closeSheet} />}
        </>
      ) : (
        <ChatHeaderMenu
          items={items}
          label="Message options"
          menuLabel="Composer actions"
          triggerRef={triggerRef}
          variant="composer-plus"
        />
      )}
      {approval && approvalOpen && (
        <div
          ref={panelRef}
          data-composer-approval-panel
          className="absolute bottom-full left-0 z-40 mb-2 [&>[role=menu]]:static [&>[role=menu]]:mb-0 [&>[role=menu]]:max-h-[70dvh] [&>[role=menu]]:w-[min(20rem,calc(100vw-1.5rem))] [&>[role=menu]]:overflow-y-auto"
        >
          {approval.renderMenu(closeApproval)}
        </div>
      )}
    </div>
  );
}
