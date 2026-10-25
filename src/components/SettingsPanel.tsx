import { ChevronDown, ChevronLeft, FolderOpen, X } from "lucide-react";
import { notebookLastWrittenLine } from "../lib/notebook-last-written";
import { Suspense, useEffect, useState } from "react";
import { api, useStore, type Bot } from "@/state/store";
import { stateForBot } from "@/lib/mascot";
import { CloudBackendPicker } from "./CloudBackendPicker";
import { ModelPicker } from "./ModelPicker";
import { BotFollowModelRow, LimitBackupRow } from "./ThreadFollowControls";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { effortLabel } from "@/lib/effort-label";
import { builtInBrowserEnabled } from "@/lib/feature-flags";
import { requestNotificationPermission } from "@/lib/notify";
import { useDesktopSurface } from "@/lib/use-surface";
import { usageCaption } from "@/lib/usage-card";
import { botUsage, formatTokens, formatUsd, freshTokens, hasFiniteCost, usageDetail } from "@/lib/usage";
import { shortPath } from "@/lib/short-path";
import { autoNeedsLocalComputerWarning, instanceSupportsLocalComputer, localAutoHostPlatform, localComputerDisabledReason, localComputerSelectable } from "@/lib/local-computer";
import { BotProfileAvatarCard } from "./BotProfileAvatarCard";
import { BotRoleControl } from "./BotRoleControl";
import { CanTalkToControl } from "./CanTalkToControl";
import { BotSetupAction } from "./BotIntakeCard";
import { BotSkillsPanel } from "./BotSkillsPanel";
import { BotShapesPanel } from "./BotShapesPanel";
import { PublishedSitesPanel } from "./PublishCard";
import { LearningSettings } from "./LearningSettings";
import { LearningOverviewLine } from "./LearningOverviewLine";
import { FolderTrustNote } from "./FolderTrustNote";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";
import { FullAccessWarning } from "./FullAccessWarning";
import { BotPermissionDefault } from "./BotPermissionDefault";
import { BotImageApproval } from "./BotImageApproval";
import { RememberedApprovals } from "./RememberedApprovals";
import { defaultModeStep, PEER_CONTACT_LABEL, peerContactHint, type PermissionMode } from "@/lib/permission-mode";
import { VoiceSettings } from "./VoiceSettings";
import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile";
import { Switch } from "./SettingsPrimitives";
import { BotAccessSettings } from "./BotAccessSettings";
import { MemoryLauncher } from "./MemoryLauncher";
import { ContinuityBlock } from "./ContinuityBlock";
import { activeSettingsRole, settingsRoleLabel, type BotSettingsSection } from "./bot-settings-sections";
import { botRoleTitle } from "@/lib/bot-role";
import { allHeldTasks, findTask } from "@/lib/task-window";
import { useOlderTasks } from "@/lib/use-ensure-task";
import { useBotSettingsDraft, useBotSettingsNavigation } from "./bot-settings-drafts";
import { LazyBoundary, retryableLazy } from "./LazyBoundary";
import { notebookCanSave, notebookSaveBody } from "./notebook-save";

// Bot settings > Teams loads on first open (SPEC-X 13.1): the owner's
// sharing routes are desktop only, and none of it belongs in first paint.
const TeamsSection = retryableLazy(() => import("./BotTeamsSection"));

/** A tab's contents mount the first time it is shown and then stay mounted (its unsaved edits and
 * scroll survive switching away). Hidden tabs that were never opened cost nothing: opening bot
 * settings used to mount and fetch for all fourteen. A deep link (botSettingsIntent) just changes
 * `active`, so its target mounts on arrival. */
export function SettingsSection({ id, active, children }: { id: BotSettingsSection; active?: BotSettingsSection; children?: React.ReactNode }) {
  const shown = active === undefined || active === id;
  const [seen, setSeen] = useState(shown);
  if (shown && !seen) setSeen(true);
  return <section hidden={!shown} data-settings-section={id} className="space-y-4">{seen ? children : null}</section>;
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1.5 text-[13px] text-ink-secondary">{label}</div>
      {children}
    </label>
  );
}

/** What this bot has spent across its tasks. Cost is captioned by how the
 * engine is billed — on a subscription the figure is an equivalent. */
