import { LazyBoundary, retryableLazy } from "./LazyBoundary";
import { effortLabel } from "@/lib/effort-label";
import { t } from "@/lib/i18n";
import { DISCARD_SETTINGS_CHANGES, settingsDrafts } from "@/lib/settings-drafts";
import { SEND_KEYS, chooseSendKey, currentSendKey, isMacPlatform, sendKeyName, subscribeSendKey } from "@/lib/send-key";
import { waitForAnchor } from "@/lib/anchor-wait";
// App settings, as a real modal with sections rather than one long panel.
// Per-bot settings (persona, model, computer) stay in SettingsPanel; this is
// the stuff shared by every bot: who you are, your keys, and the machine your
// bots can borrow.
//
// 0.1.62 (NAV-OVERHAUL.md, Option B): six group headings over short pages
// that each do one job. The section ids, their groups and their search words
// live in lib/settings-sections.ts; this file owns the icons and the pages.
import { Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Archive, BookOpen, Bot, Brain, Coins, Globe, LifeBuoy, MessageCircle, Puzzle, Search, Smartphone, Trash2, User, Wrench, X } from "lucide-react";
import { api, useStore, type AppSettingsSection, type ConfigStatus } from "@/state/store";
import { analyticsEnabled, setAnalyticsEnabled } from "@/lib/analytics";
import { inNativeShell } from "@/lib/native-shell";
import { builtInBrowserEnabled, skillRecorderEnabled } from "@/lib/feature-flags";
import { localeChoices } from "@/locales";
import { useUpdaterState, type UpdaterState } from "@/lib/updater";
import { AdvancedHost, AdvancedSection, AdvancedSlotTarget, Card, Switch } from "./SettingsPrimitives";
import { PreviousVersionRow } from "./PreviousVersionRow";
import { SettingsSearchResults, useShowToolCalls } from "./SettingsSearchResults";
import { Anchor } from "./SettingsAnchor";
import { BotsSettings } from "./BotsSettings";
import { AiSettings } from "./AiSettings";
import { ToolsSettings } from "./ToolsSettings";
import { DevicesSettings } from "./DevicesSettings";
import { UsageSection } from "./UsageSection";
import { SkinPicker } from "./SkinPicker";
import { SkillsSettings } from "./skills/SkillsSettings";
import { cloudCardHidden, cloudSectionBlocked, ON_YOUR_COMPUTER_ONLY, ON_YOUR_COMPUTER_ONLY_DETAIL } from "@/lib/cloud-settings";
import { isCloudOrigin } from "@/lib/cloud-workspace";
import { homeMeta } from "@/lib/cloud-door";
import { CloudDevicesSettings } from "./cloud/CloudDevicesSettings";
import { CloudDisconnectComputer, DISCONNECT_COPY, cloudDisconnectBridge } from "./cloud/CloudDisconnectComputer";
import { ScriptAccessSettings } from "./ScriptAccessSettings";
import { AboutMeSettings } from "./AboutMeSettings";
import { NotificationSettings } from "./NotificationSettings";
import { CallsSettings } from "./CallsSettings";
import { BackupSettings } from "./BackupSettings";
import { StorageSettings } from "./StorageSettings";
import { StartupSettings } from "./StartupSettings";
import { AnnouncementsSettings } from "./AnnouncementsSettings";
import { NewsSignupSettings } from "./NewsSignupSettings";
import { BotEmailAccountCard } from "./BotEmailSettings";
import { ComputerOnlyStub, SETTINGS_STUB_COPY } from "./SettingsStub";
import { TelegramSettings } from "./TelegramSettings";
import { SlackSettings } from "./SlackSettings";
import { WhatsAppSettings } from "./WhatsAppSettings";
import { DiscordSettings } from "./DiscordSettings";
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
  settingsPageLabel,
  settingsSectionLabel,
  settingsSectionNote,
  settingsSectionRedirect,
} from "@/lib/settings-sections";
import { SECTION_PAGES, resolveSettingsSection, type SettingsPage, type SettingsPageEntry } from "@/lib/settings-pages";
import { cardForAnchor, type SettingsCard } from "@/lib/settings-cards";
import { SETTINGS_CARDS } from "@/lib/settings-card-registry";
import {
  chooseAutoRail,
  chooseSidebarDensity,
  sidebarDensityState,
  subscribeSidebarDensity,
  type SidebarDensity,
} from "@/lib/sidebar-preferences";
import { copyVersionText } from "@/lib/about-version";
import { APP_VERSION } from "@/lib/whats-new";
import { sourceCodeLink, sourceVersionLabel } from "@/lib/source-code";
import { openKeyboardShortcuts, openWhatsNew } from "@/lib/app-events";
import { copyText } from "@/lib/copy-text";
import { HealthCard, healthDestination } from "./HealthCard";

