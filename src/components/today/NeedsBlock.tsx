// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Today's Needs you block (Today slice 1.0.18, designs/TODAY-SLICE-1104.md sections 2 and 3): Decide, then Worth a
// look, three lines in all. Every row is decided by needsLines (src/lib/today-needs.ts); this only draws them.
//
//   - count not known: "Checking what needs you."
//   - nothing owed and no line: one line with a green dot, no box: "Nothing needs you"
//   - owed but no row read yet: one row that opens Needs you (never "Nothing needs you" while count > 0)
//   - "and {n} more" expands in place to every line Today holds; "Show less" folds it; owed items Today cannot
//     name end the list with "Open Needs you for the rest" (or are the "and {n} more" itself when nothing is hidden)
//   - the Decide label shows only when a Decide line is shown
//
// Seam for Detailed (S4): `mode="all"` draws every line with no cap and no "Show less", the same as the expanded
// Calm state. The caller computes `lines` once with needsLines (`cap` Infinity for Detailed) and passes it here.
// Not drawn on the browser door (TodayView decides): the door has no Needs you read.
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { NeedsLine, NeedsLines } from "@/lib/today-needs";
import { say } from "./say";

const rowButton = "flex min-h-11 w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";
const linkButton = "flex min-h-11 w-full items-center rounded-lg px-2 text-left text-[13px] font-medium text-accent-text hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

export interface NeedsBlockProps {
  needs: NeedsLines;
  /** Calm only: the "and {n} more" state, expanded in place */
  expanded: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  /** "calm" caps at the needsLines cap; "all" (Detailed) draws every line, no "Show less" */
  mode?: "calm" | "all";
  /** the count, for the one row shown while it is known but no row is read yet */
  count: number | undefined;
  /** the count could not be refreshed (`useNeedsSummary().stale`): "Checking what needs you." over the rows as last
   *  read, and a stale zero never reads as "Nothing needs you" */
  stale?: boolean;
  onOpenLine: (line: NeedsLine) => void;
  /** the Needs you door */
  onOpenDoor: () => void;
}

function Row({ line, onOpen }: { line: NeedsLine; onOpen: (line: NeedsLine) => void }) {
  const meta = line.meta ? say(line.meta) : "";
  const detail = line.detail ? say(line.detail) : "";
  return (
    <li>
      <button type="button" className={rowButton} onClick={() => onOpen(line)} data-line={line.kind}>
        <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", line.level === "decide" ? "bg-accent" : "bg-warning")} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] text-ink">{say(line.text)}</span>
          {meta && <span className="block truncate text-[13px] text-ink-secondary">{meta}</span>}
          {detail && <span className="block truncate text-[13px] text-ink-secondary">{detail}</span>}
        </span>
        <span className="shrink-0 rounded-lg border border-hairline/50 px-3 py-1 text-[13px] font-medium text-ink">{say(line.act)}</span>
      </button>
    </li>
  );
}

export function NeedsBlock({ needs, expanded, onExpand, onCollapse, mode = "calm", count, stale = false, onOpenLine, onOpenDoor }: NeedsBlockProps) {
  const title = t("ux.l2a.today.needs.title");
  if (needs.checking || (stale && needs.nothing)) {
    return (
      <section aria-labelledby="today-needs" className="rounded-xl border border-hairline/50 bg-panel p-4">
        <h2 id="today-needs" className="text-[13px] font-semibold text-ink-secondary">{title}</h2>
        <p role="status" className="px-2 py-2 text-[13px] text-ink-secondary">{t("ux.l2a.today.needsChecking")}</p>
      </section>
    );
  }
  if (needs.nothing) {
    // The quiet state: one line, no box.
    return (
      <section aria-labelledby="today-needs" data-needs="quiet" className="flex items-start gap-3 px-2 py-2">
        <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-full bg-success" />
        <span className="min-w-0 flex-1">
          <h2 id="today-needs" className="text-[14px] font-medium text-ink">{t("ux.l2a.today.needs.none")}</h2>
          <span className="block text-[13px] text-ink-secondary">{t("ux.l2a.today.needsEmptySub")}</span>
        </span>
      </section>
    );
  }
  const all = mode === "all" || expanded;
  const shown = all ? needs.all : needs.lines;
  const decide = shown.filter((line) => line.level === "decide");
  const look = shown.filter((line) => line.level === "look");
  // Lines past the cap expand here; owed items Today cannot name go to the door.
  const moreHere = !all && needs.hidden > 0;
  const moreToDoor = !all && needs.hidden === 0 && needs.unnamed > 0 && shown.length > 0;
  const rest = all && needs.rest;
  return (
    <section aria-labelledby="today-needs" data-needs={all ? "all" : "capped"} className="rounded-xl border border-hairline/50 bg-panel p-4">
      <h2 id="today-needs" className="text-[13px] font-semibold text-ink-secondary">{title}</h2>
      {stale && <p role="status" data-needs-stale="" className="px-2 pt-1 text-[13px] text-ink-secondary">{t("ux.l2a.today.needsChecking")}</p>}
      {shown.length === 0 ? (
        // Owed, but no row read yet (or none Today can name): one row to the door. Never "Nothing needs you" here.
        <button type="button" className={rowButton} onClick={onOpenDoor}>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] text-ink">{count === 1 ? t("ux.l2a.tag.needsOne") : t("ux.l2a.tag.needsMany", { n: count ?? needs.unnamed })}</span>
            <span className="block truncate text-[13px] text-ink-secondary">{t("ux.l2a.today.openNeeds")}</span>
          </span>
        </button>
      ) : (
        <>
          {decide.length > 0 && (
            <>
              <h3 className="mt-2 px-2 text-[12px] font-semibold uppercase tracking-wide text-ink-secondary">{t("ux.l2a.today.needs.decide")}</h3>
              <ul>{decide.map((line) => <Row key={line.id} line={line} onOpen={onOpenLine} />)}</ul>
            </>
          )}
          {look.length > 0 && (
            <>
              <h3 className="mt-2 px-2 text-[12px] font-semibold uppercase tracking-wide text-ink-secondary">{t("ux.l2a.today.needs.look")}</h3>
              <ul>{look.map((line) => <Row key={line.id} line={line} onOpen={onOpenLine} />)}</ul>
            </>
          )}
        </>
      )}
      {moreHere && (
        <button type="button" className={linkButton} aria-expanded={false} onClick={onExpand}>{t("ux.l2a.today.needs.more", { n: needs.more })}</button>
      )}
      {moreToDoor && (
        <button type="button" className={linkButton} onClick={onOpenDoor}>{t("ux.l2a.today.needs.more", { n: needs.unnamed })}</button>
      )}
      {rest && (
        <button type="button" className={linkButton} onClick={onOpenDoor}>{t("ux.l2a.today.needs.rest")}</button>
      )}
      {expanded && mode === "calm" && (
        <button type="button" className={linkButton} aria-expanded={true} onClick={onCollapse}>{t("ux.l2a.today.needs.less")}</button>
      )}
    </section>
  );
}
