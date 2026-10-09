import { LazyBoundary, retryableLazy } from "./LazyBoundary";
import { ProjectAutonomySetting } from "./ProjectAutonomySetting";
import { BrowserExternalClients } from "./BrowserExternalClients";
import { effortLabel } from "@/lib/effort-label";
import { t } from "@/lib/i18n";
// App settings, as a real modal with sections rather than one long panel.
// Per-bot settings (persona, model, computer) stay in SettingsPanel; this is
// the stuff shared by every bot: who you are, your keys, and the machine your
// bots can borrow.
//
// 0.1.62 (NAV-OVERHAUL.md, Option B): six group headings over short pages
// that each do one job. The section ids, their groups and their search words
// live in lib/settings-sections.ts; this file owns the icons and the pages.
import { Suspense, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Archive, BookOpen, ChevronDown, Coins, Cpu, FlaskConical, Globe, Image as ImageIcon, LifeBuoy, MessageCircle, Mic, Monitor, Puzzle, ScrollText, Search, SlidersHorizontal, Smartphone, Terminal, Trash2, User, UserRound, X } from "lucide-react";
import { api, useStore, type AppSettingsSection, type ConfigStatus } from "@/state/store";
import { analyticsEnabled, setAnalyticsEnabled } from "@/lib/analytics";
import { inNativeShell } from "@/lib/native-shell";
import { builtInBrowserEnabled, showToolCallsEnabled, skillRecorderEnabled } from "@/lib/feature-flags";
import { localeChoices } from "@/locales";
import { ApiKeyRow, VpsConnection } from "./ApiKeys";
import { ImageSettings } from "./ImageSettings";
import { ModelsSettings } from "./ModelsSettings";
import { PasteKeys } from "./PasteKeys";
import { useUpdaterState, type UpdaterState } from "@/lib/updater";
import { EnginesSettings } from "./EnginesSettings";
import { LocalComputerSection } from "./LocalComputerSection";
import { CompanionSection } from "./CompanionSection";
import { Card, Switch } from "./SettingsPrimitives";
import { UsageSection } from "./UsageSection";
import { SkinPicker } from "./SkinPicker";
import { RoomTurnTimeoutSettings } from "./RoomTurnTimeoutSettings";
import { ROOM_ROUTING_COPY, RoomRoutingSettings } from "./RoomRoutingSettings";
import { TranscriptionSettings } from "./TranscriptionSettings";
import { SearchSettings } from "./SearchSettings";
import { SkillsSettings } from "./skills/SkillsSettings";
import { HouseRulesSettings } from "./HouseRulesSettings";
import { ScriptAccessSettings } from "./ScriptAccessSettings";
import { AboutMeSettings } from "./AboutMeSettings";
import { NotificationSettings } from "./NotificationSettings";
import { BackupSettings } from "./BackupSettings";
import { StartupSettings } from "./StartupSettings";
import { AnnouncementsSettings } from "./AnnouncementsSettings";
import { TelegramSettings } from "./TelegramSettings";
import { SlackSettings } from "./SlackSettings";
import { WhatsAppSettings } from "./WhatsAppSettings";
import { DiscordSettings } from "./DiscordSettings";
import { StarterProfiles } from "./StarterProfiles";
import { RemoteSignOut } from "./RemoteSignOut";
import { PhoneNotifications } from "./PhoneNotifications";
import { openFirstRun } from "@/lib/first-run";
import { cn } from "@/lib/cn";
import { useDesktopSurface, useSurfaceState } from "@/lib/use-surface";
import {
  browserProfileDeletionBlockReason,
  browserProfilesForPatch,
  browserProfileReplacementPatch,
} from "@/lib/browser-profiles";
import { returnFocus } from "@/lib/return-focus";
import {
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  sectionsForSurface,
  settingsGroupLabel,
  settingsGroupNote,
  settingsSectionLabel,
  settingsSectionNote,
  settingsSectionRedirect,
  type SettingsSectionEntry,
} from "@/lib/settings-sections";
import { settingsSectionMatches } from "@/lib/settings-search";
import {
  chooseAutoRail,
  chooseSidebarDensity,
  sidebarDensityState,
  subscribeSidebarDensity,
  type SidebarDensity,
} from "@/lib/sidebar-preferences";
import { APP_VERSION, whatsNewPage } from "@/lib/whats-new";
import { sourceCodeLink, sourceVersionLabel } from "@/lib/source-code";
import { openKeyboardShortcuts, openWhatsNew } from "@/lib/app-events";

export { sectionsForSurface, settingsSectionRedirect } from "@/lib/settings-sections";
export { settingsSearchResults } from "@/lib/settings-search";

const MemorySection = retryableLazy(() => import("./MemorySection"));
// The same chunk ImageSettings opens behind its button elsewhere.
const ImageLibrary = retryableLazy(() => import("./ImageLibrary"));

const SECTION_ICONS: Record<AppSettingsSection, typeof User> = {
  general: User,
  aboutMe: UserRound,
  botDefaults: SlidersHorizontal,
  houseRules: ScrollText,
  skills: BookOpen,
  memory: Cpu,
  models: Globe,
  engines: Terminal,
  images: ImageIcon,
  webSearch: Search,
  voice: Mic,
  connections: Puzzle,
  computer: Monitor,
  channels: MessageCircle,
  companion: Smartphone,
  backups: Archive,
  usage: Coins,
  about: LifeBuoy,
  experimental: FlaskConical,
};

type Section = SettingsSectionEntry & { icon: typeof User };
const SECTIONS: Section[] = SETTINGS_SECTIONS.map((entry) => ({ ...entry, icon: SECTION_ICONS[entry.id] }));

