// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { localeVersion, subscribeLocale, t } from "@/lib/i18n";
import { AttentionCard, refusalMessage } from "./AttentionCard";
import { cleanAttentionText, type AttentionItems, type AttentionResult } from "./bridge";
import "./attention-panel.css";

/** Shared by attention entries. All privileged effects use the narrow bridge.
 * Other kinds may omit tray controls; the IPC gate remains the authority. */
export function AttentionPanel({ trayControls = true }: { trayControls?: boolean }) {
  useSyncExternalStore(subscribeLocale, localeVersion, localeVersion);
  const [data, setData] = useState<AttentionItems | null>(null), [error, setError] = useState("");
  const [text, setText] = useState(""), [busy, setBusy] = useState(false), [status, setStatus] = useState("");
  const refresh = useRef<() => void>(() => {}), sending = useRef(false);
  const chiefId = useId(), needsId = useId(), runningId = useId(), receiptsId = useId();
  useEffect(() => {
    const bridge = window.attentionWindow;
    if (!bridge) { setError(t("trayPanel.loadError")); return; }
    let alive = true, reading = false, again = false;
    const read = async () => {
      if (reading) { again = true; return; }
      reading = true; setData(null);
      do {
        again = false;
        try {
          const result = await bridge.items();
          if (alive && !again) {
            if (result.ok && "items" in result) { setData(result); setError(""); }
            else setError(t("trayPanel.loadError"));
          }
        } catch { if (alive) setError(t("trayPanel.loadError")); }
      } while (alive && again);
      reading = false;
    };
    refresh.current = () => { if (alive) void read(); };
    const unsubscribe = bridge.onChange(() => { setData(null); refresh.current(); });
    refresh.current();
    return () => { alive = false; refresh.current = () => {}; unsubscribe(); };
  }, []);
  const run = async (effect: () => Promise<AttentionResult>, done: () => void) => {
    if (sending.current) return;
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
        ? <AttentionCard key={data.items[0].openToken} item={data.items[0]} onAnswered={() => refresh.current()} />
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
      <input id={chiefId} type="text" value={text} maxLength={4000} disabled={busy || !data?.chief} onChange={event => setText(event.target.value)} />
      <button type="submit" disabled={busy || !data?.chief || chiefText.length === 0 || chiefText.length > 4000}>{t("trayPanel.send")}</button>
    </form>}
    <footer className="attention-actions">
      <button type="button" disabled={busy || !data?.openToken} onClick={() => {
        const bridge = window.attentionWindow;
        if (bridge && data) void run(() => bridge.open(data.openToken), () => refresh.current());
      }}>{t("trayPanel.openMurage")}</button>
      {trayControls && <button type="button" disabled={busy || !data} onClick={() => {
        const bridge = window.attentionWindow;
        if (bridge) void run(() => bridge.pauseAutomations(), () => setStatus(t("trayPanel.paused")));
      }}>{t("trayPanel.pause")}</button>}
    </footer>
    {status && <p role="status">{status}</p>}
    {error && <p role="alert">{error}</p>}
  </main>;
}
