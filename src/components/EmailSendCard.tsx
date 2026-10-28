// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The email card (BOT-EMAIL-MURAGE-109 4.1): a view of the send's row, with its own buttons. The words come from the server (built from the
// frozen record); this component only shows them and sends the owner's answer to the thread's respond route, which claims `email-` ids
// before anything else. It is never answered from the composer, by voice or by an engine.
import { useState } from "react";
import { Mail } from "lucide-react";
import { api, type Message } from "@/state/store";
import { respondWithFreshAuth } from "@/lib/fresh-auth";
import { EMAIL_TRUST_COPY, type EmailCardAction } from "../../shared/email-copy.ts";

export interface EmailAnswerBody { requestId: string; behavior: "allow" | "deny" | "answer"; emailAction: EmailCardAction; emailRevision: number; emailDraft?: { text: string; subject?: string } }

/** The respond body for one button: Send and Retry are an allow, Don't send a deny, Edit an answer carrying the edited words. */
export function emailAnswerBody(requestId: string, revision: number, action: EmailCardAction, draft?: { text: string; subject?: string }): EmailAnswerBody {
  const behavior = action === "dont_send" ? "deny" : action === "edit" ? "answer" : "allow";
  return { requestId, behavior, emailAction: action, emailRevision: revision, ...(action === "edit" && draft ? { emailDraft: draft } : {}) };
}

const LABEL: Record<EmailCardAction, string> = { send: "Send", edit: "Edit", dont_send: "Don't send", retry: "Retry" };

export function EmailSendCard({ threadId, message, onManage }: { threadId: string; message: Message; onManage?: () => void }) {
  const card = message.card;
  const email = card?.emailSend;
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!card || !email || !card.requestId) return null;
  const answer = async (action: EmailCardAction) => {
    setBusy(true); setError(null);
    try {
      const body = emailAnswerBody(card.requestId!, email.revision, action, action === "edit" && editing !== null ? { text: editing } : undefined);
      const post = (extra?: Record<string, unknown>) => api(`/api/threads/${threadId}/respond`, { method: "POST", body: JSON.stringify({ ...body, ...extra }) });
      // 4.3: a phone Send or Retry carries a fresh device proof over this exact card (its payload hash, held ids and revision)
      if (body.behavior === "allow") await respondWithFreshAuth(post, { threadId, requestId: card.requestId!, decision: "allow", card, reason: card.title ?? "Send this email" });
      else await post();
      setEditing(null);
    } catch (caught) {
      setError(caught instanceof Error && caught.message ? caught.message : "That answer did not go through. Try again.");
    } finally { setBusy(false); }
  };
  const open = email.phase === "open";
  return (
    <div className={`w-full max-w-[840px] rounded-2xl border bg-card p-4 ${open ? "border-accent/40" : "border-hairline/30 opacity-80"}`} data-testid="email-send-card">
      <div className="flex items-baseline gap-2 text-[15px] font-semibold text-ink"><Mail size={15} aria-hidden /> {card.title}</div>
      {editing === null ? (
        <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-inset px-3 py-2 text-[13px] leading-relaxed text-ink">{card.subtitle}</pre>
      ) : (
        <textarea aria-label="Email text" value={editing} onChange={event => setEditing(event.target.value)} className="mt-2 min-h-40 w-full rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px]" />
      )}
      {email.note && <p className="mt-2 text-[13px] text-ink-secondary">{email.note}</p>}
      {error && <p role="alert" className="mt-2 text-[13px] text-warning">{error}</p>}
      {open && (
        <div className="mt-3 flex flex-wrap gap-2">
          {editing !== null ? (
            <>
              <button type="button" disabled={busy} onClick={() => void answer("edit")} className="min-h-9 rounded-lg bg-accent px-3 text-[13px] font-medium text-white disabled:opacity-60">Save</button>
              <button type="button" disabled={busy} onClick={() => setEditing(null)} className="min-h-9 rounded-lg bg-control px-3 text-[13px]">Cancel</button>
            </>
          ) : email.actions.map(action => (
            <button key={action} type="button" disabled={busy}
              onClick={() => action === "edit" ? setEditing(email.draft.text) : void answer(action)}
              className={`min-h-9 rounded-lg px-3 text-[13px] font-medium disabled:opacity-60 ${action === "send" || action === "retry" ? "bg-accent text-white" : "bg-control text-ink"}`}>{LABEL[action]}</button>
          ))}
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-3 text-[12.5px]">
        {email.links.checkSent && <span className="text-ink-secondary">{email.links.checkSent}</span>}
        {onManage && <button type="button" onClick={onManage} className="text-accent underline-offset-2 hover:underline">{email.links.manage}</button>}
      </div>
    </div>
  );
}

/** The earned-trust proposal (3.5, the routine-card pattern): "Add [address]" or "Not now". Add is the owner's yes (a fresh device proof on a
 * phone); the card comes from Murage's own record and never carries the bot's words. */
export function emailTrustAnswerBody(requestId: string, add: boolean): { requestId: string; behavior: "allow" | "deny"; emailTrust: "add" | "not_now" } {
  return { requestId, behavior: add ? "allow" : "deny", emailTrust: add ? "add" : "not_now" };
}

export function EmailTrustOfferCard({ threadId, message }: { threadId: string; message: Message }) {
  const card = message.card;
  const offer = card?.emailTrustOffer;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!card || !offer || !card.requestId) return null;
  const answer = async (add: boolean) => {
    setBusy(true); setError(null);
    try {
      const body = emailTrustAnswerBody(card.requestId!, add);
      const post = (extra?: Record<string, unknown>) => api(`/api/threads/${threadId}/respond`, { method: "POST", body: JSON.stringify({ ...body, ...extra }) });
      if (add) await respondWithFreshAuth(post, { threadId, requestId: card.requestId!, decision: "allow", card, reason: EMAIL_TRUST_COPY.add(offer.address) });
      else await post();
    } catch (caught) {
      setError(caught instanceof Error && caught.message ? caught.message : EMAIL_TRUST_COPY.failed);
    } finally { setBusy(false); }
  };
  const open = offer.phase === "open";
  return (
    <div className={`w-full max-w-[840px] rounded-2xl border bg-card p-4 ${open ? "border-accent/40" : "border-hairline/30 opacity-80"}`} data-testid="email-trust-card">
      <div className="flex items-baseline gap-2 text-[15px] font-semibold text-ink"><Mail size={15} aria-hidden /> {card.title}</div>
      {!open && <p className="mt-2 text-[13px] text-ink-secondary">{card.subtitle}</p>}
      {error && <p role="alert" className="mt-2 text-[13px] text-warning">{error}</p>}
      {open && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => void answer(true)} className="min-h-9 rounded-lg bg-accent px-3 text-[13px] font-medium text-white disabled:opacity-60">{EMAIL_TRUST_COPY.add(offer.address)}</button>
          <button type="button" disabled={busy} onClick={() => void answer(false)} className="min-h-9 rounded-lg bg-control px-3 text-[13px] font-medium text-ink disabled:opacity-60">{EMAIL_TRUST_COPY.notNow}</button>
        </div>
      )}
    </div>
  );
}
