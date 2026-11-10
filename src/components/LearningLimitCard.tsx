// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Monthly learning limit (usage.learning-limit, was memory.limit; SETTINGS-LOCKED-1019.md 3.16): how much memory learning may
// read and write in a month, in millions of tokens. It reads and saves through the same /api/memory routes the Memory page
// used (`configure` with the learning revision), so nothing about the stored limit changed when the card moved to Usage.
import { useEffect, useState } from "react";
import { learningRequestError } from "@/lib/memory-learning-text";
import { ceilingPercent } from "@/lib/learning-limit";
import { formatTokens, requestLearningAction, type MemoryLearning } from "@/lib/memory-learning";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { useAction } from "@/lib/use-action";
import { useDesktopSurface } from "@/lib/use-surface";
import { api } from "@/state/store";
import { ActionButton } from "./ActionButton";
import { Card } from "./SettingsPrimitives";
import { ComputerOnlyStub } from "./SettingsStub";

const button = "min-h-11 rounded-lg border border-hairline/40 px-3 py-2 text-[13px] text-ink hover:bg-control focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50";
const field = "w-full min-h-11 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink focus-visible:ring-2 focus-visible:ring-accent-border";
const millions = (tokens: number) => String(Math.round(tokens / 100_000) / 10);
const parseMillions = (text: string): number | null => { const n = Number(text); return text.trim() !== "" && Number.isFinite(n) && n >= 0 && n <= 1_000_000 ? Math.round(n * 1_000_000) : null; };

type Ceiling = NonNullable<MemoryLearning["ceiling"]>;

/** Change the monthly limit: two numbers in millions of tokens. */
function CeilingEditor({ ceiling, blocked, onSave, onCancel }: { ceiling: { input: number; output: number }; blocked: boolean; onSave: (next: { input: number; output: number }) => Promise<unknown>; onCancel: () => void }) {
  const [read, setRead] = useState(millions(ceiling.input)), [written, setWritten] = useState(millions(ceiling.output));
  const input = parseMillions(read), output = parseMillions(written), valid = input !== null && output !== null;
  const save = useAction(async () => { await onSave({ input: input!, output: output! }); onCancel(); }, { idle: t("memoryPage.ceiling.save"), pending: t("memoryPage.saving"), success: t("memoryPage.ceiling.saved"), failure: t("memoryPage.didNotWork"), slowHint: t("memoryPage.stillSaving") });
  // Refresh replaces the server snapshot, never either draft field or the editor itself.
  const dismiss = save.dismiss;
  useEffect(() => { dismiss(); }, [ceiling, dismiss]);
  return (
    <div className="mt-3 space-y-3 rounded-lg border border-hairline/40 p-3 text-[13px]">
      <div>
        <label className="block space-y-1">{t("memoryPage.ceiling.readLabel")}<input className={field} inputMode="decimal" aria-describedby="memory-limit-read-current" value={read} onChange={(event) => setRead(event.target.value)} /></label>
        <p id="memory-limit-read-current" className="text-[12px] text-ink-secondary">{t("settings.usage.savedLimit" as LocaleKey, { limit: millions(ceiling.input) })}</p>
      </div>
      <div>
        <label className="block space-y-1">{t("memoryPage.ceiling.writtenLabel")}<input className={field} inputMode="decimal" aria-describedby="memory-limit-written-current" value={written} onChange={(event) => setWritten(event.target.value)} /></label>
        <p id="memory-limit-written-current" className="text-[12px] text-ink-secondary">{t("settings.usage.savedLimit" as LocaleKey, { limit: millions(ceiling.output) })}</p>
      </div>
      {!valid && <p role="status" className="text-[12px] text-ink-secondary">{t("memoryPage.ceiling.invalid")}</p>}
      {valid && (input === 0 || output === 0) && <p role="status" className="text-[12px] text-ink-secondary">{t("memoryPage.ceiling.zero")}</p>}
      <div className="flex flex-wrap items-start gap-2">
        <ActionButton action={{ ...save, error: blocked || !valid ? null : save.error }} blocked={blocked || !valid} retryLabel={t("providerError.retry")} className={button}>{t("memoryPage.ceiling.save")}</ActionButton>
        <button type="button" className={button} onClick={onCancel}>{t("memoryPage.cancel")}</button>
      </div>
    </div>
  );
}