export { sectionsForSurface, settingsSectionRedirect } from "@/lib/settings-sections";
export { settingsSearchResults } from "@/lib/settings-search";

const MemorySection = retryableLazy(() => import("./MemorySection"));

const PAGE_ICONS: Record<SettingsPage, typeof User> = {
  general: User,
  botDefaults: Bot,
  skills: BookOpen,
  memory: Brain,
  models: Globe,
  webSearch: Wrench,
  connections: Puzzle,
  channels: MessageCircle,
  companion: Smartphone,
  backups: Archive,
  usage: Coins,
  about: LifeBuoy,
};

type Page = SettingsPageEntry & { icon: typeof User };
const PAGES: Page[] = SECTION_PAGES.map((entry) => ({ ...entry, icon: PAGE_ICONS[entry.id] }));
// Every one of the 19 ids stays a section: the redirect below waits on an
// unresolved surface by section, the sidebar and the page switch read pages.
const SECTIONS = SETTINGS_SECTIONS;

/** Scroll to an anchor, focus it, and mark it for two seconds. */
function revealAnchor(element: HTMLElement) {
  element.scrollIntoView({ block: "start" });
  if (!element.hasAttribute("tabindex") && !/^(?:BUTTON|INPUT|SELECT|TEXTAREA|A)$/.test(element.tagName)) element.setAttribute("tabindex", "-1");
  element.focus({ preventScroll: true });
  // Settings focuses its own dialog as it mounts; take focus back once.
  requestAnimationFrame(() => { if (document.activeElement !== element) element.focus({ preventScroll: true }); });
  const mark = ["rounded-xl", "ring-2", "ring-accent", "transition-shadow"];
  element.classList.add(...mark);
  window.setTimeout(() => element.classList.remove(...mark), 2000);
}

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
  return running + updatesStatusLine(s);
}