/** Reopens the guided first run.
 *
 * Not a dialog any more: it takes them to their chief of staff, where the
 * first run happens, and shows the progress rail beside it. Every step still
 * carries the tick the workspace's own live state earns, so running it again
 * on a working install reinstalls nothing and asks nothing twice. Settings
 * closes first, because what it is opening is the app underneath. */
export function SetupAgainRow() {
  const { dispatch } = useStore();
  return (
    <Card
      title="Get set up"
      subtitle="Your chief of staff picks it up where you left it. Everything already done stays done."
    >
      <button
        type="button"
        onClick={() => {
          dispatch({ type: "toggleAppSettings", open: false });
          openFirstRun();
        }}
        className="min-h-11 rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        Run setup again
      </button>
    </Card>
  );
}

/** Name + email, persisted to /api/config {profile} on blur. */
function ProfileFields() {
  const { state, dispatch } = useStore();
  const desktop = useDesktopSurface();
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");
  const saving = useRef(false);
  const [name, setName] = useState(state.config?.profile?.name ?? "");
  const [email, setEmail] = useState(state.config?.profile?.email ?? "");
  useEffect(() => {
    setName(state.config?.profile?.name ?? "");
    setEmail(state.config?.profile?.email ?? "");
  }, [state.config?.profile?.name, state.config?.profile?.email]);

  const save = async () => {
    if (desktop !== true || saving.current) return;
    const profile = { name: name.trim(), email: email.trim().toLowerCase() };
    if (profile.name === state.config?.profile?.name && profile.email === state.config?.profile?.email) return;
    saving.current = true;
    setStatus("saving");
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", { method: "PUT", body: JSON.stringify({ profile }) });
      if (!config.profile || typeof config.profile.name !== "string" || typeof config.profile.email !== "string") {
        throw new Error("The profile save could not be confirmed. Please retry.");
      }
      dispatch({ type: "configStatus", config });
      setStatus("saved");
    } catch (cause) {
      setStatus("error");
      setError(cause instanceof Error ? cause.message : "Could not save your profile. Please retry.");
    } finally {
      saving.current = false;
    }
  };

  const inputClass =
    "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";
  return (
    <div className="flex flex-col gap-3">
      <input aria-label="Your name" value={name} readOnly={desktop !== true} disabled={status === "saving"} onChange={(e) => { setName(e.target.value); setStatus("idle"); }} onBlur={() => void save()} placeholder="Your name" className={inputClass} />
      <input
        type="email"
        value={email}
        aria-label="Your email"
        readOnly={desktop !== true}
        disabled={status === "saving"}
        onChange={(e) => { setEmail(e.target.value); setStatus("idle"); }}
        onBlur={() => void save()}
        placeholder="you@example.com"
        className={inputClass}
      />
      {desktop !== true && <p className="text-[12px] text-ink-secondary">Change your profile in the desktop app.</p>}
      {(status === "saving" || status === "saved") && <p role="status" className="text-[12px] text-ink-secondary">{status === "saving" ? "Saving…" : "Saved"}</p>}
      {status === "error" && <div role="alert" className="text-[12px] text-danger">{error} <button type="button" onClick={() => void save()} className="rounded px-1 underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">Retry save</button></div>}
    </div>
  );
}

/** The Updates row's line. It leads with the running version: Linux has no
 * About panel, so this is the one place that version is shown. */
export function updatesSubtitle(s: UpdaterState | null): string {
  if (s?.status === "error" && s.action === "download-from-murage") return t("updates.verificationRefused");
  const running = s?.currentVersion ? `Murage ${s.currentVersion}. ` : "";
  return running + (
    s?.status === "deferred" ? "This update is waiting for the pre-upgrade backup flow. Review Settings → Backups if it needs attention." : s?.status === "checking"
      ? "Checking…"
      : s?.status === "available"
        ? `${s.version} available`
        : s?.status === "downloading"
          ? s.percent == null ? "Starting download…" : `Downloading ${Math.round(s.percent)}%`
          : s?.status === "downloaded"
            ? s.installMode === "handoff" ? `${s.version} ready. Finish in a terminal` : `${s.version} ready. Restart to apply`
            : s?.status === "installing"
              ? "Preparing the update…"
              : s?.status === "handed-off"
                ? "Install command copied. Finish in a terminal."
            : s?.status === "error"
              ? `Update could not finish: ${s.message ?? "unknown error"}`
              : "You're on the latest version we know of."
  );
}

export function UpdatesRow() {
  const s = useUpdaterState();
  if (!window.muragebox?.updater) return null;
  const updater = window.muragebox.updater;
  const label = updatesSubtitle(s);
  return (
    <Card title={t("updates.title")} subtitle={label}>
      {s?.status !== "deferred" && <button
        onClick={() => {
          if (s?.status === "error" && s.action === "download-from-murage") return void window.muragebox?.openExternal?.("https://murage.ai/download");
          if (s?.status === "available") return void updater.download();
          if (s?.status === "downloaded") return void updater.install();
          if (s?.status === "error") return void updater.retry();
          void updater.check();
        }}
        disabled={s?.status === "checking" || s?.status === "downloading" || s?.status === "installing"}
        className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control disabled:opacity-40"
      >
        {s?.status === "available"
          ? t("updates.download")
          : s?.status === "downloaded"
            ? s.installMode === "handoff" ? "Install" : t("updates.restartInstall")
            : s?.status === "installing" ? "Preparing…"
              : s?.status === "error" ? s.action === "download-from-murage" ? t("updates.downloadFromMurage") : t("updates.retry")
            : t("updates.check")}
      </button>}
    </Card>
  );
}

/** Usage analytics, on by default and switchable here. Naming what is sent
 * matters more than the switch: people who cannot see the scope assume the
 * worst, and the worst — conversation text — is exactly what this never
 * sends (autocapture is off; see lib/analytics.ts). */
