// The chat header (U0-T1), lifted out of ChatView so the layout it now
// computes can be measured on its own, in a real browser, at real container
// widths (src/e2e/chat-header.human.spec.ts).
//
// What was wrong: every control in the shipped header was `shrink-0`, so the
// identity cluster absorbed the whole shortage and the bot's name measured
// 0px in a 390px column — six unlabelled icons and no conversation name.
//
// What it does now: the header decides its own layout from what it can
// measure (`@/lib/chat-header-layout`). Bot identity, Stop, the task/model
// context and the call button keep their place at every width. Secondary
// metadata (role label, usage, Inspector) is RELOCATED into one
// keyboard-reachable More menu first, then the chips fold to icons (the task
// keeps its title one step longer), then the header takes a deliberate
// second row — with the labels back — and only then do real controls move
// into the menu. Nothing is clipped and nothing is silently dropped.
//
// It answers to the CHAT CONTAINER, not the window: the same shortage happens
// in a 1600px window with the sidebar and the computer panel open.
import { useMemo, useRef, useState } from "react";
import { Bug, Folder, Monitor, Search, Square } from "lucide-react";

import { cn } from "@/lib/cn";
import { COMPACT_BUBBLE, COMPACT_SQUARE } from "@/lib/compact-chip";
import { t } from "@/lib/i18n";
import { stateForBot } from "@/lib/mascot";
import { useDesktopSurface } from "@/lib/use-surface";
import { formatTokens, formatUsd, freshTokens, hasFiniteCost, usageChip, usageReport } from "@/lib/usage";
import { HEADER_RELOCATION_ORDER, useChatHeaderLayout, type HeaderSlot } from "@/lib/chat-header-layout";
import { useStore, type AppState, type Bot, type InstanceInfo, type Message } from "@/state/store";

import { BotAvatar } from "./Avatar";
import { CallButton } from "./CallView";
import { ChatHeaderMenu, type HeaderMenuItem } from "./ChatHeaderMenu";
import { openFiles } from "./Files";
import { MemoryLauncher } from "./MemoryLauncher";
import { ModelPicker } from "./ModelPicker";
import { RenameTitle } from "./RenameTitle";
import { RoleBadge } from "./RoleBadge";
import { TaskPicker } from "./TaskPicker";
import { UsagePopover } from "./UsagePopover";
import { WorkingDots } from "@/components/WorkingIndicator";

export interface EffectiveWorkspace {
  path?: string;
  origin: "task" | "bot" | "default";
}

/** Where the open task's files actually are, and whether that is the task's
 * own folder, the bot's default, or nothing dedicated at all. A custom path
 * must never read as the default bot folder, so the origin travels with it. */
export function effectiveWorkspace(bot: Bot): EffectiveWorkspace {
  const task = bot.tasks?.find((candidate) => candidate.threadId === bot.threadId);
  // `task.cwd === null` is an explicit "this task has no folder of its own";
  // `undefined` means the task never overrode the bot.
  if (task?.cwd) return { path: task.cwd, origin: "task" };
  if (task?.cwd === undefined && bot.cwd) return { path: bot.cwd, origin: "bot" };
  return { origin: "default" };
}

/** The friendly action name — what the control DOES. */
export function workspaceActionLabel(workspace: EffectiveWorkspace): string {
  if (workspace.origin === "task") return t("chatHeader.openTaskFiles");
  if (workspace.origin === "bot") return t("chatHeader.openBotFiles");
  return t("chatHeader.openFiles");
}

/** The complete resolved location, which is what the accessible description
 * carries. Having no dedicated workspace is its own sentence, not a blank. */
export function workspaceDetail(workspace: EffectiveWorkspace): string {
  if (workspace.origin === "task") return t("chatHeader.taskFolderAt", { path: workspace.path! });
  if (workspace.origin === "bot") return t("chatHeader.botFolderAt", { path: workspace.path! });
  return t("chatHeader.noDedicatedWorkspace");
}

const folderName = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

/** Opens this bot/task's deliverables — the effective workspace, never the
 * agent's folder SETTING. Working-folder configuration stays in the profile
 * and is not changed by file navigation. */
