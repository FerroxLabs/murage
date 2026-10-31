// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// UX-TRUST-MOMENTS-1012 3.2: the level menu's example table, rendered from
// LEVEL_EXAMPLES (shared/level-examples.ts), the same constant the reader
// lane checks against the verdict. Every cell is for a turn with nothing
// said yes to before. Shown in the chat chip's menu and in Settings › Level;
// `only` shows one level's column (the phone sheet's picked level).
import { LEVEL_EXAMPLES, type LevelId } from "../../../shared/level-examples";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { cn } from "@/lib/cn";
import { levelName } from "@/lib/fold-words";

export function LevelExamples({ only, current, className }: { only?: LevelId; current?: LevelId; className?: string }) {
  const levels = only ? [only] : [...LEVEL_EXAMPLES.levels];
  const cell = (value: "asks" | "goes-ahead") => (value === "asks" ? t("ux.l1.level.asks") : t("ux.l1.level.goesAhead"));
  return (
    <div data-level-examples className={cn("text-[12px] text-ink", className)}>
      <table className="w-full border-collapse text-left">
        <caption className="pb-1 text-left text-[12px] font-medium text-ink-secondary">{t("ux.l1.level.tableHeading")}</caption>
        <thead>
          <tr>
            <th scope="col" className="py-1 pr-2 font-normal text-ink-secondary">{t("ux.l1.level.whatColumn")}</th>
            {levels.map((level) => (
              <th key={level} scope="col" className={cn("px-1 py-1 font-normal text-ink-secondary", current === level && "font-medium text-ink")}>{levelName(level)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {LEVEL_EXAMPLES.owner.map((row) => (
            <tr key={row.id} data-level-row={row.id} className="border-t border-hairline/20 align-top">
              <th scope="row" className="py-1 pr-2 font-normal">{t(`ux.l1.level.row.${row.id}` as LocaleKey)}</th>
              {levels.map((level) => (
                <td key={level} data-cell={row.cells[level]} className={cn("px-1 py-1", row.cells[level] === "asks" ? "text-warning" : "text-ink-secondary")}>{cell(row.cells[level])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <table className="mt-2 w-full border-collapse text-left">
        <caption className="pb-1 text-left text-[12px] font-medium text-ink-secondary">{t("ux.l1.level.otherHeading")}</caption>
        <thead>
          <tr>
            <th scope="col" className="py-1 pr-2 font-normal text-ink-secondary">{t("ux.l1.level.whatColumn")}</th>
            <th scope="col" className="px-1 py-1 font-normal text-ink-secondary">{t("ux.l1.level.ordinaryColumn")}</th>
            <th scope="col" className="px-1 py-1 font-normal text-ink-secondary">{t("ux.l1.level.stopColumn")}</th>
          </tr>
        </thead>
        <tbody>
          {LEVEL_EXAMPLES.other.map((row) => {
            const level = only ?? current ?? "auto";
            return (
              <tr key={row.id} data-level-other={row.id} className="border-t border-hairline/20 align-top">
                <th scope="row" className="py-1 pr-2 font-normal">
                  {t(`ux.l1.level.other.${row.id}` as LocaleKey)}
                  {row.notes.map((note) => <div key={note} className="text-[11.5px] text-ink-secondary">{t(`ux.l1.level.note.${note}` as LocaleKey)}</div>)}
                </th>
                <td className="px-1 py-1 text-ink-secondary">{t(`ux.l1.level.cell.${row.ordinary[level]}` as LocaleKey)}</td>
                <td className="px-1 py-1 text-ink-secondary">{t(`ux.l1.level.cell.${row.stopLine[level]}` as LocaleKey)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-[12px] text-ink-secondary">{t("ux.l1.level.underTable")}</p>
    </div>
  );
}
