import { track } from "@/lib/analytics";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ArrowDownToLine,
  BellDot,
  BookOpen,
  Bot as BotIcon,
  CalendarDays,
  Check,
  ClipboardCopy,
  Copy,
  Crown,
  Eye,
  EyeOff,
  FolderMinus,
  FolderPlus,
  Library,
  Loader2,
  MoreHorizontal,
  Network,
  Pencil,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Settings,
  Puzzle,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { api, useStore, formatTime, visibleMessages, type Bot, type Group } from "@/state/store";

import { BotAvatar, InitialsAvatar } from "./Avatar";
import { ConfirmDelete } from "./ConfirmDelete";
import { stateForBot } from "@/lib/mascot";
import { useUpdaterState } from "@/lib/updater";
import { cn } from "@/lib/cn";
import { skillRecorderEnabled } from "@/lib/feature-flags";
import { nextRename } from "@/lib/rename";
import { TeamExportDialog } from "./TeamExportDialog";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { MIN_QUERY, SearchResults } from "./SearchResults";
import {
  TeamLibraryPanel,
  archivedRestorePatch,
  teamImportSkillSummary,
  type ArchivedTeamBot,
  type TeamImportResult,
  type TeamImportSkillError,
} from "./TeamLibraryPanel";
import { RenameTitle } from "./RenameTitle";
import { RoleIcon } from "./RoleBadge";
import { botRole, botRolePatch, BOT_ROLE_BADGE, BOT_ROLE_TITLE } from "@/lib/bot-role";
import { BotPickerList } from "./BotPickerList";
import {
  loadCollapsedSections,
  loadSectionOrder,
  loadSidebarDensity,
  saveCollapsedSections,
  saveSectionOrder,
  saveSidebarDensity,
  toggleCollapsedSection,
  type SidebarDensity,
} from "@/lib/sidebar-preferences";
import {
  BOT_CHATS_SECTION_ID,
  BOTS_SECTION_ID,
  CHANNELS_SECTION_ID,
  PINNED_SECTION_ID,
  mergeSectionOrder,
  moveSection,
  orderedSidebarSections,
  partitionSidebarBots,
  partitionSidebarGroups,
  placeSection,
  sameSectionOrder,
  sidebarGoalRunPreview,
  sidebarLayoutInteractive,
  sidebarSectionCollapsed,
  sidebarSectionLabel,
  userSectionId,
  userSectionName,
  type SectionDropPlace,
} from "@/lib/sidebar-layout";
import { sidebarSectionAttention } from "@/lib/sidebar-attention";
import { phoneSettingsAction, SidebarPhoneButton } from "./SidebarPhoneButton";
import { useDesktopSurface } from "@/lib/use-surface";
import { SidebarMoreMenu } from "./SidebarMoreMenu";
import { SidebarSectionHeader } from "./SidebarSectionHeader";

/** What the bottom-left toast is currently saying. `detail` is a second,
 *  quieter line: present when something about the thing that just happened
 *  is worth knowing but is not the headline. */
export interface TeamFeedback {
  error: boolean;
  text: string;
  detail?: string;
  undo?: TeamImportResult;
  restoreBot?: { id: string; name: string };
}

/** Every PATCH the team-import undo sends to put the previous roster back:
 *  one per archived bot, no exceptions and no bespoke bodies.
 *
 *  Both halves of that matter, because both were once wrong here. The undo
 *  used to split the archive in two and hand-write the chief half's body as
 *  `{ hidden: false, chiefOfStaff: true }` — an election with no tier, which
 *  the org chart (src/lib/bot-role.ts) reads as a SECTION lead, so pressing
 *  Undo demoted the workspace Chief and said nothing. It stopped showing
 *  only once the harness began keeping her tier on the archived record and
 *  reading a bare election against it; that is a net under the client, not
 *  the contract. One map through `archivedRestorePatch` states the tier
 *  outright, and leaves no second branch for a tier-less body to live in. */
export function teamUndoRestores(
  archived: ArchivedTeamBot[],
): Array<{ id: string; body: ReturnType<typeof archivedRestorePatch> }> {
  return archived.map((bot) => ({ id: bot.id, body: archivedRestorePatch(bot) }));
}

/** The second line of the team-import toast, or "" when the import was
 *  whole.
 *
 *  A team can land with fewer skills than its profile promised: the harness
 *  answers 201 with the bots it made and a `skillErrors` list beside them.
 *  It used to print that list to a console nobody reads, so somebody was
 *  told "loaded" and got an assistant quietly short of the thing it was
 *  hired for.
 *
 *  The tone is deliberate. A short import is NOT a failed one — the bots
 *  exist, the rooms exist, and the toast keeps its ordinary styling and its
 *  ordinary headline. The shortfall is a quieter second line rather than a
 *  louder first one, so the eye reads "team loaded" and then "and here is
 *  what is missing", which is the true order of those two facts.
 *
 *  There is no denominator to quote. The response carries the failures, not
 *  the total the profile declared, so this counts what went wrong and never
 *  invents an "n of m". `install` and `enable` are kept apart because a
 *  skill that never arrived and a skill sitting there switched off are
 *  different things to go and fix. */
export function teamImportShortfall(result: { skillErrors: TeamImportSkillError[] }): string {
  const { failed, unavailable, disabled } = teamImportSkillSummary(result);
  if (failed === 0) return "";
  const clauses: string[] = [];
  if (unavailable > 0) {
    clauses.push(`${unavailable} ${unavailable === 1 ? "skill" : "skills"} could not be installed`);
  }
  if (disabled > 0) {
    clauses.push(`${disabled} ${disabled === 1 ? "skill" : "skills"} arrived switched off`);
  }
  // Naming the one bot is worth the words; naming nine is a wall of text.
  const names = [...new Set(result.skillErrors.map((entry) => entry.botName))];
  const who = names.length === 1 ? ` for ${names[0]}` : ` across ${names.length} bots`;
  return `${clauses.join(" and ")}${who}.`;
}

/** The toast a finished team import puts up.
 *
 *  Never an error, even when skills were lost: the bots and rooms landed,
 *  and a red toast over a working team would be wrong in the other
 *  direction. Undo is offered only when there is a previous roster to put
 *  back. */
export function teamImportFeedback(result: TeamImportResult): TeamFeedback {
  return {
    error: false,
    text: `${result.name} loaded · ${result.members} ${result.members === 1 ? "bot" : "bots"}`,
    detail: teamImportShortfall(result),
    undo: result.archived.length > 0 ? result : undefined,
  };
}

/** The bottom-left toast itself. Headline, an Undo where one applies, and
 *  the quiet second line underneath. */
export function TeamFeedbackToast({
  feedback,
  onUndoTeam,
  onUndoBot,
}: {
  feedback: TeamFeedback;
  onUndoTeam: (undo: TeamImportResult) => void;
  onUndoBot: (bot: { id: string; name: string }) => void;
}) {
  // Pulled out of `feedback` so each handler closes over a value the type
  // system already knows is there, rather than re-reading a field it would
  // then have to be told again is not null.
  const { undo, restoreBot } = feedback;
  return (
    <div
      role="status"
      className={cn(
        "fixed bottom-4 left-4 z-[60] max-w-[300px] rounded-xl border px-3.5 py-2.5 text-[13px] shadow-xl",
        feedback.error ? "border-danger/30 bg-card text-danger" : "border-hairline/50 bg-card text-ink",
      )}
    >
      <div className="flex items-center gap-3">
        <span>{feedback.text}</span>
        {undo && (
          <button
            onClick={() => onUndoTeam(undo)}
            className="rounded-md px-1.5 py-0.5 font-medium text-accent hover:bg-raised"
          >
            Undo
          </button>
        )}
        {restoreBot && (
          <button
            onClick={() => onUndoBot(restoreBot)}
            className="rounded-md px-1.5 py-0.5 font-medium text-accent hover:bg-raised"
          >
            Undo
          </button>
        )}
      </div>
      {feedback.detail && (
        <p className="mt-1.5 text-[12px] leading-snug text-ink-secondary">{feedback.detail}</p>
      )}
    </div>
  );
}

/** "Milind Soni" → "MS", "milind" → "M", "you@x.dev" → "Y", unset → "?" */
function profileInitials(profile?: { name?: string; email?: string }): string {
  const name = profile?.name?.trim();
  if (name) {
    const words = name.split(/\s+/);
    return words
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("");
  }
  const email = profile?.email?.trim();
  return email ? email[0]!.toUpperCase() : "?";
}

/** Manual update check, next to the settings gear. Packaged app only (no
 * bridge in dev/browser). One button, state-dependent: check → download →
 * restart, with a brief "up to date" tick when a check finds nothing so a
 * click is never silent. The bottom-left popup handles the loud cases. */