export function WorkingFolderChip({ bot }: { bot: Bot }) {
  const desktop = useDesktopSurface();
  const workspace = effectiveWorkspace(bot);
  if (desktop !== true) return null;
  const detail = workspaceDetail(workspace);
  return (
    <button
      data-header-labelled="folder"
      onClick={() => openFiles({ botId: bot.id, threadId: bot.threadId })}
      className={cn(
        "flex max-w-[180px] items-center gap-1.5 rounded-full border border-hairline/40 bg-raised/60 px-2.5 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink",
        COMPACT_SQUARE,
      )}
      title={detail}
      // Friendly action first, resolved location second: a screen reader
      // hears both, and the folded icon-only form is still self-describing.
      aria-label={`${workspaceActionLabel(workspace)} — ${detail}`}
    >
      <Folder size={12} className="chip-trim:size-[14px]" />
      <span className="truncate font-mono chip-trim:hidden">
        {workspace.path ? folderName(workspace.path) : t("chatHeader.files")}
      </span>
    </button>
  );
}

/** What the open task has spent — quiet until the first turn settles.
 *
 * Click still opens the bot's settings, where the Usage card lives. The
 * breakdown is no longer only there: hovering or focusing the chip opens
 * `UsagePopover` beside it, which is the affordance a native `title` could
 * never be (see the note at the top of that file). */
export function UsageChip({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const usage = bot.tasks?.find((t) => t.threadId === bot.threadId)?.usage;
  const billing = state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId)?.snapshot.billing;
  const text = usage ? usageChip(usage, billing) : "";
  if (!usage || !text) return null;
  // Every line, always the same shape — including the honest sentences for an
  // engine that reports no cache or no cost, and the caveat that says these
  // are the LAST SETTLED turn's figures while a turn is still running.
  const lines = usageReport(usage, { billing, busy: bot.busy, activity: bot.activity });
  // folded: one figure — cost when the engine reports one, else tokens
  // Folded, the same rule: money only where money is owed.
  const short = billing === "metered" && hasFiniteCost(usage.costUsd)
    ? formatUsd(usage.costUsd)
    : formatTokens(freshTokens(usage));
  return (
    <UsagePopover
      lines={lines}
      onAllBots={() => dispatch({ type: "toggleAppSettings", open: true, section: "usage" })}
      // Leaving the header entirely is the layout's decision now (the chip is
      // relocated into the More menu, figure intact), so the wrapper has no
      // fold of its own; the button keeps its `chip-trim:px-2`, and the two
      // spans keep the swap between the full figure and `short`.
      trigger={({ describedBy }) => (
        <button
          onClick={() => dispatch({ type: "toggleSettings", open: true })}
          // Read-only status whose click target is the agent profile — the same
          // place the header name goes. In a narrow column it is a duplicate that
          // costs the conversation its name.
          className="whitespace-nowrap rounded-full border border-hairline/40 bg-raised/60 px-2.5 py-1 text-[12px] tabular-nums text-ink-secondary hover:bg-raised hover:text-ink chip-trim:px-2"
          aria-describedby={describedBy}
          aria-label={`Usage: ${text}`}
        >
          <span className="chip-trim:hidden">{text}</span>
          <span className="hidden chip-trim:inline">{short}</span>
        </button>
      )}
    />
  );
}

/** The chip's one-line figure, for the More menu. The hover popover needs an
 * anchor the menu cannot give it, so the relocated item carries the same
 * figure and the same destination as the chip's own click. */
function usageMenuText(bot: Bot, instances: readonly InstanceInfo[]): string {
  const usage = bot.tasks?.find((task) => task.threadId === bot.threadId)?.usage;
  if (!usage) return "";
  const billing = instances.find((i) => i.instanceId === bot.modelSelection.instanceId)?.snapshot.billing;
  return usageChip(usage, billing);
}

