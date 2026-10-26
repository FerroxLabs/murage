// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { ArrowDown } from "lucide-react";
import { t } from "@/lib/i18n";

/** One tap back to the newest message; the chat and room views both use it. */
export function JumpToLatestButton({ onClick, bottom }: { onClick: () => void; bottom: number }) {
  return (
    <button
      onClick={onClick}
      aria-label={t("chat.jumpToLatestAria")}
      className="animate-pop-in absolute left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-hairline/40 bg-raised px-3 py-1.5 text-[12.5px] text-ink shadow-lg hover:bg-raised-hover"
      style={{ bottom }}
    >
      <ArrowDown size={13} /> {t("chat.jumpToLatest")}
    </button>
  );
}
