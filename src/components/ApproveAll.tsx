// SPDX-License-Identifier: AGPL-3.0-or-later
// Approve all on Inbox > Approvals (APPROVE-ALL-1016 rev 3 sections 3, 4 and 5). The button shows only where the server's
// owner-app check says so (the desktop app or the owner's phone app, never a browser), and only when 2 or more cards
// qualify. Press: the first-use caution until dismissed (a shared owner pref), then the confirm sheet frozen from the
// server's preview, then one result line. Nothing here decides eligibility.
import { useEffect, useRef, useState } from "react";
import { api, useStoreIfAny } from "@/state/store";
import { t } from "@/lib/i18n";
import { BotAvatar } from "./Avatar";
import { applyApproveAll, batchReason, cardDetail, groupByBot, kindLine, previewGate, reasonLine, resultLine, tickedCards, type ApplyResult, type ApproveAllPreview, type ApproveAllSurface, type EligibleCard } from "@/lib/approve-all";

const button = "min-h-11 rounded-lg px-3 py-1.5 text-[13px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60";

/** The server's answer to "does this surface show Approve all", read once per mount. Any failure reads as hidden. */
export function useApproveAllSurface(revision = 0): [ApproveAllSurface, (dismissed: boolean) => Promise<void>] {
  const [surface, setSurface] = useState<ApproveAllSurface>({ show: false });
  useEffect(() => {
    let live = true;
    api("/api/inbox/approve-all/surface", { method: "POST", body: "{}" })
      .then((value: ApproveAllSurface) => { if (live) setSurface(value?.show === true ? value : { show: false }); })
      .catch(() => { if (live) setSurface({ show: false }); });
    return () => { live = false; };
  }, [revision]);
  const setDismissed = async (dismissed: boolean) => {
    const value = await api("/api/inbox/approve-all/caution", { method: "POST", body: JSON.stringify({ dismissed }) }) as { cautionDismissed?: boolean };
    setSurface((current) => ({ ...current, cautionDismissed: value?.cautionDismissed === true }));
  };
  return [surface, setDismissed];
}

type Step = { at: "idle" } | { at: "caution" } | { at: "sheet"; preview: ApproveAllPreview } | { at: "result"; line: string };

