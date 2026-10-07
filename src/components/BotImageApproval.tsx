// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { useId, useState } from "react";
import type { Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { IMAGE_ASK_AFTER_MAX, type ImageApprovalSetting } from "../../shared/image-approval-setting";

const CHOICES: ReadonlyArray<{ value: ImageApprovalSetting; label: Parameters<typeof t>[0]; tip: Parameters<typeof t>[0] }> = [
  { value: "follow", label: "botImages.follow", tip: "botImages.followTip" },
  { value: "ask", label: "botImages.ask", tip: "botImages.askTip" },
  { value: "allow", label: "botImages.allow", tip: "botImages.allowTip" },
];

/** What was typed in the guard field, as the request it makes: blank clears
 * the limit, a whole number from 1 to 50 sets it, anything else is refused. */
export function imageAskAfterPatch(text: string): { ok: true; value: number | null } | { ok: false } {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: null };
  const value = /^\d{1,3}$/.test(trimmed) ? Number(trimmed) : 0;
  return value >= 1 && value <= IMAGE_ASK_AFTER_MAX ? { ok: true, value } : { ok: false };
}

function AskAfterField({ value, disabled, onCommit }: { value: number | undefined; disabled: boolean; onCommit: (value: number | null) => void }) {
  const id = useId();
  const [draft, setDraft] = useState(value === undefined ? "" : String(value));
  const [invalid, setInvalid] = useState(false);
  const commit = () => {
    const parsed = imageAskAfterPatch(draft);
    setInvalid(!parsed.ok);
    if (parsed.ok && parsed.value !== (value ?? null)) onCommit(parsed.value);
  };
  return (
    <div className="mt-3 rounded-lg bg-inset px-3 py-2.5">
      <label htmlFor={id} className="text-[13px] text-ink">{t("botImages.askAfterLabel")}</label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={1}
        max={IMAGE_ASK_AFTER_MAX}
        value={draft}
        disabled={disabled}
        placeholder={t("botImages.askAfterPlaceholder")}
        aria-invalid={invalid}
        aria-describedby={`${id}-hint`}
        onChange={(event) => { setDraft(event.target.value); setInvalid(false); }}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === "Enter") commit(); }}
        className="mt-1.5 block min-h-11 w-28 rounded-md bg-card px-3 text-[14px] text-ink disabled:opacity-40"
      />
      <div id={`${id}-hint`} className={cn("mt-1.5 text-[11.5px]", invalid ? "text-warning" : "text-ink-secondary")}>
        {invalid ? t("botImages.askAfterInvalid") : t("botImages.askAfterHint")}
      </div>
    </div>
  );
}

/** Bot Settings' "Images" setting: whether this bot asks before it makes an
 * image. The default follows the permission level; the other two override it.
 * An image is only ever made without asking in the owner's own conversations
 * (server/image-approval.ts), whatever is chosen here. */
export function BotImageApproval({
  bot,
  desktop,
  onChoose,
  onAskAfter,
}: {
  bot: Pick<Bot, "imageApproval" | "imageAskAfter">;
  /** this renderer is the desktop app (useDesktopSurface): false on a phone
   * or the browser door, where the server refuses the change */
  desktop?: boolean;
  onChoose: (setting: ImageApprovalSetting) => void;
  onAskAfter: (value: number | null) => void;
}) {
  const current: ImageApprovalSetting = bot.imageApproval === "ask" || bot.imageApproval === "allow" ? bot.imageApproval : "follow";
  const remote = desktop === false;
  const detail = CHOICES.find((choice) => choice.value === current)!.tip;
  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{t("botImages.title")}</div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">{t("botImages.intro")}</div>
      <div className="mt-3 flex flex-col gap-1 rounded-lg bg-inset p-0.5 sm:flex-row" role="radiogroup" aria-label={t("botImages.groupLabel")}>
        {CHOICES.map(({ value, label, tip }) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={current === value}
            disabled={remote}
            title={t(tip)}
            onClick={() => current !== value && onChoose(value)}
            className={cn(
              "min-h-11 flex-1 rounded-md px-2.5 py-1.5 text-[13px] font-medium disabled:cursor-not-allowed",
              current === value ? "bg-raised text-ink" : "text-ink-secondary hover:text-ink disabled:hover:text-ink-secondary",
            )}
          >
            {t(label)}
          </button>
        ))}
      </div>
      <div className="mt-2 text-[12.5px] text-ink-secondary">{t(detail)}</div>
      {remote && <div className="mt-1 text-[12.5px] text-ink-secondary">{t("botImages.desktopOnly")}</div>}
      <AskAfterField key={bot.imageAskAfter ?? "none"} value={bot.imageAskAfter ?? undefined} disabled={remote} onCommit={onAskAfter} />
    </div>
  );
}
