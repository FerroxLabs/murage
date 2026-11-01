// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Bot email settings (BOT-EMAIL-MURAGE-109 2.0, 2.5, 2.6, 3.3, 3.5, 6, 8):
//   - BotEmailAccountCard: Settings > Bot email (desktop): account on/off with the 2.0 confirm, the price line from capabilities (never in
//     the phone apps), and "Removing [address]" rows;
//   - BotEmailSection: the bot's Email section: the state line (section 6), the setup steps (2.5), Retry / Pause / Resume / Remove /
//     Reconnect, the 3.3 policy row, the trusted and Never email lists (3.5) and the Activity list;
//   - BotEmailFluxLine: the section 8 line, shown in Access only when the server says this install had email and lost its Flux key.
// Nothing renders unless the status route said enabled: true. Words come from shared/email-copy.ts verbatim.
import { useEffect, useState } from "react";
import { Mail } from "lucide-react";
import { Card, Switch } from "./SettingsPrimitives";
import { inNativeShell } from "@/lib/native-shell";
import { emailOwnerAct, emailSectionActions, priceLine, readBotEmail, readEmailStatus, removeOtherSetup, setEmailAccount, signInEmailOwner, useEmailStatus, type EmailStatusState } from "@/lib/bot-email";
import { EMAIL_FILTERED_COPY, EMAIL_OWNER_COPY, EMAIL_POLICY_COPY, EMAIL_SETUP_COPY, type EmailBotView, type EmailOwnerAction, type EmailStatusView } from "../../shared/email-copy.ts";

const button = "min-h-9 rounded-lg px-3 text-[13px] font-medium disabled:opacity-60";
const message = (error: unknown) => (error instanceof Error && error.message ? error.message : EMAIL_OWNER_COPY.actionFailed);

export function BotEmailFluxLine({ status }: { status: EmailStatusState }) {
  if (status.kind !== "flux-off") return null;
  return <p className="rounded-xl bg-card p-4 text-[13px] text-ink-secondary" data-testid="bot-email-flux-off">{status.line}</p>;
}

