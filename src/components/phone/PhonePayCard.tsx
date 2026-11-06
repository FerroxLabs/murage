// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX L7 part 2: the Pay card on a phone or the browser door (MurageMain ruling,
// 1.0.19). Billing stays on the computer for now, so the card says where it
// lives and nothing else: no price, no plan, no purchase or upgrade link (store
// rule, murage-store-apps-no-purchase-links). Rendered in Settings > General on
// a confirmed remote surface only (SettingsModal), so never on the first paint.
import { Monitor } from "lucide-react";
import { t } from "@/lib/i18n";
import { SettingsStub } from "@/components/SettingsStub";

export function PhonePayCard() {
  return (
    <div data-phone-pay-card>
      <SettingsStub title={t("ux.l7.pay.title")} state="other-surface" line={t("ux.l7.pay.line")} testId="phone-pay-card" />
      <p data-phone-pay-hint className="mt-2 flex items-center gap-1.5 px-1 text-[12px] text-ink-secondary">
        <Monitor size={13} aria-hidden="true" />{t("ux.l7.pay.hint")}
      </p>
    </div>
  );
}