function AnalyticsRow() {
  const [on, setOn] = useState(analyticsEnabled);
  return (
    <Card
      title="Usage analytics"
      subtitle="Anonymous product events: app opened, which features get used. Never conversations, prompts, file contents, or bot output. Your email is only attached if you shared it during setup."
    >
      <Switch
        checked={on}
        aria-label="Send usage analytics"
        onClick={() => {
          const next = !on;
          setAnalyticsEnabled(next);
          setOn(next);
        }}
      />
    </Card>
  );
}

function LanguageRow() {
  const { state, dispatch } = useStore();
  const current = state.config?.language ?? "";
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async (language: string) => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ language }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the language.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title="Language"
      subtitle="The app follows your system language unless you pick one here. Only part of the interface is translated so far; untranslated text stays in English."
    >
      <select
        value={current}
        disabled={saving}
        aria-label="App language"
        onChange={(event) => void save(event.target.value)}
        className="w-full max-w-[280px] rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 text-[13.5px] text-ink disabled:cursor-wait disabled:opacity-50"
      >
        <option value="">System</option>
        {localeChoices.map(({ code, label }) => (
          <option key={code} value={code}>
            {label}
          </option>
        ))}
      </select>
      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
    </Card>
  );
}

const NEW_BOT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/** Effort for new bots (triage row 23): applied only where the new bot's
 *  engine offers that level; an explicit choice on the bot wins. */
function NewBotEffortRow() {
  const { state, dispatch } = useStore();
  const [error, setError] = useState("");
  const current = state.config?.newBots?.effort ?? "";
  const change = async (value: string) => {
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", { method: "PATCH", body: JSON.stringify({ newBots: { effort: value || null } }) });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the effort for new bots.");
    }
  };
  return (
    <Card title="New bots" subtitle="The effort a new bot starts with, when its engine offers that level. You can change it on any bot later.">
      <label className="flex items-center justify-between gap-4 text-[14px] text-ink">
        Effort for new bots
        <select value={current} onChange={(event) => void change(event.target.value)} className="rounded-md bg-inset px-2 py-1.5 text-[13px] text-ink">
          <option value="">Engine default</option>
          {NEW_BOT_EFFORTS.map((level) => <option key={level} value={level}>{effortLabel(level)}</option>)}
        </select>
      </label>
      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
    </Card>
  );
}

function ToolCallsRow() {
  const { state, dispatch } = useStore();
  const enabled = showToolCallsEnabled(state.config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const toggle = async () => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ features: { showToolCalls: !enabled } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the tool-call setting.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title="Tool calls"
      subtitle="Show each tool a bot runs in the transcript. Off by default; the mascot already shows that work is happening."
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-ink">Show tool calls</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
            Named chips for Bash, search, and other tools. Errors and bot-to-bot messages still appear.
          </div>
        </div>
        <Switch
          checked={enabled}
          aria-label="Show tool calls in chat"
          disabled={saving}
          onClick={() => void toggle()}
          className="disabled:cursor-wait disabled:opacity-50"
        />
      </div>
      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
    </Card>
  );
}

function ExperimentalFeaturesRow() {
  const { state, dispatch } = useStore();
  const skillRecorder = skillRecorderEnabled(state.config);
  const browser = builtInBrowserEnabled(state.config);
  const desktopBrowser = Boolean(window.muragebox?.browser);
  const browserBlockedOnWindows = window.muragebox?.platform === "win32" && !desktopBrowser;
  const [saving, setSaving] = useState<"skillRecorder" | "browser" | null>(null);
  const [error, setError] = useState("");

  const toggle = async (feature: "skillRecorder" | "browser", next: boolean) => {
    if (saving) return;
    setSaving(feature);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ features: { [feature]: next } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the experimental feature setting.");
    } finally {
      setSaving(null);
    }
  };

  return (
    <Card
      title="Experimental features"
      subtitle="Early features may change while we test them. They stay off unless you enable them."
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-ink">Teach a skill</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
            Record a workflow, use /learn, or ask a supported bot to run /create-verification-skill. Every change waits for your review.
          </div>
        </div>
        <Switch
          checked={skillRecorder}
          aria-label="Show Teach a skill"
          disabled={saving !== null}
          onClick={() => void toggle("skillRecorder", !skillRecorder)}
          className="disabled:cursor-wait disabled:opacity-50"
        />
      </div>
      <div className="mt-4 flex items-center justify-between gap-4 border-t border-hairline/30 pt-4">
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-ink">Built-in browser</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
            {desktopBrowser
              ? browser
                ? "Enabled for this workspace. Each bot also has its own browser switch."
                : "Off by default. Enable it to let supported bots use a browser tab you can watch and take over."
              : browserBlockedOnWindows
                ? "Temporarily unavailable on Windows while Electron's production sandbox support is being verified."
                : "Needs the Murage desktop app."}
          </div>
        </div>
        <Switch
          checked={browser}
          aria-label="Enable the built-in browser"
          disabled={saving !== null || (!browser && !desktopBrowser)}
          onClick={() => void toggle("browser", !browser)}
          className="disabled:cursor-wait disabled:opacity-50"
        />
      </div>
      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
    </Card>
  );
}

/** Named browser sessions: rename or delete; deleting wipes that session's
 * logins, storage and cache and sends any bot on it back to its own. */
