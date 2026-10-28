// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// 1.0.9 share and ask S41: under a user line that came through the phone, a quiet "From your phone" and an "Ask again" chip. The chip puts the
// line's words in the composer for the owner to send; the line itself stays what the phone sent (it is not editable, regenerated or retried).
import { askAgainFromLine } from "@/lib/compose-link";
import { t } from "@/lib/i18n";
import type { Message } from "@/state/store";

export function FromPhoneLineView({ via, onAskAgain }: { via: Message["via"]; onAskAgain: () => void }) {
  if (via === undefined || via === null) return null;
  return (
    <div data-testid="from-phone-line" className="mt-1 flex max-w-[34rem] flex-wrap items-center justify-end gap-2 text-[12px] text-ink-secondary">
      <span>{t("phone.ask.fromPhone")}</span>
      <button type="button" onClick={onAskAgain} data-testid="ask-again" className="rounded-md px-2 py-0.5 text-[12px] font-medium text-ink hover:bg-raised">
        {t("phone.ask.askAgain")}
      </button>
    </div>
  );
}

export function FromPhoneLine({ message, botId, threadId }: { message: Pick<Message, "via" | "text">; botId: string; threadId: string }) {
  return <FromPhoneLineView via={message.via} onAskAgain={() => askAgainFromLine(message, { botId, threadId })} />;
}
