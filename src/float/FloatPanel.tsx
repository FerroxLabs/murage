// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { localeVersion, subscribeLocale, t } from "@/lib/i18n";
import { AttentionCard } from "../attention-ui/AttentionCard";
import { cleanAttentionText, type FloatBot } from "../attention-ui/bridge";
import { useAttentionItems } from "../attention-ui/useAttentionItems";
import "../attention-ui/attention-panel.css";
import "./float.css";

const botName = (bot: FloatBot) => bot.name || t("float.bot");
function BotButton({ bot, onClick, disabled }: { bot: FloatBot; onClick: () => void; disabled: boolean }) {
  const name = botName(bot);
  const state = bot.state === "needs-you" ? t("float.needsYou") : bot.state === "working" ? t("float.working") : t("float.idle");
  return <button type="button" className="float-bot" disabled={disabled} onClick={onClick} title={`${name}: ${state}`}
    aria-label={`${t("float.openBot", { name })}: ${state}`}>
    <span className="float-avatar" aria-hidden="true">{name.slice(0, 2)}</span>
    {bot.state === "needs-you" && <span className="float-dot" aria-hidden="true" />}
  </button>;
}

/** Both packaged entries use this tree. Only the gated attention bridge is used. */
export function FloatPanel({ kind }: { kind: "bubble" | "dock" }) {
  useSyncExternalStore(subscribeLocale, localeVersion, localeVersion);
  const { data, refreshing, failed, stalled, drafts, refresh, setDraft, clearDraft } = useAttentionItems("float");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = data?.bots?.find(bot => bot.key === selectedKey) ?? null;
  const selectedCard = selected?.item ?? null;
  const [menu, setMenu] = useState(false), [error, setError] = useState("");
  const [text, setText] = useState(""), [busy, setBusy] = useState(false), [sent, setSent] = useState(false);
  const sending = useRef(false), selecting = useRef(false), revision = useRef(0), inputId = useId();
  useEffect(() => {
    if ((selectedKey && !selected) || (failed && menu)) {
      revision.current++;
      setSelectedKey(null); setMenu(false); setText(""); setSent(false);
      void window.attentionWindow?.setExpanded?.(false).catch(() => {});
    }
  }, [selectedKey, selected, failed, menu]);
  useEffect(() => {
    return () => { revision.current++; };
  }, []);
  const expand = async (bot: FloatBot | null) => {
    if (refreshing || selecting.current) return;
    selecting.current = true;
    const ticket = revision.current;
    try {
      // Read at the click boundary too: a different card may replace an older
      // request without changing the bot's three-state indicator.
      let current = bot;
      if (bot) {
        const latest = await refresh();
        if (ticket !== revision.current) return;
        if (!latest) return;
        current = latest.bots?.find(row => row.key === bot.key) ?? null;
        if (!current) return;
      }
      const result = await window.attentionWindow?.setExpanded?.(true);
      if (ticket !== revision.current) { void window.attentionWindow?.setExpanded?.(false).catch(() => {}); return; }
      if (!result?.ok) { setError(t("float.error")); return; }
      setSelectedKey(current?.key ?? null); setMenu(bot === null); setError(""); setSent(false);
    } catch { setError(t("float.error")); } finally { selecting.current = false; }
  };
  const collapse = async () => {
    revision.current++;
    setSelectedKey(null); setMenu(false);
    try { await window.attentionWindow?.setExpanded?.(false); } catch { setError(t("float.error")); }
  };
  const chat = cleanAttentionText(text);
  const bots = kind === "bubble" ? data?.bots?.slice(0, 1) : data?.bots;
  return <main className={`attention-panel float-panel float-${kind} ${selected || menu ? "float-expanded" : ""}`}
    aria-label={t(kind === "bubble" ? "float.bubble" : "float.dock")}
    onContextMenu={event => { event.preventDefault(); void expand(null); }}
    onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); void collapse(); }
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); void expand(null); }
    }}>
    <div className="float-strip">{bots?.map(bot => <BotButton key={bot.key} bot={bot} disabled={refreshing} onClick={() => void expand(bot)} />)}</div>
    {menu && <div role="menu" aria-label={t(kind === "bubble" ? "float.bubble" : "float.dock")}>
      <button type="button" role="menuitem" onClick={async () => {
        try {
          const result = await window.attentionWindow?.hideForAnHour?.();
          if (!result?.ok) setError(t("float.error"));
        } catch { setError(t("float.error")); }
      }}>{t("float.hideHour")}</button>
    </div>}
    {selected && (selectedCard
      ? <AttentionCard key={selectedCard.cardId} item={selectedCard} refreshing={refreshing || stalled} onAnswered={() => void refresh()}
        draft={drafts[selectedCard.cardId]} onDraft={next => next ? setDraft(selectedCard.cardId, next) : clearDraft(selectedCard.cardId)} />
      : kind === "bubble" ? <form onSubmit={async event => {
        event.preventDefault();
        if (refreshing || sending.current || !window.attentionWindow || chat.length < 1 || chat.length > 4000) return;
        sending.current = true; setBusy(true); setSent(false); setError("");
        try {
          const result = await window.attentionWindow.sendToPinned(chat);
          if (result.ok) { setText(""); setSent(true); } else setError(t("float.error"));
        } catch { setError(t("float.error")); } finally { sending.current = false; setBusy(false); }
      }}>
        <label htmlFor={inputId}>{t("float.chat")}</label>
        <input id={inputId} autoFocus maxLength={4000} value={text} disabled={refreshing || busy} onChange={event => setText(event.target.value)} />
        <button type="submit" disabled={refreshing || busy || chat.length < 1 || chat.length > 4000}>{t("trayPanel.send")}</button>
        {sent && <p role="status">{t("float.sent")}</p>}
      </form> : <button type="button" disabled={refreshing} onClick={async () => {
        if (refreshing) return;
        try { if (!(await window.attentionWindow?.open(selected.openToken))?.ok) setError(t("float.error")); }
        catch { setError(t("float.error")); }
      }}>{t("trayPanel.open")}</button>)}
    {(selected || menu) && <button type="button" onClick={() => void collapse()}>{t("float.collapse")}</button>}
    {(failed || error) && <p role="alert">{failed ? t("float.error") : error}</p>}
  </main>;
}