function UpdateButton() {
  const s = useUpdaterState();
  const [checkedAt, setCheckedAt] = useState(0);
  const updater = window.muragebox?.updater;
  const status = s?.status ?? "idle";
  // download and install both round-trip through main before the status
  // changes — spin on the click itself, and let the new status clear it
  const [pending, setPending] = useState(false);
  useEffect(() => setPending(false), [status]);
  // a check that found nothing lands back on idle — acknowledge it for 3s
  const upToDate = Boolean(checkedAt) && (!s || s.status === "idle") && Date.now() - checkedAt < 3000;
  useEffect(() => {
    if (!upToDate) return;
    const timer = setTimeout(() => setCheckedAt(0), 3000);
    return () => clearTimeout(timer);
  }, [upToDate]);
  if (!updater) return null;

  const working =
    pending || status === "checking" || status === "downloading" || status === "installing";
  const label =
    status === "available"
      ? `Version ${s?.version ?? ""} available — download`
      : status === "downloading"
        ? s?.percent == null
          ? "Starting download…"
          : `Downloading… ${Math.round(s.percent)}%`
        : status === "downloaded"
          ? `Version ${s?.version ?? ""} ready — restart to update`
          : status === "installing"
            ? "Restarting to update…"
            : status === "checking"
              ? "Checking for updates…"
              : upToDate
                ? "You're up to date"
                : "Check for updates";

  return (
    <button
      onClick={() => {
        if (status === "downloaded") {
          setPending(true);
          return void updater.install();
        }
        if (status === "available") {
          setPending(true);
          return void updater.download();
        }
        setCheckedAt(Date.now());
        void updater.check();
      }}
      disabled={working}
      title={label}
      aria-label={label}
      className="relative flex size-10 items-center justify-center rounded-md text-accent hover:bg-raised disabled:opacity-60"
    >
      {working ? (
        <Loader2 size={18} className="animate-spin" />
      ) : upToDate ? (
        <Check size={18} />
      ) : status === "available" ? (
        <ArrowDownToLine size={18} />
      ) : (
        <RefreshCw size={18} />
      )}
      {status === "downloaded" && (
        <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-accent" />
      )}
    </button>
  );
}

function preview(bot: Bot): string {
  if (bot.activity === "waiting-on-you") return "Waiting for you…";
  if (bot.busy) return "Working…";
  // the visible branch's tail — bot.messages holds every fork, so its last
  // entry can belong to a version the user switched away from
  const last = visibleMessages(bot).at(-1);
  if (!last) return "";
  if (last.kind === "options" && last.card) return last.card.title;
  if (last.kind === "activity" && last.tool) return last.tool.name;
  if (last.kind === "screen") return "Screen frame";
  return last.text ?? "";
}

interface MenuState {
  botId: string;
  x: number;
  y: number;
}

function groupPreview(group: Group, bots: Bot[]): string {
  if (group.busyBotId) {
    return `${bots.find((b) => b.id === group.busyBotId)?.name ?? "A bot"} is working…`;
  }
  if (group.working) return "The team is working…";
  const last = group.messages.at(-1);
  if (!last) return `${group.memberIds.length} ${group.memberIds.length === 1 ? "bot" : "bots"}`;
  const text = last.kind === "activity" && last.tool
    ? last.tool.name
    : last.kind === "goal.run" && last.goalRun
      ? sidebarGoalRunPreview(last.goalRun)
      : (last.text ?? "");
  if (last.role === "user") return `You: ${text}`;
  return last.from ? `${last.from.name}: ${text}` : text;
}

/** Room avatar: 2–3 overlapping embers in the same 56px slot a bot gets. */
function StackedEmbers({ members, density }: { members: Bot[]; density: SidebarDensity }) {
  const iconOnly = density === "icons";
  const slotSize = iconOnly ? "size-12" : density === "compact" ? "size-10" : "size-14";
  const singleSize = iconOnly ? 44 : density === "compact" ? 40 : 56;
  if (members.length <= 1) {
    const b = members[0];
    return (
      <div className={cn("flex shrink-0 items-center justify-center", slotSize)}>
        {b ? <BotAvatar bot={b} state="happy" size={singleSize} animated={false} /> : <Users size={24} className="text-ink-secondary" />}
      </div>
    );
  }
  const shown = members.slice(0, 3);
  const extra = members.length - shown.length;
  return (
    <div className={cn("flex shrink-0 items-center justify-center", slotSize)}>
      <div className="flex items-center -space-x-3">
        {shown.map((b) => (
          <BotAvatar key={b.id} bot={b} state="happy" size={30} animated={false} />
        ))}
        {extra > 0 && (
          <span className="z-10 flex size-[22px] items-center justify-center rounded-full border border-hairline/40 bg-raised text-[10px] font-medium text-ink-secondary">
            +{extra}
          </span>
        )}
      </div>
    </div>
  );
}

function GroupListItem({
  group,
  density,
  onMenu,
  onNavigate,
}: {
  group: Group;
  density: SidebarDensity;
  onMenu: (menu: { groupId: string; x: number; y: number }) => void;
  onNavigate: () => void;
}) {
  const { state, dispatch } = useStore();
  const selected = state.activeView === "chat" && state.selectedId === group.id;
  const members = group.memberIds
    .map((id) => state.bots.find((b) => b.id === id))
    .filter((b): b is Bot => Boolean(b));
  const last = group.messages.at(-1);
  return (
    <button
      onClick={() => { dispatch({ type: "select", id: group.id }); onNavigate(); }}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ groupId: group.id, x: e.clientX, y: e.clientY });
      }}
      // the menu must be reachable without a pointer: Shift+F10, and the
      // dedicated ContextMenu key (whose native event carries no useful
      // coordinates) both open it centered on the row
      onKeyDown={(e) => {
        if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        onMenu({ groupId: group.id, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      }}
      className={cn(
        "relative flex w-full items-center rounded-xl text-left",
        density === "icons" ? "justify-center px-1 py-1.5" : density === "compact" ? "gap-2 px-2 py-1.5" : "gap-3 px-3 py-2.5",
        selected ? "bg-raised" : "hover:bg-raised/50",
      )}
      title={density === "icons" ? group.name : undefined}
      aria-label={density === "icons" ? group.name : undefined}
    >
      <StackedEmbers members={members} density={density} />
      <div className={cn("min-w-0 flex-1", density === "icons" && "hidden")}>
        <div className="flex items-baseline justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 text-[15px] font-semibold text-ink">
            <Users size={13} className="shrink-0 text-ink-secondary" aria-hidden="true" />
            <span className="truncate">{group.name}</span>
          </span>
          {selected && last && <span className="shrink-0 text-xs text-ink-secondary">{formatTime(last.at)}</span>}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[13px] text-ink-secondary">{groupPreview(group, state.bots)}</span>
          {group.unread && <span className="size-2 shrink-0 rounded-full bg-accent" />}
        </div>
      </div>
      {density === "icons" && group.unread && (
        <span className="absolute bottom-1.5 right-1.5 size-2 rounded-full border border-panel bg-accent" />
      )}
    </button>
  );
}

function RoomContextMenu({
  menu,
  onClose,
  onRequestDelete,
  onMoveToSection,
}: {
  menu: { groupId: string; x: number; y: number };
  onClose: () => void;
  onRequestDelete: (group: { id: string; name: string }) => void;
  onMoveToSection: (groupId: string) => void;
}) {
  const { state, dispatch } = useStore();
  const group = state.groups.find((g) => g.id === menu.groupId);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(group?.name ?? "");

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-room-menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  if (!group) return null;
  const isBotChat = Boolean(group.dm);
  const saveRename = () => {
    const name = nextRename(group.name, draft);
    if (name) dispatch({ type: "patchGroup", groupId: group.id, patch: { name } });
    onClose();
  };
  const top = Math.min(menu.y, window.innerHeight - 204);
  const left = Math.min(menu.x, window.innerWidth - 240);
  return createPortal(
    <div
      data-room-menu
      style={{ top, left }}
      className="fixed z-40 w-[228px] overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60"
    >
      {renaming ? (
        <div className="flex items-center gap-1 px-2 py-1">
          <input
            autoFocus
            value={draft}
            maxLength={100}
            aria-label={`Rename ${group.name}`}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                saveRename();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
            className="min-w-0 flex-1 rounded-lg bg-raised px-2 py-1.5 text-[14px] text-ink focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <button
            type="button"
            onClick={saveRename}
            aria-label={isBotChat ? "Save chat name" : "Save channel name"}
            title="Save"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <Check size={15} />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={isBotChat ? "Cancel chat rename" : "Cancel channel rename"}
            title="Cancel"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={15} />
          </button>
        </div>
      ) : (
        <button
          onClick={() => {
            setDraft(group.name);
            setRenaming(true);
          }}
          className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
        >
          <Pencil size={16} className="text-ink-secondary" />
          {isBotChat ? "Rename chat" : "Rename Channel"}
        </button>
      )}
      {!isBotChat && (
        <button
          onClick={() => {
            onClose();
            onMoveToSection(group.id);
          }}
          className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
        >
          <FolderPlus size={16} className="text-ink-secondary" />
          Move to context
        </button>
      )}
      <button
        onClick={() => {
          void navigator.clipboard?.writeText(group.threadId);
          onClose();
        }}
        className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
      >
        <ClipboardCopy size={16} className="text-ink-secondary" />
        Copy conversation ID
      </button>
      <button
        onClick={() => {
          if (group) onRequestDelete(group);
          onClose();
        }}
        className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-danger hover:bg-raised/70"
      >
        <Trash2 size={16} />
        {isBotChat ? "Delete chat" : "Delete Channel"}
      </button>
    </div>,
    document.body,
  );
}

