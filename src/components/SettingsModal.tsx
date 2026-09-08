// App settings, as a real modal with sections rather than one long panel.
// Per-bot settings (persona, model, computer) stay in SettingsPanel — this
// is the stuff shared by every bot: who you are, your keys, and the
// machine your bots can borrow.
import { useEffect, useRef, useState } from "react";
import { Coins, FlaskConical, Globe, KeyRound, MessageCircle, Monitor, Search, Smartphone, Terminal, Trash2, User, X } from "lucide-react";
import { api, useStore, type AppSettingsSection, type ConfigStatus } from "@/state/store";
import { analyticsEnabled, setAnalyticsEnabled } from "@/lib/analytics";
import { builtInBrowserEnabled, showToolCallsEnabled, skillRecorderEnabled } from "@/lib/feature-flags";
import { localeChoices } from "@/locales";
import { ApiKeyRow, VpsConnection } from "./ApiKeys";
import { ImageSettings } from "./ImageSettings";
import { ModelsSettings } from "./ModelsSettings";
import { PasteKeys } from "./PasteKeys";
import { useUpdaterState } from "@/lib/updater";
import { EnginesSettings } from "./EnginesSettings";
import { LocalComputerSection } from "./LocalComputerSection";
import { CompanionSection } from "./CompanionSection";
import { Card, Switch } from "./SettingsPrimitives";
import { UsageSection } from "./UsageSection";
import { SkinPicker } from "./SkinPicker";
import { RoomTurnTimeoutSettings } from "./RoomTurnTimeoutSettings";
import { TranscriptionSettings } from "./TranscriptionSettings";
import { SearchSettings } from "./SearchSettings";
import { NotificationSettings } from "./NotificationSettings";
import { TelegramSettings } from "./TelegramSettings";
import { StarterProfiles } from "./StarterProfiles";
import { cn } from "@/lib/cn";
import { useDesktopSurface } from "@/lib/use-surface";
import {
  browserProfileDeletionBlockReason,
  browserProfilesForPatch,
} from "@/lib/browser-profiles";

const SECTIONS: Array<{
  id: AppSettingsSection;
  label: string;
  icon: typeof User;
  /** Hidden on any surface that is not the confirmed desktop. */
  desktopOnly?: boolean;
  keywords: string[];
}> = [
  { id: "general", label: "General", icon: User, keywords: ["profile", "name", "email", "skin", "theme", "appearance", "analytics", "updates", "tools", "tool calls", "notifications", "quiet hours", "privacy", "previews"] },
  { id: "experimental", label: "Experimental", icon: FlaskConical, desktopOnly: true, keywords: ["early", "preview", "teach", "skill", "browser", "profiles"] },
  // `desktopOnly` is not a tidiness flag. These four are the credential and
  // execution surface of the app: API keys for xAI, Box, Composio and the
  // OpenCode gateway, the VPS connection, the engine CLI installers, and the
  // local VM controls. A paired phone was rendering every one of them —
  // readable, editable, on a device that is only supposed to be able to read
  // conversations. The door already refuses the routes behind them, so
  // nothing could execute, but a key on screen is a key disclosed.
  //
  // Phone is here for a different reason: on a phone it is an offer to do the
  // thing you have already done.
  { id: "models", label: "Models", icon: Globe, desktopOnly: true, keywords: ["models", "providers", "keys", "catalog", "flux", "pricing", "openai", "anthropic"] },
  { id: "engines", label: "Engines", icon: Terminal, desktopOnly: true, keywords: ["models", "claude", "grok", "providers", "cli", "flux", "flux router", "router", "opencode", "keys"] },
  { id: "connections", label: "Tools & Connections", icon: KeyRound, desktopOnly: true, keywords: ["keys", "api", "composio", "box", "xai", "vps", "paste", "env", "search", "tavily", "exa", "transcription"] },
  { id: "channels", label: "Channels", icon: MessageCircle, desktopOnly: true, keywords: ["telegram", "botfather", "pair", "slack", "discord", "whatsapp", "messaging"] },
  { id: "companion", label: "Phone", icon: Smartphone, desktopOnly: true, keywords: ["companion", "phone", "pair", "mobile"] },
  { id: "computer", label: "Local VM", icon: Monitor, desktopOnly: true, keywords: ["vm", "virtual", "desktop"] },
  { id: "usage", label: "Usage", icon: Coins, keywords: ["tokens", "cost", "billing"] },
];

function sectionMatches(section: (typeof SECTIONS)[number], query: string): boolean {
  if (!query) return true;
  return [section.label, ...section.keywords].some((part) => part.toLowerCase().includes(query));
}

/** The sections this surface may see.
 *
 * `undefined` — the surface has not answered yet — withholds the desktop-only
 * ones. Neutral is the narrow side: showing an API key for one frame and then
 * hiding it has already disclosed it, and a section appearing a moment late on
 * the desktop costs nothing. */