function BotUsageCard({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const navigate = useBotSettingsNavigation();
  const usage = botUsage(bot);
  const instance = state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId);
  if (usage.turns === 0) return null;
  return (
    <div className="rounded-xl bg-card p-4">
      <div className="flex items-baseline justify-between">
        <div className="text-[15px] font-medium text-ink">{t("usageCard.title")}</div>
        <button
          onClick={() => navigate(() => dispatch({ type: "toggleAppSettings", open: true, section: "usage" }))}
          className="text-[12px] text-ink-secondary hover:text-ink"
        >
          {t("usageCard.allBots")}
        </button>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-3 text-[13px]">
        <div>
          <div className="text-[11.5px] uppercase tracking-wide text-ink-secondary">{t("usageCard.colTurns")}</div>
          <div className="mt-0.5 tabular-nums text-ink">{usage.turns}</div>
        </div>
        <div>
          <div className="text-[11.5px] uppercase tracking-wide text-ink-secondary">{t("usageCard.colTokens")}</div>
          <div className="mt-0.5 tabular-nums text-ink" title={usageDetail(usage)}>
            {formatTokens(freshTokens(usage))}
          </div>
        </div>
        <div>
          <div className="text-[11.5px] uppercase tracking-wide text-ink-secondary">{t("usageCard.colCost")}</div>
          <div className="mt-0.5 tabular-nums text-ink">{hasFiniteCost(usage.costUsd) ? formatUsd(usage.costUsd) : t("usageCard.unknown")}</div>
        </div>
      </div>
      <div className="mt-2 text-[12px] text-ink-secondary">
        {hasFiniteCost(usage.costUsd) ? t("usageCard.costLine", { caption: usageCaption(instance?.snapshot.billing) }) : t("usageCard.unpriced")}
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:outline-none focus:border-hairline";

/** Where a bot's shell tools run. Set per bot; each task pins its own copy
 * on its first turn (the server does the pinning — Claude keeps sessions
 * per project folder, so a folder must not move under a live task). The
 * PATCH is made directly rather than through updateBot: the server
 * validates the path and a rejected folder must not stick in local state. */
function WorkingFolder({ bot }: { bot: Bot }) {
  const { capabilities } = useDesktopCapabilities();
  const home = capabilities.host.homeDir;
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const canPick = Boolean(window.muragebox?.pickFolder);
  const task = findTask(bot, bot.threadId);
  const pinned = task?.cwd; // undefined = not yet, null = legacy home, string = folder
  const pinnedElsewhere = pinned !== undefined && (pinned ?? undefined) !== bot.cwd;
  useBotSettingsDraft("Working folder", draft !== null && draft !== (bot.cwd ?? ""), saving);
  // The folder is an element, so the sentence is split around its placeholder.
  const [pinnedBefore = "", pinnedAfter = ""] = t("settings.bot.folder.pinned").split("{folder}");

  const save = async (cwd: string | null) => {
    setSaving(true);
    setError(null);
    try {
      await api(`/api/bots/${bot.id}`, { method: "PATCH", body: JSON.stringify({ cwd }) });
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const pick = async () => {
    const chosen = await window.muragebox?.pickFolder?.(bot.cwd);
    if (chosen) void save(chosen);
  };

  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{t("settings.bot.folder.title")}</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">{t("settings.bot.folder.note")}</div>
      {canPick ? (
        <div className="mt-3 flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12.5px] text-ink" title={bot.cwd}>
            {bot.cwd ? shortPath(bot.cwd, home) : <span className="text-ink-secondary">{t("settings.bot.folder.private")}</span>}
          </div>
          <button onClick={() => void pick()} disabled={saving} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
            <FolderOpen size={14} /> {t("settings.bot.folder.choose")}
          </button>
          {bot.cwd && (
            <button onClick={() => void save(null)} disabled={saving} className="shrink-0 rounded-lg px-2 py-2 text-[13px] text-ink-secondary hover:text-ink disabled:opacity-50">
              {t("settings.bot.folder.clear")}
            </button>
          )}
        </div>
      ) : (
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            // an emptied field clears the folder — the server wants null
            void save((draft ?? bot.cwd ?? "").trim() || null);
          }}
        >
          <input
            className={cn(inputCls, "font-mono text-[12.5px]")}
            aria-label={t("settings.bot.folder.pathLabel")}
            placeholder={t("settings.bot.folder.pathPlaceholder")}
            value={draft ?? bot.cwd ?? ""}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" disabled={saving || draft === null} className="shrink-0 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
            {t("settings.bot.save")}
          </button>
        </form>
      )}
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
      {pinnedElsewhere && (
        <div className="mt-2 text-[12px] text-ink-secondary">
          {pinnedBefore}{pinned ? <span className="font-mono">{shortPath(pinned, home)}</span> : t("settings.bot.folder.homeFolder")}{pinnedAfter}
        </div>
      )}
      <FolderTrustNote folder={bot.cwd} botId={bot.id} threadId={bot.threadId} />
    </div>
  );
}

interface MemoryTopic {
  name: string;
  bytes: number;
}

const formatBytes = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 102.4) / 10} KB`);

/** MEMORY.md + memory/ topic files, surfaced so the user can read and fix
 * what the bot believes. Fetched on expand, not on mount: settings opens for
 * every bot and most visits never look at memory — and an expand also
 * re-reads, so notes the bot wrote mid-session show up on the next open. */
function MemoryCard({ bot }: { bot: Bot }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [lastWrittenAt, setLastWrittenAt] = useState<number | null>(null);
  // the notebook revision this editor loaded: a save sends it, so words written since (by the bot, or another window) are kept (U33)
  const [revision, setRevision] = useState<string | undefined>(undefined);
  const [topics, setTopics] = useState<MemoryTopic[]>([]);
  const [saving, setSaving] = useState(false);
  const [topic, setTopic] = useState<{ name: string; text: string } | null>(null);
  useBotSettingsDraft("Legacy notebook", dirty, saving);

  const load = async () => {
    setLoading(true);
    setError(null);
    setTopic(null);
    // no revision until this load answers: a failed load leaves Save off, so an edit can never be saved blind over the file (U33)
    setRevision(undefined);
    try {
      const result: { text: string; truncated: boolean; lastWrittenAt?: number | null; revision?: string; topics: MemoryTopic[] } = await api(
        `/api/bots/${bot.id}/memory`,
      );
      setText(result.text);
      setRevision(typeof result.revision === "string" ? result.revision : undefined);
      setTruncated(result.truncated);
      setLastWrittenAt(typeof result.lastWrittenAt === "number" ? result.lastWrittenAt : null);
      setTopics(result.topics);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const save = async () => {
    if (revision === undefined) return;
    setSaving(true);
    setError(null);
    try {
      const result: { truncated: boolean; lastWrittenAt?: number | null; revision?: string } = await api(`/api/bots/${bot.id}/memory`, {
        method: "PUT",
        body: JSON.stringify(notebookSaveBody(text, revision)),
      });
      setRevision(typeof result.revision === "string" ? result.revision : undefined);
      setTruncated(result.truncated);
      // the save is a write (Astra r1 #12)
      setLastWrittenAt(typeof result.lastWrittenAt === "number" ? result.lastWrittenAt : null);
      setDirty(false);
    } catch (e) {
      // the notebook was written after this editor opened: the newer words are kept and this edit stays here, unsaved
      if ((e as { status?: number } | null)?.status === 409) setError("This notebook was written after you opened it, so your edit was not saved over it. Your edit is still here: copy what you need, then close and reopen the notebook to see the newer version.");
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const openTopic = async (name: string) => {
    setError(null);
    try {
      setTopic(await api(`/api/bots/${bot.id}/memory/topics/${encodeURIComponent(name)}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="rounded-xl bg-card p-4">
      <button
        className="flex w-full items-center justify-between gap-4 text-left"
        aria-expanded={open}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) void load();
        }}
      >
        <div>
          <div className="text-[15px] font-medium text-ink">{t("settings.bot.notebook.title")}</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            {t("settings.bot.notebook.note")}
          </div>
        </div>
        <ChevronDown size={16} className={cn("shrink-0 text-ink-secondary transition-transform", open && "rotate-180")} />
      </button>

      {open && loading && <div className="mt-3 text-[13px] text-ink-secondary">{t("settings.bot.notebook.loading")}</div>}

      {open && !loading && topic && (
        <div className="mt-3">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-mono text-[12.5px] text-ink">memory/{topic.name}</span>
            <button
              onClick={() => setTopic(null)}
              className="shrink-0 rounded-md px-2 py-1 text-[13px] text-ink-secondary hover:bg-control hover:text-ink"
            >
              {t("settings.bot.notebook.back")}
            </button>
          </div>
          <pre className="mt-2 max-h-[240px] overflow-auto whitespace-pre-wrap rounded-lg border border-hairline/40 bg-inset p-3 font-mono text-[12.5px] leading-relaxed text-ink">
            {topic.text}
          </pre>
        </div>
      )}

      {open && !loading && !topic && (
        <div className="mt-3">
          <textarea
            className={cn(inputCls, "min-h-[160px] resize-y font-mono text-[12.5px] leading-relaxed")}
            value={text}
            placeholder={t("settings.bot.notebook.placeholder")}
            aria-label={t("settings.bot.notebook.label")}
            onChange={(e) => {
              setText(e.target.value);
              setDirty(true);
            }}
          />
          {/* O5: a notebook nobody wrote for a week reads as stale, not as "remembers nothing". */}
          <div className="mt-1.5 text-[11.5px] text-ink-secondary">{notebookLastWrittenLine(lastWrittenAt, Date.now())}</div>
          <div className="mt-2 flex items-center gap-3">
            <button
              onClick={() => void save()}
              disabled={!notebookCanSave({ saving, dirty, revision })}
              className="rounded-lg bg-control px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
            >
              {saving ? t("settings.bot.saving") : t("settings.bot.save")}
            </button>
            {truncated && (
              <span className="text-[11.5px] text-ink-secondary">
                {t("settings.bot.notebook.truncated")}
              </span>
            )}
          </div>
          {topics.length > 0 && (
            <div className="mt-3">
              <div className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
                {t("settings.bot.notebook.topics")}
              </div>
              <div className="overflow-hidden rounded-lg border border-hairline/40">
                {topics.map((entry) => (
                  <button
                    key={entry.name}
                    onClick={() => void openTopic(entry.name)}
                    className="flex w-full items-center justify-between gap-2 border-b border-hairline/40 px-3 py-2 text-left last:border-b-0 hover:bg-control/60"
                  >
                    <span className="truncate font-mono text-[12.5px] text-ink">{entry.name}</span>
                    <span className="shrink-0 text-[11.5px] text-ink-secondary">{formatBytes(entry.bytes)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}

export function SettingsPanel({ bot, section, embedded = false }: { bot: Bot; section?: BotSettingsSection; embedded?: boolean }) {
  const navigate = useBotSettingsNavigation();
  const olderHistory = useOlderTasks("bot", bot.id);
  // The one card in this panel that provisions rather than configures: "This
  // computer" hands a bot the machine, and Cloud opens the Box / VPS backend
  // picker, which is where a managed container gets created and started. Those
  // routes require the desktop marker and the browser door strips it, so from
  // a phone the segmented control was four buttons that 404. See below.
  const desktop = useDesktopSurface();
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const providerSupportsLocal = instanceSupportsLocalComputer(state.instances, bot);
  const localSelectable = localComputerSelectable({ capabilities, providerSupportsLocal });
  const [localAutoWarning, setLocalAutoWarning] = useState<"auto" | "full" | "unlimited" | "local" | null>(null);
  const [fullAccessWarning, setFullAccessWarning] = useState<{ onThisComputer: boolean; level: "full" | "unlimited" } | null>(null);
  const localDisabledReason = localComputerDisabledReason({ capabilities, providerSupportsLocal });
  // The roster carries the first lines of a long description (`descriptionCut`). The whole text is fetched before the field can be
  // edited, so an edit never writes the cut copy back over the rest.
  useEffect(() => {
    if (bot.descriptionCut) dispatch({ type: "ensureBotDetail", botId: bot.id });
  }, [bot.id, bot.descriptionCut, dispatch]);
  const patch = (
    p: Partial<
      Pick<
        Bot,
        | "name"
        | "title"
        | "description"
        | "notifications"
        | "computer"
        | "cloudBackend"
        | "autoStartVps"
        | "color"
        | "mascotExpression"
        | "mascotBody"
        | "avatarUrl"
        | "avatarCrop"
        | "autoApprove"
        | "fullAccess"
        | "noLimits"
        | "fullAccessChannelMessages"
        | "fullAccessSetupRequests"
        | "imageApproval"
        | "imageAskAfter"
        | "autoReview"
        | "speakReplies"
        | "voice"
        | "chiefOfStaff"
        | "approvePeerComms"
        | "composio"
        | "browser"
        | "continuity"
        | "modelSelection"
      >
    > & { acknowledgeLocalAuto?: boolean; acknowledgeFullAccess?: boolean; acknowledgeNoLimits?: boolean; persona?: string },
  ) => dispatch({ type: "updateBot", botId: bot.id, patch: {...p,...(p.modelSelection!==undefined||p.autoApprove!==undefined||p.fullAccess!==undefined||p.noLimits!==undefined?{settingsScope:"defaults" as const}:{})} });
  // The bot's default approval level: the same warnings, in the same order,
  // as the composer's switch (defaultModeStep). The platform is the
  // harness's own (announced on /api/config), not this browser's UA.
  const chooseDefaultMode = (mode: PermissionMode) => {
    const needsLocal = autoNeedsLocalComputerWarning({ platform: localAutoHostPlatform(capabilities, { harness: state.config?.harness }), computer: bot.computer, autoApprove: bot.autoApprove });
    const step = defaultModeStep(bot, mode, needsLocal);
    if (step.kind === "full-warning") setFullAccessWarning({ onThisComputer: step.onThisComputer, level: "full" });
    else if (step.kind === "no-limits-warning") setFullAccessWarning({ onThisComputer: step.onThisComputer, level: "unlimited" });
    else if (step.kind === "local-warning") setLocalAutoWarning(step.mode);
    else patch(step.patch);
  };
  // `persona` is validated, persisted and prompted server-side already
  // (shared/bot-profile.ts, server/bot-profile.ts, server/index.ts). The
  // renderer's `Bot` record and `BotUpdatePatch` live in src/state/, which
  // this lane does not own, so it is read through a narrow view until the
  // field lands there. The PATCH body is untyped JSON either way, so the
  // round trip is real today.
  const persona = (bot as { persona?: string }).persona ?? "";
  const activeState = stateForBot(bot);
  const mascotMotion = state.mascotMotion?.botId === bot.id ? state.mascotMotion : null;
  const engine = state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId);
  const canAutoReview = engine?.capabilities?.approvalReview === true;
  const canCoordinate = engine?.capabilities?.agentsMcp === true;
  const canUseConnectedApps = engine?.capabilities?.composioMcp === true;
  const canUseVps = engine?.capabilities?.computerMcp === true && engine.driverKind !== "boxAgent";
  const connectedAppsConfigured = state.config?.composio?.configured === true;
  // "A second bot exists" — an archived one is not somebody to report to.
  const hasTeammates = state.bots.filter((candidate) => !candidate.hidden).length > 1;
  const connectedAppsEnabled = bot.composio !== false;
  const canUseBrowser = engine?.capabilities?.browserMcp === true;
  const browserFeature = builtInBrowserEnabled(state.config);
  const browserAllowed = bot.browser !== false;
  const browserEnabled = browserFeature && browserAllowed;

  return (
    <>
    <aside
      className={embedded ? "relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-clip bg-panel" : cn(
        // Clip without creating a second scroll container. overflow:hidden
        // still lets focus/scrollIntoView scroll this aside past its header.
        "animate-panel-in relative z-20 flex h-full min-h-0 flex-col overflow-clip border-l border-hairline/40 bg-panel",
        "md:w-[400px] md:shrink-0",
        // Same collapse as InspectorPanel: a fixed 400px column beside the chat
        // takes main to 0px wide below ~800px. Below md the profile covers the
        // chat; its header already carries the "Collapse agent profile" back
        // button, so there is a way out.
        "max-md:absolute max-md:inset-0 max-md:z-40 max-md:w-full",
        // Covering the chat means covering its header's status-bar inset too.
        "max-md:pt-[var(--inset-top)] max-md:pb-[var(--inset-bottom)]",
      )}
    >
      {/* The native wrapper owns its own header. */}
      {!embedded && <div className="flex shrink-0 items-center justify-between px-4 py-3">
        <button
          onClick={() => dispatch({ type: "toggleSettings", open: false })}
          aria-label={t("settings.bot.header.collapse")}
          title={t("settings.bot.header.collapse")}
          className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"
        >
          <ChevronLeft size={18} />
        </button>
        <span className="text-[15px] font-semibold text-ink">{t("settings.bot.header.title")}</span>
        <button
          onClick={() => dispatch({ type: "toggleSettings", open: false })}
          aria-label={t("settings.bot.header.close")}
          title={t("settings.bot.header.close")}
          className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>}

      <div data-settings-scroll className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        <div className="flex flex-col gap-4 pt-4">
          {/* Below md this panel covers the chat, and the chat is where the
              app's error banner renders — a refused role change would land
              behind it with nothing on screen to explain the snap-back. */}
          {state.error && (
            <div role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-[12.5px] leading-relaxed text-danger">
              {state.error}
            </div>
          )}
          <SettingsSection id="overview" active={section}>
          {/* What this bot is FOR comes first. The avatar studio used to open
              the panel, with the purpose and the role below the fold. */}
          <BotSetupAction bot={bot} />
          {desktop === true && <LearningOverviewLine key={`learning-line-${bot.id}`} botId={bot.id} />}
          {/* An org chart needs an org. With one bot in the workspace there is
              nobody to lead and nobody to report to, so the role summary and
              the Role control below are both hidden until a second bot
              exists. */}
          {hasTeammates && <div className="rounded-xl bg-card p-4 text-[13px]">
            <p className="font-medium">{botRoleTitle(bot)}</p>
            <p className="mt-1 text-ink-secondary">{bot.title || t("settings.bot.overview.noTitle")}{bot.section ? ` · ${bot.section}` : ""}</p>
            {bot.installedPackage?.sourceRole && <div className="mt-3 border-t border-hairline/40 pt-3">
              <p>{t("settings.bot.overview.importedRole", { role: settingsRoleLabel(bot.installedPackage.sourceRole) })}</p>
              {bot.installedPackage.sourceTeam && <p className="mt-1">{t("settings.bot.overview.importedTeam", { team: bot.installedPackage.sourceTeam })}</p>}
              <p className="mt-2 text-ink-secondary">{bot.installedPackage.sourceRole === activeSettingsRole(bot)
                ? t("settings.bot.overview.roleMatches")
                : t("settings.bot.overview.roleInactive")}</p>
              <p className="mt-1 text-ink-secondary">{t("settings.bot.overview.noGrant")}</p>
            </div>}
          </div>}
          </SettingsSection>
          <SettingsSection id="identity" active={section}>
          {/* Appearance opens Identity & instructions, always open: a bot's
              looks sit with its name and instructions (Sean, 2026-10-03). */}
          <div className="rounded-xl bg-card p-3">
            <h3 className="mb-2 text-[13px] font-medium">{t("settings.appearance.title")}</h3>
            <BotProfileAvatarCard
              bot={bot}
              activeState={activeState}
              mascotMotion={mascotMotion}
              onPatch={patch}
            />
          </div>
          <Field label={t("settings.bot.identity.name")}>
            <input
              className={inputCls}
              maxLength={BOT_PROFILE_LIMITS.name}
              value={bot.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </Field>
          <Field label={t("settings.bot.identity.title")}>
            <input
              className={inputCls}
              maxLength={BOT_PROFILE_LIMITS.title}
              placeholder={t("settings.bot.identity.titlePlaceholder")}
              value={bot.title}
              onChange={(e) => patch({ title: e.target.value })}
            />
          </Field>
          {/* Description is NOT a note about the bot. It is pasted verbatim
              into the bot's system prompt on every turn ("About: …"), and it
              is also what a Chief of Staff, the avatar prompt and the team
              manifest read to decide who does the work. The label said
              neither, so people wrote notes where instructions go — and, once
              they realised, wrote voice ("be snarky") into the one field that
              routing reads. Personality below is the field for that. */}
          <Field label={t("settings.bot.identity.instructions")}>
            <textarea
              className={cn(inputCls, "min-h-[96px] resize-none")}
              maxLength={BOT_PROFILE_LIMITS.description}
              placeholder={t("settings.bot.identity.instructionsPlaceholder")}
              value={bot.description}
              disabled={bot.descriptionCut === true}
              onChange={(e) => patch({ description: e.target.value })}
            />
            <p className="mt-1.5 text-[12px] leading-relaxed text-ink-secondary">
              {t("settings.bot.identity.instructionsHint")}
            </p>
          </Field>
          <Field label={t("settings.bot.identity.personality")}>
            <textarea
              className={cn(inputCls, "min-h-[64px] resize-none")}
              maxLength={BOT_PROFILE_LIMITS.persona}
              placeholder={t("settings.bot.identity.personalityPlaceholder")}
              value={persona}
              onChange={(e) => patch({ persona: e.target.value })}
            />
            <div className="mt-1.5 flex items-start justify-between gap-3">
              <p className="text-[12px] leading-relaxed text-ink-secondary">
                {t("settings.bot.identity.personalityHint")}
              </p>
              <span className="shrink-0 pt-px text-[11.5px] tabular-nums text-ink-secondary">
                {persona.length}/{BOT_PROFILE_LIMITS.persona}
              </span>
            </div>
          </Field>

          </SettingsSection>

          {/* SETUP LIVES HERE, not in the composer dock.
              Beside the role control because this is the same kind of
              question — what IS this bot — and because a person arrives at
              this panel on purpose. The composer version renders only for a
              genuinely new agent; this one is always reachable, and warns
              before it touches an agent that already has skills, a
              description, or a conversation behind it. */}
          <SettingsSection id="overview" active={section}>
          {hasTeammates && <BotRoleControl bot={bot} canCoordinate={canCoordinate} />}
          </SettingsSection>


          <SettingsSection id="permissions" active={section}>
          <CanTalkToControl bot={bot} />
          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
            <div>
              <div className="text-[15px] font-medium text-ink">
                {PEER_CONTACT_LABEL}
              </div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                {peerContactHint(bot)}
              </div>
            </div>
            <Switch
              checked={Boolean(bot.approvePeerComms)}
              aria-label={PEER_CONTACT_LABEL}
              disabled={!bot.approvePeerComms && !canCoordinate}
              onClick={() => patch({ approvePeerComms: !bot.approvePeerComms })}
              title={!bot.approvePeerComms && !canCoordinate ? t("settings.bot.peer.engineCannot") : undefined}
              className="disabled:cursor-not-allowed"
            />
          </div>

          </SettingsSection>
          <SettingsSection id="access" active={section}>
          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
            <div>
              <div className="text-[15px] font-medium text-ink">{t("settings.bot.apps.title")}</div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                {!connectedAppsConfigured
                  ? t("settings.bot.apps.connectFirst")
                  : !canUseConnectedApps
                    ? t("settings.bot.apps.engineCannot")
                    : connectedAppsEnabled
                      ? t("settings.bot.apps.on")
                      : t("settings.bot.apps.off")}
              </div>
            </div>
            <Switch
              checked={connectedAppsEnabled}
              aria-label={t("settings.bot.apps.switchLabel")}
              disabled={
                !connectedAppsEnabled && (!connectedAppsConfigured || !canUseConnectedApps)
              }
              onClick={() => patch({ composio: !connectedAppsEnabled })}
              title={
                !connectedAppsEnabled && !connectedAppsConfigured
                  ? t("settings.bot.apps.connectFirstTitle")
                  : !connectedAppsEnabled && !canUseConnectedApps
                    ? t("settings.bot.apps.engineCannotTitle")
                    : undefined
              }
              className="disabled:cursor-not-allowed"
            />
          </div>

          <BotAccessSettings key={`access-${bot.id}`} botId={bot.id} />

          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
            <div>
              <div className="text-[15px] font-medium text-ink">{t("settings.bot.browser.title")}</div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                {!browserFeature
                    ? t("settings.bot.browser.featureOff")
                    : !canUseBrowser
                      ? t("settings.bot.browser.engineCannot")
                      : browserEnabled
                        ? t("settings.bot.browser.on")
                        : t("settings.bot.browser.off")}
              </div>
            </div>
            <Switch
              checked={browserEnabled}
              aria-label={t("settings.bot.browser.switchLabel")}
              disabled={!browserEnabled && (!browserFeature || !canUseBrowser)}
              onClick={() => patch({ browser: !browserAllowed })}
              className="disabled:cursor-not-allowed"
            />
          </div>

          </SettingsSection>
          <SettingsSection id="model" active={section}>
          <div className="rounded-xl bg-card p-4">
            <ModelPicker
              bot={bot}
              contained
              label={
                <div>
                  <div className="text-[15px] font-medium text-ink">{t("settings.bot.model.title")}</div>
                  <div className="mt-0.5 text-[13px] text-ink-secondary">
                    {t("slik.botModelDetail")}
                  </div>
                </div>
              }
            />
            <BotFollowModelRow bot={bot} />
          </div>
          {desktop && <LimitBackupRow bot={bot} />}

          {!!engine?.capabilities?.effortLevels?.length && (
            <div className="rounded-xl bg-card p-4">
              <div className="text-[15px] font-medium text-ink">{t("settings.bot.effort.title")}</div>
              {/* Says what the app does, not what the engine ends up at:
                  Codex applies a level to the whole thread and has no way to
                  take one back, so "currently: engine default" was a promise
                  we could not keep for a thread that had already been sent
                  one. Sending nothing is true on every engine. */}
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                {bot.modelSelection.effort ? t("settings.bot.effort.note") : t("settings.bot.effort.noteEngineDecides")}
              </div>
              <div className="mt-3 flex overflow-hidden rounded-lg border border-hairline/40">
                {([undefined, ...engine.capabilities.effortLevels] as const).map((level, i) => (
                  <button
                    key={level ?? "default"}
                    aria-pressed={bot.modelSelection.effort === level}
                    onClick={() => patch({ modelSelection: { ...bot.modelSelection, effort: level } })}
                    className={cn(
                      "flex-1 py-1.5 text-[13px] capitalize",
                      i > 0 && "border-l border-hairline/40",
                      bot.modelSelection.effort === level
                        ? "bg-control text-ink"
                        : "text-ink-secondary hover:bg-control/60 hover:text-ink",
                    )}
                  >
                    {effortLabel(level)}
                  </button>
                ))}
              </div>
            </div>
          )}

          </SettingsSection>
          <SettingsSection id="access" active={section}>
          {/* WHERE THE WORK RUNS is a decision for the keyboard.
              Rendered only on a confirmed desktop — `undefined` shows nothing,
              because showing it and then taking it away is worse than a card
              that arrives a moment late. The bot keeps whatever it is already
              set to; nothing here is required to read a conversation, approve
              an action, or send a message from a phone. */}
          {desktop === true && (
          <div className="rounded-xl bg-card p-4">
            <div className="text-[15px] font-medium text-ink">{t("settings.bot.computer.title")}</div>
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              {bot.computer ? t("settings.bot.computer.note") : t("settings.bot.computer.noteAuto")}
            </div>
            <div className="mt-3 flex overflow-hidden rounded-lg border border-hairline/40">
              {([
                ["cloud", t("settings.bot.computer.cloud")],
                ["vm", t("settings.bot.computer.vm")],
                ["local", t("settings.bot.computer.local")],
                ["off", t("settings.bot.computer.off")],
              ] as const).map(([mode, label], i) => (
                <button
                  key={mode}
                  disabled={mode === "local" && !localSelectable}
                  title={mode === "local" && !localSelectable ? localDisabledReason ?? undefined : undefined}
                  onClick={() => {
                    if (mode === bot.computer) return;
                    if (mode === "local" && bot.autoApprove) setLocalAutoWarning("local");
                    else patch({ computer: mode });
                  }}
                  className={cn(
                    "flex-1 py-1.5 text-[13px] capitalize",
                    i > 0 && "border-l border-hairline/40",
                    mode === "local" && !localSelectable && "cursor-not-allowed opacity-40",
                    bot.computer === mode
                      ? "bg-control text-ink"
                      : "text-ink-secondary hover:bg-control/60 hover:text-ink",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {(!bot.computer || bot.computer === "cloud") && (
              <>
                <CloudBackendPicker
                  value={bot.cloudBackend ?? "box"}
                  vpsSupported={canUseVps}
                  onChange={(backend) => patch({ cloudBackend: backend })}
                />
                {!bot.computer && bot.cloudBackend === "vps" && (
                  <div className="mt-3 flex items-center justify-between gap-4 rounded-lg bg-inset px-3 py-2.5">
                    <div className="min-w-0">
                      <div className="text-[13px] text-ink">{t("settings.bot.computer.vpsTitle")}</div>
                      <div className="mt-0.5 text-[11.5px] text-ink-secondary">
                        {t("settings.bot.computer.vpsNote")}
                      </div>
                    </div>
                    <Switch
                      checked={Boolean(bot.autoStartVps)}
                      aria-label={t("settings.bot.computer.vpsTitle")}
                      onClick={() => patch({ autoStartVps: !bot.autoStartVps })}
                    />
                  </div>
                )}
              </>
            )}
          </div>
          )}

          </SettingsSection>
          <SettingsSection id="usage" active={section}>
          <BotUsageCard bot={bot} />
          {botUsage(bot).turns === 0 && <p className="text-[13px] text-ink-secondary">{t("usageCard.empty")}</p>}
          </SettingsSection>
          <SettingsSection id="access" active={section}>
          <WorkingFolder bot={bot} />
          <PublishedSitesPanel bot={bot} />
          </SettingsSection>


          <SettingsSection id="memory" active={section}>
          {/* keyed so switching bots never shows one bot's notes under another's name */}
          <section className="rounded-xl bg-card p-4">
            <h3 className="text-[15px] font-medium text-ink">{t("settings.bot.memory.title")}</h3>
            <p className="mt-1 text-[12px] text-ink-secondary">{t("settings.bot.memory.note")}</p>
            <MemoryLauncher key={`memory-${bot.id}`} botId={bot.id} botName={bot.name} />
          </section>
          {desktop === true && <ContinuityBlock key={`continuity-${bot.id}`} bot={bot} />}
          <MemoryCard key={bot.id} bot={bot} />
          </SettingsSection>


          {/* Everything that goes into this bot's instructions, in the order it
              reads it (server/bot-shapes.ts). The route is desktop only: it
              shows the bot's notes and its team's brief. Read again each
              time the section is shown. */}
          <SettingsSection id="shapes" active={section}>
          {desktop === true && <BotShapesPanel key={`shapes-${bot.id}`} bot={bot} active={section === undefined || section === "shapes"} />}
          </SettingsSection>


          {/* "Add a skill" picks and adds skills right here, inside this
              window (skills/SkillPicker): nothing to close, nothing behind. */}
          <SettingsSection id="skills" active={section}>
          <BotSkillsPanel key={`skills-${bot.id}`} bot={bot} />
          </SettingsSection>
          <SettingsSection id="learning" active={section}>
          {desktop === true && <LearningSettings key={`learning-${bot.id}`} bot={bot} />}
          </SettingsSection>


          <SettingsSection id="permissions" active={section}>
          <BotPermissionDefault
            bot={bot}
            onThisComputer={bot.computer === "local"}
            desktop={desktop}
            onChoose={chooseDefaultMode}
            onOption={(key, value) => patch(key === "fullAccessChannelMessages" ? { fullAccessChannelMessages: value } : { fullAccessSetupRequests: value })}
          />

          <BotImageApproval
            bot={bot}
            desktop={desktop}
            onChoose={(setting) => patch({ imageApproval: setting })}
            onAskAfter={(value) => patch({ imageAskAfter: value })}
          />

          <RememberedApprovals bot={bot} desktop={desktop} />

          <div className="rounded-xl bg-card p-4">
            <div className="text-[15px] font-medium text-ink">{t("settings.bot.review.title")}</div>
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              {canAutoReview
                ? t("settings.bot.review.supported")
                : t("settings.bot.review.unsupported")}
            </div>
            <div className="mt-3 flex gap-1 rounded-lg bg-inset p-0.5">
              {(
                [
                  ["off", t("settings.bot.review.off"), t("settings.bot.review.offHint")],
                  ["shadow", t("settings.bot.review.shadow"), t("settings.bot.review.shadowHint")],
                  ["enforce", t("settings.bot.review.enforce"), t("settings.bot.review.enforceHint")],
                ] as const
              ).map(([value, label, hint]) => {
                const current = bot.autoReview === "shadow" || bot.autoReview === "enforce" ? bot.autoReview : "off";
                const disabled = value !== "off" && !canAutoReview;
                return (
                  <button
                    key={value}
                    title={disabled ? t("settings.bot.review.notSupported") : hint}
                    disabled={disabled}
                    onClick={() => patch({ autoReview: value })}
                    className={cn(
                      "flex-1 rounded-md px-2.5 py-1.5 text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-40",
                      current === value ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink",
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          </SettingsSection>
          <SettingsSection id="voice" active={section}>
          <VoiceSettings bot={bot} onPatch={patch} />

          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
            <div>
              <div className="text-[15px] font-medium text-ink">
                {t("settings.bot.notifications.title")}
              </div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                {t("settings.bot.notifications.note")}
              </div>
            </div>
            <Switch
              checked={bot.notifications}
              aria-label={t("settings.bot.notifications.switchLabel")}
              onClick={() => {
                const enabled = !bot.notifications;
                if (enabled) void requestNotificationPermission();
                patch({ notifications: enabled });
              }}
            />
          </div>
          </SettingsSection>
          <SettingsSection id="routines" active={section}>
          {state.routines.filter(routine => routine.botId === bot.id).map(routine => <div key={routine.id} className="rounded-xl bg-card p-4"><p className="text-[14px] font-medium">{routine.name}</p><p className="mt-1 text-[12px] text-ink-secondary">{routine.enabled ? t("settings.bot.routines.enabled") : t("settings.bot.routines.paused")}</p></div>)}
          {!state.routines.some(routine => routine.botId === bot.id) && <p className="text-[13px] text-ink-secondary">{t("settings.bot.routines.none")}</p>}
          <button type="button" onClick={() => navigate(() => dispatch({ type: "showRoutines" }))} className="min-h-10 rounded-lg bg-control px-3 py-2 text-[13px]">{t("settings.bot.routines.open")}</button>
          </SettingsSection>
          <SettingsSection id="teams" active={section}>
          {desktop === true && section === "teams" && <LazyBoundary inline onRetry={TeamsSection.retry}><Suspense fallback={<p role="status" className="text-[13px] text-ink-secondary">{t("settings.bot.teams.loading")}</p>}><TeamsSection.Component key={`teams-${bot.id}`} bot={bot} /></Suspense></LazyBoundary>}
          </SettingsSection>
          <SettingsSection id="history" active={section}>
          {allHeldTasks(bot).map(task => <button type="button" key={task.threadId} onClick={() => dispatch({ type: "switchTask", botId: bot.id, threadId: task.threadId })} className="block min-h-10 w-full rounded-xl bg-card p-4 text-left">
            <p className="text-[14px] font-medium">{task.title}</p><p className="mt-1 text-[12px] text-ink-secondary">{new Date(task.createdAt).toLocaleString()}{task.threadId === bot.threadId ? ` · ${t("settings.bot.history.current")}` : ""}</p>
          </button>)}
          {!bot.tasks?.length && <p className="text-[13px] text-ink-secondary">{t("settings.bot.history.none")}</p>}
          {olderHistory.hasMore && <button type="button" disabled={olderHistory.loading} onClick={olderHistory.loadMore} className="block min-h-10 w-full rounded-xl bg-control px-3 py-2 text-left text-[13px] disabled:opacity-60">{olderHistory.loading ? t("settings.bot.history.loadingOlder") : t("settings.bot.history.showOlder")}</button>}
          {olderHistory.failed && !olderHistory.loading && <p role="alert" className="text-[13px] text-danger">{t("settings.bot.history.loadFailed")}</p>}
          </SettingsSection>
        </div>
      </div>
    </aside>
    <LocalComputerAutoWarning
      open={localAutoWarning !== null}
      mode={localAutoWarning === "full" || localAutoWarning === "unlimited" ? localAutoWarning : "auto"}
      onCancel={() => setLocalAutoWarning(null)}
      onConfirm={() => {
        if (localAutoWarning === "auto") patch({ autoApprove: true, fullAccess: false, acknowledgeLocalAuto: true });
        if (localAutoWarning === "full") patch({ autoApprove: true, fullAccess: true, noLimits: false, acknowledgeLocalAuto: true });
        if (localAutoWarning === "unlimited") patch({ autoApprove: true, fullAccess: true, noLimits: true, acknowledgeLocalAuto: true });
        if (localAutoWarning === "local") patch({ computer: "local", acknowledgeLocalAuto: true });
        setLocalAutoWarning(null);
      }}
    />
    <FullAccessWarning
      open={fullAccessWarning !== null}
      botName={bot.name}
      level={fullAccessWarning?.level ?? "full"}
      scope="bot"
      onThisComputer={fullAccessWarning?.onThisComputer === true}
      onCancel={() => setFullAccessWarning(null)}
      onConfirm={() => {
        if (fullAccessWarning) patch({
          autoApprove: true, fullAccess: true,
          ...(fullAccessWarning.level === "unlimited" ? { noLimits: true, acknowledgeNoLimits: true } : { noLimits: false, acknowledgeFullAccess: true }),
          ...(fullAccessWarning.onThisComputer ? { acknowledgeLocalAuto: true } : {}),
        });
        setFullAccessWarning(null);
      }}
    />
    </>
  );
}