/** Pick members and an optional Work/Personal/project context, then create. */
function NewRoomPanel({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [name, setName] = useState("");
  const [section, setSection] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const bots = state.bots.filter((b) => !b.hidden);
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const create = () => {
    if (!picked.size) return;
    dispatch({
      type: "createGroup",
      memberIds: [...picked],
      name: name.trim() || undefined,
      section: section.trim() || undefined,
    });
    track("room_created", { members: picked.size, context: Boolean(section.trim()) });
    onClose();
  };
  return (
    <div
      className="fixed inset-x-0 top-0 z-40 flex h-[var(--vvh,100dvh)] items-center justify-center bg-black/40"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-[340px] rounded-2xl border border-hairline/50 bg-card p-4 shadow-2xl">
        <div className="mb-3 text-[15px] font-semibold text-ink">New Channel</div>
        <input
          autoFocus
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
            if (e.key === "Escape") onClose();
          }}
          placeholder="Channel name (for example, Website launch)"
          className="mb-3 w-full rounded-lg bg-raised/70 px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        <input
          value={section}
          maxLength={60}
          onChange={(e) => setSection(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
            if (e.key === "Escape") onClose();
          }}
          placeholder="Context (optional): Work, Personal, Client…"
          aria-label="Channel context"
          className="mb-3 w-full rounded-lg bg-raised/70 px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        <BotPickerList
          bots={bots}
          picked={picked}
          onToggle={toggle}
          emptyHint="Create a bot first. Channels are made of bots."
        />
        <button
          onClick={create}
          disabled={!picked.size}
          className="mt-3 w-full rounded-lg bg-accent py-2 text-[14px] font-medium text-white hover:brightness-110 disabled:opacity-40"
        >
          Create Channel{picked.size ? ` · ${picked.size} ${picked.size === 1 ? "bot" : "bots"}` : ""}
        </button>
      </div>
    </div>
  );
}

/** Move-to-section popover: existing sections as chips (checkmark on the
 * target's current one), a create field, and a remove action. Serves bots
 * and channels alike — the caller supplies the assignment. Mirrors the
 * context menu's fixed positioning + dismiss-on-outside-click contract. */
function SectionPicker({
  current,
  anchor,
  onClose,
  onAssign,
}: {
  /** the target's current section; undefined = none */
  current: string | undefined;
  anchor: { x: number; y: number };
  onClose: () => void;
  /** "" clears — the server drops an empty section */
  onAssign: (section: string) => void;
}) {
  const { state } = useStore();
  const [name, setName] = useState("");
  const trimmed = name.trim();

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-section-picker]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  // Hidden bots can carry a stale assignment; don't offer it as a context.
  // Channels and bots share one namespace, so Work or Personal can hold both.
  const sections = [
    ...new Set([
      ...state.bots.filter((b) => !b.hidden && b.section).map((b) => b.section!),
      ...state.groups.filter((g) => g.section).map((g) => g.section!),
    ]),
  ];

  const assign = (section: string) => {
    onAssign(section);
    onClose();
  };

  const top = Math.max(8, Math.min(anchor.y, window.innerHeight - 300));
  const left = Math.min(anchor.x, window.innerWidth - 260);

  return (
    <div
      data-section-picker
      style={{ top, left }}
      className="fixed z-40 w-[236px] overflow-hidden rounded-xl border border-hairline/50 bg-card py-2 shadow-2xl shadow-black/60"
    >
      <div className="px-3.5 pb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
        Move to context
      </div>
      {sections.length > 0 && (
        <div className="flex flex-col gap-0.5 px-1.5 py-1">
          {sections.map((section) => (
            <button
              key={section}
              onClick={() => assign(section)}
              className={cn(
                "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px]",
                section === current ? "bg-raised text-ink" : "text-ink hover:bg-raised/70",
              )}
            >
              <span className="truncate">{section}</span>
              {section === current && <Check size={14} className="shrink-0 text-accent" />}
            </button>
          ))}
        </div>
      )}
      <form
        className="flex items-center gap-1.5 px-2.5 py-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (!trimmed || trimmed.length > 60) return;
          assign(trimmed);
        }}
      >
        <input
          autoFocus
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New context…"
          aria-label="New context name"
          className="w-full rounded-lg bg-raised/70 px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        <button
          type="submit"
          disabled={!trimmed || trimmed.length > 60}
          className={cn(
            "shrink-0 rounded-lg px-2.5 py-1.5 text-[12px] font-medium",
            trimmed ? "bg-accent text-panel" : "bg-raised/70 text-ink-secondary",
          )}
        >
          Add
        </button>
      </form>
      {current && (
        <>
          <div className="mx-2 my-1 border-t border-hairline/40" />
          <button
            onClick={() => assign("")}
            className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[13px] text-danger hover:bg-raised/70"
          >
            <FolderMinus size={15} />
            Remove from context
          </button>
        </>
      )}
    </div>
  );
}

export function leadershipPromotionBlocked(role: ReturnType<typeof botRole>, canCoordinate: boolean): boolean {
  return role !== "chief" && role !== "leader" && !canCoordinate;
}

export function sidebarBotVisible(bot: Pick<Bot, "hidden" | "sidebarHidden">, showHidden: boolean): boolean {
  return !bot.hidden && (showHidden || !bot.sidebarHidden);
}

export function BotContextMenu({
  menu,
  onClose,
  onArchive,
  onToggleHidden,
  onRequestDelete,
  onMoveToSection,
}: {
  menu: MenuState;
  onClose: () => void;
  onArchive: (bot: Bot) => void;
  onToggleHidden: (bot: Bot) => void;
  onRequestDelete: (bot: Bot) => void;
  onMoveToSection: (botId: string) => void;
}) {
  const { state, dispatch } = useStore();
  const bot = state.bots.find((b) => b.id === menu.botId);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-bot-menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  if (!bot) return null;
  const engine = state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId);
  const canCoordinate = engine?.capabilities?.agentsMcp === true;
  const visibleBotCount = state.bots.filter((candidate) => !candidate.hidden).length;
  const role = botRole(bot);
  // Both roles are still blocked from archiving — a team with no lead is the
  // state `create_bot` refuses to add to — but the reason has to name the role
  // being blocked. A team leader was told to choose another Chief of Staff,
  // which is neither what happened nor something it would fix.
  const archiveBlocked = role === "chief" || role === "leader" || visibleBotCount <= 1;
  const archiveHint =
    role === "chief"
      ? "Choose another Chief of Staff first"
      : role === "leader"
        ? `Choose another lead for ${bot.section?.trim() || "this team"} first`
        : visibleBotCount <= 1
          ? "Keep at least one active bot"
          : undefined;
  // keep the menu on-screen near the click
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - 380));
  const left = Math.min(menu.x, window.innerWidth - 240);

  const item = (
    icon: React.ReactNode,
    label: string,
    onClick?: () => void,
    opts?: { danger?: boolean; disabled?: boolean; hint?: string },
  ) => (
    <button
      key={label}
      disabled={opts?.disabled}
      onClick={() => {
        onClick?.();
        onClose();
      }}
      title={opts?.hint}
      className={cn(
        "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px]",
        opts?.danger ? "text-danger" : "text-ink",
        opts?.disabled ? "cursor-default opacity-40" : "hover:bg-raised/70",
      )}
    >
      {icon}
      {label}
    </button>
  );
  const divider = (key: string) => <div key={key} className="mx-2 my-1 border-t border-hairline/40" />;

  return (
    <div
      data-bot-menu
      style={{ top, left }}
      className="fixed z-40 w-[228px] overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60"
    >
      {[
        item(
          bot.pinned ? <PinOff size={16} className="text-ink-secondary" /> : <Pin size={16} className="text-ink-secondary" />,
          bot.pinned ? "Unpin" : "Pin",
          () => dispatch({ type: "updateBot", botId: bot.id, patch: { pinned: !bot.pinned } }),
        ),
        // Named for the role this bot actually holds. It used to say "Remove
        // Chief of Staff" on a team leader, because it read `chiefOfStaff`
        // raw — the field is true for both roles and `chiefScope` is what
        // separates them. `botRole()` is the only thing allowed to make that
        // call, here as everywhere else.
        //
        // The patch goes through `botRolePatch()` rather than a bare flag
        // flip. A bare `chiefOfStaff: true` states one of three fields and
        // leaves the other two to whatever the record already carried, which
        // is how a bot ends up flagged as leading something with no tier
        // saying what.
        item(
          role === "chief" ? (
            <Crown size={16} className="text-accent" />
          ) : (
            <Users size={16} className={role === "leader" ? "text-ink" : "text-ink-secondary"} />
          ),
          role === "chief" || role === "leader"
            ? `Remove ${BOT_ROLE_TITLE[role]}`
            : "Make Team leader",
          () =>
            dispatch({
              type: "updateBot",
              botId: bot.id,
              patch:
                role === "chief" || role === "leader"
                  ? botRolePatch("member")
                  : botRolePatch("leader"),
            }),
          {
            disabled: leadershipPromotionBlocked(role, canCoordinate),
            hint: leadershipPromotionBlocked(role, canCoordinate) ? "Choose an engine with Murage delegation support first" : undefined,
          },
        ),
        item(<FolderPlus size={16} className="text-ink-secondary" />, "Move to section", () => {
          onClose();
          onMoveToSection(bot.id);
        }),
        item(<BellDot size={16} className="text-ink-secondary" />, "Mark as Unread", () =>
          dispatch({ type: "markUnread", botId: bot.id }),
        ),
        divider("d1"),
        item(<BookOpen size={16} className="text-ink-secondary" />, "Add a skill", () => {
          dispatch({ type: "showTeamLibrary", botId: bot.id });
        }),
        item(<Pencil size={16} className="text-ink-secondary" />, "Edit Profile", () => {
          dispatch({ type: "select", id: bot.id });
          dispatch({ type: "toggleSettings", open: true });
        }),
        item(<Copy size={16} className="text-ink-secondary" />, "Duplicate", () =>
          dispatch({ type: "duplicateBot", botId: bot.id }),
        ),
        divider("d2"),
        item(<ClipboardCopy size={16} className="text-ink-secondary" />, "Copy conversation ID", () => {
          void navigator.clipboard?.writeText(bot.threadId);
        }),
        divider("d3"),
        item(bot.sidebarHidden ? <Eye size={16} /> : <EyeOff size={16} />,
          bot.sidebarHidden ? "Restore to sidebar" : "Hide from sidebar", () => onToggleHidden(bot)),
        item(
          <Archive size={16} className="text-ink-secondary" />,
          "Archive",
          () => onArchive(bot),
          {
            disabled: archiveBlocked,
            hint: archiveHint,
          },
        ),
        item(<Trash2 size={16} />, "Delete", () => onRequestDelete(bot), {
          danger: true,
        }),
      ]}
    </div>
  );
}

