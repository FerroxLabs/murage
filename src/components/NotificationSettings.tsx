import { useEffect, useRef, useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { requestNotificationPermission } from "@/lib/notify";
import { notificationPreferencesSchema, resolveNotificationPreferences, type NotificationPreferences } from "../../shared/notification-preferences";

type Permission = NotificationPermission | "unavailable";
function currentPermission(): Permission { return typeof Notification === "undefined" ? "unavailable" : Notification.permission; }
export function NotificationSettings() {
  const { state, dispatch } = useStore();
  const [draft, setDraft] = useState<NotificationPreferences>(() => resolveNotificationPreferences(state.config?.notifications));
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [permissionPending, setPermissionPending] = useState(false);
  const [permission, setPermission] = useState<Permission>(currentPermission);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
  useEffect(() => {
    if (!dirtyRef.current) setDraft(resolveNotificationPreferences(state.config?.notifications));
  }, [state.config?.notifications]);
  const edit = (next: NotificationPreferences) => {
    dirtyRef.current = true; setDirty(true); setDraft(next); setSaved(false); setError("");
  };
  const quiet = draft.quietHours;
  const setQuietEnabled = (enabled: boolean) => {
    // Never replace an existing stored zone with the viewing device's zone.
    const value = quiet ?? (enabled ? { enabled, start: "22:00", end: "08:00", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } : undefined);
    edit({ ...draft, ...(value ? { quietHours: { ...value, enabled } } : {}) });
  };
  const save = async () => {
    if (!state.config || savingRef.current || !dirty) return;
    setError(""); setSaved(false);
    const parsed = notificationPreferencesSchema.safeParse(draft);
    if (!parsed.success) {
      const zone = parsed.error.issues.some(issue => issue.path.includes("timeZone"));
      setError(zone ? "Choose a valid named time zone, such as Asia/Bangkok or Europe/London."
        : quiet?.start === quiet?.end ? "Quiet hours need different start and end times."
          : "Enter valid quiet-hour times in HH:MM format.");
      return;
    }
    savingRef.current = true; setSaving(true);
    try {
      const config = await api("/api/config", { method: "PUT", body: JSON.stringify({ notifications: parsed.data }) }) as ConfigStatus;
      const confirmed = notificationPreferencesSchema.safeParse(config.notifications);
      if (!confirmed.success || JSON.stringify(confirmed.data) !== JSON.stringify(parsed.data)) throw new Error("Unconfirmed preferences");
      dirtyRef.current = false; setDirty(false); setDraft(confirmed.data);
      dispatch({ type: "configStatus", config }); setSaved(true);
    } catch { setError("Could not save notification preferences. Your edits are still here; try saving again."); }
    finally { savingRef.current = false; setSaving(false); }
  };
  const askPermission = async () => {
    if (permissionPending) return;
    setPermissionPending(true); setError("");
    try { const request = requestNotificationPermission(); setPermission(request ? await request : currentPermission()); }
    catch { setPermission(currentPermission()); setError("The notification permission request could not be completed. Check your browser or system settings."); }
    finally { setPermissionPending(false); }
  };
  const check = (field: "attention" | "completion" | "failures" | "previewContent", label: string, detail: string) =>
    <label className="flex min-h-11 items-start gap-2 py-1.5 text-[13px] text-ink">
      <input type="checkbox" checked={draft[field]} disabled={!state.config || saving} onChange={event => edit({ ...draft, [field]: event.target.checked })} className={"mt-0.5 " + focus} />
      <span>{label}<span className="mt-0.5 block text-[11px] leading-relaxed text-ink-secondary">{detail}</span></span>
    </label>;
  return <section aria-labelledby="notification-settings-title" className="rounded-xl border border-hairline/40 bg-card p-4">
    <h3 id="notification-settings-title" className="text-[15px] font-medium text-ink">Notifications</h3>
    <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">These settings mute notifications only. Tasks and approval cards stay active. A bot with notifications turned off stays off.</p>
    <div className="mt-3">
      {check("attention", "Needs your attention", "Approvals, questions and requests for takeover.")}
      {check("completion", "Task completed", "A task has finished.")}
      {check("failures", "Task failed", "A task or routine needs review after a failure.")}
      {check("previewContent", "Show notification previews", "Turn off to use a generic Murage title and message. Clicking still opens the right conversation.")}
    </div>
    <div className="mt-3 rounded-lg bg-inset p-3">
      <label className="flex min-h-11 items-center gap-2 text-[13px] font-medium text-ink">
        <input type="checkbox" checked={quiet?.enabled === true} disabled={!state.config || saving} onChange={event => setQuietEnabled(event.target.checked)} className={focus} />
        Quiet hours
      </label>
      <p className="text-[11px] leading-relaxed text-ink-secondary">Suppress all notification categories during this window. Muted notifications are not replayed later.</p>
      {quiet && <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="min-w-0 text-[12px] text-ink">Start
          <input type="time" value={quiet.start} disabled={saving} aria-label="Quiet hours start" onChange={event => edit({ ...draft, quietHours: { ...quiet, start: event.target.value } })}
            className={"mt-1 min-h-11 w-full min-w-0 rounded-lg border border-hairline/50 bg-control px-2 text-[13px] " + focus} />
        </label>
        <label className="min-w-0 text-[12px] text-ink">End
          <input type="time" value={quiet.end} disabled={saving} aria-label="Quiet hours end" onChange={event => edit({ ...draft, quietHours: { ...quiet, end: event.target.value } })}
            className={"mt-1 min-h-11 w-full min-w-0 rounded-lg border border-hairline/50 bg-control px-2 text-[13px] " + focus} />
        </label>
        <label className="col-span-2 text-[12px] text-ink">Time zone
          <input type="text" value={quiet.timeZone} disabled={saving} aria-label="Quiet hours time zone" placeholder="Asia/Bangkok" autoComplete="off" spellCheck={false}
            onChange={event => edit({ ...draft, quietHours: { ...quiet, timeZone: event.target.value } })}
            className={"mt-1 min-h-11 w-full rounded-lg border border-hairline/50 bg-control px-3 text-[13px] " + focus} />
        </label>
      </div>}
    </div>
    <div className="mt-3 text-[12px] text-ink-secondary">
      {permission === "granted" ? <p>Notification permission is granted. Delivery still follows these preferences and your system settings.</p>
        : permission === "denied" ? <p>Notification permission is blocked. Allow Murage in your browser or system notification settings.</p>
          : permission === "unavailable" ? <p>Notification permission controls are unavailable in this environment.</p>
            : <p>Notification permission has not been granted. You can request it when you are ready.</p>}
      {permission === "default" && <button type="button" disabled={permissionPending} onClick={() => void askPermission()}
        className={"mt-2 min-h-11 rounded-lg border border-hairline/50 bg-control px-3 text-ink disabled:opacity-50 " + focus}>
        {permissionPending ? "Requesting permission…" : "Request notification permission"}
      </button>}
    </div>
    {error && <p role="alert" className="mt-3 text-[12px] text-danger">{error}</p>}
    {saved && <p role="status" className="mt-3 text-[12px] text-success">Notification preferences saved.</p>}
    <div className="mt-3 flex justify-end">
      <button type="button" disabled={!state.config || !dirty || saving} onClick={() => void save()}
        className={"min-h-11 rounded-lg bg-control px-3 text-[13px] font-medium text-ink disabled:opacity-50 " + focus}>
        {saving ? "Saving…" : "Save notifications"}
      </button>
    </div>
  </section>;
}