export function LearningLimitCard() {
  const desktop = useDesktopSurface();
  const [learning, setLearning] = useState<MemoryLearning | null>(null), [failed, setFailed] = useState(false), [editing, setEditing] = useState(false), [conflict, setConflict] = useState(false);
  const [loading, setLoading] = useState(true), [readVersion, setReadVersion] = useState(0);
  const refresh = () => { setLoading(true); setFailed(false); setReadVersion((version) => version + 1); };
  useEffect(() => {
    if (desktop !== true) return;
    const controller = new AbortController();
    api("/api/memory/status", { signal: controller.signal })
      .then((status) => {
        if (controller.signal.aborted) return;
        const next = (status as { learning?: MemoryLearning } | null)?.learning;
        if (!next?.ceiling) throw new Error("Missing learning limits");
        setLearning(next);
        setFailed(false);
        setConflict(false);
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [desktop, readVersion]);
  if (desktop !== true) return <ComputerOnlyStub anchor="memory-limit-heading" />;
  const ceiling: Ceiling | undefined = learning?.ceiling;
  const rows = ceiling ? ([[t("memoryPage.limit.read"), ceiling.inputUsed, ceiling.input], [t("memoryPage.limit.written"), ceiling.outputUsed, ceiling.output]] as const) : [];
  const save = async (next: { input: number; output: number }) => {
    if (!learning || loading || failed) throw new Error(t("memoryPage.loadFailed"));
    if (conflict) throw new Error(t("memoryPage.conflict"));
    try {
      const answer = await requestLearningAction(api, { action: "configure", ceiling: next, learningRevision: learning.revision }) as { learning?: MemoryLearning } | null;
      if (answer?.learning) setLearning(answer.learning);
      setConflict(false);
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes("MEMORY_LEARNING_REVISION_CONFLICT")) setConflict(true);
      throw new Error(learningRequestError(cause));
    }
  };
  return (
    <Card title={t("memoryPage.limit.title")} subtitle={t("memoryPage.limit.note")}>
      {loading && <p role="status" className="text-[13px] text-ink-secondary">{t("memoryPage.settingsLoading")}</p>}
      {failed && <div className="space-y-2">
        <p role="alert" className="text-[13px] text-ink-secondary">{t("memoryPage.loadFailed")}</p>
        <button type="button" className={button} disabled={loading} onClick={refresh}>{t("providerError.retry")}</button>
      </div>}
      {ceiling && (
        <div className="space-y-2 text-[13px]">
          {rows.map(([name, used, limit]) => (
            <div key={name}>
              <p>{t("memoryPage.limit.row", { name, used: formatTokens(used), limit: formatTokens(limit) })}{" "}<span className="text-ink-secondary">{ceilingPercent(used, limit)}%</span></p>
              <progress aria-label={t("memoryPage.limit.thisMonth", { name })} className="h-2 w-full accent-accent" max={100} value={ceilingPercent(used, limit)} />
            </div>
          ))}
          <p className="text-[12px] text-ink-secondary">{t("memoryPage.limit.reset")}</p>
          {conflict && <div className="space-y-2">
            <p role="alert" className="text-[12px] text-warning">{t("memoryPage.conflict")}</p>
            <button type="button" className={button} disabled={loading} onClick={refresh}>{t("memoryPage.refresh")}</button>
          </div>}
          {!editing
            ? <button type="button" data-setting-control="memory-limit-heading" className={button} onClick={() => setEditing(true)}>{t("memoryPage.limit.change")}</button>
            : <CeilingEditor ceiling={ceiling} blocked={conflict || loading || failed} onCancel={() => setEditing(false)} onSave={save} />}
        </div>
      )}
    </Card>
  );
}
