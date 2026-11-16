import { t } from "@/lib/i18n";
import { SEND_KEYS, chooseSendKey, currentSendKey, isMacPlatform, sendKeyName, subscribeSendKey } from "@/lib/send-key";
import { useEffect, useRef, useState, useSyncExternalStore, } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { analyticsEnabled, setAnalyticsEnabled } from "@/lib/analytics";
import { localeChoices } from "@/locales";
import { Card, Switch } from "../../SettingsPrimitives";
import { cn } from "@/lib/cn";
import { useDesktopSurface, } from "@/lib/use-surface";
import {
  chooseAutoRail,
  chooseSidebarDensity,
  sidebarDensityState,
  subscribeSidebarDensity,
  type SidebarDensity,
} from "@/lib/sidebar-preferences";
import { FONT_IDS, FONT_LABELS, applyFont, isFontId, readFont, type FontId } from "@/lib/fonts";
// Settings' own words, on this chunk rather than the first paint (1.0.19, SettingsCopy.lazy.test.ts).
import "@/lib/settings-copy";



/** Name + email, persisted to /api/config {profile} on blur. */
export function ProfileFields() {
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
      <input data-setting-control="profile-heading" aria-label="Your name" value={name} readOnly={desktop !== true} disabled={status === "saving"} onChange={(e) => { setName(e.target.value); setStatus("idle"); }} onBlur={() => void save()} placeholder="Your name" className={inputClass} />
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

/** Usage analytics, on by default and switchable here. Naming what is sent
 * matters more than the switch: people who cannot see the scope assume the
 * worst, and the worst — conversation text — is exactly what this never
 * sends (autocapture is off; see lib/analytics.ts). */
export function AnalyticsRow() {
  const [on, setOn] = useState(analyticsEnabled);
  return (
    <Card
      title="Usage analytics"
      subtitle="Product events and counts use a stored anonymous identifier. PostHog also sees your IP address. Never conversations, prompts, file contents, file paths, or bot output, and never your name or email."
    >
      <Switch
        checked={on}
        data-setting-control="analytics-heading" aria-label="Send usage analytics"
        onClick={() => {
          const next = !on;
          setAnalyticsEnabled(next);
          setOn(next);
        }}
      />
    </Card>
  );
}

export function LanguageRow() {
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
        data-setting-control="language-heading" aria-label="App language"
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

/** The interface font, apart from the skin (B86): this machine only, like the skin. */
export function FontRow() {
  const [current, setCurrent] = useState<FontId>(readFont);
  return (
    <div className="mt-4 flex items-center justify-between gap-4 border-t border-hairline pt-4">
      <div className="min-w-0">
        <div id="settings-interface-font" className="text-[14px] font-medium text-ink">Interface font</div>
        <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">The lettering across the app on this computer.</div>
      </div>
      <select
        value={current}
        aria-labelledby="settings-interface-font"
        onChange={(event) => {
          const id = event.target.value;
          if (!isFontId(id)) return;
          applyFont(id);
          setCurrent(id);
        }}
        className="min-h-8 w-full max-w-[200px] rounded-lg border border-hairline bg-inset px-2.5 py-1.5 text-[13px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
      >
        {FONT_IDS.map((id) => (
          <option key={id} value={id}>{FONT_LABELS[id]}</option>
        ))}
      </select>
    </div>
  );
}

const DENSITY_OPTIONS: readonly { id: SidebarDensity; label: () => string }[] = [
  { id: "compact", label: () => t("settings.sidebar.standard") },
  { id: "comfortable", label: () => t("settings.sidebar.roomy") },
  { id: "icons", label: () => t("settings.sidebar.rail") },
];

/** Sidebar density, beside the skin (it used to be a menu in the sidebar's
 *  header, next to a Collapse button that did the same thing). */
export function SidebarDensityRow() {
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
              data-setting-control={index === 0 ? "sidebar-density-heading" : undefined}
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

/** Which key sends a message. Enter stays the default, Japanese starts on
 *  Ctrl/Cmd+Enter (an input method confirms its candidate with Enter), and the
 *  choice is kept on this device. */
export function SendKeyRow() {
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
              data-setting-control={index === 0 ? "send-key-heading" : undefined}
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

