import { installerOffer } from "@/lib/update-card";
// App settings, as a real modal with sections rather than one long panel.
// Per-bot settings (persona, model, computer) stay in SettingsPanel; this is
// the stuff shared by every bot: who you are, your keys, and the machine your
// bots can borrow.
//
// 0.1.62 (NAV-OVERHAUL.md, Option B): six group headings over short pages
// that each do one job. The section ids, their groups and their search words
// live in lib/settings-sections.ts; this file owns the icons and the pages.
import { LazyBoundary, retryableLazy } from "./LazyBoundary";
import { t } from "@/lib/i18n";
import { DISCARD_SETTINGS_CHANGES, settingsDrafts } from "@/lib/settings-drafts";
import { waitForAnchor } from "@/lib/anchor-wait";
import { landOnSetting, type LandingElement } from "@/lib/settings-landing";
import { Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Archive, BookOpen, Bot, Brain, Coins, Globe, LifeBuoy, Monitor, Phone, Puzzle, Search, Smartphone, Trash2, User, Users, Wrench, X } from "lucide-react";
import { api, useStore, type AppSettingsSection, type Bot as BotRecord, type ConfigStatus } from "@/state/store";
import type { BotSettingsLeave } from "./BotSettingsPane";
import { loadBotSettingsPane, loadedBotSettingsPane } from "@/lib/bot-settings-pane-load";
import { leaveBotPage, registerBotPageLeave } from "@/lib/settings-leave";
import { builtInBrowserEnabled, skillRecorderEnabled } from "@/lib/feature-flags";
import { useUpdaterState, type UpdaterState } from "@/lib/updater";
import { Card, Switch } from "./SettingsPrimitives";
import { SETTINGS_STUB_COPY } from "./SettingsStub";
import { SettingsAskLine } from "./SettingsAskLine";
import { SettingsSearchResults } from "./SettingsSearchResults";
import { cloudSectionBlocked, ON_YOUR_COMPUTER_ONLY, ON_YOUR_COMPUTER_ONLY_DETAIL } from "@/lib/cloud-settings";
import { isCloudOrigin } from "@/lib/cloud-workspace";
import { openFirstRun } from "@/lib/first-run";
import { cn } from "@/lib/cn";
import { BOX_PANES, BoxBody, BoxHead } from "./ui/BoxShell";
import { useSurfaceState } from "@/lib/use-surface";
import {
  browserProfileDeletionBlockReason,
  browserProfilesForPatch,
  browserProfileReplacementPatch,
} from "@/lib/browser-profiles";
import { canHandleLayerEscape } from "@/lib/focus-trap";
import { useLayerContainer, useLayerOwner } from "./LayerSlot";
import { LayerSurface } from "./LayerSurface";
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
import { BROWSE_BOTS_ROUTE, SECTION_PAGES, isSimpleTarget, resolveSettingsSection, type SettingsPage, type SettingsPageEntry } from "@/lib/settings-pages";
import { selectorPageLabel, truncateAtWord } from "@/lib/settings-page-select";
import { setSettingsMode, useSettingsMode } from "@/lib/settings-mode";
import { sidebarBots } from "@/lib/settings-shell-bots";
import { isAdvancedOnlyCard } from "@/lib/settings-simple-cards";
import { sw } from "@/lib/settings-words";
import { settingsPageLink } from "@/lib/settings-link";
import { ADVANCED_MODE_ANCHOR } from "./settings/AdvancedModeCard";
import { BrowseBotsPage } from "./settings/BrowseBotsPage";
import { SettingsBreadcrumb } from "./settings/SettingsBreadcrumb";
import { SettingsPageMount, hasPageFile } from "./settings/page-registry";
import { SetInAdvancedLine } from "./settings/PageCards";
import { cardForAnchor, type SettingsCard } from "@/lib/settings-cards";
import { SETTINGS_CARDS, resolveSettingsCard } from "@/lib/settings-card-registry";
// Settings' own words, on this chunk rather than the first paint (1.0.19, SettingsCopy.lazy.test.ts).
import "@/lib/settings-copy";

