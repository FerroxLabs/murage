// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CROSS-CHAT-READ-1019 3.1 + 8a.1: a bot's share request in a room. The room row carries only the query; the excerpts are fetched for the
// owner's session (GET /api/room-shares/:id) and shown exactly as they would be shared. The owner unticks, then Share or Don't share;
// Share sends the draft's nonce and digest back, so a changed preview is refused. The composer entry asks the same picker for a member.
import { useEffect, useState } from "react";

import { api, type Bot, type Group } from "@/state/store";
import { t } from "@/lib/i18n";

const button = "min-h-9 rounded-lg border border-hairline/50 bg-control px-3 text-[12.5px] text-ink hover:bg-raised disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2";

type CardView = { id: string; botName: string; query: string; status: string; copy: string; nonce: string; digest: string;
  excerpts: { messageId: string; source: string; text: string }[] };

export function RoomShareCard({ shareId, text }: { shareId: string; text: string }) {
  const [card, setCard] = useState<CardView | null>(null);
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => {
    let live = true;
    api(`/api/room-shares/${encodeURIComponent(shareId)}`).then((body: { share: CardView }) => {
      if (!live) return;
      setCard(body.share);
      setKeep(new Set(body.share.excerpts.map((e) => e.messageId)));
    }).catch(() => { if (live) setCard(null); });
    return () => { live = false; };
  }, [shareId]);
  const answer = async (action: "share" | "decline") => {
    if (!card) return;
    setBusy(true); setNote("");
    try {
      const body = action === "share" ? { nonce: card.nonce, digest: card.digest, keep: [...keep] } : {};
      const result = await api(`/api/room-shares/${encodeURIComponent(card.id)}/${action}`, { method: "POST", body: JSON.stringify(body) }) as { status: string };
      setCard({ ...card, status: result.status, excerpts: [] });
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : t("roomShare.failed"));
    } finally { setBusy(false); }
  };
  const open = card?.status === "pending";
  return (
    <div className="max-w-[560px] rounded-xl border border-hairline bg-raised px-4 py-3 text-[13px] text-ink" data-room-share={shareId}>
      <p>{card ? t("roomShare.askRow", { name: card.botName }) : text}</p>
      {open && card && (
        <>
          <p className="mt-2 text-[12px] text-ink-secondary">{t("roomShare.cardCopy")}</p>
          {card.excerpts.length === 0 && <p className="mt-2 text-[12px] text-ink-secondary">{t("roomShare.empty")}</p>}
          <ul className="mt-2 space-y-2">
            {card.excerpts.map((e) => (
              <li key={e.messageId}>
                <label className="flex items-start gap-2">
                  <input type="checkbox" checked={keep.has(e.messageId)} disabled={busy}
                    onChange={(event) => { const next = new Set(keep); if (event.target.checked) next.add(e.messageId); else next.delete(e.messageId); setKeep(next); }} />
                  <span><span className="block text-[11px] text-ink-secondary">{e.source}</span><span className="whitespace-pre-wrap">{e.text}</span></span>
                </label>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex gap-2">
            <button type="button" className={button} disabled={busy || keep.size === 0} onClick={() => void answer("share")}>{t("roomShare.share")}</button>
            <button type="button" className={button} disabled={busy} onClick={() => void answer("decline")}>{t("roomShare.decline")}</button>
          </div>
        </>
      )}
      {card && !open && <p className="mt-2 text-[12px] text-ink-secondary">{card.status === "shared" ? t("roomShare.shared", { name: card.botName }) : card.status === "declined" ? t("roomShare.declined") : t("roomShare.closed")}</p>}
      {note && <p role="status" className="mt-2 text-[12px] text-ink-secondary">{note}</p>}
    </div>
  );
}

export function RoomShareAsk({ group, members }: { group: Group; members: Bot[] }) {
  const [open, setOpen] = useState(false);
  const [botId, setBotId] = useState(members[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  if (!members.length) return null;
  const ask = async () => {
    setBusy(true); setNote("");
    try {
      const result = await api(`/api/groups/${encodeURIComponent(group.id)}/room-shares`, { method: "POST", body: JSON.stringify({ botId, query }) }) as { shareId: string | null; text: string };
      if (result.shareId) { setOpen(false); setQuery(""); } else setNote(result.text);
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : t("roomShare.failed"));
    } finally { setBusy(false); }
  };
  if (!open) return <div className="px-4 pb-1"><button type="button" className="text-[12px] text-ink-secondary underline" onClick={() => setOpen(true)}>{t("roomShare.composerEntry")}</button></div>;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-hairline bg-app px-4 py-2 text-[13px]">
      <select aria-label={t("roomShare.fromChatsOf")} value={botId} onChange={(event) => setBotId(event.target.value)} className="rounded border border-hairline bg-control px-2 py-1">
        {members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
      </select>
      <input aria-label={t("roomShare.lookFor")} maxLength={200} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("roomShare.lookFor")}
        className="min-w-[180px] flex-1 rounded border border-hairline bg-control px-2 py-1" />
      <button type="button" className={button} disabled={busy || !query.trim() || !botId} onClick={() => void ask()}>{t("roomShare.find")}</button>
      <button type="button" className={button} disabled={busy} onClick={() => setOpen(false)}>{t("roomShare.cancel")}</button>
      {note && <p role="status" className="w-full text-[12px] text-ink-secondary">{note}</p>}
    </div>
  );
}
