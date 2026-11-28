// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 B2-page: the bot's "Archive or delete" block. Archive comes first; with saved app choices it goes
// through roster's ConfirmClearsAppChoices review (src/lib/archive-review.ts), which sends the reviewed accessRevision.
import { useState } from "react";
import { t } from "@/lib/i18n";
import { newDeleteAttempt, useStore, type Bot, type DeleteOutcome } from "@/state/store";
import { ConfirmDelete } from "../ConfirmDelete";
import { archiveReviewed, openArchiveReview, readArchiveReviewBot } from "@/lib/archive-review";
import type { ArchiveReviewBot, ArchiveReviewOutcome } from "../../../shared/settings-v10/archive-review";

interface ArchiveSteps {
  read: (bot: { id: string; name: string }) => Promise<ArchiveReviewBot>;
  review: (bot: ArchiveReviewBot) => Promise<ArchiveReviewOutcome>;
  archive: (bot: ArchiveReviewBot) => Promise<{ outcome: "archived" | "conflict" }>;
}

export const defaultArchiveSteps: ArchiveSteps = { read: (b) => readArchiveReviewBot(b), review: (b) => openArchiveReview(b), archive: (b) => archiveReviewed(b) };

/** Read the bot's saved choices; open the review when it has any, otherwise archive in one click. Both send the revision read. */
export async function archiveFromProfile(
  bot: { id: string; name: string },
  steps: ArchiveSteps = defaultArchiveSteps,
): Promise<ArchiveReviewOutcome> {
  const current = await steps.read(bot);
  if (current.savedChoices.length > 0 || current.hasSavedPolicy) return steps.review(current);
  return (await steps.archive(current)).outcome;
}

export function ArchiveOrDeleteRow({ bot }: { bot: Pick<Bot, "id" | "name"> }) {
  const { dispatch } = useStore();
  const [note, setNote] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const archive = () => {
    if (archiving) return;
    setNote(null);
    setArchiving(true);
    archiveFromProfile(bot).then(
      (outcome) => setNote(outcome === "conflict" ? t("ux.botpages.archive.conflict", { name: bot.name }) : outcome === "archived" ? t("ux.botpages.archive.done", { name: bot.name }) : null),
      (cause) => setNote(cause instanceof Error ? cause.message : String(cause)),
    ).finally(() => setArchiving(false));
  };
  const remove = async (emailConfirm?: string) => {
    setConfirmingDelete(false);
    const result = await new Promise<DeleteOutcome>((resolve) => dispatch({ type: "deleteBot", source: "local", botId: bot.id, attempt: newDeleteAttempt(), ...(emailConfirm !== undefined ? { emailConfirm } : {}), onSettled: resolve }));
    if (result.outcome !== "deleted") setNote(result.error ?? t("ux.botpages.delete.failed", { name: bot.name }));
  };
  return (
    <div id="bot-setting-archive" data-setting="bot.identity.archive" className="space-y-3 rounded-xl bg-card p-3">
      <div>
        <h3 className="text-[13px] font-medium text-ink">{t("ux.botpages.archive.title")}</h3>
        <div className="mt-2 flex items-start justify-between gap-3">
          <p className="text-[12px] leading-relaxed text-ink-secondary">
            <strong className="font-medium text-ink">{t("ux.botpages.archive.lead", { name: bot.name })}</strong> {t("ux.botpages.archive.body", { name: bot.name })}
          </p>
          <button type="button" className="shrink-0 rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px]" disabled={archiving} onClick={archive}>{t("ux.botpages.archive.button")}</button>
        </div>
        <div className="mt-3 flex items-start justify-between gap-3">
          <p className="text-[12px] leading-relaxed text-ink-secondary">
            <strong className="font-medium text-ink">{t("ux.botpages.delete.lead", { name: bot.name })}</strong> {t("ux.botpages.delete.body", { name: bot.name })}
          </p>
          <button type="button" className="shrink-0 rounded-lg border border-hairline/40 px-3 py-1.5 text-[13px]" onClick={() => setConfirmingDelete(true)}>{t("ux.botpages.delete.button")}</button>
        </div>
        {note ? <p role="alert" className="mt-2 text-[12px] text-ink-secondary">{note}</p> : null}
      </div>
      {confirmingDelete ? (
        <ConfirmDelete
          name={bot.name}
          kind="bot"
          preview={{ botId: bot.id }}
          detail={`${bot.name}, its chats, memory and routines are removed for good. A backup is the only way back.`}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={(options) => void remove(options?.emailConfirm)}
        />
      ) : null}
    </div>
  );
}