export function ApproveAllButton({ eligibleHint, onApplied }: { /** Approval rows listed now; under 2 the button stays away without asking. */ eligibleHint: number; onApplied: () => void }) {
  const [surface, setDismissed] = useApproveAllSurface();
  const [step, setStep] = useState<Step>({ at: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const gate = useRef(previewGate()).current;
  const store = useStoreIfAny();
  const bots = store?.state.bots ?? [];
  const botOf = (id?: string) => bots.find((bot) => bot.id === id);
  const botName = (id?: string) => botOf(id)?.name ?? t("approveAll.botFallback");
  if (!surface.show || (eligibleHint < 2 && step.at === "idle")) return null;

  // Single flight (review H2): a second Continue while a preview loads does nothing, and a preview (or its failure)
  // that lands after a sign started, or after a newer preview, is dropped and never touches the sheet.
  const openSheet = async () => {
    const token = gate.begin();
    if (token === null) return;
    setError(null);
    setBusy(true);
    try {
      const preview = await api("/api/inbox/approve-all/preview", { method: "POST", body: "{}" }) as ApproveAllPreview;
      if (gate.accepts(token)) setStep({ at: "sheet", preview });
    } catch (e) {
      if (!gate.accepts(token)) return;
      setError(e instanceof Error ? e.message : String(e));
      setStep({ at: "idle" });
    } finally {
      if (!gate.signing) setBusy(false);
    }
  };
  const press = () => (surface.cautionDismissed ? void openSheet() : setStep({ at: "caution" }));

  return <div className="mt-3">
    {(step.at === "idle" || (step.at === "result" && eligibleHint >= 2)) && <button type="button" className={`${button} bg-accent text-on-accent`} disabled={busy} onClick={press}>{t("approveAll.button")}</button>}
    {error && <p role="alert" className="mt-2 text-[13px] text-danger">{error}</p>}
    {step.at === "caution" && <Caution busy={busy} onReview={() => setStep({ at: "idle" })} onContinue={async (dontShow) => {
      if (dontShow) { try { await setDismissed(true); } catch { /* the caution simply shows again next time */ } }
      await openSheet();
    }} />}
    {step.at === "sheet" && <ApproveAllSheet preview={step.preview} detailed={surface.app === "phone"} botName={botName} botOf={botOf} busy={busy} onCancel={() => setStep({ at: "idle" })} onApprove={async (cards, names) => {
      if (!gate.sign()) return;
      const preview = step.preview;
      setBusy(true);
      setError(null);
      try {
        const done = await applyApproveAll(
          (body) => api("/api/inbox/approve-all/apply", { method: "POST", body: JSON.stringify(body) }) as Promise<{ approved: number; results: ApplyResult[] }>,
          preview, cards, batchReason(cards.length, names));
        const threadBot = new Map(preview.eligible.map((card) => [card.threadId, card.botId]));
        setStep({ at: "result", line: resultLine(done.results, (threadId) => botName(threadBot.get(threadId))) });
        onApplied();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (message) setError(message);
        if ((e as { code?: string })?.code !== "cancelled") setStep({ at: "idle" });
      } finally {
        gate.done();
        setBusy(false);
      }
    }} />}
    {step.at === "result" && <p role="status" className="text-[13px] text-ink">{step.line}</p>}
  </div>;
}

function Caution({ busy, onReview, onContinue }: { busy: boolean; onReview: () => void; onContinue: (dontShow: boolean) => void }) {
  const [dontShow, setDontShow] = useState(false);
  return <div role="dialog" aria-modal="true" aria-labelledby="approve-all-caution" className="mt-3 rounded-xl bg-card p-4">
    <h2 id="approve-all-caution" className="text-[15px] font-semibold">{t("approveAll.caution.title")}</h2>
    <p className="mt-2 text-[13px] text-ink-secondary">{t("approveAll.caution.look")}</p>
    <p className="mt-2 text-[13px] text-ink-secondary">{t("approveAll.caution.leavesOut")}</p>
    <label className="mt-3 flex min-h-11 items-center gap-2 text-[13px]"><input type="checkbox" checked={dontShow} onChange={(e) => setDontShow(e.target.checked)} />{t("approveAll.caution.dontShow")}</label>
    <div className="mt-3 flex justify-end gap-2">
      <button type="button" className={`${button} bg-inset text-ink`} onClick={onReview}>{t("approveAll.caution.review")}</button>
      <button type="button" className={`${button} bg-accent text-on-accent`} disabled={busy} onClick={() => onContinue(dontShow)}>{t("approveAll.caution.continue")}</button>
    </div>
  </div>;
}

/** The confirm sheet. On the phone (detailed) every card it will sign is listed with its tool, subtitle, summary and
 *  held line, and Approve hands over those same card objects, so what is signed is what is on screen (design 7.3). Ticks
 *  lock while a sign is in flight (review H2). */
export function ApproveAllSheet({ preview, detailed = false, botName, botOf, busy, onCancel, onApprove }: {
  preview: ApproveAllPreview; detailed?: boolean; botName: (id?: string) => string; botOf: (id?: string) => Parameters<typeof BotAvatar>[0]["bot"] | undefined; busy: boolean;
  onCancel: () => void; onApprove: (cards: EligibleCard[], botNames: string[]) => void;
}) {
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(() => new Set());
  const groups = groupByBot(preview.eligible);
  const ticked = tickedCards(preview.eligible, unticked);
  const toggle = (botId: string) => busy ? undefined : setUnticked((current) => {
    const next = new Set(current);
    if (next.has(botId)) next.delete(botId); else next.add(botId);
    return next;
  });
  const names = groups.filter((group) => !unticked.has(group.botId)).map((group) => botName(group.botId || undefined));
  return <div role="dialog" aria-modal="true" aria-labelledby="approve-all-sheet" className="mt-3 rounded-xl bg-card p-4">
    <h2 id="approve-all-sheet" className="text-[15px] font-semibold">{t(ticked.length === 1 ? "approveAll.sheet.title.one" : "approveAll.sheet.title.other", { n: ticked.length })}</h2>
    {preview.more > 0 && <p className="mt-1 text-[13px] text-ink-secondary">{t("approveAll.sheet.more")}</p>}
    <ul className="mt-3 space-y-2">
      {groups.map((group) => {
        const bot = botOf(group.botId || undefined);
        return <li key={group.botId || "none"} className="flex items-start gap-3">
          <input type="checkbox" className="mt-2" aria-label={botName(group.botId || undefined)} checked={!unticked.has(group.botId)} disabled={busy} onChange={() => toggle(group.botId)} />
          {bot && <BotAvatar bot={bot} size={28} />}
          <div className="text-[13px]">
            <div className="font-medium">{botName(group.botId || undefined)} ({group.requestIds.length})</div>
            {group.kinds.map((kind) => <div key={kind.kind} className="text-ink-secondary">{kindLine(kind.kind, kind.n)}</div>)}
            {detailed && <ul data-testid="approve-all-cards" className="mt-1 space-y-2">
              {preview.eligible.filter((card) => (card.botId ?? "") === group.botId).map((card) => {
                const detail = cardDetail(card);
                return <li key={`${card.threadId}:${card.requestId}`} data-request-id={card.requestId} data-digest={card.digest} className="space-y-1 text-[12.5px] text-ink">
                  {detail.tool && <p className="font-mono text-[12px] text-ink-secondary">{detail.tool}</p>}
                  {detail.subtitle && <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-control p-2 font-mono text-[12px]">{detail.subtitle}</pre>}
                  {detail.summary && <p className="break-words">{detail.summary}</p>}
                  {detail.held && <p className="break-words text-ink-secondary">{detail.held}</p>}
                </li>;
              })}
            </ul>}
          </div>
        </li>;
      })}
    </ul>
    {preview.excluded.length > 0 && <div className="mt-4">
      <div className="text-[13px] font-medium">{t("approveAll.sheet.stays", { n: preview.excluded.length })}</div>
      <ul className="mt-1 space-y-1">
        {preview.excluded.map((card) => <li key={`${card.threadId}:${card.requestId}`} className="text-[13px] text-ink-secondary">
          {botName(card.botId)}: {card.summary} <span className="text-ink-tertiary">({reasonLine(card.reasonKey)})</span>
        </li>)}
      </ul>
    </div>}
    <p className="mt-4 text-[12px] text-ink-secondary">{t("approveAll.sheet.footer")}</p>
    <div className="mt-3 flex justify-end gap-2">
      <button type="button" className={`${button} bg-inset text-ink`} disabled={busy} onClick={onCancel}>{t("approveAll.sheet.cancel")}</button>
      <button type="button" className={`${button} bg-accent text-on-accent`} disabled={busy || ticked.length === 0 || !preview.batchId} onClick={() => onApprove(ticked, names)}>{t("approveAll.sheet.approve", { n: ticked.length })}</button>
    </div>
  </div>;
}

/** Settings > Approvals: bring the caution back, on the surfaces that can press Approve all and only once it was hidden. */
export function ApproveAllReminderReset() {
  const [surface, setDismissed] = useApproveAllSurface();
  const [done, setDone] = useState(false);
  if (!surface.show || (!surface.cautionDismissed && !done)) return null;
  return <div className="mt-3 text-[13px]">
    {done ? <span role="status" className="text-ink-secondary">{t("approveAll.settings.done")}</span>
      : <button type="button" className={`${button} bg-inset text-ink`} onClick={() => void setDismissed(false).then(() => setDone(true), () => undefined)}>{t("approveAll.settings.reset")}</button>}
  </div>;
}
