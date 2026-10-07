// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { localeVersion, subscribeLocale, t } from "@/lib/i18n";
import { memo, useId, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from "react";
import type { ProjectCard } from "@/lib/project-client";
import type { CardFace, OwnerAction } from "@/lib/project-board";
import type { Bot } from "@/state/store";
import { BotAvatar } from "./Avatar";
import { BOARD_BUTTON } from "./ProjectBoardDialog";
export const ProjectBoardCard = memo(function ProjectBoardCard({ card, face, bot, readOnly, onOpen, onAction, onGoal, onKeyDown, onPointerDown }: {
  card: ProjectCard; face: CardFace; bot?: Bot; readOnly: boolean;
  onOpen: (id: string) => void; onAction: (id: string, action: OwnerAction) => void; onGoal?: () => void;
  onKeyDown?: (e: KeyboardEvent<HTMLButtonElement>, card: ProjectCard) => void;
  onPointerDown?: (e: PointerEvent<HTMLButtonElement>, card: ProjectCard) => void;
}) {
  // memo skips a render when the props are equal, so the card listens for a language change itself.
  useSyncExternalStore(subscribeLocale, localeVersion, localeVersion);
  const titleId = useId(), detailsId = useId(), assigneeId = useId();
  return <article data-card-box={card.id} className="project-board-card min-w-0 rounded-lg border border-hairline/40 bg-card text-ink">
    <button type="button" data-board-card={card.id} aria-roledescription="card" aria-labelledby={titleId} aria-describedby={`${assigneeId} ${detailsId} board-drag-instructions`} onClick={() => onOpen(card.id)} onKeyDown={e => onKeyDown?.(e, card)} onPointerDown={e => onPointerDown?.(e, card)} className="block w-full min-w-0 space-y-2 rounded-lg p-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
      <span id={assigneeId} className="flex min-w-0 items-center gap-2">{bot && face.avatarId && <BotAvatar bot={bot} size={24} />}<span className="min-w-0 break-words text-xs text-ink-secondary">{face.assignee}</span></span>
      <span id={titleId} className="block break-words text-sm font-medium"><span className="sr-only">{t("projects.common.cardLabel",{number:card.number ?? ""})}: </span>{card.title}</span>
      <span id={detailsId} className="block space-y-2">
      <span className="flex flex-wrap gap-2 text-xs"><span className={face.failed ? "text-danger font-semibold" : "text-ink-secondary"}>{face.state}</span><span>#{card.number}</span><span>{face.time}</span></span>
      <span className="block text-xs text-ink-secondary">{face.work}{face.tokens ? ` · ${face.tokens}` : ""}</span>
      {face.reason && <span className="block break-words text-xs">{face.reason}</span>}
      <span className="flex flex-wrap gap-2 text-xs">{face.review && <span>{t("projects.boardCard.review")}</span>}{face.depends > 0 && <span>{t("projects.boardCard.dependsOn",{count:face.depends})}</span>}{face.queued && <span>{t("projects.boardCard.queued")}</span>}{face.dependency && <span>{face.dependency}</span>}</span>
      </span>
    </button>
    <button type="button" aria-label={t("projects.boardCard.openDetails",{number:card.number ?? ""})} onClick={() => onOpen(card.id)} className="min-h-11 w-full px-3 text-left text-xs underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">{t("projects.boardCard.details")}</button>
    {face.goalTitle && <button type="button" onClick={onGoal} className="min-h-11 w-full break-words px-3 text-left text-xs underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">{face.goalTitle}</button>}
    {!readOnly && face.failed && <div className="flex flex-wrap gap-2 px-3 pb-3">{card.assigneeBotId && <button type="button" className={BOARD_BUTTON} onClick={() => onAction(card.id, "retry")}>{t("projects.boardCard.retry")}</button>}<button type="button" className={BOARD_BUTTON} onClick={() => onAction(card.id, "reassign")}>{t("projects.common.reassign")}</button></div>}
  </article>;
});