export { sectionsForSurface, settingsSectionRedirect } from "@/lib/settings-sections";
export { settingsSearchResults } from "@/lib/settings-search";

// A bot's page of this window (S7): loaded with the window by the bot opener (BotSettingsDialog), on first use otherwise.
const BotPane = retryableLazy(() => loadBotSettingsPane().then((module) => ({ default: module.BotSettingsPane })));
// Settings > Connected apps > Phone calls (BOT-CALLS-1020): its screen and its 8-language words load the first time the page shows.

const PAGE_ICONS: Record<SettingsPage, typeof User> = {
  general: User,
  calls: Phone,
  computer: Monitor,
  botDefaults: Users,
  skills: BookOpen,
  memory: Brain,
  models: Globe,
  webSearch: Wrench,
  connections: Puzzle,
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

/** Land on the card or row an opener named: any closed fold around it opens, it scrolls into view, its control (the
 *  switch, field or button itself, not the card around it) takes focus, and the row is marked for two seconds. */
function revealAnchor(element: HTMLElement) {
  landOnSetting(element as unknown as LandingElement);
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
        data-setting-control="setup-heading"
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

/** The Updates row's line. It leads with the running version: Linux has no
 * About panel, so this is the one place that version is shown. */
export function updatesSubtitle(s: UpdaterState | null): string {
  if (s?.status === "error" && s.action === "download-from-murage") return t("updates.verificationRefused");
  const running = s?.currentVersion ? `Murage ${s.currentVersion}. ` : "";
  return running + updatesStatusLine(s);
}

/** Where the update stands, without the running version in front of it (the About card puts the version in its headline). */
export function updatesStatusLine(s: UpdaterState | null): string {
  const installer=installerOffer(s);
  if(installer)return t("updates.installerSteps",{version:installer.version});
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

/** The one button for the update in hand: Check, Download, Restart and install, Try again. The About card carries it (the
 *  page's only update control since 1.0.10). UpdatesRow is no longer on a page; it stays exported because the update-state
 *  tests and the localization spec render it to check the shared button and status line. */
export function UpdateActionButton({ state: s }: { state: UpdaterState | null }) {
  const installer=installerOffer(s);
  const updater = window.muragebox?.updater;
  // the download page did not open: the button stays pressable and a line says so
  const [openFailed, setOpenFailed] = useState(false);
  const openPage = (url: string) => {
    setOpenFailed(false);
    Promise.resolve(window.muragebox?.openExternal?.(url)).catch(() => setOpenFailed(true));
  };
  if (!updater || s?.status === "deferred") return null;
  return (
    <>
    <button
      onClick={() => {
        if(installer)return openPage(installer.url);
        if (s?.status === "error" && s.action === "download-from-murage") return openPage("https://murage.ai/download");
        if (s?.status === "available") return void updater.download();
        if (s?.status === "downloaded") return void updater.install();
        if (s?.status === "error") return void updater.retry();
        void updater.check();
      }}
      data-setting-control="updates-heading"
      disabled={s?.status === "checking" || s?.status === "downloading" || s?.status === "installing"}
      className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control disabled:opacity-40"
    >
      {installer ? t("updates.downloadInstaller",{version:installer.version}) : s?.status === "available"
        ? t("updates.download")
        : s?.status === "downloaded"
          ? s.installMode === "handoff" ? "Install" : t("updates.restartInstall")
          : s?.status === "installing" ? "Preparing…"
            : s?.status === "error" ? s.action === "download-from-murage" ? t("updates.downloadFromMurage") : t("updates.retry")
          : t("updates.check")}
    </button>
    {openFailed && <div role="alert" className="mt-1.5 text-[12px] text-danger">{t("modelSignIn.error.browser")}</div>}
    </>
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
              {SETTINGS_STUB_COPY.off(browser ? SETTINGS_STUB_COPY.letsBots.browser : SETTINGS_STUB_COPY.letsBots.skillRecorder)}
            </div>
          )}
        </div>
        <Switch
          // Without the desktop browser bridge the built-in browser cannot run, so the switch says so: off and unavailable.
          checked={enabled && (!browser || desktopBrowser)}
          data-setting-control={browser ? "browser-settings-heading" : "skill-recorder-heading"}
          aria-label={t(browser ? "settings.workspaceFeature.browser.aria" : "settings.workspaceFeature.recorder.aria")}
          // Until the saved switches load, the row cannot tell on from off, so it waits instead of saving a guess.
          disabled={saving || state.config == null || (browser && !desktopBrowser)}
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








/** Settings > Images: the setup, and the library of saved prompt blocks and
 *  reference packs as a tab of its own rather than a button inside a card. */
const SETTINGS_NAV_STOPS = "[data-settings-section], [data-settings-bots-toggle], [data-settings-bot]";
/** Up/Down (Left/Right on the phone strip) move between sections, Home and
 *  End jump to the ends. Group headings are not stops. */
function moveBetweenSections(event: ReactKeyboardEvent<HTMLElement>) {
  const keys: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
  if (!(event.target instanceof HTMLElement) || !event.target.matches(SETTINGS_NAV_STOPS)) return;
  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(SETTINGS_NAV_STOPS));
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
 * summary), so the trap's first and last stops have to skip them too or Tab escapes the dialog. It also skips what
 * styles alone hide (the phone strip with the keyboard up): focus cannot land there, so a wrap to it would leave Tab
 * stuck. iOS before 17.4 has no checkVisibility, so there the same answer comes from the computed styles. */
export function inSettingsTabOrder(element: Pick<Element, "closest" | "parentElement" | "tagName"> & Partial<Pick<Element, "checkVisibility">>): boolean {
  if (element.closest("[hidden]")) return false;
  if (element.checkVisibility) {
    if (!element.checkVisibility()) return false;
  } else {
    for (let each = element as Element | null; each; each = each.parentElement) {
      if (getComputedStyle(each).display === "none") return false;
    }
  }
  const folded = element.closest("details:not([open])");
  return !folded || (element.parentElement === folded && element.tagName === "SUMMARY");
}

/** The one Settings window. With `bot` it shows that bot's page under the Bots group (the bot opener, BotSettingsDialog,
 *  mounts it that way); without, the app's pages. Every way between them goes through the open page's unsaved-edit check. */
export function SettingsModal({ bot, onBotClose }: { bot?: BotRecord; onBotClose?: () => void } = {}) {
  const { state, dispatch } = useStore();
  const botLeave = useRef<BotSettingsLeave | null>(null);
  const mode = useSettingsMode();
  // The store keeps the id it was asked for (any of the 19); the page it lands on is `section` below, so the page
  // bodies read as they always have. An alias also names a card on that page (state.appSettingsAnchor).
  const requested = state.appSettingsSection;
  // A Cloud window: a page it cannot use matches none of the page bodies and shows the "on your computer only" card instead.
  const cloud = isCloudOrigin();
  const blocked = cloudSectionBlocked(requested);
  const browsing = !bot && requested === BROWSE_BOTS_ROUTE;
  const resolved = (blocked || browsing ? "" : resolveSettingsSection(requested).section) as SettingsPage;
  // A page with a file of its own (settings/page-registry.tsx) is mounted from there; `section` is what the legacy blocks
  // below still match on, so it is empty for a page that has moved out. Pages leave the legacy blocks one at a time.
  const mountedPage = resolved && hasPageFile(resolved) ? resolved : null;
  const section = (mountedPage ? "" : resolved) as SettingsPage;
  // The nav marks the page the request lands on, blocked or not, so a Cloud window still shows where the person is.
  // Browse bots is a route, not a page: no page is marked while it shows (it would read as General).
  const navPage = browsing ? null : resolveSettingsSection(requested).section;
  const targetCard = state.appSettingsAnchor ? resolveSettingsCard(state.appSettingsAnchor) : undefined;
  const anchor = targetCard?.anchor ?? state.appSettingsAnchor;
  const dialogRef = useRef<HTMLDivElement>(null);
  const settingsLayerOwner = useLayerOwner();
  const navRef = useRef<HTMLElement>(null);
const paneRef = useRef<HTMLDivElement>(null);
const anchorWaitRef = useRef<{ anchor: string; at: number } | null>(null);
  const [query, setQuery] = useState("");
  const q = query.trim();
  const { desktop, confirmed } = useSurfaceState();
  // Browse bots (`browsing`, above) is a route of the Each bot group, not one of the 13 pages (settings-pages.ts BROWSE_BOTS_ROUTE).
  // Simple lists the pages marked `simple` and nothing else; Advanced lists all 13. An opener that lands on a page Simple
  // does not list turns Advanced mode on (below), so nothing is ever out of reach.
  const visiblePages = sectionsForSurface(PAGES, desktop).filter((entry) => mode === "advanced" || entry.simple);
  const current = PAGES.find((entry) => entry.id === resolved);
  const botRows = sidebarBots(state.bots, bot?.id);
  // The card an opener named stays "in view" for Copy link after the store has cleared the anchor, until the page changes.
  const [landed, setLanded] = useState<{ section: AppSettingsSection; anchor: string } | null>(null);
  // A page left and come back to without a card does not keep the old card for Copy link.
  useEffect(() => { setLanded((now) => (anchor ? { section: requested, anchor } : now && now.section === requested ? now : null)); }, [anchor, requested]);
  const pageLinkCard = landed && landed.section === requested ? cardForAnchor(SETTINGS_CARDS, landed.anchor) : undefined;
  // A request for a page Simple does not list (a link, a What's new tile, a search result) turns Advanced mode on first.
  useEffect(() => { if (!bot && mode === "simple" && !isSimpleTarget(requested)) setSettingsMode("advanced"); }, [bot, mode, requested]);
  // One Advanced per page, closed on a page change unless an opener opens it (below).
  const [advancedOpen, setAdvancedOpen] = useState<Record<SettingsPage, boolean>>(() => Object.fromEntries(SECTION_PAGES.map((entry) => [entry.id, false])) as Record<SettingsPage, boolean>);

  useEffect(() => {
    const visible = sectionsForSurface(SECTIONS, desktop);
    const next = bot ? null : settingsSectionRedirect(SECTIONS, requested, desktop, visible, confirmed);
    if (next) dispatch({ type: "toggleAppSettings", open: true, section: next });
  }, [dispatch, desktop, confirmed, requested, bot]);

  // An opener (a deep link, a What's new tile, the palette, a search result) leaves the search box.
  useEffect(() => { setQuery(""); }, [requested, anchor]);

  useEffect(() => {
    setAdvancedOpen((now) => (Object.values(now).some(Boolean) ? Object.fromEntries(SECTION_PAGES.map((entry) => [entry.id, false])) as Record<SettingsPage, boolean> : now));
  }, [resolved]);

  // Land on the card the opener named: its page's Advanced first when it lives there, then scroll, focus, highlight.
  useEffect(() => {
    if (!anchor || query || bot) return;
    const card = resolveSettingsCard(anchor);
    if (card && mode === "simple" && isAdvancedOnlyCard(card.section, card.id)) {
      setSettingsMode("advanced");
      return;
    }
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
      // A retained tab panel can already contain the anchor while still hidden. Wait for its tab to activate too.
      find: () => { const element = document.getElementById(anchor); return element?.closest("[hidden]") ? null : element; },
      onFound: (element) => { anchorWaitRef.current = null; if (settingsLayerOwner?.handle?.active) revealAnchor(element); dispatch({ type: "appSettingsAnchorDone" }); },
      onGiveUp: () => { anchorWaitRef.current = null; paneRef.current?.scrollTo?.({ top: 0 }); dispatch({ type: "appSettingsAnchorDone" }); },
    });
  }, [anchor, query, advancedOpen, dispatch, bot, mode]);

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
  // A bot's page asks through its own check (BotSettingsPane), which also waits for a save to finish. While one shows, the
  // store's dispatch asks it too before any opener anywhere takes it away (lib/settings-leave.ts).
  const showsBot = Boolean(bot);
  useEffect(() => (showsBot ? registerBotPageLeave(() => botLeave.current) : undefined), [showsBot]);
  const leave = useCallback((operation: () => void) => {
    if (bot) { leaveBotPage(operation); return; }
    if (settingsDrafts.anyUnsaved() && !window.confirm(DISCARD_SETTINGS_CHANGES)) return;
    settingsDrafts.clear();
    operation();
  }, [bot]);
  const closeBot = useCallback(() => { if (onBotClose) onBotClose(); else dispatch({ type: "toggleSettings", open: false }); }, [dispatch, onBotClose]);
  const closeSettings = useCallback(() => leave(bot ? closeBot : () => dispatch({ type: "toggleAppSettings", open: false })), [leave, bot, closeBot, dispatch]);
  const openPage = (id: SettingsPage) => { setQuery(""); if (bot) leave(() => dispatch({ type: "toggleAppSettings", open: true, section: id })); else dispatch({ type: "toggleAppSettings", open: true, section: id }); };
  const openBot = (id: string) => { if (bot?.id === id) return; leave(() => dispatch({ type: "toggleSettings", open: true, botId: id })); };
  const Pane = loadedBotSettingsPane() ?? BotPane.Component;

  const layer = useLayerContainer(dialogRef, { onEscape: closeSettings, initialFocus: null, holdFocus: false });

  // A handful of sections (a paired phone sees four) read better as plain
  // chips on the phone strip than under headings that each hold one or two.
  const fewSections = visiblePages.length <= 4;

  return (
    <LayerSurface><div
      // C5: `fixed` resolves against the layout viewport, which iOS does not
      // shrink for the keyboard, so inset-0 would leave this centred in the
      // full 844px with the bottom half behind the keys. Height tracks --vvh.
      className="fixed inset-x-0 top-0 flex h-[var(--vvh,100%)] items-center justify-center bg-black/50 p-6 max-md:p-0"
      onMouseDown={(e) => e.target === e.currentTarget && closeSettings()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={bot ? undefined : "app-settings-title"}
        aria-label={bot ? `Bot settings: ${bot.name}` : undefined}
        tabIndex={-1}
        className={cn(
          BOX_PANES,
          "settings-dialog w-full rounded-2xl border border-hairline/50 bg-panel shadow-2xl outline-none",
          // overflow-clip, not overflow-hidden: a hidden box can still be
          // scrolled by focus, which slid the title and header off the top.
          // The list and the page each scroll on their own; the dialog never
          // does. 780 fits the grouped list (19 rows of 28px under 6 headings
          // of 22px, about 750px) in a 1440x900 window; a shorter window
          // scrolls the list, with the app's always-visible scrollbar.
          // --vvh, not 100dvh: a bot's page shows in this window now (UX-L3B S7),
          // and its Close must stay on screen when the visual viewport shrinks.
          "h-[min(780px,calc(var(--vvh,100dvh)-2rem))]",
          // A bot's page brings its own section list, so the window is wider while one shows.
          bot ? "max-w-[1120px]" : "max-w-[920px]",
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
            // 272px: the longest label, "Search, images and dictation", fits in Inter
            // even beside the list's scrollbar on a short window.
            "md:w-[272px] md:shrink-0 md:min-h-0 md:overflow-y-auto",
            "max-md:w-full max-md:shrink-0 max-md:flex-row max-md:items-center max-md:gap-1.5 max-md:overflow-x-auto max-md:border-r-0 max-md:border-b max-md:px-4 max-md:py-2",
            // Typing on a bot's page, the phone strip gives its height to the page. Only there: the strip of the
            // app's own pages holds the search box, which the keyboard may be up for.
            bot && "max-md:keyboard-open:hidden",
          )}
          ref={navRef}
          aria-label={t("settings.navAria")}
          onKeyDown={moveBetweenSections}
        >
          <div id="app-settings-title" className="px-2 pb-1.5 pt-0.5 text-[15px] font-semibold text-ink max-md:hidden">
            {t("settings.title")}
          </div>
          {/* The bot page has its own search, over that bot's settings. The app search is the anchor for its hint (L4C). */}
          <div data-settings-search hidden={bot ? true : undefined} className={cn("mb-1 flex min-h-8 items-center gap-2 rounded-lg bg-control/70 px-2.5 max-md:mb-0 max-md:min-h-11 max-md:min-w-0 max-md:flex-1", bot && "hidden")}>
            <Search size={14} className="shrink-0 text-ink-secondary" aria-hidden="true" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (!canHandleLayerEscape(layer, e.nativeEvent)) return;
                e.preventDefault();
                e.stopPropagation();
                if (query) setQuery("");
                else closeSettings();
              }}
              id="settings-search"
              data-coach-anchor="settings-search"
              placeholder={t("settings.search")}
              aria-label={t("settings.searchAria")}
              className="w-full bg-transparent text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
            />
          </div>
          {/* The phone: one page selector beside the search, as the locked mockup draws it, in place of a strip of chips
            * that put Search off-screen. The chips below stay for the desktop list and are hidden here. */}
          <select
            data-settings-page-select
            aria-label={t("settings.pageSelectAria")}
            value={bot ? `bot:${bot.id}` : browsing ? BROWSE_BOTS_ROUTE : navPage ?? ""}
            onChange={(e) => {
              const value = e.target.value;
              if (value.startsWith("bot:")) openBot(value.slice(4));
              else if (value === BROWSE_BOTS_ROUTE) { setQuery(""); leave(() => dispatch({ type: "toggleAppSettings", open: true, section: BROWSE_BOTS_ROUTE })); }
              else openPage(value as SettingsPage);
            }}
            className="hidden min-h-11 min-w-0 flex-1 rounded-lg border border-hairline/50 bg-control/70 px-2.5 text-[13.5px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-md:block"
          >
            {SETTINGS_GROUPS.map((group) => {
              const entries = visiblePages.filter((entry) => entry.group === group);
              const rows = group === "bots" ? botRows.rows : [];
              if (entries.length === 0 && rows.length === 0) return null;
              return (
                <optgroup key={group} label={settingsGroupLabel(group)}>
                  {entries.map(({ id }) => <option key={id} value={id} aria-label={selectorPageLabel(id, requested)}>{truncateAtWord(selectorPageLabel(id, requested))}</option>)}
                  {rows.map((each) => <option key={`bot-${each.id}`} value={`bot:${each.id}`} aria-label={each.name}>{truncateAtWord(each.name)}</option>)}
                  {group === "bots" && botRows.browse && desktop === true && <option value={BROWSE_BOTS_ROUTE}>{sw("settings.browse.toggle", { count: botRows.total })}</option>}
                </optgroup>
              );
            })}
          </select>
          {SETTINGS_GROUPS.map((group) => {
            const entries = visiblePages.filter((entry) => entry.group === group);
            // Each bot (LOCKED 2.1): up to five rows, the Chief first, the open bot always one of them; past five, the
            // Browse bots row opens the list page. Archived bots are not listed, except the one this window is showing.
            const rows = group === "bots" ? botRows.rows : [];
            if (entries.length === 0 && group !== "bots") return null;
            return (
              <div
                key={group}
                role="group"
                aria-labelledby={`settings-group-${group}`}
                aria-description={settingsGroupNote(group)}
                className="flex flex-col max-md:hidden"
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
                    onClick={() => openPage(id)}
                    aria-current={!bot && navPage === id ? "page" : undefined}
                    title={settingsPageLabel(id)}
                    className={cn(
                      "flex h-7 shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13.5px]",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
                      "max-md:h-11 max-md:whitespace-nowrap max-md:rounded-full max-md:px-3.5",
                      !bot && !q && navPage === id ? "bg-control font-medium text-ink" : "text-ink-secondary hover:bg-control/50 hover:text-ink",
                    )}
                  >
                    <Icon size={15} className="shrink-0" aria-hidden="true" />
                    <span className="min-w-0 truncate">{settingsPageLabel(id)}</span>
                  </button>
                ))}
                {group === "bots" && botRows.total === 0 && <p data-settings-no-bots className="px-2.5 py-1 text-[12.5px] leading-snug text-ink-secondary max-md:hidden">{sw("settings.browse.noBots")}</p>}
                {rows.map((each) => (
                  <button
                    key={`bot-${each.id}`}
                    type="button"
                    data-settings-bot={each.id}
                    onClick={() => openBot(each.id)}
                    aria-current={bot?.id === each.id ? "page" : undefined}
                    title={`${each.name}'s settings`}
                    className={cn(
                      "flex h-7 shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13.5px]",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
                      "max-md:h-11 max-md:whitespace-nowrap max-md:rounded-full max-md:px-3.5",
                      bot?.id === each.id ? "bg-control font-medium text-ink" : "text-ink-secondary hover:bg-control/50 hover:text-ink",
                    )}
                  >
                    <Bot size={15} className="shrink-0" aria-hidden="true" />
                    <span className="min-w-0 truncate">{each.name}</span>
                  </button>
                ))}
                {group === "bots" && botRows.browse && desktop === true && (
                  <button
                    type="button"
                    data-settings-section={BROWSE_BOTS_ROUTE}
                    onClick={() => { setQuery(""); leave(() => dispatch({ type: "toggleAppSettings", open: true, section: BROWSE_BOTS_ROUTE })); }}
                    aria-current={!bot && browsing ? "page" : undefined}
                    className={cn(
                      "flex h-7 shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13.5px]",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
                      "max-md:h-11 max-md:whitespace-nowrap max-md:rounded-full max-md:px-3.5",
                      !bot && !q && browsing ? "bg-control font-medium text-ink" : "text-ink-secondary hover:bg-control/50 hover:text-ink",
                    )}
                  >
                    <Users size={15} className="shrink-0" aria-hidden="true" />
                    <span className="min-w-0 truncate">{sw("settings.browse.toggle", { count: botRows.total })}</span>
                  </button>
                )}
              </div>
            );
          })}
          {/* Simple lists seven pages; one line at the bottom takes a person to the rest, so no page is out of reach. */}
          {mode === "simple" && !bot && <div className="mt-2 px-1.5 max-md:hidden"><SetInAdvancedLine count={SECTION_PAGES.length - visiblePages.length} /></div>}
          {/* On Advanced the bottom of the list says so and opens the one switch (LOCKED 2.5). */}
          {mode === "advanced" && !bot && (
            <button
              type="button"
              data-settings-mode-footer
              // Its own name, led by "Settings", so it never reads as a second "Advanced" beside a page's Advanced section.
              aria-label={`${t("settings.title")}: ${sw("settings.mode.footer")}. ${sw("settings.mode.footerChange")}`}
              onClick={() => { setQuery(""); dispatch({ type: "toggleAppSettings", open: true, section: "general", anchor: ADVANCED_MODE_ANCHOR }); }}
              className="mt-2 flex min-h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-left text-[12px] text-ink-secondary hover:bg-control/50 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-md:hidden"
            >
              <span>{sw("settings.mode.footer")}</span><span aria-hidden="true">·</span><span className="underline underline-offset-2">{sw("settings.mode.footerChange")}</span>
            </button>
          )}
        </nav>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <BoxHead className="items-start px-5 py-3">
            <div className="min-w-0">
              {bot ? (
                <>
                  <SettingsBreadcrumb crumbs={[{ label: settingsGroupLabel("bots") }, { label: bot.name, onClick: () => leave(() => dispatch({ type: "toggleSettings", open: true, botId: bot.id, intent: { section: "overview" } })) }]} link={null} />
                  <p data-settings-page-note className="mt-0.5 text-[12.5px] leading-snug text-ink-secondary">{`What ${bot.name} knows, can use and how it works.`}</p>
                </>
              ) : q ? (
                <>
                  <span className="block truncate text-[15px] font-semibold text-ink">{t("settings.l1.resultsFor", { query: q })}</span>
                  <p data-settings-page-note className="mt-0.5 text-[12.5px] leading-snug text-ink-secondary">{t("settings.l1.resultsNote")}</p>
                </>
              ) : (
                <>
                  {browsing ? (
                    <SettingsBreadcrumb crumbs={[{ label: settingsGroupLabel("bots") }, { label: t("settings.page.browseBots") }]} link={settingsPageLink(BROWSE_BOTS_ROUTE)} />
                  ) : (
                    <SettingsBreadcrumb crumbs={current ? [{ label: settingsGroupLabel(current.group) }, { label: requested === "channels" ? t("settings.page.channels") : settingsPageLabel(current.id) }] : []} link={current ? settingsPageLink(current.id, pageLinkCard?.id) : null} />
                  )}
                  {/* What the page is for, in one line (the grandma test). */}
                  {browsing ? <p data-settings-page-note className="mt-0.5 text-[12.5px] leading-snug text-ink-secondary">{t("settings.pageNote.browseBots")}</p> : current && <p data-settings-page-note className="mt-0.5 text-[12.5px] leading-snug text-ink-secondary">{settingsSectionNote(requested === "channels" ? "channels" : current.id)}</p>}
                </>
              )}
            </div>
            <button
              onClick={closeSettings}
              aria-label={bot ? t("settings.bot.header.close") : t("settings.close")}
              className="flex size-10 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <X size={18} />
            </button>
          </BoxHead>

          {bot ? (
            <LazyBoundary inline onRetry={BotPane.retry}>
              <Suspense fallback={<p role="status" className="px-5 text-[13px] text-ink-secondary">Loading {bot.name}'s settings</p>}>
                <Pane bot={bot} onClose={closeBot} leaveRef={botLeave} />
              </Suspense>
            </LazyBoundary>
          ) : (
          <BoxBody ref={paneRef} className="flex flex-1 flex-col gap-4 px-5 pb-5 [--box-pad:1.25rem]" data-settings-page={mountedPage || section || undefined}>
            {q && <SettingsSearchResults query={q} desktop={desktop} onOpen={openCard} onLeave={() => setQuery("")} />}
            {/* A search hides the open page instead of unmounting it, so words typed and not yet
              * saved there (a skill being written, House rules) are still there when the search clears. */}
            <div data-settings-page-body hidden={q ? true : undefined} className={q ? "hidden" : "contents"}>
            {blocked && (
              <Card title={ON_YOUR_COMPUTER_ONLY} subtitle={ON_YOUR_COMPUTER_ONLY_DETAIL}>
                <p data-cloud-computer-only={requested} className="text-[13px] text-ink-secondary">{settingsSectionLabel(requested)}</p>
              </Card>
            )}
            {mountedPage && <SettingsPageMount page={mountedPage} mode={mode} desktop={desktop} cloud={cloud} anchor={anchor} />}
            {browsing && (
              <BrowseBotsPage
                bots={state.bots}
                openId={null}
                onOpen={openBot}
              />
            )}


            {/* Every page ends with the one quiet way out (SETTINGS-LOCKED-1019 section 10). */}
            <SettingsAskLine />
            </div>
          </BoxBody>
          )}
        </div>
      </div>
    </div></LayerSurface>
  );
}
