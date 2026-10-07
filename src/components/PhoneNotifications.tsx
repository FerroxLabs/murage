import { useEffect, useState } from "react";
import { callNative, nativeAvailable, onNativeEvent } from "../lib/native-shell";
import { browserPushDeps, pushStatusCurrent, syncPush, type PushState, type PushStatus } from "../lib/push-enrol";
import { Card, Switch } from "./SettingsPrimitives";
import { t } from "../lib/i18n";
import type { LocaleKey } from "../locales";

/** Why "Turn on" left the row off (final review M3). */
const WHY: Partial<Record<PushState, LocaleKey>> = {
  hostOff: "phoneNotifications.hostOff",
  unsupported: "phoneNotifications.unsupported",
  failed: "phoneNotifications.retry",
};

/** Phone-specific preview consent lives beside this phone's push binding. */
export function PhoneNotifications() {
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState<LocaleKey | null>(null);
  const [preview, setPreview] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const refresh = async () => {
    if (!(await nativeAvailable("pushStatus"))) return;
    setStatus((await callNative("pushStatus")) as PushStatus);
    const answer = await browserPushDeps.get("/api/mobile/push/preferences");
    const value = (answer.body as { previewContent?: unknown } | null)?.previewContent;
    setPreview(answer.status === 200 && typeof value === "boolean" ? value : null);
  };
  useEffect(() => {
    void refresh().catch(() => {});
    return onNativeEvent("resume", () => {
      void syncPush(browserPushDeps, "foreground").then(refresh).catch(() => {});
    });
  }, []);
  if (!status) return null;
  const on = pushStatusCurrent(status, Date.now());
  return (
    <Card title={t("phoneNotifications.title")}>
      <p>{t(on ? "phoneNotifications.on" : status.permission === "denied" ? "phoneNotifications.denied" : "phoneNotifications.off")}</p>
      {!on && status.permission !== "denied" && (
        <button type="button" disabled={busy} onClick={async () => {
          setBusy(true);
          const result: PushState = await syncPush(browserPushDeps, "manual").catch(() => "failed" as const);
          setWhy(WHY[result] ?? null);
          await refresh().catch(() => {});
          setBusy(false);
        }}>
          {t("phoneNotifications.turnOn")}
        </button>
      )}
      {!on && why && <p role="status">{t(why)}</p>}
      <div className="mt-4 flex min-h-11 items-start justify-between gap-3 text-[13px] text-ink">
        <span id="phone-preview-label">{t("phoneNotifications.previewLabel")}
          <span id="phone-preview-help" className="mt-1 block text-[12px] text-ink-secondary">{t("phoneNotifications.previewHelp")}</span>
        </span>
        <Switch aria-labelledby="phone-preview-label" aria-describedby="phone-preview-help" checked={preview === true}
          disabled={preview === null || saving || busy} onClick={async () => {
            setSaving(true); setPreviewError(false);
            try {
              const next = !preview;
              const answer = await browserPushDeps.post("/api/mobile/push/preferences", { previewContent: next });
              if (answer.status !== 200 || (answer.body as { previewContent?: unknown } | null)?.previewContent !== next) throw new Error("Unconfirmed preference");
              setPreview(next);
            } catch { setPreviewError(true); }
            finally { setSaving(false); }
          }} />
      </div>
      {previewError && <p role="alert">{t("phoneNotifications.previewRetry")}</p>}
    </Card>
  );
}
