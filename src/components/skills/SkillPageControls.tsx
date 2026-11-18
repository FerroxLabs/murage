import type { SkillPagination } from "../../../shared/skill-pagination";

/** Shared by Browse templates, Settings, and the bot's skill picker. */
export function SkillPageControls({ page, busy, onPage }: {
  page: SkillPagination; busy: boolean; onPage(offset: number): void;
}) {
  const end = Math.min(page.offset + page.limit, page.total);
  const button = "min-h-11 rounded-lg bg-control px-3 text-[12px] text-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-focus";
  return <nav aria-label="Skill pages" aria-busy={busy} className="mt-3 flex flex-wrap items-center gap-2">
    <p role="status" className="mr-auto text-[12px] text-ink-secondary">{page.total ? `${page.offset + 1}–${end}` : "0"} of {page.total} {page.total === 1 ? "skill" : "skills"}</p>
    {page.total > page.limit && <>
      <button type="button" aria-label="Previous page" disabled={busy || page.offset === 0} onClick={() => onPage(Math.max(0, page.offset - page.limit))} className={button}>Previous</button>
      <button type="button" aria-label="Next page" disabled={busy || end >= page.total} onClick={() => onPage(page.offset + page.limit)} className={button}>Next</button>
    </>}
  </nav>;
}