export function BrowserProfilesRow() {
  const { state, dispatch } = useStore();
  const profiles = state.config?.browserProfiles ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string; expected: Array<{ id: string; name: string }> } | null>(null);
  const [error, setError] = useState("");
  // Windows temporarily gates the live browser surface, but upgraded users
  // must still be able to rename or permanently erase existing sessions.
  // The packaged server can perform that private lifecycle cleanup without
  // exposing the browser renderer bridge.
  if (!window.muragebox || (!builtInBrowserEnabled(state.config) && profiles.length === 0)) return null;

  const save = async (next: typeof profiles, expected: typeof profiles) => {
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify(browserProfileReplacementPatch(next, expected)),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save browser profiles.");
    } finally {
      setBusy(null);
      setRenaming(null);
    }
  };
  const remove = async (id: string) => {
    if (busy) return;
    const profile = profiles.find((candidate) => candidate.id === id);
    if (!profile) return;
    const referencedBots = state.bots.filter((bot) => bot.browserProfile === id);
    const blocked = browserProfileDeletionBlockReason(state.bots, id);
    if (blocked) {
      setError(blocked);
      return;
    }
    const botSummary = referencedBots.length
      ? ` ${referencedBots.length === 1 ? referencedBots[0]!.name : `${referencedBots.length} bots`} will switch to their own browser sessions.`
      : "";
    if (!window.confirm(`Delete “${profile.name}”?${botSummary} This permanently signs out of this profile and erases its browser data.`)) {
      return;
    }
    setBusy(id);
    setError("");
    try {
      // The server commits the profile list and clears every bot reference as
      // one transaction, then privately asks Electron to erase the partition.
      // Never wipe browser data from the renderer before that commit succeeds:
      // a rejected config save must leave the user's signed-in session intact.
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify(browserProfileReplacementPatch(profiles.filter((candidate) => candidate.id !== id), profiles)),
      });
      dispatch({ type: "configStatus", config });
      // Packaged Electron receives the same post-commit cleanup privately
      // from the server. Keep this idempotent fallback for split-process
      // desktop development, where the server has no parent message port.
      try {
        await window.muragebox?.browser?.forgetProfile?.(profile.partitionId ?? profile.id);
      } catch {
        setError("The profile was removed, but its local browser data could not be erased. Restart Murage before reusing that profile name.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not delete the browser profile.");
    } finally {
      setBusy(null);
    }
  };
  const rename = () => {
    if (!renaming || busy) return;
    const name = renaming.name.trim();
    if (!name) return;
    setBusy(renaming.id);
    setError("");
    void save(renaming.expected.map((profile) => (profile.id === renaming.id ? { ...profile, name } : profile)), renaming.expected);
  };
  const usersOf = (id: string) => state.bots.filter((bot) => !bot.hidden && bot.browserProfile === id).map((bot) => bot.name);

  return (
    <Card
      title="Browser profiles"
      subtitle="Save a browser sign-in and choose which bots share it. Create a profile from a bot's Browser tab."
    >
      {profiles.length === 0 ? (
        <div className="text-[13px] text-ink-secondary">No profiles yet. Pick "+ Add profile…" under a bot's browser.</div>
      ) : (
        <div className="flex flex-col divide-y divide-hairline/30">
          {profiles.map((profile) => {
            const users = usersOf(profile.id);
            const editing = renaming?.id === profile.id;
            return (
              <div key={profile.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <Globe size={14} className="shrink-0 text-ink-secondary" />
                  {editing ? (
                    // Shrinks with the row: at phone width the name field
                    // overflowed under Delete, so a tap on Save hit Delete.
                    <form
                      className="flex min-w-0 flex-1 items-center gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        rename();
                      }}
                    >
                      <input
                        autoFocus
                        value={renaming.name}
                        onChange={(event) => setRenaming({ ...renaming!, name: event.target.value })}
                        maxLength={40}
                        className="min-w-0 flex-1 rounded-md bg-inset px-2 py-1 text-[13px] text-ink outline-none"
                        aria-label="Profile name"
                      />
                      <button type="submit" disabled={busy !== null} className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-accent-ink disabled:opacity-50">
                        Save
                      </button>
                      <button type="button" onClick={() => setRenaming(null)} className="shrink-0 text-[12px] text-ink-secondary hover:text-ink">
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setRenaming({ id: profile.id, name: profile.name, expected: browserProfilesForPatch(profiles) })}
                      className="truncate text-left text-[14px] font-medium text-ink hover:underline"
                      title="Rename"
                    >
                      {profile.name}
                    </button>
                  )}
                  <span className="truncate text-[12px] text-ink-secondary">
                    {users.length ? `used by ${users.join(", ")}` : "not in use"}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => void remove(profile.id)}
                  disabled={busy !== null}
                  className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-control hover:text-danger disabled:opacity-50"
                  title="Delete this profile and forget its logins"
                >
                  <Trash2 size={13} /> Delete
                </button>
              </div>
            );
          })}
        </div>
      )}
      {error ? <div className="mt-2"><p role="alert" className="text-[12px] text-danger">{error}</p><button type="button" disabled={busy !== null} className="mt-2 rounded-md bg-control px-3 py-2 text-[12px] text-ink disabled:opacity-50" onClick={async () => {
        setBusy("refresh");
        try { const config: ConfigStatus = await api("/api/config"); dispatch({ type: "configStatus", config }); setRenaming(null); setError(""); }
        catch { setError("Could not refresh browser profiles. Try again."); }
        finally { setBusy(null); }
      }}>Refresh profiles</button></div> : null}
    </Card>
  );
}

/** Writes a redacted diagnostics file to a location the user picks. The
 * report holds versions, configured-or-not booleans and the server.log tail —
 * never credential values (the desktop shell does not read secret fields). */