export function BotEmailAccountCard({ status: given }: { status?: EmailStatusState }) {
  const read = useEmailStatus(true);
  const [status, setStatus] = useState<EmailStatusState>(given ?? read);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!given) setStatus(read); }, [read, given]);
  if (status.kind !== "on") return null;
  const view = status.view;
  const on = view.accountState === "active" || view.accountState === "on";
  const change = async (next: boolean) => {
    if (!next && !window.confirm(EMAIL_SETUP_COPY.accountOffConfirm)) return;
    setBusy(true); setError(null);
    try {
      // 2.4: turning email on is the owner act that obtains the email:owner token (desktop sign-in), before Flux is asked
      if (next && !view.ownerSignedIn) { const refused = await signInEmailOwner(); if (refused) { setError(refused); return; } }
      const answer = await setEmailAccount(next, next ? { acceptTermsVersion: view.termsVersion ?? undefined } : { confirm: true }) as EmailStatusView | { enabled: false };
      setStatus(answer.enabled === true ? { kind: "on", view: answer } : { kind: "off" });
    } catch (caught) { setError(message(caught)); } finally { setBusy(false); }
  };
  const removeOther = async (inboxId: string, address: string | null) => {
    if (!window.confirm(EMAIL_OWNER_COPY.otherSetupRemoveConfirm(address ?? inboxId))) return;
    setBusy(true); setError(null);
    try { setStatus({ kind: "on", view: await removeOtherSetup(inboxId) }); } catch (caught) { setError(message(caught)); } finally { setBusy(false); }
  };
  const signIn = async () => {
    setBusy(true); setError(null);
    try { const refused = await signInEmailOwner(); if (refused) setError(refused); else setStatus(await readEmailStatus()); } catch (caught) { setError(message(caught)); } finally { setBusy(false); }
  };
  const price = priceLine(view, inNativeShell());
  const canSignIn = !inNativeShell() && typeof window !== "undefined" && Boolean(window.muragebox?.emailOwnerSignin);
  return (
    <Card title={EMAIL_OWNER_COPY.sectionTitle}>
      <div className="flex items-center justify-between gap-3" data-testid="bot-email-account">
        <span className="text-[13px] text-ink">{on ? EMAIL_OWNER_COPY.accountOnLine : EMAIL_OWNER_COPY.accountOffLine}</span>
        <Switch checked={on} disabled={busy} aria-label={on ? EMAIL_OWNER_COPY.accountOffAction : EMAIL_OWNER_COPY.accountOn} onClick={() => void change(!on)} />
      </div>
      {price && <p className="mt-2 text-[12.5px] text-ink-secondary" data-testid="bot-email-price">{price}</p>}
      {view.ownerKeyLine && <p className="mt-2 text-[12.5px] text-ink-secondary" data-testid="bot-email-owner-key">{view.ownerKeyLine}</p>}
      {on && canSignIn && (view.ownerKeyLine || !view.ownerSignedIn) && <button type="button" className={`${button} mt-2 bg-control text-ink`} disabled={busy} onClick={() => void signIn()}>{EMAIL_SETUP_COPY.signInAction}</button>}
      {view.accountSends && <p className="mt-2 text-[12.5px] text-ink-secondary" data-testid="bot-email-account-sends">{EMAIL_OWNER_COPY.accountSentToday(view.accountSends.today, view.accountSends.perDay)}</p>}
      {view.removing.map(item => <p key={item.botId} className="mt-2 text-[12.5px] text-ink-secondary">{EMAIL_OWNER_COPY.removingLine(item.address ?? "an address")}</p>)}
      {view.otherSetups?.length ? (
        <div className="mt-3" data-testid="bot-email-other-setups">
          <p className="text-[13px] font-medium text-ink">{EMAIL_OWNER_COPY.otherSetupsTitle}</p>
          {view.otherSetups.map(item => (
            <div key={item.inboxId} className="mt-1 flex items-center justify-between gap-3 text-[12.5px] text-ink-secondary">
              <span>{item.address ?? item.inboxId}</span>
              <button type="button" className={button} disabled={busy} onClick={() => void removeOther(item.inboxId, item.address)}>{EMAIL_OWNER_COPY.remove}</button>
            </div>
          ))}
        </div>
      ) : null}
      {error && <p role="alert" className="mt-2 text-[13px] text-warning">{error}</p>}
    </Card>
  );
}

