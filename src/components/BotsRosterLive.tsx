// Settings v10 A9-bots (roster): the Bots list's container. It wires the store and the helpers in src/lib/bots-bulk.ts
// and src/lib/archive-review.ts to BotsRosterBody. Loaded lazily by the Bots page: it reads window at import.
import { useCallback, useMemo, useState } from "react";

import { BotsRosterBody } from "@/components/BotsRoster";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { archiveReviewedList, readArchiveReviewBot } from "@/lib/archive-review";
import { applyBulkLevel, commitMoveAll, fetchMoveAllPlan, reviewBulkLevel, type BulkLevelResult, type BulkLevelReview, type MoveAllOutcome } from "@/lib/bots-bulk";
import { autoMountsThisComputer, localAutoHostPlatform } from "@/lib/local-computer";
import type { PermissionMode } from "@/lib/permission-mode";
import { api, fromAnswer, useStore, useStoreActions, type BotAnnouncement } from "@/state/store";
import type { ArchiveReviewBot } from "../../shared/settings-v10/archive-review";
import type { NoLimitsPlan } from "../../shared/settings-v10/no-limits-plan";

const STATE_TEXT: Record<BulkLevelResult["state"], string> = {
  saved: "Saved",
  unchanged: "Already there",
  changed: "Changed since the review. Review again.",
  failed: "Not saved",
};

export default function BotsRosterLive() {
  const { state } = useStore();
  const { dispatch, flushBotPatches } = useStoreActions();
  const { capabilities } = useDesktopCapabilities();
  const hostPlatform = localAutoHostPlatform(capabilities, { harness: state.config?.harness });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [target, setTarget] = useState<PermissionMode>("auto");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Array<{ botId: string; text: string }>>([]);
  const [levelReview, setLevelReview] = useState<BulkLevelReview[] | null>(null);
  const [archiveReview, setArchiveReview] = useState<ArchiveReviewBot[] | null>(null);
  const [moveAll, setMoveAll] = useState<{ plan: NoLimitsPlan; outcome: MoveAllOutcome | null } | null>(null);
  const deps = useMemo(() => ({
    api,
    flush: flushBotPatches,
    onBot: (answer: unknown) => dispatch({ type: "botPatched", ...fromAnswer(answer as BotAnnouncement), bot: answer as BotAnnouncement }),
  }), [dispatch, flushBotPatches]);
  const chosen = useCallback(() => state.bots.filter((bot) => selected.has(bot.id)), [state.bots, selected]);
  const guard = useCallback(async (run: () => Promise<void>) => {
    setBusy(true);
    try { await run(); } catch (cause) { setResults([{ botId: "", text: cause instanceof Error ? cause.message : String(cause) }]); } finally { setBusy(false); }
  }, []);

  return (
    <BotsRosterBody
      bots={state.bots}
      selected={selected}
      onToggle={(id) => setSelected((current) => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; })}
      onClear={() => setSelected(new Set())}
      target={target}
      onTarget={setTarget}
      busy={busy}
      results={results}
      onApply={() => void guard(async () => {
        setResults([]);
        setLevelReview(await reviewBulkLevel(deps, chosen().map((bot) => ({ bot, drivesComputer: autoMountsThisComputer({ platform: hostPlatform, computer: bot.computer }) })), target));
      })}
      levelReview={levelReview}
      onCancelLevel={() => setLevelReview(null)}
      onConfirmLevel={() => void guard(async () => {
        const reviewed = levelReview ?? [];
        setLevelReview(null);
        const done = await applyBulkLevel(deps, reviewed, target, true);
        setResults(done.map((item) => ({ botId: item.botId, text: `${item.name}: ${STATE_TEXT[item.state]}${item.message ? ` ${item.message}` : ""}` })));
      })}
      onArchive={() => void guard(async () => {
        setResults([]);
        setArchiveReview(await Promise.all(chosen().filter((bot) => !bot.hidden).map((bot) => readArchiveReviewBot(bot))));
      })}
      archiveReview={archiveReview}
      onCancelArchive={() => setArchiveReview(null)}
      onConfirmArchive={() => void guard(async () => {
        const reviewed = archiveReview ?? [];
        setArchiveReview(null);
        const done = await archiveReviewedList(reviewed);
        setResults([
          ...done.archived.map((bot) => ({ botId: bot.id, text: `${bot.name}: archived` })),
          ...done.changed.map((bot) => ({ botId: bot.id, text: `${bot.name}: its app choices changed since this review, so it was not archived` })),
          ...done.failed.map((item) => ({ botId: item.bot.id, text: `${item.bot.name}: not archived. ${item.message}` })),
        ]);
        setSelected(new Set());
      })}
      onMoveAll={() => void guard(async () => setMoveAll({ plan: await fetchMoveAllPlan(api), outcome: null }))}
      moveAll={moveAll}
      onCancelMoveAll={() => setMoveAll(null)}
      onConfirmMoveAll={() => void guard(async () => {
        if (!moveAll) return;
        const outcome = await commitMoveAll(api, moveAll.plan);
        setMoveAll({ plan: outcome.kind === "changed" ? outcome.plan : moveAll.plan, outcome });
      })}
    />
  );
}