function DiagnosticsRow() {
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  const exportDiagnostics = async () => {
    if (!window.muragebox?.exportDiagnostics || exporting) return;
    setExporting(true);
    setResult(null);
    try {
      const path = await window.muragebox.exportDiagnostics();
      if (path) setResult({ kind: "success", message: `Saved to ${path}` });
    } catch (e) {
      setResult({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setExporting(false);
    }
  };

  return (
    <Card
      title="Diagnostics"
      subtitle="Versions, configuration on/off state and a redacted server log tail. Review the file before sharing it."
    >
      <div className="flex min-w-0 flex-col items-end gap-2">
        <button
          onClick={() => void exportDiagnostics()}
          disabled={exporting}
          aria-label="Export diagnostics to a text file"
          className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control disabled:opacity-40"
        >
          {exporting ? "Exporting…" : "Export Diagnostics…"}
        </button>
        {result ? (
          <span
            role={result.kind === "error" ? "alert" : "status"}
            className={`max-w-64 break-all text-right text-[12px] ${result.kind === "error" ? "text-danger" : "text-success"}`}
          >
            {result.message}
          </span>
        ) : null}
      </div>
    </Card>
  );
}

const DENSITY_OPTIONS: readonly { id: SidebarDensity; label: () => string }[] = [
  { id: "compact", label: () => t("settings.sidebar.standard") },
  { id: "comfortable", label: () => t("settings.sidebar.roomy") },
  { id: "icons", label: () => t("settings.sidebar.rail") },
];

/** Sidebar density, beside the skin (it used to be a menu in the sidebar's
 *  header, next to a Collapse button that did the same thing). */
function SidebarDensityRow() {
  const prefs = useSyncExternalStore(subscribeSidebarDensity, sidebarDensityState, sidebarDensityState);
  return (
    <div className="mt-4 border-t border-hairline/30 pt-4 max-md:hidden">
      <div id="settings-sidebar-density" className="text-[14px] font-medium text-ink">{t("settings.sidebar.label")}</div>
      <div role="radiogroup" aria-labelledby="settings-sidebar-density" className="mt-2 grid grid-cols-3 overflow-hidden rounded-lg border border-hairline">
        {DENSITY_OPTIONS.map(({ id, label }, index) => {
          const selected = prefs.density === id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              onKeyDown={(event) => {
                const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
                if (!step) return;
                event.preventDefault();
                const at = (index + step + DENSITY_OPTIONS.length) % DENSITY_OPTIONS.length;
                chooseSidebarDensity(DENSITY_OPTIONS[at].id);
                event.currentTarget.parentElement?.querySelectorAll("button")[at]?.focus();
              }}
              onClick={() => chooseSidebarDensity(id)}
              className={cn(
                "flex h-9 items-center justify-center px-3 text-[13px] transition-colors",
                index > 0 && "border-l border-hairline",
                selected
                  ? "bg-control font-medium text-accent-text shadow-[inset_0_0_0_1px_var(--color-accent-border)]"
                  : "text-ink-secondary hover:bg-control/50",
              )}
            >
              {label()}
            </button>
          );
        })}
      </div>
      <div className="mt-3 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div id="settings-auto-rail" className="text-[13.5px] text-ink">{t("settings.sidebar.autoRail")}</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">{t("settings.sidebar.autoRailNote")}</div>
        </div>
        <Switch checked={prefs.autoRail} aria-labelledby="settings-auto-rail" onClick={() => chooseAutoRail(!prefs.autoRail)} />
      </div>
    </div>
  );
}

/** Opens the page What's new showed after the last update. */
function WhatsNewRow() {
  const { dispatch } = useStore();
  const desktop = useDesktopSurface();
  if (desktop !== true || !whatsNewPage()) return null;
  return (
    <Card title={t("settings.about.whatsNewTitle")} subtitle={t("settings.about.whatsNewNote")}>
      <button
        type="button"
        onClick={() => {
          dispatch({ type: "toggleAppSettings", open: false });
          openWhatsNew();
        }}
        className="min-h-11 rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {t("settings.about.whatsNewOpen")}
      </button>
    </Card>
  );
}

/** The source offer the GNU AGPL (section 13) asks for. Shown on every
 * surface, the browser door included: whoever uses Murage over a network is
 * told where the source of this version is. */
function SourceCodeRow() {
  return (
    <Card title={t("settings.about.sourceTitle")} subtitle={`${t("settings.about.sourceNote")} ${sourceVersionLabel(APP_VERSION)}.`}>
      <a
        href={sourceCodeLink()}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex min-h-11 items-center rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {t("settings.about.sourceOpen")}
      </a>
    </Card>
  );
}

function ShortcutsRow() {
  const { dispatch } = useStore();
  return (
    <Card title={t("settings.about.shortcutsTitle")} subtitle={t("settings.about.shortcutsNote")}>
      <button
        type="button"
        onClick={() => {
          dispatch({ type: "toggleAppSettings", open: false });
          openKeyboardShortcuts();
        }}
        className="min-h-11 rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {t("settings.about.shortcutsOpen")}
      </button>
    </Card>
  );
}

const linkButton = "rounded px-0.5 font-medium text-accent-text underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";
const secondaryButton = "min-h-11 rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

/** Settings > Connected apps: the key and the way into the panel. The apps
 *  themselves live in the panel (the sidebar's Apps place). */
function ConnectedAppsSettings() {
  const { state, dispatch } = useStore();
  const go = (section: AppSettingsSection) => dispatch({ type: "toggleAppSettings", open: true, section });
  const openPanel = (surface: "apps" | "mcp") => {
    dispatch({ type: "toggleAppSettings", open: false });
    dispatch({ type: "togglePlugins", open: true, surface });
  };
  return (
    <>
      <Card title={t("settings.section.connections")} subtitle={t("settings.connections.note")}>
        <div className="flex flex-col gap-4">
          {state.config?.composio.mode === "managed" ? (
            <div className="rounded-lg border border-success/25 bg-success/10 px-3 py-2 text-[13px] text-success">
              {t("settings.connections.ready")}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => openPanel("apps")} className={secondaryButton}>{t("settings.connections.openApps")}</button>
            <button type="button" onClick={() => openPanel("mcp")} className={secondaryButton}>{t("settings.connections.openMcp")}</button>
          </div>
        </div>
      </Card>
      {/* 0.1.62 only: Image generation, web search and transcription keys
          used to sit on this page, and an old notice or habit still lands
          here looking for them. */}
      <p className="px-1 text-[12.5px] leading-relaxed text-ink-secondary">
        {t("settings.connections.moved")}{" "}
        <button type="button" onClick={() => go("images")} className={linkButton}>{settingsSectionLabel("images")}</button>
        {" · "}
        <button type="button" onClick={() => go("webSearch")} className={linkButton}>{settingsSectionLabel("webSearch")}</button>
        {" · "}
        <button type="button" onClick={() => go("voice")} className={linkButton}>{settingsSectionLabel("voice")}</button>
        {" · "}
        <button type="button" onClick={() => go("models")} className={linkButton}>{t("settings.models.pasteTitle")}</button>
      </p>
    </>
  );
}

/** Settings > Images: the setup, and the library of saved prompt blocks and
 *  reference packs as a tab of its own rather than a button inside a card. */
function ImagesSettings() {
  const [tab, setTab] = useState<"setup" | "library">("setup");
  const tabs = [
    { id: "setup" as const, label: t("settings.images.setup") },
    { id: "library" as const, label: t("settings.images.library") },
  ];
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const next = tab === "setup" ? "library" : "setup";
    setTab(next);
    document.getElementById(`images-tab-${next}`)?.focus();
  };
  return (
    <>
      <div role="tablist" aria-label={settingsSectionLabel("images")} onKeyDown={onKeyDown} className="flex gap-1 rounded-lg bg-control/50 p-1 self-start">
        {tabs.map(({ id, label }) => (
          <button
            key={id}
            id={`images-tab-${id}`}
            type="button"
            role="tab"
            aria-selected={tab === id}
            aria-controls={tab === id ? `images-panel-${id}` : undefined}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
            className={cn(
              "min-h-9 rounded-md px-3.5 text-[13px] max-md:min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
              tab === id ? "bg-panel font-medium text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div id={`images-panel-${tab}`} role="tabpanel" aria-labelledby={`images-tab-${tab}`} className="min-w-0">
        {tab === "setup" ? (
          <ImageSettings showLibrary={false} />
        ) : (
          <div className="rounded-xl bg-card p-4">
            <LazyBoundary inline onRetry={ImageLibrary.retry}>
              <Suspense fallback={<p role="status" className="text-[12px] text-ink-secondary">{t("imageLibrary.busy")}</p>}>
                <ImageLibrary.Component />
              </Suspense>
            </LazyBoundary>
          </div>
        )}
      </div>
    </>
  );
}

/** Settings > Computer & browser: every computer a bot can borrow, and the
 *  browser it can use. It used to be spread over Local VM, Tools &
 *  Connections and Experimental. */
function ComputerAndBrowserSettings() {
  return (
    <>
      <LocalComputerSection />
      <Card title={t("settings.computer.remoteTitle")} subtitle={t("settings.computer.remoteNote")}>
        <div className="flex flex-col gap-4">
          <ApiKeyRow section="box" />
          <VpsConnection />
        </div>
      </Card>
      <BrowserProfilesRow />
      <BrowserExternalClients />
    </>
  );
}

/** Up/Down (Left/Right on the phone strip) move between sections, Home and
 *  End jump to the ends. Group headings are not stops. */
function moveBetweenSections(event: ReactKeyboardEvent<HTMLElement>) {
  const keys: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
  if (!(event.target instanceof HTMLElement) || !event.target.hasAttribute("data-settings-section")) return;
  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-settings-section]"));
  const at = buttons.indexOf(event.target);
  let next = -1;
  if (event.key in keys) next = (at + keys[event.key]! + buttons.length) % buttons.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = buttons.length - 1;
  if (next < 0) return;
  event.preventDefault();
  buttons[next]?.focus();
}

export function SettingsModal() {
  const { state, dispatch } = useStore();
  const section = state.appSettingsSection;
  const dialogRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const { desktop, confirmed } = useSurfaceState();
  const allowed = sectionsForSurface(SECTIONS, desktop);
  const visibleSections = allowed.filter((entry) => settingsSectionMatches(entry, q));
  const current = SECTIONS.find((entry) => entry.id === section);

  useEffect(() => {
    const visible = sectionsForSurface(SECTIONS, desktop).filter((entry) => settingsSectionMatches(entry, q));
    const next = settingsSectionRedirect(SECTIONS, section, desktop, visible, confirmed);
    if (next) dispatch({ type: "toggleAppSettings", open: true, section: next });
  }, [dispatch, desktop, confirmed, q, section]);

  // The open section stays in view in the list: a deep link to Experimental
  // on a short window, or a chip at the far end of the phone strip.
  useEffect(() => {
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active) return;
    const box = nav.getBoundingClientRect(), row = active.getBoundingClientRect();
    if (row.top < box.top || row.bottom > box.bottom || row.left < box.left || row.right > box.right) {
      active.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [section]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dispatch({ type: "toggleAppSettings", open: false });
        return;
      }
      if (event.key !== "Tab" || !dialog) return;

      // A folded <details> (Models > Paste any keys) keeps its contents out
      // of the Tab order but its summary in it, so the loop has to agree.
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => {
        const folded = element.closest("details:not([open])");
        return !folded || element.parentElement === folded && element.tagName === "SUMMARY";
      });
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      returnFocus(previousFocus);
    };
  }, [dispatch]);

  // A handful of sections (a paired phone sees three) read better as plain
  // chips on the phone strip than under headings that each hold one or two.
  const fewSections = visibleSections.length <= 4;

  return (
    <div
      // C5: `fixed` resolves against the layout viewport, which iOS does not
      // shrink for the keyboard, so inset-0 would leave this centred in the
      // full 844px with the bottom half behind the keys. Height tracks --vvh.
      className="fixed inset-x-0 top-0 z-50 flex h-[var(--vvh,100%)] items-center justify-center bg-black/50 p-6 max-md:p-0"
      onMouseDown={(e) => e.target === e.currentTarget && dispatch({ type: "toggleAppSettings", open: false })}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-settings-title"
        tabIndex={-1}
        className={cn(
          "settings-dialog flex w-full max-w-[920px] overflow-clip rounded-2xl border border-hairline/50 bg-panel shadow-2xl outline-none",
          // overflow-clip, not overflow-hidden: a hidden box can still be
          // scrolled by focus, which slid the title and header off the top.
          // The list and the page each scroll on their own; the dialog never
          // does. 780 fits the grouped list (19 rows of 28px under 6 headings
          // of 22px, about 750px) in a 1440x900 window; a shorter window
          // scrolls the list, with the app's always-visible scrollbar.
          "h-[min(780px,calc(100dvh-2rem))]",
          // Below md a side list beside the content left too little of either
          // on a 390px screen. Full-bleed sheet, list folded to a horizontal
          // strip above it. --vvh rather than 100dvh so the footer buttons stay
          // reachable with the keyboard up (100dvh is the layout viewport,
          // which iOS does not shrink).
          "max-md:h-[var(--vvh,100dvh)] max-md:max-w-none max-md:flex-col max-md:rounded-none",
          // Full-bleed from the top of the screen, so the sheet keeps its own
          // ground under the status bar and the home indicator and its
          // controls start below the one and end above the other.
          "max-md:pt-[var(--inset-top)] max-md:pb-[var(--inset-bottom)]",
        )}
      >
        {/* section nav */}
        <nav
          className={cn(
            "flex flex-col border-r border-hairline/40 px-3 pb-2 pt-3",
            // A window too short for every section scrolls the list, with the
            // app's always-visible scrollbar, rather than clipping it (G3).
            // 240px: the longest label, "Phone and other devices", fits in Inter
            // even beside the list's scrollbar on a short window.
            "md:w-[240px] md:shrink-0 md:min-h-0 md:overflow-y-auto",
            "max-md:w-full max-md:shrink-0 max-md:flex-row max-md:items-center max-md:gap-1.5 max-md:overflow-x-auto max-md:border-r-0 max-md:border-b max-md:px-4 max-md:py-2",
            // On the phone strip, the right edge fades: there is more to swipe to.
            "max-md:[mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)]",
          )}
          ref={navRef}
          aria-label={t("settings.navAria")}
          onKeyDown={moveBetweenSections}
        >
          <div id="app-settings-title" className="px-2 pb-1.5 pt-0.5 text-[15px] font-semibold text-ink max-md:hidden">
            {t("settings.title")}
          </div>
          <div className="mb-1 flex min-h-8 items-center gap-2 rounded-lg bg-control/70 px-2.5 max-md:mb-0 max-md:min-h-11 max-md:w-[9rem] max-md:shrink-0">
            <Search size={14} className="shrink-0 text-ink-secondary" aria-hidden="true" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.stopPropagation();
                if (query) setQuery("");
                else dispatch({ type: "toggleAppSettings", open: false });
              }}
              placeholder={t("settings.search")}
              aria-label={t("settings.searchAria")}
              className="w-full bg-transparent text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
            />
          </div>
          {visibleSections.length === 0 && (
            <div className="px-2.5 py-4 text-[12.5px] leading-relaxed text-ink-secondary max-md:shrink-0 max-md:whitespace-nowrap max-md:py-0">
              {t("settings.noMatch", { query: query.trim() })}
            </div>
          )}
          {SETTINGS_GROUPS.map((group) => {
            const entries = visibleSections.filter((entry) => entry.group === group);
            if (entries.length === 0) return null;
            return (
              <div
                key={group}
                role="group"
                aria-labelledby={`settings-group-${group}`}
                aria-description={settingsGroupNote(group)}
                className="flex flex-col max-md:shrink-0 max-md:flex-row max-md:items-center max-md:gap-1.5"
              >
                <div
                  id={`settings-group-${group}`}
                  title={settingsGroupNote(group)}
                  className={cn(
                    "flex h-[22px] items-end px-2.5 pb-1 text-[11px] font-medium uppercase leading-none tracking-[0.06em] text-ink-secondary",
                    "max-md:h-auto max-md:whitespace-nowrap max-md:pb-0 max-md:pl-2 max-md:pr-0.5 max-md:text-[10.5px]",
                    fewSections && "max-md:sr-only",
                  )}
                >
                  {settingsGroupLabel(group)}
                </div>
                {entries.map(({ id, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    data-settings-section={id}
                    onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: id })}
                    aria-current={section === id ? "page" : undefined}
                    title={settingsSectionLabel(id)}
                    className={cn(
                      "flex h-7 shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13.5px]",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
                      "max-md:h-11 max-md:whitespace-nowrap max-md:rounded-full max-md:px-3.5",
                      section === id ? "bg-control font-medium text-ink" : "text-ink-secondary hover:bg-control/50 hover:text-ink",
                    )}
                  >
                    <Icon size={15} className="shrink-0" aria-hidden="true" />
                    <span className="min-w-0 truncate">{settingsSectionLabel(id)}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </nav>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex items-start justify-between gap-3 px-5 py-3">
            <div className="min-w-0">
              <span className="block truncate text-[15px] font-semibold text-ink">
                {current && <><span className="font-normal text-ink-secondary">{settingsGroupLabel(current.group)}</span><span aria-hidden="true" className="px-1.5 font-normal text-ink-secondary">/</span></>}
                <span>{current ? settingsSectionLabel(current.id) : null}</span>
              </span>
              {/* What the page is for, in one line (the grandma test). */}
              {current && <p data-settings-page-note className="mt-0.5 text-[12.5px] leading-snug text-ink-secondary">{settingsSectionNote(current.id)}</p>}
            </div>
            <button
              onClick={() => dispatch({ type: "toggleAppSettings", open: false })}
              aria-label={t("settings.close")}
              className="flex size-10 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <X size={18} />
            </button>
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-5 pb-5">
            {section === "general" && (
              <>
                <Card title="Profile" subtitle={desktop === true ? "Shown in the sidebar. Saved as you go." : "Shown in the sidebar."}>
                  <ProfileFields />
                </Card>
                <Card title={t("settings.appearance.title")} subtitle={t("settings.appearance.note")}>
                  <SkinPicker />
                  {/* The phone's drawer has no rail or density: desktop only. */}
                  {desktop === true && <SidebarDensityRow />}
                </Card>
                {desktop === true && <LanguageRow />}
                {desktop === true && <NotificationSettings />}
                {desktop === true && <StartupSettings />}
                {desktop !== true && <p className="text-[12px] text-ink-secondary">{t("settings.general.remoteNote")}</p>}
                {/* The phone apps never send usage analytics, so they show no switch for it. */}
                {!inNativeShell() && <AnalyticsRow />}
                {/* Confirmed remote only. `undefined` renders the neutral
                  * thing, and the desktop has no session to sign out of: the
                  * route lives on the browser door alone. */}
                {desktop === false && <RemoteSignOut />}
                {desktop === false && <PhoneNotifications />}
                {/* Headless installs have no desktop to make a script grant on; the owner's own browser door can (S1b R2). */}
                {desktop === false && <ScriptAccessSettings bots={state.bots} />}
              </>
            )}

            {desktop === true && section === "aboutMe" && <AboutMeSettings />}

            {desktop === true && section === "botDefaults" && (
              <>
                <NewBotEffortRow />
                <ToolCallsRow />
                <ProjectAutonomySetting />
                <Card title="Channel turns" subtitle="Stop a bot that goes quiet in a channel. Use Stop to end a reply yourself.">
                  <RoomTurnTimeoutSettings />
                </Card>
                <Card title={ROOM_ROUTING_COPY.title} subtitle={ROOM_ROUTING_COPY.subtitle}>
                  <RoomRoutingSettings />
                </Card>
                <StarterProfiles />
              </>
            )}

            {desktop === true && section === "houseRules" && <HouseRulesSettings />}

            {desktop === true && section === "skills" && <SkillsSettings />}

            {desktop === true && section === "memory" && <LazyBoundary inline onRetry={MemorySection.retry}><Suspense fallback={<p role="status" className="text-[13px] text-ink-secondary">Loading memory settings…</p>}><MemorySection.Component /></Suspense></LazyBoundary>}

            {desktop === true && section === "models" && (
              <>
                <ModelsSettings />
                {/* PasteKeys already files each pasted key under the section
                    that owns it, so it can sit with the keys people paste
                    most. Folded: most visits here are about models. */}
                <details id="paste-any-keys" className="group rounded-xl bg-card p-4">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                    <span className="min-w-0">
                      <span className="block text-[15px] font-medium text-ink">{t("settings.models.pasteTitle")}</span>
                      <span className="mt-0.5 block text-[13px] leading-relaxed text-ink-secondary">{t("settings.models.pasteNote")}</span>
                    </span>
                    <ChevronDown size={16} aria-hidden="true" className="shrink-0 text-ink-secondary transition-transform group-open:rotate-180" />
                  </summary>
                  <div className="mt-4">
                    <PasteKeys />
                  </div>
                </details>
              </>
            )}

            {desktop === true && section === "engines" && (
              <Card title="Your engines" subtitle="Install, connect and update the software that runs your bots. Manage provider keys and model catalogs under Models.">
                <EnginesSettings />
              </Card>
            )}

            {desktop === true && section === "images" && <ImagesSettings />}

            {desktop === true && section === "webSearch" && <SearchSettings />}

            {desktop === true && section === "voice" && (
              <Card title={t("settings.voice.title")} subtitle={t("settings.voice.note")}>
                <TranscriptionSettings />
              </Card>
            )}

            {desktop === true && section === "connections" && <ConnectedAppsSettings />}

            {desktop === true && section === "computer" && <ComputerAndBrowserSettings />}

            {desktop === true && section === "channels" && <div className="space-y-4"><TelegramSettings /><SlackSettings /><DiscordSettings /><WhatsAppSettings /></div>}

            {desktop === true && section === "companion" && <><CompanionSection profileEmail={state.config?.profile?.email} /><ScriptAccessSettings bots={state.bots} /></>}

            {desktop === true && section === "backups" && <BackupSettings />}

            {section === "usage" && <UsageSection />}

            {section === "about" && (
              <>
                <UpdatesRow />
                <WhatsNewRow />
                {desktop === true && <AnnouncementsSettings />}
                <DiagnosticsRow />
                {desktop === true && <SetupAgainRow />}
                <ShortcutsRow />
                <SourceCodeRow />
              </>
            )}

            {desktop === true && section === "experimental" && <ExperimentalFeaturesRow />}
          </div>
        </div>
      </div>
    </div>
  );
}
