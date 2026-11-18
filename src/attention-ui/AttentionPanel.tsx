// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { localeVersion, subscribeLocale, t } from "@/lib/i18n";
import { AttentionCard, refusalMessage } from "./AttentionCard";
import { cleanAttentionText, type AttentionResult } from "./bridge";
import { useAttentionItems } from "./useAttentionItems";
import "./attention-panel.css";

/** Shared by attention entries. All privileged effects use the narrow bridge.
 * Other kinds may omit tray controls; the IPC gate remains the authority. */
export function AttentionPanel({ trayControls = true }: { trayControls?: boolean }) {
  useSyncExternalStore(subscribeLocale, localeVersion, localeVersion);
  const { data, refreshing, failed, stalled, drafts, refresh, setDraft, clearDraft } = useAttentionItems("panel");
  const [error, setError] = useState("");
  const [text, setText] = useState(""), [busy, setBusy] = useState(false), [status, setStatus] = useState("");
  const sending = useRef(false);
  const chiefId = useId(), needsId = useId(), runningId = useId(), receiptsId = useId();
  useEffect(() => {
    if (!data) { setText(""); setStatus(""); setError(""); }
  }, [data]);
  const run = async (effect: () => Promise<AttentionResult>, done: () => void) => {
    if (sending.current || refreshing || !data) return;
    sending.current = true; setBusy(true); setError(""); setStatus("");
    try {
      const result = await effect();
      if (result.ok) done(); else setError(refusalMessage(result.reason));
    } catch { setError(refusalMessage()); } finally { sending.current = false; setBusy(false); }
  };
  const chiefText = cleanAttentionText(text);
  return <main className="attention-panel" aria-label={t("trayPanel.title")}>
    <section aria-labelledby={needsId}>
      <h2 id={needsId}>{t("trayPanel.needsYou")}</h2>
      {!data ? <p>{t("trayPanel.loading")}</p> : data.items[0]
        ? <AttentionCard key={data.items[0].cardId} item={data.items[0]} refreshing={refreshing || stalled} onAnswered={() => void refresh()}
          draft={drafts[data.items[0].cardId]} onDraft={next => next ? setDraft(data.items[0]!.cardId, next) : clearDraft(data.items[0]!.cardId)} />
        : <p className="attention-secondary">{t("trayPanel.noRequests")}</p>}
    </section>
    <section aria-labelledby={runningId}>
      <h2 id={runningId}>{t("trayPanel.running")}</h2>
      {data?.running.length ? <ul>{data.running.map((row, index) => <li key={index}>{row.botName}<p className="attention-secondary">{row.doing}</p></li>)}</ul>
        : <p className="attention-secondary">{t("trayPanel.empty")}</p>}
    </section>
    <section aria-labelledby={receiptsId}>
      <h2 id={receiptsId}>{t("trayPanel.receipts")}</h2>
      {data?.receipts.length ? <ul>{data.receipts.slice(-3).map((row, index) => <li key={index}>{row.text}</li>)}</ul>
        : <p className="attention-secondary">{t("trayPanel.empty")}</p>}
    </section>
    {trayControls && <form onSubmit={event => {
      event.preventDefault(); const bridge = window.attentionWindow;
      if (bridge && data?.chief && chiefText.length >= 1 && chiefText.length <= 4000)
        void run(() => bridge.sendToChief(chiefText), () => { setText(""); setStatus(t("trayPanel.sent")); });
    }}>
      <label htmlFor={chiefId}>{t("trayPanel.talkChief")}</label>
      <input id={chiefId} type="text" value={text} maxLength={4000} disabled={refreshing || busy || !data?.chief} onChange={event => setText(event.target.value)} />
      <button type="submit" disabled={refreshing || busy || !data?.chief || chiefText.length === 0 || chiefText.length > 4000}>{t("trayPanel.send")}</button>
    </form>}
    <footer className="attention-actions">
      <button type="button" disabled={refreshing || busy || !data?.openToken} onClick={() => {
        const bridge = window.attentionWindow;
        if (bridge && data) void run(() => bridge.open(data.openToken), () => void refresh());
      }}>{t("trayPanel.openMurage")}</button>
      {trayControls && <button type="button" disabled={refreshing || busy || !data} onClick={() => {
        const bridge = window.attentionWindow;
        if (bridge) void run(() => bridge.pauseAutomations(), () => setStatus(t("trayPanel.paused")));
      }}>{t("trayPanel.pause")}</button>}
    </footer>
    {status && <p role="status">{status}</p>}
    {(failed || error) && <p role="alert">{failed ? t("trayPanel.loadError") : error}</p>}
  </main>;
}