export function ChatHeader({
  bot,
  messages,
  mascotMotion,
  findOpen,
  onToggleFind,
}: {
  bot: Bot;
  messages: Message[];
  mascotMotion: AppState["mascotMotion"];
  findOpen: boolean;
  onToggleFind: () => void;
}) {
  const { state, dispatch } = useStore();
  const headerRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const desktop = useDesktopSurface();
  const workspace = effectiveWorkspace(bot);
  const usageText = usageMenuText(bot, state.instances);
  const task = bot.tasks?.find((candidate) => candidate.threadId === bot.threadId);

  // Anything that changes what the header has to fit restarts the ladder at
  // its richest layout, so a shorter name or a settled turn gives relocated
  // controls their place back.
  const contentKey = [
    bot.id,
    bot.threadId,
    bot.name,
    String(bot.busy ?? false),
    usageText,
    workspace.origin,
    workspace.path ?? "",
    String(desktop),
    // The chips' own labels: a task switch or a model change widens or
    // narrows the secondary track without changing the header's box, which
    // is the one thing the ResizeObserver cannot see.
    task?.title ?? "",
    String(bot.tasks?.length ?? 0),
    bot.modelSelection.instanceId,
    bot.modelSelection.model,
    String(bot.modelSelection.effort ?? ""),
  ].join("\u0001");
  const { layout, slots } = useChatHeaderLayout(headerRef, contentKey);
  const twoRow = layout.twoRow;
  const inHeader = (slot: HeaderSlot) => !slots.has(slot);

  const menuItems = useMemo<HeaderMenuItem[]>(() => {
    const byId: Partial<Record<HeaderSlot, HeaderMenuItem>> = {
      // roleLabel folds to its icon in place — the badge keeps its accessible
      // name, so there is no action to relocate.
      usage: usageText
        ? {
            id: "usage",
            label: t("chatHeader.usageMenu", { usage: usageText }),
            description: t("chatHeader.usageDetail"),
            onSelect: () => dispatch({ type: "toggleSettings", open: true }),
          }
        : undefined,
      inspector: {
        id: "inspector",
        label: t("chatHeader.inspector"),
        description: t("chatHeader.inspectorDetail"),
        icon: <Bug size={16} />,
        checked: state.inspectorOpen,
        onSelect: () => dispatch({ type: "toggleInspector" }),
      },
      computer: {
        id: "computer",
        label: t("chatHeader.computer"),
        icon: <Monitor size={16} />,
        checked: state.computerOpen,
        onSelect: () => dispatch({ type: "toggleComputer" }),
      },
      find: {
        id: "find",
        label: t("chatHeader.find"),
        description: t("chatHeader.findShortcut"),
        icon: <Search size={16} />,
        checked: findOpen,
        onSelect: onToggleFind,
      },
      memory: {
        id: "memory",
        label: t("chatHeader.memory"),
        onSelect: () => setMemoryOpen(true),
      },
      folder:
        desktop === true
          ? {
              id: "folder",
              label: workspaceActionLabel(workspace),
              description: workspaceDetail(workspace),
              icon: <Folder size={16} />,
              onSelect: () => openFiles({ botId: bot.id, threadId: bot.threadId }),
            }
          : undefined,
    };
    // Menu order follows the header's own priority order, so the control that
    // moved most recently is always last in the list.
    return HEADER_RELOCATION_ORDER.filter((slot) => slots.has(slot))
      .map((slot) => byId[slot])
      .filter((item): item is HeaderMenuItem => Boolean(item));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    slots,
    usageText,
    state.inspectorOpen,
    state.computerOpen,
    findOpen,
    onToggleFind,
    dispatch,
    desktop,
    workspace.origin,
    workspace.path,
    bot.id,
    bot.threadId,
  ]);

  return (
    <div
      ref={headerRef}
      data-chat-header
      data-chat-header-rows={twoRow ? "2" : "1"}
      // The stamp `chip-trim:`/`chip-trim:` utilities answer to
      // (src/styles.css): chips fold to icons when the LAYOUT says so, not at
      // a container breakpoint.
      data-chat-header-chips={layout.chips}
      data-chat-header-relocated={slots.size}
      className={cn(
        "flex items-center gap-2 px-5 py-3",
        twoRow ? "flex-wrap" : "flex-nowrap",
        // Room for the drawer button, which overlays this corner below md.
        "pl-11 md:pl-5",
        // The status bar sits over this row in a standalone install. calc()
        // rather than a bare pt-[env()] so the desktop keeps its py-3 top
        // padding when the inset resolves to 0px.
        "pt-[calc(0.75rem+env(safe-area-inset-top))]",
      )}
    >
      {/* Identity. `min-w-0 flex-1` is the fix: this cluster now TAKES the
          space the controls leave instead of being the only thing that gives.
          `nameTrackMinimum` in the layout hook is what stops "what is left"
          from meaning zero. */}
      <div className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1.5 py-1 chip-trim:gap-1.5 chip-trim:px-0">
        <button
          onClick={() => dispatch({ type: "toggleSettings", open: true })}
          // Folded, the 40px button and the 10px gaps beside it are 20px the
          // NAME needs more: measured at a 320px column, the guaranteed track
          // came out one pixel short of its 96px floor with the desktop
          // sizes. The 28px mascot is unchanged; only its padding and the
          // gaps shrink, and the target stays a 32px square.
          className="flex size-10 shrink-0 items-center justify-center rounded-lg hover:bg-raised/50 chip-trim:size-8"
          title="Open agent profile"
          aria-label={`Open ${bot.name}'s profile`}
        >
          <BotAvatar
            bot={bot}
            state={stateForBot({ ...bot, messages })}
            size={28}
            motion={mascotMotion?.kind ?? "none"}
            motionKey={mascotMotion?.nonce ?? 0}
          />
        </button>
        {/* min-w-0 but NOT flex-1: the cluster around it already takes the
            leftover width, so leaving the name at its natural size keeps the
            role badge and the working dots beside the name instead of pushing
            them to the far edge of an empty track. */}
        <div data-chat-header-name className="min-w-0">
          <RenameTitle
            value={bot.name}
            onCommit={(name) => dispatch({ type: "updateBot", botId: bot.id, patch: { name } })}
            onActivate={() => dispatch({ type: "toggleSettings", open: true })}
            showEditButton
            className="truncate text-[15px] font-semibold text-ink"
            inputClassName="max-w-[220px] rounded bg-inset px-1.5 py-0.5 text-[15px] font-semibold"
            // 40px of shrink-0 pencil beside a name that has no width left to
            // give. Rename is the Name field in the agent profile, which the
            // name button itself opens.
            editButtonClassName="chip-trim:hidden"
          />
        </div>
        {/* Three tiers, one mark. Without shrink-0 and nowrap this pill was
            measured at 390px wrapping to three lines, taking the header from
            72px to 85.5px, overlapping the Find button by 79.4px and leaving
            the bot name 0px wide — both live on the badge itself. Folded, the
            icon carries the signal and the chip's accessible name stays whole. */}
        <RoleBadge
          bot={bot}
          labelClassName={inHeader("roleLabel") ? undefined : "hidden"}
          className={inHeader("roleLabel") ? undefined : "px-1"}
        />
        {bot.busy && <WorkingDots className="text-ink-secondary" />}
      </div>

      {/* Secondary track. ONE flex item, so the second row is a class change
          (`w-full` cannot share a line) rather than a re-parent: TaskPicker
          and ModelPicker keep their React identity, their open menus and the
          task they have selected across every relayout. */}
      <div
        data-chat-header-secondary
        className={cn(
          "flex min-w-0 shrink-0 items-center gap-2",
          twoRow ? "order-last w-full justify-end pt-1.5" : "w-auto",
          // A chip that cannot fit must OVERFLOW so the layout hook can see
          // it and take the next step, rather than squash its label to
          // nothing and report a fit. So: `shrink-0` children everywhere,
          // except on the labelled second row, where the chips that still
          // carry a label (all of them when "full", the task alone when
          // "titled") may truncate down to a 5.5rem floor — that row exists
          // to show their names, and a truncated name beats an icon.
          !twoRow || layout.chips === "compact"
            ? "*:shrink-0"
            : layout.chips === "full"
              ? "[&>[data-header-labelled]]:min-w-[5.5rem]"
              : "[&>*:not([data-header-labelled=task])]:shrink-0 [&>[data-header-labelled=task]]:min-w-[5.5rem]",
        )}
      >
        {/* The wrappers carry the floor above, and `*:min-w-0` lets the
            pickers' own roots shrink to it so their labels truncate instead
            of holding their full width; the roots stay `relative` and keep
            their menus anchored exactly as before. */}
        <div data-header-labelled="task" className="flex min-w-0 *:min-w-0">
          <TaskPicker bot={bot} />
        </div>
        <div data-header-labelled="model" className="flex min-w-0 *:min-w-0">
          <ModelPicker key={`model-${bot.threadId}`} bot={bot} threadId={bot.threadId} />
        </div>
        {inHeader("folder") && <WorkingFolderChip bot={bot} />}
        {inHeader("usage") && <UsageChip bot={bot} />}
        {inHeader("find") && (
          <button
            onClick={onToggleFind}
            aria-label={t("chatHeader.find")}
            aria-pressed={findOpen}
            className={cn(
              "shrink-0 rounded-md p-1.5 hover:bg-raised",
              findOpen ? "text-accent" : "text-ink-secondary hover:text-ink",
            )}
            title={t("chatHeader.findTitle")}
          >
            <Search size={18} />
          </button>
        )}
        {/* Call never relocates: its availability, label and voice-setup
            fallback live inside CallTargetButton, and a menu copy would be a
            second implementation of that logic rather than the same control.
            It is already one icon at these widths. */}
        <CallButton bot={bot} />
        {inHeader("computer") && (
          <button
            onClick={() => dispatch({ type: "toggleComputer" })}
            aria-label={t("chatHeader.computer")}
            aria-pressed={state.computerOpen}
            className={cn(
              "shrink-0 rounded-md p-1.5 hover:bg-raised",
              state.computerOpen ? "text-accent" : "text-ink-secondary hover:text-ink",
            )}
            title={t("chatHeader.computer")}
          >
            <Monitor size={18} />
          </button>
        )}
        {inHeader("inspector") && (
          <button
            onClick={() => dispatch({ type: "toggleInspector" })}
            aria-label={t("chatHeader.inspector")}
            aria-pressed={state.inspectorOpen}
            className={cn(
              "shrink-0 rounded-md p-1.5 hover:bg-raised",
              state.inspectorOpen ? "text-accent" : "text-ink-secondary hover:text-ink",
            )}
            title={t("chatHeader.inspectorDetail")}
          >
            <Bug size={18} />
          </button>
        )}
        {/* Mounted at every width: only the TRIGGER moves into the menu, so a
            memory edit in progress survives a resize. It lives in the
            secondary track so the two-row header keeps row one to identity,
            Stop and More, the way the design draws it. */}
        <MemoryLauncher
          key={`memory-${bot.id}`}
          botId={bot.id}
          botName={bot.name}
          compact
          showTrigger={inHeader("memory")}
          // Controlled at every width, so relocating the trigger while the
          // dialog is open cannot close it.
          open={memoryOpen}
          onOpenChange={setMemoryOpen}
          returnFocusRef={moreRef}
        />
      </div>

      {/* Row one, always, in this order: Stop, then More. */}
      <div className="flex shrink-0 items-center gap-2">
        {bot.busy && (
          <button
            onClick={() => dispatch({ type: "interrupt", botId: bot.id, threadId: bot.threadId })}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-full border border-hairline/40 bg-raised/60 px-2.5 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink",
              COMPACT_BUBBLE,
            )}
            title={t("chatHeader.stop")}
            // The label survives the fold to an icon bubble, so Stop is
            // reachable by name at every width.
            aria-label={t("chatHeader.stop")}
          >
            <Square size={12} className="fill-current" />
            <span className="chip-trim:hidden">{t("chatHeader.stopShort")}</span>
          </button>
        )}
        {/* No relocation, no menu: an empty overflow button would be a control
            that does nothing. It appears with the first relocated item. */}
        {menuItems.length > 0 && (
          <ChatHeaderMenu
            items={menuItems}
            label={t("chatHeader.more")}
            menuLabel={t("chatHeader.moreMenu")}
            triggerRef={moreRef}
          />
        )}
      </div>
    </div>
  );
}
