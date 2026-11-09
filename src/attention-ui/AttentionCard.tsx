// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useId, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { cleanAttentionText, type AttentionItem } from "./bridge";

export function refusalMessage(reason?: string) {
  return reason === "locked" ? t("trayPanel.refusedLocked") : reason === "card" ? t("trayPanel.refusedCard") : t("trayPanel.refusedOpen");
}

/** The unsent Reply is controlled: `draft` / `onDraft` live in the items reader, keyed by cardId, so the
 * words survive this card unmounting (pill collapse, float reselect) and a refresh that keeps its cardId. */
export function AttentionCard({ item, onAnswered, refreshing = false, replyTyping = true, requestReplyFocus, openLabel, draft, onDraft }: {
  item: AttentionItem; onAnswered: () => void; refreshing?: boolean; replyTyping?: boolean;
  requestReplyFocus?: () => Promise<boolean>; openLabel?: string;
  draft?: { text: string; replying: boolean }; onDraft?: (next: { text: string; replying: boolean } | null) => void;
}) {
  const replying = draft?.replying ?? false, text = draft?.text ?? "";
  // The reader owns the draft; `latest` only mirrors what the card last saw or sent, so a non-keystroke write never carries stale text.
  const replyInput = useRef<HTMLTextAreaElement>(null), replyButton = useRef<HTMLButtonElement>(null);
  const latest = useRef(draft);
  latest.current = draft;
  // S8R rev 2.2 (E1): an async continuation writes only while it still owns what it writes. `mounted` is true between this instance's
  // mount and unmount; `replyReq` numbers Reply requests; `itemNow` / `refreshingNow` give continuations call-time reads.
  const mounted = useRef(false), replyReq = useRef(0), itemNow = useRef(item), refreshingNow = useRef(refreshing);
  itemNow.current = item; refreshingNow.current = refreshing;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // Focus intent: live (non-null) from Reply being pressed, or the caret being put in the field, until focus goes elsewhere.
  // Restoring a draft mints none, so restoration never takes focus.
  const intent = useRef<number | null>(null), intentSeq = useRef(0);
  const [busy, setBusy] = useState(false), [spentToken, setSpentToken] = useState<string | null>(null), [error, setError] = useState("");
  const [openedToken, setOpenedToken] = useState<string | null>(null);
  const actionStarted = useRef<string | null>(null), opening = useRef<string | null>(null), replyStarted = useRef<string | null>(null);
  const spent = busy || spentToken === item.actionToken;
  const locked = refreshing || spent;
  const lockedNow = useRef(locked), spentNow = useRef(spent);
  lockedNow.current = locked; spentNow.current = spent;
  const [focusNonce, setFocusNonce] = useState(0);
  // One path for Reply-press focus and refresh-recovery refocus; only while the intent is live.
  useEffect(() => {
    const input = replyInput.current;
    if (replying && !locked && intent.current !== null && input && document.activeElement !== input) input.focus();
  }, [replying, locked, focusNonce]);
  // Focus or a click going anywhere else cancels the intent. The Reply button is exempt from focusin: Electron hands focus back to it
  // when the pill window becomes focusable during the focus request. Handlers read only event.target.
  useEffect(() => {
    const onFocusIn = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target !== replyInput.current && target !== replyButton.current) intent.current = null;
    };
    const onPointerDown = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target !== replyInput.current) intent.current = null;
    };
    document.addEventListener("focusin", onFocusIn, true); document.addEventListener("pointerdown", onPointerDown, true);
    return () => { document.removeEventListener("focusin", onFocusIn, true); document.removeEventListener("pointerdown", onPointerDown, true); intent.current = null; };
  }, []);
  useEffect(() => { setError(""); }, [item.actionToken, item.openToken]);
  const replyId = useId(), remainingId = useId();
  const reply = cleanAttentionText(text);
  const answer = async (action: "allow" | "deny" | "reply") => {
    const bridge = window.attentionWindow;
    if (!bridge || refreshing || busy || !item.actionToken || actionStarted.current === item.actionToken || (action === "reply" && (reply.length < 1 || reply.length > 2000))) return;
    const token = item.actionToken;
    actionStarted.current = token; setBusy(true); setSpentToken(token); setError("");
    // A refusal for a token a refresh has replaced is not about the card now showing. The success branch and `finally` are not guarded:
    // the host consumed that token, so its draft is dead for every instance, and this instance's own lock is always released.
    const owns = () => mounted.current && itemNow.current.actionToken === token;
    try {
      const result = await bridge.act(token, action, action === "reply" ? reply : undefined);
      if (result.ok) { intent.current = null; onDraft?.(null); onAnswered(); } else if (owns()) setError(refusalMessage(result.reason));
    } catch { if (owns()) setError(refusalMessage()); } finally { setBusy(false); }
  };
  const open = async () => {
    const now = itemNow.current;
    if (refreshingNow.current || opening.current === now.openToken || !window.attentionWindow) return;
    const token = now.openToken;
    opening.current = token; setOpenedToken(token);
    const owns = () => mounted.current && itemNow.current.openToken === token;
    try {
      const result = await window.attentionWindow.open(token);
      if (!result.ok && owns()) setError(refusalMessage(result.reason));
    } catch { if (owns()) setError(refusalMessage()); }
  };
  const startReply = async () => {
    if (refreshing) return;
    if (!replyTyping) { intent.current = null; await open(); return; }
    if (replyStarted.current === item.actionToken) return;
    replyStarted.current = item.actionToken ?? null;
    const req = ++replyReq.current, mine = ++intentSeq.current; intent.current = mine;
    const owns = () => mounted.current && replyReq.current === req;
    let ok: boolean;
    try { ok = !requestReplyFocus || await requestReplyFocus(); } catch { ok = false; }
    // Refusal, throw and success alike: a request this instance no longer owns (unmounted, or a newer Reply started) writes nothing.
    if (!owns()) return;
    if (!ok) { intent.current = null; await open(); return; }
    // A Send during the request spent the card: a late write would reopen an empty field.
    if (spentNow.current) return;
    onDraft?.({ text: latest.current?.text ?? "", replying: true });
    if (intent.current === mine) setFocusNonce(n => n + 1);
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
        <button type="button" ref={replyButton} disabled={refreshing || spent} onClick={() => void startReply()}>{t("trayPanel.reply")}</button>
      </>}
      <button type="button" disabled={refreshing || openedToken === item.openToken} onClick={() => void open()}>{openLabel ?? t("trayPanel.open")}</button>
    </div>
    {replying && <form onSubmit={event => { event.preventDefault(); void answer("reply"); }}>
      <label htmlFor={replyId}>{t("trayPanel.replyLabel")}</label>
      <textarea id={replyId} ref={replyInput} rows={3} maxLength={2000} value={text} disabled={locked}
        onFocus={() => { if (intent.current === null) intent.current = ++intentSeq.current; }}
        onBlur={event => {
          if (event.relatedTarget !== null) { intent.current = null; return; }
          // Chromium blurs a field that becomes disabled during a refresh, and a window switch blurs it too: neither is the user leaving.
          if (!lockedNow.current && document.hasFocus()) intent.current = null;
        }}
        aria-describedby={remainingId} onChange={event => { const next = { text: event.target.value, replying: true }; latest.current = next; onDraft?.(next); }} />
      <p id={remainingId} className="attention-secondary">{t("trayPanel.remaining", { count: 2000 - text.length })}</p>
      <button type="submit" disabled={refreshing || spent || reply.length === 0 || reply.length > 2000}>{t("trayPanel.sendReply")}</button>
    </form>}
    {error && <p role="alert">{error}</p>}
  </article>;
}
