// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { t } from "@/lib/i18n";
import type { PhoneSetupController } from "./PhoneSetupFlow";

/** Pairing over the local network is plain HTTP, so it is a choice (audit C6).
 * One component for the three moments: the warning before it is turned on, the
 * switch-off row while it is on, and the one-time note an install that never
 * chose gets when phones are already paired. */
export function LanPairing({ c, className = "" }: { c: PhoneSetupController; className?: string }) {
  const lan = c.state?.lanPairing;
  if (!lan) return null;
  const button = "rounded-lg border border-hairline/50 px-3 py-1.5 text-[12.5px] text-ink hover:bg-control disabled:opacity-40";
  if (c.lanPrompt) {
    return (
      <div role="alertdialog" aria-label={t("phone.lan.turnOn")} className={`rounded-lg border border-hairline/50 px-3 py-3 text-left ${className}`}>
        <p className="text-[12.5px] leading-relaxed text-ink">{t("phone.lan.warning")}</p>
        <div className="mt-3 flex gap-2">
          <button disabled={c.busy} onClick={c.confirmLan} className="rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-40">{t("phone.lan.turnOn")}</button>
          <button disabled={c.busy} onClick={c.dismissLan} className={button}>{t("phone.lan.notNow")}</button>
        </div>
      </div>
    );
  }
  if (lan.on) {
    return (
      <div className={`flex items-center justify-between gap-3 text-left ${className}`}>
        <p className="text-[11.5px] leading-relaxed text-ink-secondary">{t("phone.lan.on")}</p>
        <button disabled={c.busy} onClick={() => void c.act((companion) => companion.lanPairing(false))} className={button}>{t("phone.lan.turnOff")}</button>
      </div>
    );
  }
  if (lan.note === "narrowed") {
    return (
      <div role="status" className={`rounded-lg border border-hairline/50 px-3 py-3 text-left ${className}`}>
        <p className="text-[12.5px] leading-relaxed text-ink">{t("phone.lan.narrowed")}</p>
        <div className="mt-3 flex gap-2">
          <button disabled={c.busy} onClick={c.confirmLan} className={button}>{t("phone.lan.turnOn")}</button>
          <button disabled={c.busy} onClick={() => void c.act((companion) => companion.lanPairing(false))} className={button}>{t("phone.lan.keepOff")}</button>
        </div>
      </div>
    );
  }
  return null;
}
