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
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Hand, Paperclip, Target } from "lucide-react";

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
  /** Finish together: present in a room only. */
  goal?: { on: boolean; disabled?: boolean; onToggle: () => void };
  approval?: ComposerPlusApproval;
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

export function ComposerPlusMenu(props: ComposerPlusMenuProps) {
  const { approval } = props;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const closeApproval = () => {
    setApprovalOpen(false);
    triggerRef.current?.focus();
  };
  const items = composerPlusItems(props, () => setApprovalOpen(true));

  useEffect(() => {
    if (!approvalOpen) return;
    panelRef.current?.querySelector<HTMLElement>('[role="menuitemradio"]:not(:disabled)')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "Tab") return;
      event.preventDefault();
      setApprovalOpen(false);
      triggerRef.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !panelRef.current?.contains(event.target)) setApprovalOpen(false);
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
      <ChatHeaderMenu
        items={items}
        label="Message options"
        menuLabel="Composer actions"
        triggerRef={triggerRef}
        variant="composer-plus"
      />
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
