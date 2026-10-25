// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { t } from "@/lib/i18n";

/** The bot usage card's cost caption, in the app language (lib/usage
 *  costCaption keeps the English wording the usage report lines use). */
export function usageCaption(billing: "metered" | "subscription" | undefined): string {
  if (billing === "subscription") return t("usageCard.caption.subscription");
  if (billing === "metered") return t("usageCard.caption.metered");
  return t("usageCard.caption.reported");
}