export function sectionsForSurface(
  sections: typeof SECTIONS,
  desktop: boolean | undefined,
): typeof SECTIONS {
  return desktop === true ? sections : sections.filter((entry) => !entry.desktopOnly);
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

export function UpdatesRow() {
  const s = useUpdaterState();
  if (!window.muragebox?.updater) return null;
  const updater = window.muragebox.updater;
  const label =
    s?.status === "checking"
      ? "Checking…"
      : s?.status === "available"
        ? `${s.version} available`
        : s?.status === "downloading"
          ? s.percent == null ? "Starting download…" : `Downloading ${Math.round(s.percent)}%`
          : s?.status === "downloaded"
            ? s.installMode === "handoff" ? `${s.version} ready — finish in a terminal` : `${s.version} ready — restart to apply`
            : s?.status === "installing"
              ? "Preparing the update…"
              : s?.status === "handed-off"
                ? "Install command copied. Finish in a terminal."
            : s?.status === "error"
              ? `Update could not finish: ${s.message ?? "unknown error"}`
              : "You're on the latest version we know of.";
  return (
    <Card title="Updates" subtitle={label}>
      <button
        onClick={() => {
          if (s?.status === "available") return void updater.download();
          if (s?.status === "downloaded") return void updater.install();
          if (s?.status === "error") return void updater.retry();
          void updater.check();
        }}
        disabled={s?.status === "checking" || s?.status === "downloading" || s?.status === "installing"}
        className="rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px] text-ink hover:bg-control disabled:opacity-40"
      >
        {s?.status === "available"
          ? "Download"
          : s?.status === "downloaded"
            ? s.installMode === "handoff" ? "Install" : "Restart and install"
            : s?.status === "installing" ? "Preparing…"
              : s?.status === "error" ? "Try again"
            : "Check for updates"}
      </button>
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
function BrowserProfilesRow() {
  const { state, dispatch } = useStore();
  const profiles = state.config?.browserProfiles ?? [];
  const [busy, setBusy] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState("");
  // Windows temporarily gates the live browser surface, but upgraded users
  // must still be able to rename or permanently erase existing sessions.
  // The packaged server can perform that private lifecycle cleanup without
  // exposing the browser renderer bridge.
  if (!window.muragebox || (!builtInBrowserEnabled(state.config) && profiles.length === 0)) return null;

  const save = async (next: typeof profiles) => {
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ browserProfiles: browserProfilesForPatch(next) }),
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
        body: JSON.stringify({
          browserProfiles: browserProfilesForPatch(profiles.filter((candidate) => candidate.id !== id)),
        }),
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
    void save(profiles.map((profile) => (profile.id === renaming.id ? { ...profile, name } : profile)));
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
                <div className="flex min-w-0 items-center gap-2">
                  <Globe size={14} className="shrink-0 text-ink-secondary" />
                  {editing ? (
                    <form
                      className="flex items-center gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        rename();
                      }}
                    >
                      <input
                        autoFocus
                        value={renaming.name}
                        onChange={(event) => setRenaming({ id: profile.id, name: event.target.value })}
                        maxLength={40}
                        className="rounded-md bg-inset px-2 py-1 text-[13px] text-ink outline-none"
                        aria-label="Profile name"
                      />
                      <button type="submit" disabled={busy !== null} className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-accent-ink disabled:opacity-50">
                        Save
                      </button>
                      <button type="button" onClick={() => setRenaming(null)} className="text-[12px] text-ink-secondary hover:text-ink">
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setRenaming({ id: profile.id, name: profile.name })}
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
      {error ? <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p> : null}
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

export function SettingsModal() {
  const { state, dispatch } = useStore();
  const section = state.appSettingsSection;
  const dialogRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const desktop = useDesktopSurface();
  const allowed = sectionsForSurface(SECTIONS, desktop);
  const visibleSections = allowed.filter((entry) => sectionMatches(entry, q));

  useEffect(() => {
    const visible = sectionsForSurface(SECTIONS, desktop).filter((entry) => sectionMatches(entry, q));
    if (visible.some((entry) => entry.id === section)) return;
    const first = visible[0];
    if (first) dispatch({ type: "toggleAppSettings", open: true, section: first.id });
  }, [dispatch, desktop, q, section]);

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

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
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
      previousFocus?.focus();
    };
  }, [dispatch]);

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
          "flex w-full max-w-[860px] overflow-hidden rounded-2xl border border-hairline/50 bg-panel shadow-2xl outline-none",
          // 560px flat used to overflow a short window; the codebase already
          // knows this shape (PluginsPanel, TeamLibraryPanel).
          "h-[min(560px,calc(100dvh-2rem))]",
          // Below md a 190px nav beside the content left 152px of settings on a
          // 390px screen. Full-bleed sheet, nav folded to a horizontal scroller
          // above it. --vvh rather than 100dvh so the footer buttons stay
          // reachable with the keyboard up (100dvh is the layout viewport,
          // which iOS does not shrink).
          "max-md:h-[var(--vvh,100dvh)] max-md:max-w-none max-md:flex-col max-md:rounded-none",
        )}
      >
        {/* section nav */}
        <nav
          className={cn(
            "flex flex-col gap-0.5 border-r border-hairline/40 p-3",
            "md:w-[190px] md:shrink-0",
            "max-md:w-full max-md:shrink-0 max-md:flex-row max-md:items-center max-md:overflow-x-auto max-md:border-r-0 max-md:border-b",
          )}
        >
          <div id="app-settings-title" className="px-2 pb-2 pt-1 text-[15px] font-semibold text-ink max-md:hidden">
            Settings
          </div>
          <div className="mb-1.5 flex items-center gap-2 rounded-lg bg-control/70 px-2.5 py-1.5 max-md:mb-0 max-md:w-[9rem] max-md:shrink-0">
            <Search size={14} className="shrink-0 text-ink-secondary" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.stopPropagation();
                if (query) setQuery("");
                else dispatch({ type: "toggleAppSettings", open: false });
              }}
              placeholder="Search"
              aria-label="Search settings"
              className="w-full bg-transparent text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
            />
          </div>
          {visibleSections.length === 0 && (
            <div className="px-2.5 py-4 text-[12.5px] leading-relaxed text-ink-secondary">
              Nothing matches “{query.trim()}”
            </div>
          )}
          {visibleSections.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => dispatch({ type: "toggleAppSettings", open: true, section: id })}
              aria-current={section === id ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[14px]",
                "max-md:shrink-0 max-md:whitespace-nowrap",
                section === id ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/50 hover:text-ink",
              )}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </nav>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between px-5 py-3">
            <span className="text-[15px] font-semibold text-ink">
              {SECTIONS.find((s) => s.id === section)?.label}
            </span>
            <button
              onClick={() => dispatch({ type: "toggleAppSettings", open: false })}
              aria-label="Close settings"
              className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
            >
              <X size={18} />
            </button>
          </div>

          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 pb-5">
            {section === "general" && (
              <>
                <Card title="Profile" subtitle={desktop === true ? "Shown in the sidebar. Saved as you go." : "Shown in the sidebar."}>
                  <ProfileFields />
                </Card>
                {desktop === true && <StarterProfiles />}
                <Card title="Appearance" subtitle="Applies instantly and is remembered on this machine.">
                  <SkinPicker />
                </Card>
                {desktop === true && <NotificationSettings />}
                {desktop === true && <><Card title="Channel turns" subtitle="Set one maximum duration for every bot turn in a channel.">
                  <RoomTurnTimeoutSettings />
                </Card>
                <LanguageRow />
                <ToolCallsRow /></>}
                {desktop !== true && <p className="text-[12px] text-ink-secondary">Language, tool-call display and channel settings are managed in the desktop app.</p>}
                <UpdatesRow />
                <DiagnosticsRow />
                <AnalyticsRow />
              </>
            )}

            {desktop === true && section === "experimental" && (
              <>
                <ExperimentalFeaturesRow />
                <BrowserProfilesRow />
              </>
            )}

            {desktop === true && section === "connections" && (
              <Card
                title="Tools & Connections"
                subtitle="Connect apps for your bots. If the connected apps service isn't ready, add your Composio key below."
              >
                <div className="flex flex-col gap-4">
                  {state.config?.composio.mode === "managed" ? (
                    <div className="rounded-lg border border-success/25 bg-success/10 px-3 py-2 text-[13px] text-success">
                      Connected apps service is ready
                    </div>
                  ) : null}
                  {/* Paste a whole .env once instead of filling the rows below
                      one at a time. It only ever SUGGESTS: each key found is
                      confirmed separately, an ambiguous one is not confirmable
                      until the person says which provider it is, and the blob
                      is never React state so it cannot reach a render tree. */}
                  <PasteKeys />
                  <TranscriptionSettings />
                  <SearchSettings />
                  <ImageSettings />
                  {/* Composio sits with the other keys rather than folded into
                      a "Self-host connected apps" disclosure, which is where it
                      used to live. That disclosure made sense while Ferrox's
                      managed broker was the default and bringing your own key
                      was the exotic case. It is not the default any more —
                      connected apps need the person's own project key — so
                      hiding the only way to switch them on behind a collapsed
                      summary hid the feature itself. */}
                  <ApiKeyRow section="composio" />
                  <ApiKeyRow section="box" />
                  <VpsConnection />
                </div>
              </Card>
            )}

            {desktop === true && section === "models" && <ModelsSettings />}

            {desktop === true && section === "engines" && (
              <>
                <Card title="Your engines" subtitle="Install, connect and update the software that runs your bots. Manage provider keys and model catalogs under Models.">
                  <EnginesSettings />
                </Card>
              </>
            )}

            {desktop === true && section === "channels" && <TelegramSettings />}

            {desktop === true && section === "companion" && <CompanionSection profileEmail={state.config?.profile?.email} />}

            {desktop === true && section === "computer" && <LocalComputerSection />}

            {section === "usage" && <UsageSection />}
          </div>
        </div>
      </div>
    </div>
  );
}
