// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX L7 part 2: the alerts card, shown once on a phone's Today. It asks to
// turn on alerts through the existing push enrolment (push-enrol.ts, the same
// call Settings' Phone notifications row makes). It never shows when the
// launcher cannot do push, when alerts are already on, or after either
// button was pressed once. Loaded on its own, so the first paint stays as is.

import { useEffect, useState } from "react";
import { BellRing } from "lucide-react";
import { t } from "@/lib/i18n";
import { callNative, nativeAvailable } from "@/lib/native-shell";
import { browserPushDeps, pushStatusCurrent, syncPush, type PushStatus } from "@/lib/push-enrol";

export const PHONE_ALERTS_SEEN_KEY = "murage.phoneAlertsCard.seen";

export function phoneAlertsSeen(storage: Pick<Storage, "getItem"> | null): boolean {
  try { return storage?.getItem(PHONE_ALERTS_SEEN_KEY) === "1"; } catch { return false; }
}

export function markPhoneAlertsSeen(storage: Pick<Storage, "setItem"> | null): void {
  try { storage?.setItem(PHONE_ALERTS_SEEN_KEY, "1"); } catch { /* private mode: the card may show again, nothing breaks */ }
}

/** Show the card only when this phone can do push and alerts are off. */
export function phoneAlertsOffer(canPush: boolean, status: PushStatus | null, now: number): boolean {
  return canPush && status !== null && status.permission !== "denied" && !pushStatusCurrent(status, now);
}

const local = (): Storage | null => { try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; } };

export function PhoneAlertsCard() {
  const [offer, setOffer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    if (phoneAlertsSeen(local())) return;
    void (async () => {
      const canPush = await nativeAvailable("pushStatus");
      const status = canPush ? (await callNative("pushStatus")) as PushStatus : null;
      if (live) setOffer(phoneAlertsOffer(canPush, status, Date.now()));
    })().catch(() => {});
    return () => { live = false; };
  }, []);
  if (!offer) return null;
  const done = () => { markPhoneAlertsSeen(local()); setOffer(false); };
  const turnOn = async () => {
    setBusy(true);
    const result = await syncPush(browserPushDeps, "manual").catch(() => "failed" as const);
    setBusy(false);
    if (result === "enrolled") done();
    else setFailed(true);
  };
  return (
    <section aria-labelledby="phone-alerts-title" data-phone-alerts-card className="flex flex-col gap-3 rounded-xl border border-hairline/50 bg-panel p-4 md:hidden">
      <div className="flex items-start gap-3">
        <BellRing size={20} aria-hidden="true" className="mt-0.5 shrink-0 text-accent-text" />
        <div className="min-w-0 flex-1">
          <h2 id="phone-alerts-title" className="text-[15px] font-semibold text-ink">{t("ux.l7.alerts.title")}</h2>
          <p className="mt-0.5 text-[13px] text-ink-secondary">{t(failed ? "phoneNotifications.retry" : "ux.l7.alerts.sub")}</p>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" data-phone-alerts-later onClick={done}
          className="min-h-11 rounded-lg px-4 text-[14px] text-ink-secondary hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">{t("ux.l7.alerts.later")}</button>
        <button type="button" data-phone-alerts-on disabled={busy} onClick={() => void turnOn()}
          className="min-h-11 rounded-lg bg-accent px-4 text-[14px] font-medium text-accent-ink hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">{t("ux.l7.alerts.on")}</button>
      </div>
    </section>
  );
}
