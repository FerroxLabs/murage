// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// The "Your turn" card (spec 9.4): the hard floor stopped the bot at a step only the
// owner does (agreeing to terms, a human check, a password or code, the last
// payment step). Props follow T03's note: the binding's status says it is paused
// for a handoff (`pausedReason: "handoff"`), names the site and the floor
// category, and lists the actions the owner may take.
//
// Continue and Stop task call actions that T25 adds. A button shows only when
// the status lists that action AND a handler exists; nothing here pretends to
// act. Continue never shows on a phone: the owner finishes the step on the
// computer that holds the tab.
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

/** The hard floor's categories (server/browser-floor.ts). "account" is an account or security change (password, sign-in, recovery, permissions, sharing, closing the account): D1 hands it back, no mode passes it. `null` is a step the floor could not classify. */
export type YourTurnCategory = "consent" | "verification" | "credentials" | "payment" | "account" | null;

export interface BrowserYourTurnCardProps {
  /** the bot's name */
  bot: string;
  /** a host, never page text */
  site: string;
  category: YourTurnCategory;
  /** Anything but "handoff" is some other pause and this card does not apply. */
  pausedReason?: string;
  /** What the status says the owner may do now: "continue" and "stop". */
  actions?: readonly string[];
  /** On the paired phone: no Continue, a line that says where to continue. */
  phone?: boolean;
  onContinue?: () => void;
  onStop?: () => void;
}

const BODY: Record<Exclude<YourTurnCategory, null>, LocaleKey> = {
  consent: "browserExt.yourTurn.consent",
  verification: "browserExt.yourTurn.verification",
  credentials: "browserExt.yourTurn.credentials",
  payment: "browserExt.yourTurn.payment",
  account: "browserExt.yourTurn.account",
};

export function BrowserYourTurnCard({ bot, site, category, pausedReason, actions, phone, onContinue, onStop }: BrowserYourTurnCardProps) {
  if (pausedReason !== undefined && pausedReason !== "handoff") return null;
  const params = { bot, site };
  const body = t(category && Object.hasOwn(BODY, category) ? BODY[category] : "browserExt.yourTurn.generic", params);
  const listed = new Set(actions ?? []);
  const canContinue = !phone && listed.has("continue") && Boolean(onContinue);
  const canStop = listed.has("stop") && Boolean(onStop);
  return (
    <div data-your-turn={category ?? "other"} className="w-full max-w-[840px] rounded-2xl border border-accent/40 bg-card p-4">
      <div className="text-[15px] font-semibold text-ink">{t("browserExt.yourTurn.title")}</div>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-secondary">{phone ? t("browserExt.yourTurn.phone", params) : body}</p>
      {(canContinue || canStop) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {canContinue && (
            <button type="button" data-action="continue" onClick={onContinue}
              className="inline-flex min-h-11 items-center rounded-full bg-accent px-4 text-[13px] font-medium text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
              {t("browserExt.yourTurn.continue")}
            </button>
          )}
          {canStop && (
            <button type="button" data-action="stop" onClick={onStop}
              className={cn("inline-flex min-h-11 items-center rounded-full border border-hairline px-4 text-[13px] font-medium text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent")}>
              {t("browserExt.yourTurn.stopTask")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