/** Where the update stands, without the running version in front of it (the About card puts the version in its headline). */
export function updatesStatusLine(s: UpdaterState | null): string {
  if (s?.status === "error" && s.action === "download-from-murage") return t("updates.verificationRefused");
  return (
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

/** The one button for the update in hand: Check, Download, Restart and install, Try again. Shared by the Updates row and the About card. */
function UpdateActionButton({ state: s }: { state: UpdaterState | null }) {
  const updater = window.muragebox?.updater;
  if (!updater || s?.status === "deferred") return null;
  return (
    <button
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
    </button>
  );
}

export function UpdatesRow() {
  const s = useUpdaterState();
  if (!window.muragebox?.updater) return null;
  const label = updatesSubtitle(s);
  return (
    <Card title={t("updates.title")} subtitle={label}>
      <UpdateActionButton state={s} />
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
      subtitle="Anonymous product events: app opened, which features get used. Never conversations, prompts, file contents, or bot output, and never your name or email."
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
  const { enabled, saving, error, toggle } = useShowToolCalls();

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

/** What each workspace switch lets bots do, for its "Off. Turn it on to let bots ..." line. */
const WORKSPACE_FEATURE_OFF = {
  browser: "use a browser tab you can watch and take over",
  skillRecorder: "learn a skill from a recording or /learn",
} as const;

export function WorkspaceFeatureRow({ feature }: { feature: "skillRecorder" | "browser" }) {
  const { state, dispatch } = useStore();
  const browser = feature === "browser";
  const enabled = browser ? builtInBrowserEnabled(state.config) : skillRecorderEnabled(state.config);
  const desktopBrowser = Boolean(window.muragebox?.browser);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const toggle = async () => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ features: { [feature]: !enabled } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.workspaceFeature.saveError"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title={t(browser ? "settings.l1.card.companion.browser" : "settings.l1.card.skills.recorder")}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[12px] leading-relaxed text-ink-secondary">
            {t(browser
              ? desktopBrowser ? "settings.workspaceFeature.browser.note" : "settings.workspaceFeature.browser.desktopOnly"
              : "settings.workspaceFeature.recorder.note")}
          </div>
          {/* Off is a state (SETTINGS-UX-1011 S1): one line says so and the switch beside it turns it back on. */}
          {state.config != null && !enabled && (!browser || desktopBrowser) && (
            <div data-settings-stub="off" className="mt-1 text-[12px] leading-relaxed text-ink-secondary opacity-80">
              {SETTINGS_STUB_COPY.off(browser ? WORKSPACE_FEATURE_OFF.browser : WORKSPACE_FEATURE_OFF.skillRecorder)}
            </div>
          )}
        </div>
        <Switch
          checked={enabled}
          aria-label={t(browser ? "settings.workspaceFeature.browser.aria" : "settings.workspaceFeature.recorder.aria")}
          // Until the saved switches load, the row cannot tell on from off, so it waits instead of saving a guess.
          disabled={saving || state.config == null || (browser && !enabled && !desktopBrowser)}
          onClick={() => void toggle()}
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

/** The Health card in Settings: reads its own owner summary; next actions open existing Settings pages. */
function SettingsHealthRow() {
  const { dispatch } = useStore();
  return <HealthCard onOpenBackups={() => dispatch({ type: "toggleAppSettings", open: true, section: "backups" })}
    onNavigate={action => { const to = healthDestination(action); if (to) dispatch({ type: "toggleAppSettings", open: true, section: to.section, ...(to.anchor ? { anchor: to.anchor } : {}) }); }} />;
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
    <div className="max-md:hidden">
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

/** The first card of About & updates: which Murage this is, where its update stands, and a line to paste into a support message. The release date
 * is left out: no build records one the app can read, and a guessed date would be worse than none. */
function AboutVersionCard() {
  const s = useUpdaterState();
  const desktop = useDesktopSurface();
  const { dispatch } = useStore();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const version = s?.currentVersion || APP_VERSION;
  const copy = () => {
    const line = copyVersionText(version, window.muragebox?.platform, window.muragebox?.arch);
    void copyText(line).then((ok) => {
      setCopyFailed(!ok);
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <Card title={t("settings.about.versionTitle", { version })} subtitle={window.muragebox?.updater ? updatesStatusLine(s) : undefined}>
      <div className="flex flex-wrap items-center gap-2">
        <UpdateActionButton state={s} />
        {desktop === true && (
          <button
            type="button"
            onClick={() => {
              dispatch({ type: "toggleAppSettings", open: false });
              openWhatsNew();
            }}
            className={secondaryButton}
          >
            {t("settings.about.whatsNewOpen")}
          </button>
        )}
        <button type="button" onClick={copy} className={secondaryButton}>
          {copyFailed ? t("copy.failed") : copied ? t("settings.about.versionCopied") : t("settings.about.versionCopy")}
        </button>
      </div>
      <span role="status" className="sr-only">{copied ? t("settings.about.versionCopied") : ""}</span>
    </Card>
  );
}

/** Opens the page What's new showed after the last update. */
function WhatsNewRow() {
  const { dispatch } = useStore();
  const desktop = useDesktopSurface();
  // Always on the desktop: a version without a page opens its release notes.
  if (desktop !== true) return null;
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

/** Which key sends a message. Enter stays the default, Japanese starts on
 *  Ctrl/Cmd+Enter (an input method confirms its candidate with Enter), and the
 *  choice is kept on this device. */
function SendKeyRow() {
  const mode = useSyncExternalStore(subscribeSendKey, currentSendKey, currentSendKey);
  const mac = isMacPlatform();
  return (
    <Card title={t("settings.sendKey.title")} subtitle={t("settings.sendKey.note")}>
      <div role="radiogroup" aria-label={t("settings.sendKey.title")} className="grid grid-cols-3 overflow-hidden rounded-lg border border-hairline">
        {SEND_KEYS.map((id, index) => {
          const selected = mode === id;
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
                const at = (index + step + SEND_KEYS.length) % SEND_KEYS.length;
                chooseSendKey(SEND_KEYS[at]);
                event.currentTarget.parentElement?.querySelectorAll("button")[at]?.focus();
              }}
              onClick={() => chooseSendKey(id)}
              className={cn(
                "flex h-9 items-center justify-center px-3 text-[13px] transition-colors",
                index > 0 && "border-l border-hairline",
                selected
                  ? "bg-control font-medium text-accent-text shadow-[inset_0_0_0_1px_var(--color-accent-border)]"
                  : "text-ink-secondary hover:bg-control/50",
              )}
            >
              {sendKeyName(id, mac)}
            </button>
          );
        })}
      </div>
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
function ConnectedAppsSettings({ advancedOpen, onAdvancedOpenChange }: { advancedOpen: boolean; onAdvancedOpenChange: (open: boolean) => void }) {
  const { state, dispatch } = useStore();
  const go = (section: AppSettingsSection) => dispatch({ type: "toggleAppSettings", open: true, section });
  const openPanel = (surface: "apps" | "mcp") => {
    dispatch({ type: "toggleAppSettings", open: false });
    dispatch({ type: "togglePlugins", open: true, surface });
  };
  return (
    <>
      <Anchor id="connections-heading">
      <Card title={t("settings.section.connections")} subtitle={t("settings.connections.note")}>
        <div className="flex flex-col gap-4">
          {state.config?.composio.mode === "managed" ? (
            <div className="rounded-lg border border-success/25 bg-success/10 px-3 py-2 text-[13px] text-success">
              {t("settings.connections.ready")}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => openPanel("apps")} className={secondaryButton}>{t("settings.connections.openApps")}</button>
          </div>
        </div>
      </Card>
      </Anchor>
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
      {/* The MCP servers panel runs this computer's servers (mcp-servers:*), which a Cloud window's bridge refuses: there the
        * card is the "set this on your computer" stub (SETTINGS-UX-1011 S1). */}
      <AdvancedSection section="connections" summary={t("settings.l1.advanced.connections")} open={advancedOpen} onOpenChange={onAdvancedOpenChange}>
        <div id="mcp-servers-heading" tabIndex={-1} className="outline-none">
          {cloudCardHidden("mcp-servers-heading") ? <ComputerOnlyStub anchor="mcp-servers-heading" /> : (
            <Card title={t("settings.l1.mcp.title")} subtitle={t("settings.l1.mcp.note")}>
              <button type="button" onClick={() => openPanel("mcp")} className={secondaryButton}>{t("settings.connections.openMcp")}</button>
            </Card>
          )}
        </div>
      </AdvancedSection>
    </>
  );
}

/** Settings > Images: the setup, and the library of saved prompt blocks and
 *  reference packs as a tab of its own rather than a button inside a card. */
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

/** Whether the Settings focus trap counts a control as a Tab stop. The browser skips anything under a hidden
 * ancestor (the open page a search keeps mounted) and the contents of a folded details element (but not its
 * summary), so the trap's first and last stops have to skip them too or Tab escapes the dialog. */
export function inSettingsTabOrder(element: Pick<Element, "closest" | "parentElement" | "tagName">): boolean {
  if (element.closest("[hidden]")) return false;
  const folded = element.closest("details:not([open])");
  return !folded || (element.parentElement === folded && element.tagName === "SUMMARY");
}

export function SettingsModal() {
  const { state, dispatch } = useStore();
  // The store keeps the id it was asked for (any of the 19); the page it lands on is `section` below, so the page
  // bodies read as they always have. An alias also names a card on that page (state.appSettingsAnchor).
  const requested = state.appSettingsSection;
  // A Cloud window: a page it cannot use matches none of the page bodies and shows the "on your computer only" card instead.
  const cloud = isCloudOrigin();
  const blocked = cloudSectionBlocked(requested);
  const section = (blocked ? "" : resolveSettingsSection(requested).section) as SettingsPage;
  // An alias the Cloud window may use can land on a page it may not (Images sits on Tools, whose search and voice keys
  // are this computer's): that page then renders only the alias's own card.
  const pageComputerOnly = !blocked && cloudSectionBlocked(section);
  // The nav marks the page the request lands on, blocked or not, so a Cloud window still shows where the person is.
  const navPage = resolveSettingsSection(requested).section;
  const anchor = state.appSettingsAnchor;
  const dialogRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
const paneRef = useRef<HTMLDivElement>(null);
const anchorWaitRef = useRef<{ anchor: string; at: number } | null>(null);
  const [query, setQuery] = useState("");
  const q = query.trim();
  const { desktop, confirmed } = useSurfaceState();
  const visiblePages = sectionsForSurface(PAGES, desktop);
  const current = PAGES.find((entry) => entry.id === section);
  // One Advanced per page, closed on a page change unless an opener opens it (below).
  const [advancedOpen, setAdvancedOpen] = useState<Record<SettingsPage, boolean>>(() => Object.fromEntries(SECTION_PAGES.map((entry) => [entry.id, false])) as Record<SettingsPage, boolean>);
  const advancedFor = (page: SettingsPage) => ({ section: page, open: advancedOpen[page], onOpenChange: (open: boolean) => setAdvancedOpen((now) => ({ ...now, [page]: open })) });

  useEffect(() => {
    const visible = sectionsForSurface(SECTIONS, desktop);
    const next = settingsSectionRedirect(SECTIONS, requested, desktop, visible, confirmed);
    if (next) dispatch({ type: "toggleAppSettings", open: true, section: next });
  }, [dispatch, desktop, confirmed, requested]);

  // An opener (a deep link, a What's new tile, the palette, a search result) leaves the search box.
  useEffect(() => { setQuery(""); }, [requested, anchor]);

  useEffect(() => {
    setAdvancedOpen((now) => (Object.values(now).some(Boolean) ? Object.fromEntries(SECTION_PAGES.map((entry) => [entry.id, false])) as Record<SettingsPage, boolean> : now));
  }, [section]);

  // Land on the card the opener named: its page's Advanced first when it lives there, then scroll, focus, highlight.
  useEffect(() => {
    if (!anchor || query) return;
    const card = cardForAnchor(SETTINGS_CARDS, anchor);
    if (card?.advanced && !advancedOpen[card.section]) {
      setAdvancedOpen((now) => ({ ...now, [card.section]: true }));
      return;
    }
    // The bound is in time and survives this effect re-running (Advanced opening re-runs it), so a slow
    // status answer still lands on the card, and a card that never mounts lands on the top of the page.
    if (anchorWaitRef.current?.anchor !== anchor) anchorWaitRef.current = { anchor, at: Date.now() };
    const startedAt = anchorWaitRef.current.at;
    return waitForAnchor({
      startedAt,
      find: () => document.getElementById(anchor),
      onFound: (element) => { anchorWaitRef.current = null; revealAnchor(element); dispatch({ type: "appSettingsAnchorDone" }); },
      onGiveUp: () => { anchorWaitRef.current = null; paneRef.current?.scrollTo?.({ top: 0 }); dispatch({ type: "appSettingsAnchorDone" }); },
    });
  }, [anchor, query, advancedOpen, dispatch]);

  const openCard = (card: SettingsCard) => dispatch({ type: "toggleAppSettings", open: true, section: card.section, anchor: card.anchor });

  // The open section stays in view in the list: a deep link to Skills
  // on a short window, or a chip at the far end of the phone strip.
  useEffect(() => {
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active) return;
    const box = nav.getBoundingClientRect(), row = active.getBoundingClientRect();
    if (row.top < box.top || row.bottom > box.bottom || row.left < box.left || row.right > box.right) {
      active.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [requested]);

  // Closing with words typed in House rules or About me and not saved asks first, the way bot settings does; a page change or a
  // search does not lose them, they are kept (lib/settings-drafts.ts) and come back when the page does.
  const closeSettings = useCallback(() => {
    if (settingsDrafts.anyUnsaved() && !window.confirm(DISCARD_SETTINGS_CHANGES)) return;
    settingsDrafts.clear();
    dispatch({ type: "toggleAppSettings", open: false });
  }, [dispatch]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeSettings();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;

      // Only the stops the browser itself would Tab to (see inSettingsTabOrder).
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(inSettingsTabOrder);
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
  }, [closeSettings, dispatch]);

  // A handful of sections (a paired phone sees three) read better as plain
  // chips on the phone strip than under headings that each hold one or two.
  const fewSections = visiblePages.length <= 4;

  return (
    <div
      // C5: `fixed` resolves against the layout viewport, which iOS does not
      // shrink for the keyboard, so inset-0 would leave this centred in the
      // full 844px with the bottom half behind the keys. Height tracks --vvh.
      className="fixed inset-x-0 top-0 z-50 flex h-[var(--vvh,100%)] items-center justify-center bg-black/50 p-6 max-md:p-0"
      onMouseDown={(e) => e.target === e.currentTarget && closeSettings()}
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
                else closeSettings();
              }}
              placeholder={t("settings.search")}
              aria-label={t("settings.searchAria")}
              className="w-full bg-transparent text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
            />
          </div>
          {SETTINGS_GROUPS.map((group) => {
            const entries = visiblePages.filter((entry) => entry.group === group);
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
                    onClick={() => { setQuery(""); dispatch({ type: "toggleAppSettings", open: true, section: id }); }}
                    aria-current={navPage === id ? "page" : undefined}
                    title={settingsPageLabel(id)}
                    className={cn(
                      "flex h-7 shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13.5px]",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
                      "max-md:h-11 max-md:whitespace-nowrap max-md:rounded-full max-md:px-3.5",
                      !q && navPage === id ? "bg-control font-medium text-ink" : "text-ink-secondary hover:bg-control/50 hover:text-ink",
                    )}
                  >
                    <Icon size={15} className="shrink-0" aria-hidden="true" />
                    <span className="min-w-0 truncate">{settingsPageLabel(id)}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </nav>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex items-start justify-between gap-3 px-5 py-3">
            <div className="min-w-0">
              {q ? (
                <>
                  <span className="block truncate text-[15px] font-semibold text-ink">{t("settings.l1.resultsFor", { query: q })}</span>
                  <p data-settings-page-note className="mt-0.5 text-[12.5px] leading-snug text-ink-secondary">{t("settings.l1.resultsNote")}</p>
                </>
              ) : (
                <>
                  <span className="block truncate text-[15px] font-semibold text-ink">
                    {current && <><span className="font-normal text-ink-secondary">{settingsGroupLabel(current.group)}</span><span aria-hidden="true" className="px-1.5 font-normal text-ink-secondary">/</span></>}
                    <span>{current ? settingsPageLabel(current.id) : null}</span>
                  </span>
                  {/* What the page is for, in one line (the grandma test). */}
                  {current && <p data-settings-page-note className="mt-0.5 text-[12.5px] leading-snug text-ink-secondary">{settingsSectionNote(current.id)}</p>}
                </>
              )}
            </div>
            <button
              onClick={closeSettings}
              aria-label={t("settings.close")}
              className="flex size-10 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <X size={18} />
            </button>
          </div>

          <div ref={paneRef} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-5 pb-5">
            {q && <SettingsSearchResults query={q} desktop={desktop} onOpen={openCard} />}
            {/* A search hides the open page instead of unmounting it, so words typed and not yet
              * saved there (a skill being written, House rules) are still there when the search clears. */}
            <div data-settings-page-body hidden={q ? true : undefined} className={q ? "hidden" : "contents"}>
            {blocked && (
              <Card title={ON_YOUR_COMPUTER_ONLY} subtitle={ON_YOUR_COMPUTER_ONLY_DETAIL}>
                <p data-cloud-computer-only={requested} className="text-[13px] text-ink-secondary">{settingsSectionLabel(requested)}</p>
              </Card>
            )}
            {section === "general" && (
              <>
                <Anchor id="profile-heading">
                  <Card title={t("settings.l4.profile.title")} subtitle={desktop === true ? t("settings.l4.profile.noteDesktop") : t("settings.l4.profile.note")}>
                    <ProfileFields />
                  </Card>
                </Anchor>
                {desktop === true && <AboutMeSettings />}
                <Anchor id="appearance-heading">
                  <Card title={t("settings.appearance.title")} subtitle={t("settings.appearance.note")}>
                    <SkinPicker />
                  </Card>
                </Anchor>
                {desktop === true && <Anchor id="language-heading"><LanguageRow /></Anchor>}
                {!inNativeShell() && <Anchor id="send-key-heading"><SendKeyRow /></Anchor>}
                {desktop === true && <Anchor id="notifications-heading"><NotificationSettings /><CallsSettings /></Anchor>}
                {desktop !== true && <p className="text-[12px] text-ink-secondary">{t("settings.general.remoteNote")}</p>}
                {/* Confirmed remote only. `undefined` renders the neutral
                  * thing, and the desktop has no session to sign out of: the
                  * route lives on the browser door alone. */}
                {desktop === false && <RemoteSignOut />}
                {desktop === false && <PhoneNotifications />}
                {/* Headless installs have no desktop to make a script grant on; the owner's own browser door can (S1b R2). */}
                {desktop === false && <ScriptAccessSettings bots={state.bots} />}
                {/* The phone apps never send usage analytics and have no rail or startup, so a phone sees only what it has. */}
                {(desktop === true || !inNativeShell()) && (
                  <AdvancedSection {...advancedFor("general")} summary={t("settings.l4.advanced.general")}>
                    {desktop === true && <Anchor id="startup-heading">{cloudCardHidden("startup-heading", cloud) ? <ComputerOnlyStub anchor="startup-heading" /> : <StartupSettings />}</Anchor>}
                    {desktop === true && <Anchor id="sidebar-density-heading"><Card><SidebarDensityRow /></Card></Anchor>}
                    {!inNativeShell() && <Anchor id="analytics-heading"><AnalyticsRow /></Anchor>}
                  </AdvancedSection>
                )}
                {/* A Cloud home opened in a browser: the connected devices (the page carries the home id meta only on a Cloud home). */}
                {/* The Cloud window of the desktop app: disconnect this computer from this home (design 2.5.4). */}
                {cloud && cloudDisconnectBridge() && <Card title={DISCONNECT_COPY.title} subtitle={DISCONNECT_COPY.subtitle}><CloudDisconnectComputer /></Card>}
                {desktop !== true && homeMeta(document).homeId && <Card title="Devices" subtitle="Browsers and computers connected to this Cloud home."><CloudDevicesSettings /></Card>}
              </>
            )}

            {desktop === true && section === "botDefaults" && (
              <BotsSettings advanced={advancedFor("botDefaults")} effortRow={<NewBotEffortRow />} toolCallsRow={<ToolCallsRow />} />
            )}

            {desktop === true && section === "skills" && (
              <AdvancedHost>
                <Anchor id="skill-recorder-heading">{cloudCardHidden("skill-recorder-heading", cloud) ? <ComputerOnlyStub anchor="skill-recorder-heading" /> : <WorkspaceFeatureRow feature="skillRecorder" />}</Anchor>
                <SkillsSettings />
                <AdvancedSection {...advancedFor("skills")} summary={t("settings.l1.advanced.skills")}><AdvancedSlotTarget /></AdvancedSection>
              </AdvancedHost>
            )}

            {desktop === true && section === "memory" && <Anchor id="memory-heading"><LazyBoundary inline onRetry={MemorySection.retry}><Suspense fallback={<p role="status" className="text-[13px] text-ink-secondary">Loading memory settings…</p>}><MemorySection.Component advanced={advancedFor("memory")} /></Suspense></LazyBoundary></Anchor>}

            {desktop === true && section === "models" && <AiSettings advanced={advancedFor("models")} />}

            {desktop === true && section === "webSearch" && <ToolsSettings advanced={advancedFor("webSearch")} cloudImagesOnly={pageComputerOnly} />}

            {desktop === true && section === "connections" && <ConnectedAppsSettings advancedOpen={advancedOpen.connections} onAdvancedOpenChange={advancedFor("connections").onOpenChange} />}
            {/* Settings > Bot email (1.0.9): always rendered; while the server does not say email is on, the card is its stub (SETTINGS-UX-1011 S1) */}
            {desktop === true && section === "connections" && <Anchor id="bot-email-heading"><BotEmailAccountCard /></Anchor>}

            {desktop === true && section === "channels" && (
              <AdvancedHost>
                <div className="space-y-4"><TelegramSettings /><SlackSettings /><DiscordSettings /><WhatsAppSettings /></div>
                <AdvancedSection {...advancedFor("channels")} summary={t("settings.l1.advanced.channels")}><AdvancedSlotTarget /></AdvancedSection>
              </AdvancedHost>
            )}

            {desktop === true && section === "companion" && (
              <DevicesSettings advanced={advancedFor("companion")} profileEmail={state.config?.profile?.email} bots={state.bots} browserProfiles={<><Anchor id="browser-settings-heading"><WorkspaceFeatureRow feature="browser" /></Anchor><BrowserProfilesRow /></>} />
            )}

            {desktop === true && section === "backups" && <div className="space-y-4"><BackupSettings /><div id="storage-heading"><StorageSettings /></div></div>}

            {section === "usage" && <Anchor id="usage-heading"><UsageSection /></Anchor>}

            {section === "about" && (
              <>
                <Anchor id="about-version-heading"><AboutVersionCard /></Anchor>
                {(cloudCardHidden("updates-heading", cloud) || window.muragebox?.updater) && <Anchor id="updates-heading">{cloudCardHidden("updates-heading", cloud) ? <ComputerOnlyStub anchor="updates-heading" /> : <UpdatesRow />}</Anchor>}
                {desktop === true && <Anchor id="whats-new-heading"><WhatsNewRow /></Anchor>}
                {desktop === true && <Anchor id="news-heading"><NewsSignupSettings /></Anchor>}
                {desktop === true && <Anchor id="setup-heading">{cloudCardHidden("setup-heading", cloud) ? <ComputerOnlyStub anchor="setup-heading" /> : <SetupAgainRow />}</Anchor>}
                <Anchor id="shortcuts-heading"><ShortcutsRow /></Anchor>
                <Anchor id="previous-version-heading"><PreviousVersionRow /></Anchor>
                <SourceCodeRow />
                {/* Health (1.0.9 Sentinel) sits beside Diagnostics and outside every desktop-only guard: the Cloud and
                    self-host owner see the same card. The summary route answers the owner only. */}
                <Anchor id="health-heading"><SettingsHealthRow /></Anchor>
                <AdvancedSection {...advancedFor("about")} summary={t("settings.l1.advanced.about")}>
                  {desktop === true && <Anchor id="announcements-heading"><AnnouncementsSettings /></Anchor>}
                  <Anchor id="diagnostics-heading">{cloudCardHidden("diagnostics-heading", cloud) ? <ComputerOnlyStub anchor="diagnostics-heading" /> : <DiagnosticsRow />}</Anchor>
                </AdvancedSection>
              </>
            )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
