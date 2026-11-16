// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useRef, useState, useSyncExternalStore } from "react";
import { localeVersion, subscribeLocale, t } from "@/lib/i18n";
import { AttentionCard, refusalMessage } from "../attention-ui/AttentionCard";
import { useAttentionItems } from "../attention-ui/useAttentionItems";
import "../attention-ui/attention-panel.css";
import "./pill.css";

export function Pill() {
  useSyncExternalStore(subscribeLocale, localeVersion, localeVersion);
  const { data, refreshing, failed, stalled, drafts, refresh, setDraft, clearDraft } = useAttentionItems("pill");
  const [error, setError] = useState("");
  const toggling = useRef(false);
  const toggle = async () => {
    if (refreshing || toggling.current || !data?.pill || !window.attentionWindow) return;
    toggling.current = true;
    try {
      const result = await window.attentionWindow.open(data.pill.toggleToken);
      if (!result.ok) setError(refusalMessage(result.reason));
    } catch { setError(refusalMessage()); } finally { toggling.current = false; }
  };
  const state = data?.pill?.state;
  const expanded = state === "expanded" || state === "stacked";
  if (state === "hidden" && !error) return null;
  return <main className="attention-panel pill" data-state={state ?? "loading"} aria-label={t("pill.title")}>
    {data?.pill && state !== "finished" && <button type="button" className="pill-capsule" aria-expanded={expanded}
      disabled={refreshing} onClick={() => void toggle()}>
      <span>{t("pill.capsule", { bot: data.items[0]?.display?.botName || t("pill.waiting"), count: data.pill.count })}</span>
      {expanded && <span className="attention-secondary">{t("pill.collapse")}</span>}
    </button>}
    {expanded && <ol className="pill-stack" aria-label={t("pill.requests")}>
      {data?.items.map(item => <li key={item.cardId}>
        <AttentionCard item={item} refreshing={refreshing || stalled} onAnswered={() => void refresh()} openLabel={t("pill.open")}
          draft={drafts[item.cardId]} onDraft={next => next ? setDraft(item.cardId, next) : clearDraft(item.cardId)}
          replyTyping={Boolean(item.replyFocusToken)} requestReplyFocus={async () => {
            if (!item.replyFocusToken || !window.attentionWindow) return false;
            return (await window.attentionWindow.open(item.replyFocusToken)).ok;
          }} />
      </li>)}
    </ol>}
    {(expanded || state === "finished") && data?.receipts.map((receipt, index) => <p role="status" key={index}>
      {receipt.text || t("pill.finished")}
    </p>)}
    {!data && !failed && !error && <p>{t("pill.loading")}</p>}
    {(failed || error) && <p role="alert">{failed ? t("pill.loadError") : error}</p>}
  </main>;
}
