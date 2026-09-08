import { ChevronDown, ChevronLeft, FolderOpen, X } from "lucide-react";
import { useState } from "react";
import { api, useStore, type Bot } from "@/state/store";
import { stateForBot } from "@/lib/mascot";
import { CloudBackendPicker } from "./CloudBackendPicker";
import { ModelPicker } from "./ModelPicker";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { cn } from "@/lib/cn";
import { builtInBrowserEnabled } from "@/lib/feature-flags";
import { requestNotificationPermission } from "@/lib/notify";
import { useDesktopSurface } from "@/lib/use-surface";
import { botUsage, costCaption, formatTokens, formatUsd, hasFiniteCost } from "@/lib/usage";
import { shortPath } from "@/lib/short-path";
import { instanceSupportsLocalComputer, localComputerDisabledReason, localComputerSelectable } from "@/lib/local-computer";
import { BotProfileAvatarCard } from "./BotProfileAvatarCard";
import { BotRoleControl } from "./BotRoleControl";
import { BotSetupAction } from "./BotIntakeCard";
import { BotSkillsPanel } from "./BotSkillsPanel";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";
import { VoiceSettings } from "./VoiceSettings";
import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile";
import { Switch } from "./SettingsPrimitives";
import { BotAccessSettings } from "./BotAccessSettings";
import { MemorySettings } from "./MemorySettings";

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
  const usage = botUsage(bot);
  const instance = state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId);
  if (usage.turns === 0) return null;
  return (
    <div className="rounded-xl bg-card p-4">
      <div className="flex items-baseline justify-between">
        <div className="text-[15px] font-medium text-ink">Usage</div>
        <button
          onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: "usage" })}
          className="text-[12px] text-ink-secondary hover:text-ink"
        >
          All bots →
        </button>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-3 text-[13px]">
        <div>
          <div className="text-[11.5px] uppercase tracking-wide text-ink-secondary">Turns</div>
          <div className="mt-0.5 tabular-nums text-ink">{usage.turns}</div>
        </div>
        <div>
          <div className="text-[11.5px] uppercase tracking-wide text-ink-secondary">Tokens</div>
          <div className="mt-0.5 tabular-nums text-ink" title={`${formatTokens(usage.input)} in · ${formatTokens(usage.output)} out`}>
            {formatTokens(usage.input + usage.output)}
          </div>
        </div>
        <div>
          <div className="text-[11.5px] uppercase tracking-wide text-ink-secondary">Cost</div>
          <div className="mt-0.5 tabular-nums text-ink">{hasFiniteCost(usage.costUsd) ? formatUsd(usage.costUsd) : "—"}</div>
        </div>
      </div>
      <div className="mt-2 text-[12px] text-ink-secondary">
        {hasFiniteCost(usage.costUsd) ? `Cost ${costCaption(instance?.snapshot.billing)}.` : "This engine doesn't report a price; tokens are counted."}
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
  const task = bot.tasks?.find((t) => t.threadId === bot.threadId);
  const pinned = task?.cwd; // undefined = not yet, null = legacy home, string = folder
  const pinnedElsewhere = pinned !== undefined && (pinned ?? undefined) !== bot.cwd;

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
      <div className="text-[15px] font-medium text-ink">Working folder</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">Where this bot runs its shell and file tools.</div>
      {canPick ? (
        <div className="mt-3 flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate rounded-lg border border-hairline/40 bg-inset px-3 py-2 font-mono text-[12.5px] text-ink" title={bot.cwd}>
            {bot.cwd ? shortPath(bot.cwd, home) : <span className="text-ink-secondary">Private bot workspace</span>}
          </div>
          <button onClick={() => void pick()} disabled={saving} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
            <FolderOpen size={14} /> Choose…
          </button>
          {bot.cwd && (
            <button onClick={() => void save(null)} disabled={saving} className="shrink-0 rounded-lg px-2 py-2 text-[13px] text-ink-secondary hover:text-ink disabled:opacity-50">
              Clear
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
            placeholder="Private bot workspace — or an absolute path"
            value={draft ?? bot.cwd ?? ""}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" disabled={saving || draft === null} className="shrink-0 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50">
            Save
          </button>
        </form>
      )}
      {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
      {pinnedElsewhere && (
        <div className="mt-2 text-[12px] text-ink-secondary">
          New tasks start here. This task is pinned to {pinned ? <span className="font-mono">{shortPath(pinned, home)}</span> : "the home folder"}; start a new task to use the new folder.
        </div>
      )}
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
  const [topics, setTopics] = useState<MemoryTopic[]>([]);
  const [saving, setSaving] = useState(false);
  const [topic, setTopic] = useState<{ name: string; text: string } | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    setTopic(null);
    try {
      const result: { text: string; truncated: boolean; topics: MemoryTopic[] } = await api(
        `/api/bots/${bot.id}/memory`,
      );
      setText(result.text);
      setTruncated(result.truncated);
      setTopics(result.topics);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const result: { truncated: boolean } = await api(`/api/bots/${bot.id}/memory`, {
        method: "PUT",
        body: JSON.stringify({ text }),
      });
      setTruncated(result.truncated);
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
          <div className="text-[15px] font-medium text-ink">Legacy notebook</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            Editable Markdown notes. Import them into managed memory to make them available for recall.
          </div>
        </div>
        <ChevronDown size={16} className={cn("shrink-0 text-ink-secondary transition-transform", open && "rotate-180")} />
      </button>

      {open && loading && <div className="mt-3 text-[13px] text-ink-secondary">Loading…</div>}

      {open && !loading && topic && (
        <div className="mt-3">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-mono text-[12.5px] text-ink">memory/{topic.name}</span>
            <button
              onClick={() => setTopic(null)}
              className="shrink-0 rounded-md px-2 py-1 text-[13px] text-ink-secondary hover:bg-control hover:text-ink"
            >
              Back
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
            placeholder="Optional Markdown notes for this bot."
            aria-label="Legacy bot notebook"
            onChange={(e) => {
              setText(e.target.value);
              setDirty(true);
            }}
          />
          <div className="mt-2 flex items-center gap-3">
            <button
              onClick={() => void save()}
              disabled={saving || !dirty}
              className="rounded-lg bg-control px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            {truncated && (
              <span className="text-[11.5px] text-ink-secondary">
                This exceeds the old notebook prompt limit. The full file is still saved and can be imported into managed memory.
              </span>
            )}
          </div>
          {topics.length > 0 && (
            <div className="mt-3">
              <div className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
                Topic files
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

export function SettingsPanel({ bot }: { bot: Bot }) {
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
  const [localAutoWarning, setLocalAutoWarning] = useState<"auto" | "local" | null>(null);
  const [memoryOpen, setMemoryOpen] = useState(true);
  const localDisabledReason = localComputerDisabledReason({ capabilities, providerSupportsLocal });
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
        | "avatarUrl"
        | "avatarCrop"
        | "autoApprove"
        | "autoReview"
        | "speakReplies"
        | "voice"
        | "chiefOfStaff"
        | "approvePeerComms"
        | "composio"
        | "browser"
        | "modelSelection"
      >
    > & { acknowledgeLocalAuto?: boolean; persona?: string },
  ) => dispatch({ type: "updateBot", botId: bot.id, patch: p });
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
  const connectedAppsEnabled = bot.composio !== false;
  const canUseBrowser = engine?.capabilities?.browserMcp === true;
  const desktopBrowser = Boolean(window.muragebox?.browser);
  const browserBlockedOnWindows = window.muragebox?.platform === "win32" && !desktopBrowser;
  const browserFeature = builtInBrowserEnabled(state.config);
  const browserAllowed = bot.browser !== false;
  const browserEnabled = browserFeature && browserAllowed;

  return (
    <>
    <aside
      className={cn(
        // Clip without creating a second scroll container. overflow:hidden
        // still lets focus/scrollIntoView scroll this aside past its header.
        "animate-panel-in relative z-20 flex h-full min-h-0 flex-col overflow-clip border-l border-hairline/40 bg-panel",
        "md:w-[400px] md:shrink-0",
        // Same collapse as InspectorPanel: a fixed 400px column beside the chat
        // takes main to 0px wide below ~800px. Below md the profile covers the
        // chat; its header already carries the "Collapse agent profile" back
        // button, so there is a way out.
        "max-md:absolute max-md:inset-0 max-md:z-40 max-md:w-full",
      )}
    >
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between px-4 py-3">
        <button
          onClick={() => dispatch({ type: "toggleSettings", open: false })}
          aria-label="Collapse agent profile"
          title="Collapse agent profile"
          className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"
        >
          <ChevronLeft size={18} />
        </button>
        <span className="text-[15px] font-semibold text-ink">Agent profile</span>
        <button
          onClick={() => dispatch({ type: "toggleSettings", open: false })}
          aria-label="Close agent profile"
          title="Close agent profile"
          className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        <div className="flex flex-col gap-4 pt-4">
          {/* Below md this panel covers the chat, and the chat is where the
              app's error banner renders — a refused role change would land
              behind it with nothing on screen to explain the snap-back. */}
          {state.error && (
            <div role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-[12.5px] leading-relaxed text-danger">
              {state.error}
            </div>
          )}
          <BotProfileAvatarCard
            bot={bot}
            activeState={activeState}
            mascotMotion={mascotMotion}
            onPatch={patch}
          />

          <Field label="Name">
            <input
              className={inputCls}
              maxLength={BOT_PROFILE_LIMITS.name}
              value={bot.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </Field>
          <Field label="Title">
            <input
              className={inputCls}
              maxLength={BOT_PROFILE_LIMITS.title}
              placeholder="Describe what your agent does"
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
          <Field label="Instructions">
            <textarea
              className={cn(inputCls, "min-h-[96px] resize-none")}
              maxLength={BOT_PROFILE_LIMITS.description}
              placeholder="What this agent does, what it should know, and how you want it to work"
              value={bot.description}
              onChange={(e) => patch({ description: e.target.value })}
            />
            <p className="mt-1.5 text-[12px] leading-relaxed text-ink-secondary">
              Written to this agent at the start of every turn, in its own words. Its teammates
              also read it when they decide who to hand work to, so keep it about the job.
            </p>
          </Field>
          <Field label="Personality">
            <textarea
              className={cn(inputCls, "min-h-[64px] resize-none")}
              maxLength={BOT_PROFILE_LIMITS.persona}
              placeholder="Direct, a little snarky, dry wit. Skip the pleasantries."
              value={persona}
              onChange={(e) => patch({ persona: e.target.value })}
            />
            <div className="mt-1.5 flex items-start justify-between gap-3">
              <p className="text-[12px] leading-relaxed text-ink-secondary">
                How this agent talks, spoken to it, and read by nothing else. A teammate
                deciding who to delegate to never sees it.
              </p>
              <span className="shrink-0 pt-px text-[11.5px] tabular-nums text-ink-secondary">
                {persona.length}/{BOT_PROFILE_LIMITS.persona}
              </span>
            </div>
          </Field>

          {/* SETUP LIVES HERE, not in the composer dock.
              Beside the role control because this is the same kind of
              question — what IS this bot — and because a person arrives at
              this panel on purpose. The composer version renders only for a
              genuinely new agent; this one is always reachable, and warns
              before it touches an agent that already has skills, a
              description, or a conversation behind it. */}
          <BotSetupAction bot={bot} />

          <BotRoleControl bot={bot} canCoordinate={canCoordinate} />

          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
            <div>
              <div className="text-[15px] font-medium text-ink">
                Ask me before contacting other bots
              </div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                {bot.approvePeerComms
                  ? "This bot will stop and ask before it reaches out to another bot."
                  : "Let this bot talk to teammates on its own, without a confirmation step."}
              </div>
            </div>
            <Switch
              checked={Boolean(bot.approvePeerComms)}
              aria-label="Ask me before contacting other bots"
              disabled={!bot.approvePeerComms && !canCoordinate}
              onClick={() => patch({ approvePeerComms: !bot.approvePeerComms })}
              title={!bot.approvePeerComms && !canCoordinate ? "This engine cannot contact other bots" : undefined}
              className="disabled:cursor-not-allowed"
            />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
            <div>
              <div className="text-[15px] font-medium text-ink">Connected apps</div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                {!connectedAppsConfigured
                  ? "Connect apps in App Settings before giving this bot access."
                  : !canUseConnectedApps
                    ? "This bot's current engine cannot use connected apps."
                    : connectedAppsEnabled
                      ? "Let this bot use your connected Gmail, Calendar, Slack, and other apps."
                      : "Keep your connected apps unavailable to this bot."}
              </div>
            </div>
            <Switch
              checked={connectedAppsEnabled}
              aria-label="Allow this bot to use connected apps"
              disabled={
                !connectedAppsEnabled && (!connectedAppsConfigured || !canUseConnectedApps)
              }
              onClick={() => patch({ composio: !connectedAppsEnabled })}
              title={
                !connectedAppsEnabled && !connectedAppsConfigured
                  ? "Connect apps in App Settings first"
                  : !connectedAppsEnabled && !canUseConnectedApps
                    ? "This engine cannot use connected apps"
                    : undefined
              }
              className="disabled:cursor-not-allowed"
            />
          </div>

          <BotAccessSettings key={`access-${bot.id}`} botId={bot.id} />

          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
            <div>
              <div className="text-[15px] font-medium text-ink">Browser</div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                {!desktopBrowser
                  ? browserBlockedOnWindows
                    ? "The built-in browser is temporarily unavailable on Windows while Electron's production sandbox support is being verified."
                    : "The built-in browser needs the Murage desktop app."
                  : !browserFeature
                    ? "The built-in browser is switched off under App Settings → Experimental."
                    : !canUseBrowser
                      ? "This bot's current engine cannot use the built-in browser."
                      : browserEnabled
                        ? "This bot has its own browser tab in the computer panel, with its own logins, watchable and takeable at any time."
                        : "Keep the built-in browser unavailable to this bot."}
              </div>
            </div>
            <Switch
              checked={browserEnabled}
              aria-label="Give this bot a built-in browser"
              disabled={!browserEnabled && (!desktopBrowser || !browserFeature || !canUseBrowser)}
              onClick={() => patch({ browser: !browserAllowed })}
              className="disabled:cursor-not-allowed"
            />
          </div>

          <div className="rounded-xl bg-card p-4">
            <ModelPicker
              bot={bot}
              contained
              label={
                <div>
                  <div className="text-[15px] font-medium text-ink">Model</div>
                  <div className="mt-0.5 text-[13px] text-ink-secondary">
                    Which provider and model this bot runs on
                  </div>
                </div>
              }
            />
          </div>

          {!!engine?.capabilities?.effortLevels?.length && (
            <div className="rounded-xl bg-card p-4">
              <div className="text-[15px] font-medium text-ink">Effort</div>
              {/* Says what the app does, not what the engine ends up at:
                  Codex applies a level to the whole thread and has no way to
                  take one back, so "currently: engine default" was a promise
                  we could not keep for a thread that had already been sent
                  one. Sending nothing is true on every engine. */}
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                How hard this bot thinks{bot.modelSelection.effort ? "" : " (Default: no level is sent)"}
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
                    {/* the others capitalize cleanly; "xhigh" would read "Xhigh" */}
                    {level === "xhigh" ? "X-High" : (level ?? "Default")}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* WHERE THE WORK RUNS is a decision for the keyboard.
              Rendered only on a confirmed desktop — `undefined` shows nothing,
              because showing it and then taking it away is worse than a card
              that arrives a moment late. The bot keeps whatever it is already
              set to; nothing here is required to read a conversation, approve
              an action, or send a message from a phone. */}
          {desktop === true && (
          <div className="rounded-xl bg-card p-4">
            <div className="text-[15px] font-medium text-ink">Computer</div>
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              Where this bot's computer runs{bot.computer ? "" : " (currently: auto)"}
            </div>
            <div className="mt-3 flex overflow-hidden rounded-lg border border-hairline/40">
              {([
                ["cloud", "Cloud"],
                ["vm", "Local VM"],
                ["local", "This computer"],
                ["off", "Off"],
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
                      <div className="text-[13px] text-ink">Start VPS automatically</div>
                      <div className="mt-0.5 text-[11.5px] text-ink-secondary">
                        Allow Auto to create or wake this bot's managed container when needed.
                      </div>
                    </div>
                    <Switch
                      checked={Boolean(bot.autoStartVps)}
                      aria-label="Start VPS automatically"
                      onClick={() => patch({ autoStartVps: !bot.autoStartVps })}
                    />
                  </div>
                )}
              </>
            )}
          </div>
          )}

          <BotUsageCard bot={bot} />
          <WorkingFolder bot={bot} />

          {/* keyed so switching bots never shows one bot's notes under another's name */}
          <details open={memoryOpen} className="rounded-xl bg-card p-4" onToggle={event => setMemoryOpen(event.currentTarget.open)}>
            <summary className="cursor-pointer text-[15px] font-medium text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">Managed memory</summary>
            {memoryOpen && <div className="mt-3"><MemorySettings key={`memory-${bot.id}`} botId={bot.id} /></div>}
          </details>
          <MemoryCard key={bot.id} bot={bot} />

          {/* "Add a skill" is the other end of assignment: it opens the
              library with THIS agent already chosen, so the person never has
              to say which agent twice. */}
          <BotSkillsPanel
            key={`skills-${bot.id}`}
            bot={bot}
            onBrowse={() => dispatch({ type: "showTeamLibrary", botId: bot.id })}
          />

          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
            <div>
              <div className="text-[15px] font-medium text-ink">Auto mode</div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                {bot.computer === "local"
                  ? bot.autoApprove
                    ? "Keeps going on this computer; you'll still be asked about anything destructive, and about questions it asks you."
                    : "Approve each action on this computer yourself. Turn on to let this bot keep working without stopping to ask."
                  : bot.autoApprove
                  ? "Keeps going on its own; you'll still be asked about anything destructive, and about questions it asks you."
                  : "Approve each action yourself. Turn on to let this bot keep working without stopping to ask."}
              </div>
            </div>
            <Switch
              checked={Boolean(bot.autoApprove)}
              aria-label="Auto mode"
              onClick={() => {
                if (!bot.autoApprove && bot.computer === "local") setLocalAutoWarning("auto");
                else patch({ autoApprove: !bot.autoApprove });
              }}
            />
          </div>

          <div className="rounded-xl bg-card p-4">
            <div className="text-[15px] font-medium text-ink">Review routine approvals</div>
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              {canAutoReview
                ? "The same engine reviews ordinary approval cards. Existing safety rules, unattended turns, local-computer access, and questions still wait for you."
                : "This engine cannot run an isolated review safely, so approval cards continue to wait for you."}
            </div>
            <div className="mt-3 flex gap-1 rounded-lg bg-inset p-0.5">
              {(
                [
                  ["off", "Off", "Every undecided approval waits for you."],
                  ["shadow", "Watch", "Record the review without answering the card."],
                  ["enforce", "On", "Answer only reviews that return a strict approval."],
                ] as const
              ).map(([value, label, hint]) => {
                const current = bot.autoReview === "shadow" || bot.autoReview === "enforce" ? bot.autoReview : "off";
                const disabled = value !== "off" && !canAutoReview;
                return (
                  <button
                    key={value}
                    title={disabled ? "Not supported by this engine" : hint}
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

          <VoiceSettings bot={bot} onPatch={patch} />

          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
            <div>
              <div className="text-[15px] font-medium text-ink">
                Notifications
              </div>
              <div className="mt-0.5 text-[13px] text-ink-secondary">
                Get notified when this agent finishes or needs input
              </div>
            </div>
            <Switch
              checked={bot.notifications}
              aria-label="Agent notifications"
              onClick={() => {
                const enabled = !bot.notifications;
                if (enabled) void requestNotificationPermission();
                patch({ notifications: enabled });
              }}
            />
          </div>
        </div>
      </div>
    </aside>
    <LocalComputerAutoWarning
      open={localAutoWarning !== null}
      onCancel={() => setLocalAutoWarning(null)}
      onConfirm={() => {
        if (localAutoWarning === "auto") patch({ autoApprove: true, acknowledgeLocalAuto: true });
        if (localAutoWarning === "local") patch({ computer: "local", acknowledgeLocalAuto: true });
        setLocalAutoWarning(null);
      }}
    />
    </>
  );
}
