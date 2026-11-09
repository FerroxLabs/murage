// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useId, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { cleanAttentionText, type AttentionItem } from "./bridge";

export function refusalMessage(reason?: string) {
  return reason === "locked" ? t("trayPanel.refusedLocked") : reason === "card" ? t("trayPanel.refusedCard") : t("trayPanel.refusedOpen");
}

export function AttentionCard({ item, onAnswered }: { item: AttentionItem; onAnswered: () => void }) {
  const [replying, setReplying] = useState(false), [text, setText] = useState("");
  const [busy, setBusy] = useState(false), [spent, setSpent] = useState(false), [error, setError] = useState("");
  const actionStarted = useRef(false), opening = useRef(false);
  const replyId = useId(), remainingId = useId();
  const reply = cleanAttentionText(text);
  const answer = async (action: "allow" | "deny" | "reply") => {
    const bridge = window.attentionWindow;
    if (!bridge || !item.actionToken || actionStarted.current || (action === "reply" && (reply.length < 1 || reply.length > 2000))) return;
    actionStarted.current = true; setBusy(true); setSpent(true); setError("");
    try {
      const result = await bridge.act(item.actionToken, action, action === "reply" ? reply : undefined);
      if (result.ok) onAnswered(); else setError(refusalMessage(result.reason));
    } catch { setError(refusalMessage()); } finally { setBusy(false); }
  };
  const open = async () => {
    if (opening.current || !window.attentionWindow) return;
    opening.current = true;
    try {
      const result = await window.attentionWindow.open(item.openToken);
      if (!result.ok) setError(refusalMessage(result.reason));
    } catch { setError(refusalMessage()); }
  };
  return <article className="attention-card" aria-busy={busy}>
    {item.display ? <>
      <p className="attention-secondary">{item.display.botName}</p>
      <h3>{item.display.title}</h3>
      {item.level && <p>{t("trayPanel.level", { level: item.level })}</p>}
      <p className="attention-secondary">{t("trayPanel.willRun")}</p>
      <pre className="attention-detail">{item.display.willRun}</pre>
    </> : <p>{t("trayPanel.requestWaiting")}</p>}
    <div className="attention-actions">
      {item.actionToken && <>
        <button type="button" disabled={spent} onClick={() => void answer("allow")}>{t("trayPanel.allow")}</button>
        <button type="button" disabled={spent} onClick={() => void answer("deny")}>{t("trayPanel.deny")}</button>
        <button type="button" disabled={spent} onClick={() => setReplying(true)}>{t("trayPanel.reply")}</button>
      </>}
      <button type="button" onClick={() => void open()}>{t("trayPanel.open")}</button>
    </div>
    {replying && <form onSubmit={event => { event.preventDefault(); void answer("reply"); }}>
      <label htmlFor={replyId}>{t("trayPanel.replyLabel")}</label>
      <textarea id={replyId} autoFocus rows={3} maxLength={2000} value={text} disabled={spent}
        aria-describedby={remainingId} onChange={event => setText(event.target.value)} />
      <p id={remainingId} className="attention-secondary">{t("trayPanel.remaining", { count: 2000 - text.length })}</p>
      <button type="submit" disabled={spent || reply.length === 0 || reply.length > 2000}>{t("trayPanel.sendReply")}</button>
    </form>}
    {error && <p role="alert">{error}</p>}
  </article>;
}