/** The bot's Email section. `status` is the parent's read (the section is offered only while on). */
export function BotEmailSection({ bot, status }: { bot: { id: string; name: string; threadId: string }; status: EmailStatusState }) {
  const [view, setView] = useState<EmailBotView | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [username, setUsername] = useState(""), [displayName, setDisplayName] = useState(bot.name);
  const [note, setNote] = useState(""), [trustDraft, setTrustDraft] = useState(""), [blockDraft, setBlockDraft] = useState("");
  const [setupOpen, setSetupOpen] = useState(false);
  useEffect(() => {
    if (status.kind !== "on") return;
    let live = true;
    void readBotEmail(bot.id).then(next => { if (live) setView(next); });
    return () => { live = false; };
  }, [bot.id, status.kind]);
  if (status.kind !== "on" || !view) return null;
  const act = async (action: EmailOwnerAction, body: Record<string, unknown> = {}) => {
    setBusy(true); setError(null);
    try { setView(await emailOwnerAct(bot.id, bot.threadId, action, body)); return true; } catch (caught) { setError(message(caught)); return false; } finally { setBusy(false); }
  };
  const actions = emailSectionActions(view);
  const price = priceLine(status.view, inNativeShell());
  return (
    <div className="space-y-4" data-testid="bot-email-section">
      <Card title={view.address ?? EMAIL_SETUP_COPY.give}>
        {view.chip && <span className="inline-flex items-center gap-1 rounded-full bg-control px-2 py-0.5 text-[12px] text-ink" data-testid="bot-email-chip"><Mail size={12} aria-hidden />{view.chip}</span>}
        {view.panelLine && <p className="mt-2 text-[13px] text-ink-secondary" data-testid="bot-email-line">{view.panelLine}</p>}
        {view.keyLine && <p className="mt-2 text-[13px] text-ink-secondary" data-testid="bot-email-key">{view.keyLine}</p>}
        {view.importOffer && actions.includes("give") && <p className="mt-2 text-[13px] text-ink" data-testid="bot-email-import-offer">{view.importOffer}</p>}
        {actions.includes("give") && !setupOpen && <button type="button" className={`${button} mt-2 bg-accent text-white`} onClick={() => setSetupOpen(true)}>{EMAIL_SETUP_COPY.give}</button>}
        {actions.includes("give") && setupOpen && (
          <form className="mt-2 space-y-2" onSubmit={event => { event.preventDefault(); void act("setup", { username: username.trim(), displayName: displayName.trim() }); }}>
            {price && <p className="text-[12.5px] text-ink-secondary">{price}</p>}
            <label className="block text-[13px]">{EMAIL_OWNER_COPY.usernameLabel}<input value={username} maxLength={64} onChange={event => setUsername(event.target.value)} className="mt-1 block w-full rounded-lg border border-hairline/50 bg-inset px-3 py-2" /></label>
            <p className="text-[12px] text-ink-secondary">{EMAIL_OWNER_COPY.usernameHint}</p>
            <label className="block text-[13px]">{EMAIL_OWNER_COPY.displayNameLabel}<input value={displayName} maxLength={64} onChange={event => setDisplayName(event.target.value)} className="mt-1 block w-full rounded-lg border border-hairline/50 bg-inset px-3 py-2" /></label>
            <button type="submit" disabled={busy || !username.trim()} className={`${button} bg-accent text-white`}>{EMAIL_SETUP_COPY.give}</button>
          </form>
        )}
        {actions.includes("resume") && (
          <label className="mt-2 block text-[13px]">{EMAIL_OWNER_COPY.resumeNote}<input value={note} maxLength={500} onChange={event => setNote(event.target.value)} className="mt-1 block w-full rounded-lg border border-hairline/50 bg-inset px-3 py-2" /></label>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {actions.includes("keep") && <button type="button" disabled={busy} className={`${button} bg-accent text-white`} onClick={() => void act("keep")}>{EMAIL_OWNER_COPY.keepAddress}</button>}
          {actions.includes("retry") && <button type="button" disabled={busy} className={`${button} bg-accent text-white`} onClick={() => void act("retry")}>{EMAIL_OWNER_COPY.retry}</button>}
          {actions.includes("reconnect") && <button type="button" disabled={busy} className={`${button} bg-accent text-white`} onClick={() => void act("reconnect")}>{EMAIL_SETUP_COPY.reconnect}</button>}
          {actions.includes("pause") && <button type="button" disabled={busy} className={`${button} bg-control text-ink`} onClick={() => { if (window.confirm(EMAIL_SETUP_COPY.pauseConfirm(bot.name))) void act("pause"); }}>{EMAIL_SETUP_COPY.pauseSending}</button>}
          {actions.includes("resume") && <button type="button" disabled={busy || !note.trim()} className={`${button} bg-accent text-white`} onClick={() => void act("resume", { note: note.trim() }).then(ok => { if (ok) setNote(""); })}>{EMAIL_OWNER_COPY.resume}</button>}
          {actions.includes("remove") && <button type="button" disabled={busy} className={`${button} bg-control text-ink`} onClick={() => { if (window.confirm(EMAIL_SETUP_COPY.removeConfirm(view.address ?? "this address", bot.name))) void act("remove", { confirm: true }); }}>{EMAIL_OWNER_COPY.remove}</button>}
        </div>
        {error && <p role="alert" className="mt-2 text-[13px] text-warning">{error}</p>}
      </Card>
      {view.address && (
        <>
          <Card title={EMAIL_POLICY_COPY.title(bot.name)} subtitle={EMAIL_POLICY_COPY.always}>
            <div role="radiogroup" aria-label={EMAIL_POLICY_COPY.title(bot.name)} className="space-y-2">
              {(["ask", "auto"] as const).map(policy => (
                <label key={policy} className="flex items-start gap-2 text-[13px]">
                  <input type="radio" name={`email-policy-${bot.id}`} checked={view.policy === policy} disabled={busy} onChange={() => void act("policy", { policy })} className="mt-1" />
                  <span><span className="font-medium text-ink">{EMAIL_POLICY_COPY[policy].label}</span><span className="block text-ink-secondary">{EMAIL_POLICY_COPY[policy].detail(bot.name)}</span></span>
                </label>
              ))}
            </div>
          </Card>
          <EntryList title={EMAIL_POLICY_COPY.trustedTitle(bot.name)} hint={EMAIL_POLICY_COPY.domainAllowNotAvailable(bot.name)} entries={view.trusted} draft={trustDraft} setDraft={setTrustDraft} busy={busy}
            add={() => void act("trust_add", { entry: trustDraft.trim() }).then(ok => { if (ok) setTrustDraft(""); })} remove={entry => void act("trust_remove", { entry })} testId="bot-email-trusted" />
          <EntryList title={EMAIL_POLICY_COPY.neverEmail} hint={EMAIL_OWNER_COPY.neverEmailHint} entries={view.blocked} draft={blockDraft} setDraft={setBlockDraft} busy={busy}
            add={() => void act("block_add", { entry: blockDraft.trim() }).then(ok => { if (ok) setBlockDraft(""); })} remove={entry => void act("block_remove", { entry })} testId="bot-email-blocked" />
        </>
      )}
      <Card title={EMAIL_OWNER_COPY.activityTitle}>
        {view.activity.length ? (
          <ul className="space-y-1 text-[13px]" data-testid="bot-email-activity">{view.activity.map(item => <li key={item.ref} className="flex justify-between gap-3"><span className="text-ink">{item.line}</span><span className="shrink-0 text-ink-secondary">{item.ref}</span></li>)}</ul>
        ) : <p className="text-[13px] text-ink-secondary">{EMAIL_OWNER_COPY.activityEmpty}</p>}
      </Card>
      {view.filtered?.length ? (
        <Card title={EMAIL_FILTERED_COPY.title}>
          <p className="mb-2 text-[13px] text-ink-secondary">{EMAIL_FILTERED_COPY.hint(bot.name)}</p>
          <ul className="space-y-1 text-[13px]" data-testid="bot-email-filtered">{view.filtered.map(item => <li key={item.id} className="flex justify-between gap-3"><span className="text-ink">{item.from}</span><span className="shrink-0 text-ink-secondary">{EMAIL_FILTERED_COPY.reasons[item.reason]}</span></li>)}</ul>
        </Card>
      ) : null}
    </div>
  );
}

function EntryList({ title, hint, entries, draft, setDraft, busy, add, remove, testId }: {
  title: string; hint: string; entries: EmailBotView["trusted"]; draft: string; setDraft: (value: string) => void; busy: boolean; add: () => void; remove: (entry: string) => void; testId: string;
}) {
  return (
    <Card title={title} subtitle={hint}>
      <ul className="space-y-1 text-[13px]" data-testid={testId}>
        {entries.map(item => (
          <li key={item.entry} className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-ink">{item.entry} <span className="text-ink-secondary">({item.sourceLabel})</span></span>
            <button type="button" disabled={busy} onClick={() => remove(item.entry)} className="text-[12.5px] text-accent">{EMAIL_OWNER_COPY.remove}</button>
          </li>
        ))}
      </ul>
      <form className="mt-2 flex gap-2" onSubmit={event => { event.preventDefault(); if (draft.trim()) add(); }}>
        <input value={draft} maxLength={254} onChange={event => setDraft(event.target.value)} aria-label={title} className="min-w-0 flex-1 rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px]" />
        <button type="submit" disabled={busy || !draft.trim()} className={`${button} bg-control text-ink`}>Add</button>
      </form>
    </Card>
  );
}

/** The bot settings `email` section body: reads the status when it mounts; nothing while off. */
export function BotEmailSectionHost({ bot }: { bot: { id: string; name: string; threadId: string } }) {
  const status = useEmailStatus();
  return <BotEmailSection bot={bot} status={status} />;
}

/** The Access section's section 8 line. */
export function BotEmailAccessLine() {
  return <BotEmailFluxLine status={useEmailStatus()} />;
}
