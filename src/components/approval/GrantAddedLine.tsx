// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX-TRUST-MOMENTS-1012 1.3: "Approved. {bot} stops asking: {what}. [Undo]"
// for 8 seconds, then "Take back" stays as a link. Only what the server
// reported as added is named or removed. A bot-level grant is taken back on
// the computer only (the bot remove route is desktop only).
import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { UNDO_WINDOW_MS } from "@/lib/undo-window";
import { takeBackAdded, undoOpen, useGrantAdded } from "@/lib/grant-added";
import { useDesktopSurface } from "@/lib/use-surface";
import { describeGrant } from "@/lib/remembered-grants";

const LINK = "inline-flex min-h-11 items-center rounded-md px-2 text-[12.5px] text-accent underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";

export function GrantAddedLine({ requestId, bot }: { requestId: string; bot: string }) {
  const entry = useGrantAdded(requestId);
  const desktop = useDesktopSurface();
  const [, tick] = useState(0);
  const open = entry ? undoOpen(entry) : false;
  useEffect(() => {
    if (!entry || !open) return;
    const timer = setTimeout(() => tick((n) => n + 1), Math.max(0, entry.at + UNDO_WINDOW_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [entry, open]);
  if (!entry) return null;
  if (entry.state === "taken") return <span role="status" data-grant-added="taken">{t("ux.l1.added.takenBack")}</span>;
  const line = entry.keys.length ? t("ux.l1.added.line", { bot, what: entry.words.replace(/[.]$/, "") }) : t("ux.l1.added.nothingNew", { bot });
  if (!entry.keys.length) return <span role="status" data-grant-added="none">{line}</span>;
  const canTakeBack = entry.scope !== "bot" || desktop === true;
  const busy = entry.state === "undoing";
  const run = () => { if (!busy) void takeBackAdded(requestId); };
  const remaining = entry.state === "partial" ? (entry.remaining ?? []) : [];
  return (
    <span role="status" data-grant-added={entry.state} className="inline-flex flex-wrap items-center gap-x-1">
      <span>{line}</span>
      {remaining.length > 0 && (
        <span className="text-warning">{t("ux.l1.added.partial", { list: remaining.map((key) => { const words = describeGrant(key, []); return words.kind === "exact" ? words.command : words.text; }).join(", ") })}</span>
      )}
      {canTakeBack ? (
        <button type="button" onClick={run} aria-disabled={busy || undefined} aria-busy={busy || undefined} className={cn(LINK, busy && "cursor-progress opacity-70")}>
          {busy ? t("ux.l1.added.takingBack") : remaining.length ? t("ux.l1.added.tryAgain") : open ? t("ux.l1.added.undo") : t("ux.l1.added.takeBack")}
        </button>
      ) : (
        <span className="text-ink-secondary">{t("ux.l1.added.onComputer", { bot })}</span>
      )}
    </span>
  );
}