function BotListItem({
  bot,
  density,
  onMenu,
  onArchive,
  archiveDisabled,
  onNavigate,
}: {
  bot: Bot;
  density: SidebarDensity;
  onMenu: (menu: MenuState) => void;
  onArchive: (bot: Bot) => void;
  archiveDisabled: boolean;
  onNavigate: () => void;
}) {
  const { state, dispatch } = useStore();
  const [renaming, setRenaming] = useState(false);
  const selected = state.activeView === "chat" && state.selectedId === bot.id;
  const mascotMotion = selected && state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;
  const iconOnly = density === "icons";
  useEffect(() => {
    if (iconOnly) setRenaming(false);
  }, [iconOnly]);
  const avatarSize = iconOnly ? 44 : density === "compact" ? 40 : 56;
  // the visible branch, so a version switch changes the row with the chat
  const visible = visibleMessages(bot);
  const last = visible.at(-1);
  const rowPreview = botRole(bot) === "member" || selected || bot.unread || bot.busy || bot.activity === "waiting-on-you"
    ? preview(bot)
    : "";
  const rowClass = cn(
    "flex w-full items-center rounded-xl border text-left",
    iconOnly
      ? "justify-center px-1 py-1.5"
      : density === "compact"
        ? "gap-2 px-2 py-1.5"
        : "gap-2 px-3 py-2.5",
    !iconOnly && "group-hover:pr-[5.25rem] group-focus-within:pr-[5.25rem] max-md:pr-[5.25rem] [@media(hover:none)]:pr-[5.25rem]",
    // ONLY the Chief of Staff, not every bot that leads something.
    //
    // This read `bot.chiefOfStaff`, which is true for a team leader too, so
    // the two wore the same accent row and were indistinguishable — the badge
    // below already said "Team lead" in a different colour and the row shouted
    // over it.
    //
    // A leader is not given a second hue. There is one accent in this app and
    // exactly one row in the sidebar should carry it, or it stops meaning
    // anything; the leader is marked by its badge and its Users icon, which is
    // the distinction the eye actually reads at 13px.
    botRole(bot) === "chief"
      ? selected
        ? "border-accent/40 bg-accent/15"
        : "border-accent/25 bg-accent/5 hover:bg-accent/10"
      : selected
        ? "border-transparent bg-raised"
        : "border-transparent hover:bg-raised/50",
  );
  const body = (
    <>
      <BotAvatar
        bot={bot}
        state={stateForBot({ ...bot, messages: visible })}
        size={avatarSize}
        motion={mascotMotion?.kind ?? "none"}
        motionKey={mascotMotion?.nonce ?? 0}
        // Motion means something is happening. A resting bot holds a resting
        // pose — N idle rows bobbing at display rate was most of the app's
        // visible-idle CPU (states are keyword-derived, so "working" can be
        // decorative; busy/unread/motion are the real signals).
        animated={Boolean(bot.busy) || Boolean(bot.unread) || (mascotMotion?.kind ?? "none") !== "none"}
      />
      <div className={cn("min-w-0 flex-1", iconOnly && "hidden")}>
        <div className="flex items-baseline justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 truncate text-[15px] font-semibold text-ink">
            {bot.pinned && <Pin size={12} className="shrink-0 text-ink-secondary" />}
            {bot.sidebarHidden && <EyeOff size={12} className="shrink-0 text-ink-secondary" aria-label="Hidden from sidebar" />}
            <RenameTitle
              key={iconOnly ? "icons" : "expanded"}
              value={bot.name}
              onCommit={(name) => dispatch({ type: "updateBot", botId: bot.id, patch: { name } })}
              onEditingChange={setRenaming}
              className="truncate"
              inputClassName="w-full rounded bg-inset px-1 py-0.5 text-[15px] font-semibold"
            />
          </span>
          {/* The two controls to the right are absolutely positioned over this
              timestamp. On a hover device they fade it out as they fade in; on
              a device with no hover at all they are visible at rest, so this
              has to get out of the way at rest too — otherwise iPad landscape,
              which is wide enough to miss `max-md:`, renders the archive
              button on top of the time. */}
          {selected && last && !renaming && (
            <span className="shrink-0 text-xs text-ink-secondary transition-opacity group-hover:opacity-0 group-focus-within:opacity-0 [@media(hover:none)]:opacity-0">
              {formatTime(last.at)}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 truncate text-[13px] text-ink-secondary">
            {/* All three tiers, not just the Chief: an individual assistant
                reports straight to the Chief and reads as an ordinary team
                member everywhere it is unmarked. */}
            {botRole(bot) !== "member" && (
              <span
                className={cn(
                  "flex shrink-0 items-center gap-1 text-[11.5px] font-medium",
                  botRole(bot) === "chief" ? "text-accent" : "text-ink-secondary",
                )}
              >
                <RoleIcon bot={bot} size={11} decorative /> {BOT_ROLE_BADGE[botRole(bot)]}
              </span>
            )}
            {botRole(bot) !== "member" && rowPreview && <span className="shrink-0 text-ink-secondary/60">·</span>}
            <span className="truncate">{rowPreview}</span>
          </span>
          {bot.unread && (
            <span className="size-2 shrink-0 rounded-full bg-accent" />
          )}
        </div>
      </div>
    </>
  );
  const onContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    onMenu({ botId: bot.id, x: event.clientX, y: event.clientY });
  };
  /** Open the menu ON a control rather than at a pointer. Every caller that
   *  is not a right-click goes through this. */
  const openMenuAt = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    onMenu({ botId: bot.id, x: rect.left, y: rect.bottom });
  };
  // The menu must be reachable without a pointer AND without a right-click:
  // Shift+F10 and the dedicated ContextMenu key (whose native event carries
  // no useful coordinates) both open it on the row. Rooms already did this;
  // bot rows did not, so every action in that menu was mouse-only.
  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    onMenu({ botId: bot.id, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  };

  // Keep the same tree while editing so RenameTitle is not remounted and
  // reset. Omit the row's button role while its accessible input is present.
  return (
    <div className="group relative" title={iconOnly ? bot.name : undefined}>
      <div
        role={renaming ? undefined : "button"}
        tabIndex={renaming ? undefined : 0}
        aria-label={iconOnly ? bot.name : undefined}
        onClick={() => { if (!renaming) { dispatch({ type: "select", id: bot.id }); onNavigate(); } }}
        onKeyDown={(event) => {
          if (renaming) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            dispatch({ type: "select", id: bot.id });
            onNavigate();
            return;
          }
          onMenuKeyDown(event);
        }}
        onContextMenu={onContextMenu}
        className={rowClass}
      >
        {body}
      </div>
      {iconOnly && bot.unread && (
        <span className="pointer-events-none absolute bottom-1.5 right-1.5 size-2 rounded-full border border-panel bg-accent" />
      )}
      {/* Every action in the bot menu used to live behind onContextMenu alone.
          A touch device fires no `contextmenu` event, so on a phone the menu —
          pin, Chief of Staff, move, add a skill, duplicate, delete — did not
          exist at all. This is that menu, as a control you can see. */}
      {!iconOnly && <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          openMenuAt(event.currentTarget);
        }}
        aria-label={`More actions for ${bot.name}`}
        aria-haspopup="menu"
        title={`More actions for ${bot.name}`}
        className="absolute right-11 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-lg bg-card/90 text-ink-secondary opacity-0 shadow-sm transition hover:bg-raised hover:text-ink focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 max-md:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <MoreHorizontal size={16} />
      </button>}
      {!iconOnly && <button
        type="button"
        disabled={archiveDisabled}
        onClick={() => onArchive(bot)}
        aria-label={`Archive ${bot.name}`}
        title={
          botRole(bot) === "chief"
            ? "Choose another Chief of Staff first"
            : botRole(bot) === "leader"
              ? `Choose another lead for ${bot.section?.trim() || "this team"} first`
              : archiveDisabled
                ? "Keep at least one active bot"
                : `Archive ${bot.name}`
        }
        className="absolute right-1 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-lg bg-card/90 text-ink-secondary opacity-0 shadow-sm transition hover:bg-raised hover:text-ink focus:opacity-100 disabled:cursor-default disabled:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 max-md:opacity-100 [@media(hover:none)]:opacity-100 disabled:[@media(hover:none)]:opacity-0"
      >
        <Archive size={14} />
      </button>}
    </div>
  );
}

