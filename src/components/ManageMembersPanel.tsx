// Edit an existing room's roster: the same picker "New Room" uses, opened
// from the member embers in the room header and pre-ticked with who is
// already in. Membership is the only thing this touches — the transcript
// keeps every message a departing bot already sent.
import { useFocusTrap } from "@/lib/focus-trap";
import { LayerSurface } from "@/components/LayerSurface";
import { useMemo, useRef, useState, type RefObject } from "react";
import { track } from "@/lib/analytics";
import { useStore, type Group } from "@/state/store";
import { BotPickerList } from "./BotPickerList";
import { nextMemberIds } from "@/lib/room-members";
import { BOX_FRAME, BoxBody, BoxFoot, BoxHead } from "./ui/BoxShell";

export function ManageMembersPanel({
  group,
  onClose,
  triggerRef,
}: {
  group: Group;
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const { state, dispatch } = useStore();
  const [picked, setPicked] = useState<Set<string>>(() => new Set(group.memberIds));
  const [saveError, setSaveError] = useState<string | null>(null);
  const openedMemberIds = useRef([...group.memberIds]);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Archived bots stay listed while they are still members — otherwise a
  // room could keep a member you have no way to remove.
  const bots = useMemo(
    () => state.bots.filter((b) => !b.hidden || group.memberIds.includes(b.id)),
    [state.bots, group.memberIds],
  );

  const layer = useFocusTrap(dialogRef, true, { name: "manage-members", kind: "dialog", returnFocusTo: triggerRef.current, onEscape: onClose });

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const memberIds = nextMemberIds(
    group.memberIds,
    picked,
    bots.map((b) => b.id),
  );
  const changed = memberIds.length !== group.memberIds.length || memberIds.some((id, i) => id !== group.memberIds[i]);

  const save = () => {
    if (!memberIds.length) return;
    const opened = openedMemberIds.current;
    const rosterChanged =
      opened.length !== group.memberIds.length || opened.some((id, index) => id !== group.memberIds[index]);
    if (rosterChanged) {
      setSaveError("This channel's members changed while the panel was open. Close it and try again.");
      return;
    }
    if (changed) {
      dispatch({ type: "patchGroup", groupId: group.id, patch: { memberIds } });
      track("room_members_changed", {
        members: memberIds.length,
        added: memberIds.filter((id) => !group.memberIds.includes(id)).length,
        removed: group.memberIds.filter((id) => !memberIds.includes(id)).length,
      });
    }
    onClose();
  };

  return <LayerSurface handle={layer}><div
      className="overlay-inset fixed inset-0 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Manage members of ${group.name}`}
        className={`${BOX_FRAME} max-h-[calc(var(--vvh,100dvh)-2rem)] w-[340px] rounded-2xl border border-hairline/50 bg-card shadow-2xl`}
      >
        <BoxHead className="block border-b border-hairline/40 px-4 pb-3 pt-4">
        <div className="mb-1 text-[15px] font-semibold text-ink">Manage Members</div>
        <div className="truncate text-[13px] text-ink-secondary">{group.name}</div>
        </BoxHead>
        <BoxBody className="px-4 py-3">
        <BotPickerList bots={bots} picked={picked} onToggle={toggle} emptyHint="Create a bot first; channels are made of bots." bounded={false} />
        {!memberIds.length && <div className="mt-2 text-[12px] text-ink-secondary">A channel needs at least one bot.</div>}
        {saveError && (
          <div role="alert" className="mt-2 text-[12px] text-danger">
            {saveError}
          </div>
        )}
        </BoxBody>
        <BoxFoot className="border-t border-hairline/40 px-4 py-3">
          <button
            onClick={onClose}
            className="flex-1 rounded-lg bg-raised py-2 text-[14px] font-medium text-ink hover:brightness-110"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={!memberIds.length}
            className="flex-1 rounded-lg bg-accent py-2 text-[14px] font-medium text-white hover:brightness-110 disabled:opacity-40"
          >
            Save{memberIds.length ? ` · ${memberIds.length} ${memberIds.length === 1 ? "bot" : "bots"}` : ""}
          </button>
        </BoxFoot>
      </div>
    </div></LayerSurface>;
}
