// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useId, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { cleanAttentionText, type AttentionItem } from "./bridge";

export function refusalMessage(reason?: string) {
  return reason === "locked" ? t("trayPanel.refusedLocked") : reason === "card" ? t("trayPanel.refusedCard") : t("trayPanel.refusedOpen");
}

export function AttentionCard({ item, onAnswered, refreshing = false }: { item: AttentionItem; onAnswered: () => void; refreshing?: boolean }) {
  const [replying, setReplying] = useState(false), [text, setText] = useState("");
  const [busy, setBusy] = useState(false), [spentToken, setSpentToken] = useState<string | null>(null), [error, setError] = useState("");
  const [openedToken, setOpenedToken] = useState<string | null>(null);
  const actionStarted = useRef<string | null>(null), opening = useRef<string | null>(null);
  const spent = busy || spentToken === item.actionToken;
  useEffect(() => { setError(""); }, [item.actionToken, item.openToken]);
  const replyId = useId(), remainingId = useId();
  const reply = cleanAttentionText(text);
  const answer = async (action: "allow" | "deny" | "reply") => {
    const bridge = window.attentionWindow;
    if (!bridge || refreshing || busy || !item.actionToken || actionStarted.current === item.actionToken || (action === "reply" && (reply.length < 1 || reply.length > 2000))) return;
    actionStarted.current = item.actionToken; setBusy(true); setSpentToken(item.actionToken); setError("");
    try {
      const result = await bridge.act(item.actionToken, action, action === "reply" ? reply : undefined);
      if (result.ok) onAnswered(); else setError(refusalMessage(result.reason));
    } catch { setError(refusalMessage()); } finally { setBusy(false); }
  };
  const open = async () => {
    if (refreshing || opening.current === item.openToken || !window.attentionWindow) return;
    opening.current = item.openToken; setOpenedToken(item.openToken);
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
        <button type="button" disabled={refreshing || spent} onClick={() => void answer("allow")}>{t("trayPanel.allow")}</button>
        <button type="button" disabled={refreshing || spent} onClick={() => void answer("deny")}>{t("trayPanel.deny")}</button>
        <button type="button" disabled={refreshing || spent} onClick={() => setReplying(true)}>{t("trayPanel.reply")}</button>
      </>}
      <button type="button" disabled={refreshing || openedToken === item.openToken} onClick={() => void open()}>{t("trayPanel.open")}</button>
    </div>
    {replying && <form onSubmit={event => { event.preventDefault(); void answer("reply"); }}>
      <label htmlFor={replyId}>{t("trayPanel.replyLabel")}</label>
      <textarea id={replyId} autoFocus rows={3} maxLength={2000} value={text} disabled={spent}
        aria-describedby={remainingId} onChange={event => setText(event.target.value)} />
      <p id={remainingId} className="attention-secondary">{t("trayPanel.remaining", { count: 2000 - text.length })}</p>
      <button type="submit" disabled={refreshing || spent || reply.length === 0 || reply.length > 2000}>{t("trayPanel.sendReply")}</button>
    </form>}
    {error && <p role="alert">{error}</p>}
  </article>;
}