function ArchivedBotsPanel({
  bots,
  onClose,
  onRestored,
}: {
  bots: Bot[];
  onClose: () => void;
  onRestored: (message: string) => void;
}) {
  const { dispatch } = useStore();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [restoringAll, setRestoringAll] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyId && !restoringAll) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busyId, onClose, restoringAll]);

  const restore = async (bot: Bot) => {
    setBusyId(bot.id);
    setError("");
    try {
      const response = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden: false }),
      });
      dispatch({ type: "botPatched", bot: response.bot });
      dispatch({ type: "select", id: bot.id });
      onRestored(`${bot.name} restored`);
      if (bots.length === 1) onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  };

  const restoreAll = async () => {
    setRestoringAll(true);
    setError("");
    try {
      const responses = await Promise.all(
        bots.map((bot) =>
          api(`/api/bots/${bot.id}`, {
            method: "PATCH",
            body: JSON.stringify({ hidden: false }),
          }),
        ),
      );
      for (const response of responses) dispatch({ type: "botPatched", bot: response.bot });
      const first = bots[0];
      if (first) dispatch({ type: "select", id: first.id });
      onRestored(`${bots.length} ${bots.length === 1 ? "bot" : "bots"} restored`);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRestoringAll(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px] sm:p-6"
      onMouseDown={(event) => event.target === event.currentTarget && !busyId && !restoringAll && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="archived-bots-title"
        tabIndex={-1}
        className="animate-pop-in flex max-h-[min(680px,calc(100dvh-2rem))] w-full max-w-[760px] flex-col overflow-hidden rounded-[24px] border border-hairline/50 bg-panel shadow-2xl shadow-black/50 outline-none"
      >
        <header className="flex items-start justify-between gap-4 px-6 pb-4 pt-6 sm:px-8 sm:pt-7">
          <div>
            <h2 id="archived-bots-title" className="text-[22px] font-semibold tracking-[-0.01em] text-ink">Archived bots</h2>
            <p className="mt-1 text-[13px] text-ink-secondary">Conversations are kept until you choose to delete a bot.</p>
          </div>
          <div className="flex items-center gap-1">
            {bots.length > 1 && (
              <button
                onClick={() => void restoreAll()}
                disabled={restoringAll || Boolean(busyId)}
                className="flex items-center gap-1.5 rounded-full bg-raised px-3.5 py-2 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-40"
              >
                {restoringAll && <Loader2 size={13} className="animate-spin" />}
                Restore all
              </button>
            )}
            <button
              onClick={onClose}
              disabled={restoringAll || Boolean(busyId)}
              className="flex size-10 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
              aria-label="Close archived bots"
            >
              <X size={21} />
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-7 pt-3 sm:px-8">
          <div className="mb-3 text-[12px] font-medium text-ink-secondary">{bots.length} archived</div>
          <div className="grid grid-cols-1 gap-x-8 md:grid-cols-2">
            {bots.map((bot) => (
              <div key={bot.id} className="flex min-h-[82px] items-center gap-3 border-b border-hairline/35 px-1 py-3">
                <BotAvatar bot={bot} state="happy" size={42} animated={false} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium text-ink">{bot.name}</div>
                  <div className="mt-0.5 truncate text-[12.5px] text-ink-secondary">{bot.title || "Bot"}</div>
                </div>
                <button
                  onClick={() => void restore(bot)}
                  disabled={restoringAll || Boolean(busyId)}
                  className="flex min-w-[78px] items-center justify-center gap-1.5 rounded-full bg-raised px-3.5 py-2 text-[12.5px] text-ink hover:bg-raised-hover disabled:opacity-40"
                >
                  {busyId === bot.id && <Loader2 size={13} className="animate-spin" />}
                  Restore
                </button>
              </div>
            ))}
          </div>
          {error && <div role="alert" className="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Selection is an explicit navigation event even when its id is unchanged.
  // Row menus and inline rename do not call this callback.
  const onNavigate = () => { if (open) onClose(); };
  const { state, dispatch } = useStore();
  const desktop = useDesktopSurface();
  const { capabilities } = useDesktopCapabilities();
  const importReturnRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [sectionPicker, setSectionPicker] = useState<MenuState | null>(null);
  const [roomMenu, setRoomMenu] = useState<{ groupId: string; x: number; y: number } | null>(null);
  // Deleting a bot or a room is irreversible and was one click. The dialog
  // lives here rather than in the context menus because those close on click,
  // which would unmount the confirmation the moment it opened.
  const [pendingDelete, setPendingDelete] = useState<
    { kind: "bot" | "room"; id: string; name: string } | null
  >(null);
  const [roomSectionPicker, setRoomSectionPicker] = useState<{ groupId: string; x: number; y: number } | null>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const [newRoom, setNewRoom] = useState(false);
  const [teamInstallUrl, setTeamInstallUrl] = useState<string | null>(null);
  const [archivedBotsOpen, setArchivedBotsOpen] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const hiddenChange = useRef(false);
  const [exportTeamOpen, setExportTeamOpen] = useState(false);
  const [teamFeedback, setTeamFeedback] = useState<TeamFeedback | null>(null);
  const [query, setQuery] = useState("");
  const [density, setDensityState] = useState<SidebarDensity>(() => loadSidebarDensity());
  const [lastExpandedDensity, setLastExpandedDensity] = useState<Exclude<SidebarDensity, "icons">>(() => {
    const saved = loadSidebarDensity();
    return saved === "icons" ? "comfortable" : saved;
  });
  const [densityOpen, setDensityOpen] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<string[]>(() => loadCollapsedSections());
  const [sectionOrder, setSectionOrder] = useState<string[]>(() => loadSectionOrder());
  const [draggingSectionId, setDraggingSectionId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; place: SectionDropPlace } | null>(null);
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");
  const sectionDragRef = useRef<{
    from: string | null;
    over: { id: string; place: SectionDropPlace } | null;
  }>({ from: null, over: null });

  const setDensity = (next: SidebarDensity) => {
    setDensityState(next);
    if (next !== "icons") setLastExpandedDensity(next);
    // Search is hidden in avatar-only mode. Keeping its value would silently
    // filter bots, rooms, and message results with no visible way to clear it.
    else setQuery("");
    saveSidebarDensity(next);
    setDensityOpen(false);
  };

  const toggleCollapsed = () => {
    if (density === "icons") setDensity(lastExpandedDensity);
    else {
      setLastExpandedDensity(density);
      setDensity("icons");
    }
  };

  // Esc closes the drawer, mirroring ApiKeys.tsx:75-85. Bound only while the
  // drawer is open — on mobile, exactly when a bot/room context menu or the
  // New Room panel can be open on top of it, so the same Escape press closes
  // them together. Fine, since both directions are "get me out of here."
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose]);

  useEffect(() => {
    if (!densityOpen) return;
    const closeDensityMenu = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDensityOpen(false);
    };
    window.addEventListener("keydown", closeDensityMenu);
    return () => window.removeEventListener("keydown", closeDensityMenu);
  }, [densityOpen]);

  useEffect(() => {
    return window.muragebox?.onPackageInstall?.((url) => {
      setTeamInstallUrl(url);
      dispatch({ type: "showTeamLibrary" });
    });
  }, []);

  useEffect(() => {
    if (!teamFeedback) return;
    const timer = window.setTimeout(() => setTeamFeedback(null), 5000);
    return () => window.clearTimeout(timer);
  }, [teamFeedback]);

  const undoTeamLoad = async (result: TeamImportResult) => {
    setTeamFeedback(null);
    try {
      await Promise.all([
        ...result.importedRoutineIds.map((routineId) =>
          api(`/api/routines/${routineId}`, { method: "DELETE" }).then(() =>
            dispatch({ type: "routineDeleted", routineId }),
          ),
        ),
        ...result.importedGroupIds.map((groupId) =>
          api(`/api/groups/${groupId}`, { method: "DELETE" }).then(() =>
            dispatch({ type: "groupDeleted", groupId }),
          ),
        ),
      ]);
      const archiveNew = await Promise.all(
        result.importedBotIds.map((botId) =>
          api(`/api/bots/${botId}`, {
            method: "PATCH",
            body: JSON.stringify({ hidden: true, chiefOfStaff: false }),
          }),
        ),
      );
      for (const response of archiveNew) dispatch({ type: "botPatched", bot: response.bot });

      // One map, one patch builder. This used to split the archive into
      // chiefs and everyone else and hand-write each body, and the chief
      // branch sent `{ hidden: false, chiefOfStaff: true }` — an election
      // with no tier, which the org chart (src/lib/bot-role.ts) reads as a
      // SECTION lead. Restoring the workspace Chief that way demoted her,
      // and the only reason it stopped showing was that the harness began
      // keeping her tier on the archived record and reading a bare election
      // against it. That is a safety net under the client, not the contract:
      // `archivedRestorePatch` states the tier, so the request says what it
      // means whether or not anything downstream is willing to guess.
      const restored = await Promise.all(
        teamUndoRestores(result.archived).map(({ id, body }) =>
          api(`/api/bots/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
        ),
      );
      for (const response of restored) dispatch({ type: "botPatched", bot: response.bot });
      const first = result.archived[0];
      if (first) dispatch({ type: "select", id: first.id });
      setTeamFeedback({ error: false, text: "Previous team restored" });
    } catch (cause) {
      setTeamFeedback({ error: true, text: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const archiveBot = async (bot: Bot) => {
    const activeBots = state.bots.filter((candidate) => !candidate.hidden);
    if (bot.chiefOfStaff || activeBots.length <= 1) return;
    setTeamFeedback(null);
    try {
      const response = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden: true }),
      });
      dispatch({ type: "botPatched", bot: response.bot });
      if (state.selectedId === bot.id) {
        const next = activeBots.find((candidate) => candidate.id !== bot.id);
        if (next) dispatch({ type: "select", id: next.id });
      }
      setTeamFeedback({
        error: false,
        text: `${bot.name} archived`,
        restoreBot: { id: bot.id, name: bot.name },
      });
    } catch (cause) {
      setTeamFeedback({ error: true, text: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const toggleSidebarHidden = async (bot: Bot) => {
    if (hiddenChange.current) return;
    hiddenChange.current = true;
    setMenu(null);
    setTeamFeedback({ error: false, text: bot.sidebarHidden ? "Restoring to sidebar…" : "Hiding from sidebar…" });
    try {
      const response = await api(`/api/bots/${bot.id}`, {
        method: "PATCH", body: JSON.stringify({ sidebarHidden: !bot.sidebarHidden }),
      });
      dispatch({ type: "botPatched", bot: response.bot });
      setTeamFeedback({ error: false, text: bot.sidebarHidden ? `${bot.name} restored to sidebar` : `${bot.name} hidden from sidebar. Its work continues.` });
    } catch (cause) {
      setTeamFeedback({ error: true, text: cause instanceof Error ? cause.message : String(cause) });
    } finally { hiddenChange.current = false; }
  };

  const undoBotArchive = async (bot: { id: string; name: string }) => {
    setTeamFeedback(null);
    try {
      const response = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden: false }),
      });
      dispatch({ type: "botPatched", bot: response.bot });
      dispatch({ type: "select", id: bot.id });
      setTeamFeedback({ error: false, text: `${bot.name} restored` });
    } catch (cause) {
      setTeamFeedback({ error: true, text: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const macInset = capabilities.windowChrome === "mac-inset";
  const browser = capabilities.host.label === "Browser";
  // SAFETY: Electron's documented -webkit-app-region CSS property is not in
  // React's CSSProperties type, but the renderer accepts it as an inline style.
  const windowDragStyle = macInset
    ? ({ WebkitAppRegion: "drag" } as React.CSSProperties)
    : undefined;
  // SAFETY: Same Electron-only CSS property as windowDragStyle; interactive
  // buttons must explicitly opt out of the draggable title-bar region.
  const windowNoDragStyle = macInset
    ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties)
    : undefined;

  const q = query.trim().toLowerCase();

  // Message search rides the same box as the name filter: names match
  // instantly from local state; transcript hits are the SearchResults
  // section below the list (debounced, lands on the message).

  const matchingBots = state.bots
    .filter((b) => sidebarBotVisible(b, showHidden))
    .filter(
      (b) =>
        !q ||
        b.name.toLowerCase().includes(q) ||
        (b.title ?? "").toLowerCase().includes(q) ||
        preview(b).toLowerCase().includes(q),
    );
  const visibleGroups = state.groups.filter((g) => !q || g.name.toLowerCase().includes(q));
  const {
    unsectionedChief,
    pinnedBots,
    sectionChiefs,
    sectionedBots,
    unsectionedBots,
  } = partitionSidebarBots(matchingBots);
  const { botChats, sectionedRooms, unsectionedRooms } = partitionSidebarGroups(visibleGroups);

  // User sections keep first-appearance order. The saved layout keeps an
  // empty section's former slot so it returns there when content comes back.
  const sectionNames: string[] = [];
  for (const bot of sectionedBots) {
    if (!sectionNames.includes(bot.section!)) sectionNames.push(bot.section!);
  }
  for (const bot of sectionChiefs) {
    if (!sectionNames.includes(bot.section!)) sectionNames.push(bot.section!);
  }
  for (const group of sectionedRooms) {
    if (!sectionNames.includes(group.section!)) sectionNames.push(group.section!);
  }
  // The org you built outranks conversations the bots opened by themselves.
  //
  // Bot Chats used to sit third, above every team. A bot-to-bot DM is created
  // automatically whenever one bot messages another — so a single Chief of
  // Staff talking to four teammates put 340px of machine-generated rows above
  // the whole org chart and pushed an entire team below the fold. It read as
  // the team having been disconnected; the members were rendered the whole
  // time, just out of view.
  //
  // Teams are what a person arranged on purpose, so they come first. Bot
  // Chats is last: it grows on its own, without anybody deciding it should.
  const naturalSectionIds = [
    ...(pinnedBots.length > 0 ? [PINNED_SECTION_ID] : []),
    ...(unsectionedRooms.length > 0 ? [CHANNELS_SECTION_ID] : []),
    ...sectionNames.map(userSectionId),
    ...(unsectionedBots.length > 0 ? [BOTS_SECTION_ID] : []),
    ...(botChats.length > 0 ? [BOT_CHATS_SECTION_ID] : []),
  ];
  const sectionIds = orderedSidebarSections(naturalSectionIds, sectionOrder);
  const layoutInteractive = sidebarLayoutInteractive(density, q);
  const sectionCollapsed = (id: string) =>
    sidebarSectionCollapsed(id, collapsedSections, density, q);

  const toggleSection = (id: string) => {
    if (!layoutInteractive) return;
    const next = toggleCollapsedSection(collapsedSections, id);
    setCollapsedSections(next);
    saveCollapsedSections(next);
  };

  const commitSectionOrder = (visibleOrder: string[]) => {
    if (!layoutInteractive) return;
    const next = mergeSectionOrder(sectionOrder, visibleOrder);
    if (sameSectionOrder(next, sectionOrder)) return;
    setSectionOrder(next);
    saveSectionOrder(next);
  };

  const announceSectionPosition = (id: string, visibleOrder: string[]) => {
    const position = visibleOrder.indexOf(id);
    if (position < 0) return;
    setReorderAnnouncement(
      `${sidebarSectionLabel(id)} moved to position ${position + 1} of ${visibleOrder.length}`,
    );
  };

  const moveSidebarSection = (id: string, direction: -1 | 1) => {
    const next = moveSection(sectionIds, id, direction);
    if (sameSectionOrder(next, sectionIds)) return;
    commitSectionOrder(next);
    announceSectionPosition(id, next);
  };

  const resetSectionDrag = () => {
    sectionDragRef.current = { from: null, over: null };
    setDraggingSectionId(null);
    setDropTarget(null);
  };

  const updateSectionDropTarget = (event: React.DragEvent<HTMLDivElement>, id: string) => {
    if (!layoutInteractive || !sectionDragRef.current.from) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    const place: SectionDropPlace = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
    const next = { id, place };
    sectionDragRef.current.over = next;
    setDropTarget(next);
  };

  const dropSection = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const from =
      event.dataTransfer.getData("application/x-murage-sidebar-section") ||
      event.dataTransfer.getData("text/plain") ||
      sectionDragRef.current.from;
    const over = sectionDragRef.current.over;
    if (from && over) {
      const next = placeSection(sectionIds, from, over.id, over.place);
      if (!sameSectionOrder(next, sectionIds)) {
        commitSectionOrder(next);
        announceSectionPosition(from, next);
      }
    }
    resetSectionDrag();
  };
  const activeBotCount = state.bots.filter((bot) => !bot.hidden).length;
  const archivedBots = state.bots.filter((bot) => bot.hidden);
  const sidebarHiddenCount = state.bots.filter((bot) => !bot.hidden && bot.sidebarHidden).length;

  return (
    <aside
      aria-label="Bots and navigation"
      data-native-view-overlay
      className={cn(
        "flex h-full shrink-0 flex-col border-r border-hairline/40 bg-panel transition-[width] duration-200",
        density === "icons" ? "w-[80px]" : density === "compact" ? "w-[272px]" : "w-[320px]",
        // 320px of a 390px screen leaves 70px of chat behind the drawer — not
        // enough of an edge to aim at. Cap the drawer at 86vw below md so there
        // is always a strip of conversation to tap back to.
        density === "icons" ? "" : "max-md:w-[min(320px,86vw)]",
        // In black-translucent standalone mode the drawer header sits under
        // the clock without this.
        "max-md:pt-[env(safe-area-inset-top)]",
        // Below md only: the sidebar leaves the flow and slides in over the chat.
        // Scoped with max-md: rather than cancelled with md: on purpose — Tailwind
        // v4 emits the native `translate` property, and any value other than
        // `none` turns this element into a containing block for its `fixed`
        // descendants. Cancelling it with an `md:` prefix still emits a value, which
        // silently reparents NewRoomPanel's overlay and the "+" menu backdrop on
        // desktop.
        "max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-40",
        "max-md:transition-transform max-md:duration-200",
        open ? "max-md:translate-x-0" : "max-md:-translate-x-full",
      )}
    >
      {/* macOS owns inset traffic lights; Linux/Windows use native chrome. */}
      <div
        className={cn("flex items-center pt-3.5 pb-1", density === "icons" ? "flex-col gap-1 px-2" : "justify-between px-4")}
        style={windowDragStyle}
      >
        {macInset ? (
          <div className={density === "icons" ? "h-5 w-full" : "w-14"} />
        ) : browser ? (
          // Decoration that pays for itself beside a desktop browser's own
          // chrome. On a phone there is no window to close, so three dots that
          // look exactly like buttons and do nothing are a straight cost.
          <div className="flex items-center gap-2 max-md:hidden">
            <span className="size-3 rounded-full bg-[#ff5f57]" />
            <span className="size-3 rounded-full bg-[#febc2e]" />
            <span className="size-3 rounded-full bg-[#28c840]" />
          </div>
        ) : <div />}
        <div
          className={cn("relative flex items-center", density === "icons" ? "flex-col gap-1" : "gap-1")}
          style={windowNoDragStyle}
        >
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={density === "icons" ? "Expand sidebar" : "Collapse sidebar to avatars"}
            className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
            title={density === "icons" ? "Expand sidebar" : "Collapse to avatars"}
          >
            {density === "icons" ? <PanelLeftOpen size={20} /> : <PanelLeftClose size={20} />}
          </button>
          <div className="relative">
            <button
              type="button"
              onClick={() => setDensityOpen((value) => !value)}
              aria-label="Choose sidebar density"
              aria-expanded={densityOpen}
              className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
              title="Sidebar density"
            >
              <span aria-hidden="true" className="flex size-5 flex-col items-center justify-center gap-[3px]">
                <span className="h-px w-3.5 rounded-full bg-current" />
                <span className="h-px w-2.5 rounded-full bg-current" />
                <span className="h-px w-3.5 rounded-full bg-current" />
              </span>
            </button>
            {densityOpen && (
              <>
                <div className="fixed inset-0 z-30" onMouseDown={() => setDensityOpen(false)} />
                <div className={cn(
                  "absolute top-full z-40 mt-1 w-40 overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60",
                  density === "icons" ? "left-0" : "right-0",
                )}>
                  {(["comfortable", "compact", "icons"] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setDensity(option)}
                      className={cn(
                        "flex w-full items-center justify-between px-3 py-2 text-left text-[13px] capitalize hover:bg-raised/70",
                        density === option ? "text-accent" : "text-ink",
                      )}
                    >
                      {option === "icons" ? "Avatars only" : option}
                      {density === option && <Check size={14} />}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <button
            ref={importReturnRef}
            onClick={() => setPlusOpen((o) => !o)}
            aria-label="New or share"
            aria-expanded={plusOpen}
            aria-controls="sidebar-create-options"
            className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
            title="New or share"
          >
            <Plus size={20} strokeWidth={2} />
          </button>
          {plusOpen && (
            <>
              <div className="fixed inset-0 z-30" onMouseDown={() => setPlusOpen(false)} />
              <div id="sidebar-create-options" onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setPlusOpen(false);
                  importReturnRef.current?.focus();
                }
              }} className={cn(
                "absolute top-full z-40 mt-1 w-44 overflow-hidden rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60",
                density === "icons" ? "left-0" : "right-0",
              )}>
                <button
                  autoFocus
                  onClick={() => {
                    setPlusOpen(false);
                    track("bot_created");
                    dispatch({ type: "newBot" });
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  <BotIcon size={16} className="text-ink-secondary" />
                  Blank Bot
                </button>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    dispatch({ type: "showTeamLibrary", view: "bots" });
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  <Library size={16} className="text-ink-secondary" />
                  From Template
                </button>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    setNewRoom(true);
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  <Users size={16} className="text-ink-secondary" />
                  New Channel
                </button>
                <button
                  onClick={() => {
                    setPlusOpen(false);
                    setExportTeamOpen(true);
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  <ArrowDownToLine size={16} className="text-ink-secondary" />
                  Export selected contents
                </button>
                {archivedBots.length > 0 && (
                  <button
                    onClick={() => {
                      setPlusOpen(false);
                      setArchivedBotsOpen(true);
                    }}
                    className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                  >
                    <Archive size={16} className="text-ink-secondary" />
                    <span className="flex-1">Archived bots</span>
                    <span className="text-[11.5px] text-ink-secondary">{archivedBots.length}</span>
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Search */}
      <div className={cn("pt-2 pb-3", density === "icons" ? "hidden" : "px-3")}>
        <div className="flex items-center gap-2 rounded-lg bg-raised/70 px-3 py-2">
          <Search size={16} className="text-ink-secondary" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            placeholder="Search"
            aria-label="Search bots and messages"
            className="w-full bg-transparent text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
          />
        </div>
      </div>

      {/* Bot list */}
      {sidebarHiddenCount > 0 && <button type="button" aria-pressed={showHidden}
        onClick={() => setShowHidden(value => !value)}
        className="mx-3 mb-2 rounded-lg border border-hairline/40 px-2 py-2 text-[12px] text-ink-secondary hover:bg-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        {showHidden ? "Hide hidden bots" : "Show hidden"} ({sidebarHiddenCount})
      </button>}
      <div className="flex-1 overflow-y-auto px-2">
        <div className="flex flex-col gap-0.5">
          {matchingBots.length === 0 && visibleGroups.length === 0 && q && q.length < MIN_QUERY && (
            <div className="px-3 py-6 text-center text-[13px] text-ink-secondary">Nothing matches “{query}”</div>
          )}
          {unsectionedChief && (
            <div className="mb-1.5">
              <BotListItem
                bot={unsectionedChief}
                onNavigate={onNavigate}
                density={density}
                onMenu={setMenu}
                onArchive={(bot) => void archiveBot(bot)}
                archiveDisabled
              />
            </div>
          )}
          {sectionIds.map((id, index) => {
            const sectionName = userSectionName(id);
            const sectionChiefItems = sectionName
              ? sectionChiefs.filter((bot) => bot.section === sectionName)
              : [];
            const sectionGroupItems =
              id === CHANNELS_SECTION_ID
                ? unsectionedRooms
                : id === BOT_CHATS_SECTION_ID
                  ? botChats
                  : sectionName
                    ? sectionedRooms.filter((group) => group.section === sectionName)
                    : [];
            const sectionBotItems =
              id === PINNED_SECTION_ID
                ? pinnedBots
                : id === BOTS_SECTION_ID
                  ? unsectionedBots
                  : sectionName
                    ? sectionedBots.filter((bot) => bot.section === sectionName)
                    : [];
            const collapsed = sectionCollapsed(id);
            const attention = collapsed
              ? sidebarSectionAttention(
                  [...sectionChiefItems, ...sectionBotItems],
                  sectionGroupItems,
                )
              : undefined;
            return (
              <div
                key={id}
                data-sidebar-section-id={id}
                onDragOver={(event) => updateSectionDropTarget(event, id)}
                onDrop={dropSection}
                className={cn(
                  "flex flex-col gap-0.5",
                  density !== "icons" && index > 0 && "pt-3",
                )}
              >
                {dropTarget?.id === id && dropTarget.place === "before" && draggingSectionId !== id && (
                  <div className="mx-2 h-0.5 rounded-full bg-accent" />
                )}
                {density !== "icons" && (
                  <SidebarSectionHeader
                    name={sidebarSectionLabel(id)}
                    collapsed={collapsed}
                    attention={attention}
                    onToggle={layoutInteractive ? () => toggleSection(id) : undefined}
                    reorderable={layoutInteractive && sectionIds.length > 1}
                    dragging={draggingSectionId === id}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("application/x-murage-sidebar-section", id);
                      event.dataTransfer.setData("text/plain", id);
                      sectionDragRef.current = { from: id, over: null };
                      setDraggingSectionId(id);
                    }}
                    onDragEnd={resetSectionDrag}
                    onMove={(direction) => moveSidebarSection(id, direction)}
                  />
                )}
                {!collapsed && (
                  <>
                    {sectionChiefItems.map((bot) => (
                      <BotListItem
                        key={bot.id}
                        onNavigate={onNavigate}
                        bot={bot}
                        density={density}
                        onMenu={setMenu}
                        onArchive={(candidate) => void archiveBot(candidate)}
                        archiveDisabled
                      />
                    ))}
                    {sectionGroupItems.map((group) => (
                      <GroupListItem
                        key={group.id}
                        onNavigate={onNavigate}
                        group={group}
                        density={density}
                        onMenu={setRoomMenu}
                      />
                    ))}
                    {sectionBotItems.map((bot) => (
                      <BotListItem
                        key={bot.id}
                        onNavigate={onNavigate}
                        bot={bot}
                        density={density}
                        onMenu={setMenu}
                        onArchive={(candidate) => void archiveBot(candidate)}
                        archiveDisabled={activeBotCount <= 1}
                      />
                    ))}
                  </>
                )}
                {dropTarget?.id === id && dropTarget.place === "after" && draggingSectionId !== id && (
                  <div className="mx-2 h-0.5 rounded-full bg-accent" />
                )}
              </div>
            );
          })}
          <SearchResults query={query} onLanded={() => setQuery("")} />
        </div>
      </div>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {reorderAnnouncement}
      </p>

      {/* Footer */}
      <div className={cn("pb-3 pt-2", density === "icons" ? "px-2" : "px-3")}>
        {/* The icon rail is already one icon per destination, so folding those
            icons behind a hover menu inside an icon rail helps nobody: in that
            density the four rows stay exactly as they were. */}
        {density === "icons" && (
          <>
            <button
              onClick={() => dispatch({ type: "showTeamMap" })}
              aria-label={density === "icons" ? "Team map" : undefined}
              title={density === "icons" ? "Team map" : undefined}
              className={cn(
                "flex min-h-10 w-full items-center rounded-xl py-2 text-left transition-colors",
                density === "icons" ? "justify-center px-2" : "gap-3 px-3",
                state.activeView === "team-map" ? "bg-raised text-ink" : "text-ink hover:bg-raised/50",
              )}
            >
              <Network size={20} className={state.activeView === "team-map" ? "text-accent" : "text-ink-secondary"} />
              <span className={cn("flex-1 text-[14px]", density === "icons" && "hidden")}>Team map</span>
            </button>
            {skillRecorderEnabled(state.config) && (
              <button
                onClick={() => dispatch({ type: "showSkillRecorder" })}
                aria-label={density === "icons" ? "Teach a skill" : undefined}
                title={density === "icons" ? "Teach a skill" : undefined}
                className={cn(
                  "flex min-h-10 w-full items-center rounded-xl py-2 text-left transition-colors",
                  density === "icons" ? "justify-center px-2" : "gap-3 px-3",
                  state.activeView === "skill-recorder" ? "bg-raised text-ink" : "text-ink hover:bg-raised/50",
                )}
              >
                <Sparkles size={20} className={state.activeView === "skill-recorder" ? "text-accent" : "text-ink-secondary"} />
                <span className={cn("flex-1 text-[14px]", density === "icons" && "hidden")}>Teach a skill</span>
              </button>
            )}
            <button
              onClick={() => dispatch({ type: "showRoutines" })}
              aria-label={density === "icons" ? "Calendar" : undefined}
              title={density === "icons" ? "Calendar" : undefined}
              className={cn(
                "flex min-h-10 w-full items-center rounded-xl py-2 text-left transition-colors",
                density === "icons" ? "justify-center px-2" : "gap-3 px-3",
                state.activeView === "routines" ? "bg-raised text-ink" : "text-ink hover:bg-raised/50",
              )}
            >
              <CalendarDays size={20} className={state.activeView === "routines" ? "text-accent" : "text-ink-secondary"} />
              <span className={cn("flex-1 text-[14px]", density === "icons" && "hidden")}>Calendar</span>
              {state.routineRuns.some((run) => ["failed", "missed"].includes(run.status) && !run.seenAt) && (
                <span className="size-2 rounded-full bg-danger" />
              )}
            </button>
            <button
              onClick={() => dispatch({ type: "togglePlugins", open: true })}
              className={cn("flex min-h-10 w-full items-center rounded-xl py-2 text-left hover:bg-raised/50", density === "icons" ? "justify-center px-2" : "gap-3 px-3")}
              aria-label={density === "icons" ? "Connected apps" : undefined}
              title={density === "icons" ? "Connected apps" : undefined}
            >
              <Puzzle size={20} className="text-ink-secondary" />
              <span className={cn("text-[14px] text-ink", density === "icons" && "hidden")}>Connected apps</span>
            </button>
          </>
        )}
        {/* The only thing this button does is open Settings → Phone, and that
            section does not exist on a phone — it is the setup screen for
            getting Murage ONTO one. A dot that opens an empty pane is worse
            than no dot. `undefined` hides it too: the neutral answer. */}
        {density === "icons" && desktop === true && (
          <SidebarPhoneButton
            density={density}
            onOpen={() => dispatch(phoneSettingsAction())}
          />
        )}
        {density !== "icons" && (
          <SidebarMoreMenu
            compact={density === "compact"}
            items={[
              {
                key: "team-map",
                label: "Team map",
                icon: <Network size={18} />,
                active: state.activeView === "team-map",
                onSelect: () => dispatch({ type: "showTeamMap" }),
              },
              ...(skillRecorderEnabled(state.config)
                ? [
                    {
                      key: "skill-recorder",
                      label: "Teach a skill",
                      icon: <Sparkles size={18} />,
                      active: state.activeView === "skill-recorder",
                      onSelect: () => dispatch({ type: "showSkillRecorder" }),
                    },
                  ]
                : []),
              {
                key: "routines",
                label: "Calendar",
                icon: <CalendarDays size={18} />,
                active: state.activeView === "routines",
                // folded away, this dot would otherwise vanish with the row
                attention: state.routineRuns.some(
                  (run) => ["failed", "missed"].includes(run.status) && !run.seenAt,
                ),
                onSelect: () => dispatch({ type: "showRoutines" }),
              },
              {
                key: "plugins",
                label: "Connected apps",
                icon: <Puzzle size={18} />,
                onSelect: () => dispatch({ type: "togglePlugins", open: true }),
              },
            ]}
          />
        )}
        <div className={cn("flex items-center", density === "icons" && "justify-center")}>
          <button
            onClick={() => dispatch({ type: "toggleAppSettings" })}
            className={cn("flex min-w-0 items-center rounded-xl py-2 text-left hover:bg-raised/50", density === "icons" ? "justify-center px-2" : "flex-1 gap-3 px-3")}
            aria-label={density === "icons" ? "App settings" : undefined}
            title={density === "icons" ? (state.config?.profile?.name?.trim() || "App settings") : undefined}
          >
            <InitialsAvatar initials={profileInitials(state.config?.profile)} size={28} />
            <span className={cn("truncate text-[14px] text-ink", density === "icons" && "hidden")}>
              {state.config?.profile?.name?.trim() || state.config?.profile?.email?.trim() || "You"}
            </span>
          </button>
          {density !== "icons" && desktop === true && (
            <SidebarPhoneButton
              density={density}
              onOpen={() => dispatch(phoneSettingsAction())}
            />
          )}
          {density !== "icons" && <UpdateButton />}
          {density !== "icons" && <button
            onClick={() => dispatch({ type: "toggleAppSettings" })}
            className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
            title="App settings"
          >
            <Settings size={18} />
          </button>}
        </div>
      </div>

      {menu && (
        <BotContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onArchive={(bot) => void archiveBot(bot)}
          onToggleHidden={(bot) => void toggleSidebarHidden(bot)}
          onRequestDelete={(bot) => setPendingDelete({ kind: "bot", id: bot.id, name: bot.name })}
          onMoveToSection={(botId) => setSectionPicker({ botId, x: menu.x, y: menu.y })}
        />
      )}
      {exportTeamOpen && <TeamExportDialog initialBotIds={state.groups.find(group => group.id === state.selectedId)?.memberIds ?? (state.bots.some(bot => bot.id === state.selectedId) ? [state.selectedId!] : [])} onClose={() => setExportTeamOpen(false)} onExported={exported => {
        track("team_exported", { members: exported.members, scope: "selected" });
        setTeamFeedback({ error: false, text: `${exported.members} bots exported` });
      }} />}
      {sectionPicker && (
        <SectionPicker
          current={state.bots.find((b) => b.id === sectionPicker.botId)?.section}
          anchor={sectionPicker}
          onClose={() => setSectionPicker(null)}
          onAssign={(section) => dispatch({ type: "updateBot", botId: sectionPicker.botId, patch: { section } })}
        />
      )}
      {roomMenu && (
        <RoomContextMenu
          key={roomMenu.groupId}
          menu={roomMenu}
          onClose={() => setRoomMenu(null)}
          onRequestDelete={(group) => setPendingDelete({ kind: "room", id: group.id, name: group.name })}
          onMoveToSection={(groupId) => setRoomSectionPicker({ groupId, x: roomMenu.x, y: roomMenu.y })}
        />
      )}
      {roomSectionPicker && (
        <SectionPicker
          current={state.groups.find((g) => g.id === roomSectionPicker.groupId)?.section}
          anchor={roomSectionPicker}
          onClose={() => setRoomSectionPicker(null)}
          onAssign={(section) =>
            dispatch({ type: "patchGroup", groupId: roomSectionPicker.groupId, patch: { section } })
          }
        />
      )}
      {pendingDelete && (
        <ConfirmDelete
          name={pendingDelete.name}
          kind={pendingDelete.kind === "bot" ? "bot" : "conversation"}
          detail={
            pendingDelete.kind === "bot"
              ? "Its entire conversation history goes with it, along with any skills and playbooks it was given. This cannot be undone. Archive it instead if you might want it back."
              : "Every message in this conversation is removed. The bots themselves are not deleted. This cannot be undone."
          }
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            if (pendingDelete.kind === "bot") dispatch({ type: "deleteBot", botId: pendingDelete.id });
            else dispatch({ type: "deleteGroup", groupId: pendingDelete.id });
            setPendingDelete(null);
          }}
        />
      )}
      {newRoom && <NewRoomPanel onClose={() => setNewRoom(false)} />}
      {archivedBotsOpen && (
        <ArchivedBotsPanel
          bots={archivedBots}
          onClose={() => setArchivedBotsOpen(false)}
          onRestored={(message) => setTeamFeedback({ error: false, text: message })}
        />
      )}
      {state.teamLibrary.open && (
        <TeamLibraryPanel
          returnFocusRef={importReturnRef}
          preselectedBotId={state.teamLibrary.botId}
          initialView={state.teamLibrary.view}
          initialUrl={teamInstallUrl ?? undefined}
          onClose={() => {
            dispatch({ type: "hideTeamLibrary" });
            setTeamInstallUrl(null);
          }}
          onImported={(result) => {
            dispatch({ type: "hideTeamLibrary" });
            setTeamInstallUrl(null);
            setTeamFeedback(teamImportFeedback(result));
          }}
        />
      )}
      {teamFeedback &&
        createPortal(
          <TeamFeedbackToast
            feedback={teamFeedback}
            onUndoTeam={(undo) => void undoTeamLoad(undo)}
            onUndoBot={(bot) => void undoBotArchive(bot)}
          />,
          document.body,
        )}
    </aside>
  );
}
