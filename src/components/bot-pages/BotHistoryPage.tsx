// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 B0: moved out of SettingsPanel.tsx verbatim (behaviour unchanged).
import { t } from "@/lib/i18n";
import { allHeldTasks } from "@/lib/task-window";
import { SettingsSection } from "./section";
import type { BotPanelCtx } from "./context";

export function HistoryPart({ ctx }: { ctx: BotPanelCtx }) {
  const { bot, section, olderHistory, dispatch } = ctx;
  return (
    <>
          <SettingsSection id="history" active={section}>
          <div id="bot-setting-history" data-setting="bot.history.history" className="space-y-4">
          {allHeldTasks(bot).map(task => <button type="button" key={task.threadId} onClick={() => dispatch({ type: "switchTask", botId: bot.id, threadId: task.threadId })} className="block min-h-10 w-full rounded-xl bg-card p-4 text-left">
            <p className="text-[14px] font-medium">{task.title}</p><p className="mt-1 text-[12px] text-ink-secondary">{new Date(task.createdAt).toLocaleString()}{task.threadId === bot.threadId ? ` · ${t("settings.bot.history.current")}` : ""}</p>
          </button>)}
          {!bot.tasks?.length && <p className="text-[13px] text-ink-secondary">{t("settings.bot.history.none")}</p>}
          {olderHistory.hasMore && <button type="button" disabled={olderHistory.loading} onClick={olderHistory.loadMore} className="block min-h-10 w-full rounded-xl bg-control px-3 py-2 text-left text-[13px] disabled:opacity-60">{olderHistory.loading ? t("settings.bot.history.loadingOlder") : t("settings.bot.history.showOlder")}</button>}
          {olderHistory.failed && !olderHistory.loading && <p role="alert" className="text-[13px] text-danger">{t("settings.bot.history.loadFailed")}</p>}
          </div>
          </SettingsSection>
    </>
  );
}
