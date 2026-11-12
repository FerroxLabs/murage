// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > Connected apps > Phone calls (BOT-CALLS-1020 sections 1, 2, 3c, 4). Loaded behind `import()` the first time the page
// shows it (SettingsModal.tsx), so neither the screen nor its words ride the first paint (src/first-paint.test.ts).
//
// Setup in the design's order: what it is, the Vapi account, a number that can call out, the key box (the key goes to the
// desktop shell and never comes back), the owner's numbers (read only, setup never dials), the caller settings (both lines on,
// audio recording off, by default), and the line about Vapi's own connector. Then scheduled calls frozen on older settings, with
// Cancel, and the result cards: "View in Vapi", the transcript one tap away, and "Share transcript with bot", which puts the
// fenced transcript in the chat's draft for the owner to send. Outside the desktop app the screen says only that it needs it.
import { useCallback, useEffect, useState } from "react";
import { Phone } from "lucide-react";
import { Card, Switch } from "./SettingsPrimitives";
import { api, useStore } from "@/state/store";
import { localeCode, languageCode } from "@/lib/i18n";
import { localeChoices } from "@/locales";
import { prefillBotChat } from "@/lib/compose-link";
import { chiefFor } from "@/lib/help-ask-chief";
import { FOCUS_COMPOSER_EVENT } from "@/lib/composer-focus";
import { composerReferenceTarget, type ComposerReferenceTarget } from "@/lib/image-reference";
import {
  cancelScheduledCall, costText, dashboardLink, defaultPhoneSettings, editLanguage, findNumbers, keyErrorKey, lengthText, minutesToSeconds,
  phoneCallsAvailable, phoneErrorKey, phoneKeyBridge, readPhoneStatus, recentCalls, savePhoneSettings, shareTranscript, timeText,
  usePhoneCopy, watchRecentCalls, withLineWords, type PhoneCallCard, type PhoneCopy, type PhoneCopyKey, type PhoneNumberInfo, type PhoneSettings, type PhoneStatus,
} from "@/lib/phone-calls";

const VAPI_HOME = "https://vapi.ai";
const VAPI_HELP = "https://docs.vapi.ai";
const button = "min-h-9 rounded-lg px-3 text-[13px] font-medium disabled:opacity-60";
const primary = `${button} bg-accent text-white`;
const secondary = `${button} bg-control text-ink`;
const input = "min-h-11 w-full min-w-0 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink focus-visible:ring-2 focus-visible:ring-accent-border disabled:opacity-50";
const note = "text-[12px] leading-relaxed text-ink-secondary";
const link = "text-[13px] text-accent underline-offset-2 hover:underline";

type Load = { kind: "loading" } | { kind: "ready"; status: PhoneStatus | null } | { kind: "failed" };

export default function PhoneCallsSettings() {
  const copy = usePhoneCopy();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const refresh = useCallback(async () => {
    try { setLoad({ kind: "ready", status: await readPhoneStatus(api) }); } catch { setLoad({ kind: "failed" }); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const bridge = phoneKeyBridge();
  const status = load.kind === "ready" ? load.status : null;
  return (
    <Card>
      <div data-setting-control="phone-calls-heading" tabIndex={-1} className="flex items-center gap-2 text-[15px] font-medium text-ink outline-none"><Phone className="h-4 w-4" aria-hidden />{copy("phoneCalls.title")}</div>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{copy("phoneCalls.intro")}</p>
      <div className="mt-4 space-y-4">
        {load.kind === "loading" && <p role="status" className={note}>{copy("phoneCalls.checking")}</p>}
        {load.kind === "failed" && <p role="alert" className="text-[13px] text-danger">{copy("phoneCalls.error.generic")}</p>}
        {load.kind === "ready" && !phoneCallsAvailable(status, bridge) && (
          <p data-testid="phone-calls-desktop-only" className="text-[13px] text-ink">{copy("phoneCalls.desktopOnly")}</p>
        )}
        {load.kind === "ready" && status && bridge && phoneCallsAvailable(status, bridge) && <Setup copy={copy} status={status} onChanged={refresh} />}
      </div>
    </Card>
  );
}

function Setup({ copy, status, onChanged }: { copy: PhoneCopy; status: PhoneStatus; onChanged: () => Promise<void> }) {
  const { state, dispatch } = useStore();
  const chief = chiefFor(state.bots ?? []);
  const askBot = () => {
    if (!chief) return;
    dispatch({ type: "select", id: chief.id });
    prefillBotChat({ botId: chief.id, threadId: chief.threadId }, copy("phoneCalls.askBotPrompt"));
    dispatch({ type: "toggleAppSettings", open: false });
  };
  return (
    <>
      {chief && <button type="button" className={secondary} onClick={askBot}>{copy("phoneCalls.askBot")}</button>}
      <ol className="list-decimal space-y-4 pl-5 text-[13px] text-ink">
        <li>
          <div>{copy("phoneCalls.step.account")}</div>
          <div className="mt-1 flex gap-3"><a className={link} href={VAPI_HOME} target="_blank" rel="noreferrer">{copy("phoneCalls.link.vapi")}</a></div>
        </li>
        <li>
          <div>{copy("phoneCalls.step.number")}</div>
          <p className={note}>{copy("phoneCalls.step.numberHow")}</p>
          <a className={link} href={VAPI_HELP} target="_blank" rel="noreferrer">{copy("phoneCalls.link.help")}</a>
        </li>
        <li>
          <div>{copy("phoneCalls.step.key")}</div>
          <KeyBox copy={copy} keyPresent={status.keyPresent} onChanged={onChanged} />
        </li>
        {status.keyPresent && <SettingsSteps copy={copy} status={status} ownerName={state.config?.profile?.name ?? ""} onChanged={onChanged} />}
      </ol>
      <p className={note}>{copy("phoneCalls.mcpNote")}</p>
      <p className={note}>{copy("phoneCalls.askNote")}</p>
      {status.keyPresent && <OlderScheduled copy={copy} status={status} onChanged={onChanged} />}
      {status.keyPresent && <RecentCalls copy={copy} />}
    </>
  );
}

function KeyBox({ copy, keyPresent, onChanged }: { copy: PhoneCopy; keyPresent: boolean; onChanged: () => Promise<void> }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PhoneCopyKey | null>(null);
  const act = async (action: "save" | "remove") => {
    const bridge = phoneKeyBridge();
    if (!bridge) return;
    setBusy(true); setError(null);
    try {
      const result = action === "save" ? await bridge.save(value.trim()) : await bridge.remove();
      if (!result.ok) { setError(keyErrorKey(action, result.code)); return; }
      setValue("");
      // main hands the key to the server over its private port; read the status again once that has landed
      await onChanged();
      window.setTimeout(() => void onChanged(), 1_000);
    } catch {
      setError(keyErrorKey(action, undefined));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-2 space-y-2">
      {keyPresent ? (
        <div className="flex items-center gap-3">
          <span data-testid="phone-key-saved" className="text-[13px] text-ink">{copy("phoneCalls.key.saved")}</span>
          <button type="button" className={secondary} disabled={busy} onClick={() => void act("remove")}>{copy("phoneCalls.key.remove")}</button>
        </div>
      ) : (
        <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); if (value.trim()) void act("save"); }}>
          <input
            type="password" autoComplete="off" spellCheck={false} aria-label={copy("phoneCalls.key.label")} placeholder={copy("phoneCalls.key.label")}
            value={value} disabled={busy} onChange={(event) => { setValue(event.target.value); setError(null); }} className={input}
          />
          <button type="submit" className={primary} disabled={busy || !value.trim()}>{copy("phoneCalls.key.save")}</button>
        </form>
      )}
      {error && <p role="alert" className="text-[12px] text-danger">{copy(error)}</p>}
    </div>
  );
}

/** Steps 5 and 6: the owner's numbers, then the caller settings. Saving makes a new settings revision (3c). */
function SettingsSteps({ copy, status, ownerName, onChanged }: { copy: PhoneCopy; status: PhoneStatus; ownerName: string; onChanged: () => Promise<void> }) {
  const [numbers, setNumbers] = useState<PhoneNumberInfo[] | null>(null);
  const [finding, setFinding] = useState(false);
  const [error, setError] = useState<PhoneCopyKey | null>(null);
  const [form, setForm] = useState<PhoneSettings>(() => status.active?.settings ?? defaultPhoneSettings("", ownerName));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<number | null>(null);
  const language = editLanguage(languageCode());

  const find = async () => {
    setFinding(true); setError(null);
    try {
      const found = await findNumbers(api);
      setNumbers(found);
      const callable = found.filter((n) => n.canCallOut);
      if (!found.some((n) => n.id === form.phoneNumberId && n.canCallOut) && callable.length === 1) setForm((f) => ({ ...f, phoneNumberId: callable[0]!.id }));
    } catch (e) { setError(phoneErrorKey(e)); } finally { setFinding(false); }
  };
  const save = async () => {
    setSaving(true); setError(null); setSaved(null);
    try { setSaved(await savePhoneSettings(api, { ...form, ownerName: form.ownerName.trim() })); await onChanged(); }
    catch (e) { setError(phoneErrorKey(e)); } finally { setSaving(false); }
  };
  const picked = numbers?.find((n) => n.id === form.phoneNumberId && n.canCallOut);
  const set = (patch: Partial<PhoneSettings>) => { setSaved(null); setForm((f) => ({ ...f, ...patch })); };

  return (
    <>
      <li>
        <p className={note}>{copy("phoneCalls.numbers.pick")}</p>
        <button type="button" className={`${secondary} mt-2`} disabled={finding} onClick={() => void find()}>{copy("phoneCalls.numbers.find")}</button>
        {numbers && numbers.length === 0 && <p className={`${note} mt-2`}>{copy("phoneCalls.numbers.none")}</p>}
        {numbers && numbers.length > 0 && (
          <div role="radiogroup" className="mt-2 space-y-1">
            {numbers.map((n) => (
              <label key={n.id} className="flex items-center gap-2 text-[13px]">
                <input type="radio" name="phone-number" disabled={!n.canCallOut} checked={form.phoneNumberId === n.id} onChange={() => set({ phoneNumberId: n.id })} />
                <span className={n.canCallOut ? "text-ink" : "text-ink-secondary"}>{n.canCallOut ? n.number : copy("phoneCalls.numbers.inboundOnly", { number: n.number })}</span>
              </label>
            ))}
          </div>
        )}
        {picked && <p data-testid="phone-ready" className="mt-2 text-[13px] text-ink">{copy("phoneCalls.ready", { number: picked.number })}</p>}
      </li>
      <li>
        <div className="font-medium">{copy("phoneCalls.form.title")}</div>
        <div className="mt-2 space-y-3">
          <LineField copy={copy} label={copy("phoneCalls.form.aiLine")} line={form.aiLine} language={language} onChange={(aiLine) => set({ aiLine })}>
            <p className={note}>{copy("phoneCalls.form.aiLaw")}</p>
          </LineField>
          <LineField copy={copy} label={copy("phoneCalls.form.notice")} line={form.notice} language={language} onChange={(notice) => set({ notice })} />
          <label className="block space-y-1">
            <span className={note}>{copy("phoneCalls.form.ownerName")}</span>
            <input className={input} maxLength={80} value={form.ownerName} onChange={(event) => set({ ownerName: event.target.value })} />
          </label>
          <label className="block space-y-1">
            <span className={note}>{copy("phoneCalls.form.language")}</span>
            <select className={input} value={form.language} onChange={(event) => set({ language: event.target.value })}>
              <option value="auto">{copy("phoneCalls.form.languageAuto")}</option>
              {localeChoices.map((choice) => <option key={choice.code} value={choice.code}>{choice.label}</option>)}
            </select>
          </label>
          <label className="block space-y-1">
            <span className={note}>{copy("phoneCalls.form.maxMinutes")}</span>
            <input className={input} type="number" min={1} max={60} step={1} value={Math.round(form.maxSeconds / 60)} onChange={(event) => set({ maxSeconds: minutesToSeconds(Number(event.target.value)) })} />
          </label>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div>{copy("phoneCalls.form.recordAudio")}</div>
              <p className={note}>{copy("phoneCalls.form.recordAudioNote")}</p>
            </div>
            <Switch checked={form.recordAudio} aria-label={copy("phoneCalls.form.recordAudio")} onClick={() => set({ recordAudio: !form.recordAudio })} />
          </div>
          <button type="button" className={primary} disabled={saving || !form.phoneNumberId} onClick={() => void save()}>{copy("phoneCalls.form.save")}</button>
          {saved !== null && <p role="status" className="text-[13px] text-ink">{copy("phoneCalls.form.saved")}</p>}
          {status.active && <p className={note}>{copy("phoneCalls.form.inUse", { revision: status.active.revision })}</p>}
          {error && <p role="alert" className="text-[12px] text-danger">{copy(error)}</p>}
        </div>
      </li>
    </>
  );
}

/** A line the caller says first: a checkbox (on by default) and the owner's own words for the app language. */
function LineField({ copy, label, line, language, onChange, children }: { copy: PhoneCopy; label: string; line: PhoneSettings["aiLine"]; language: string; onChange: (line: PhoneSettings["aiLine"]) => void; children?: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="flex items-center gap-2"><input type="checkbox" checked={line.on} onChange={(event) => onChange({ ...line, on: event.target.checked })} />{label}</label>
      {children}
      {line.on && <input className={input} maxLength={300} aria-label={`${label}: ${copy("phoneCalls.form.ownWords")}`} placeholder={copy("phoneCalls.form.ownWords")} value={line.edits[language] ?? ""} onChange={(event) => onChange(withLineWords(line, language, event.target.value))} />}
    </div>
  );
}

function OlderScheduled({ copy, status, onChanged }: { copy: PhoneCopy; status: PhoneStatus; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<PhoneCopyKey | null>(null);
  const rows = status.olderScheduled;
  if (rows.length === 0) return null;
  const cancel = async (id: string) => {
    setBusy(id); setError(null);
    try { await cancelScheduledCall(api, id); await onChanged(); } catch (e) { setError(phoneErrorKey(e)); } finally { setBusy(null); }
  };
  return (
    <div data-testid="phone-older-scheduled" className="rounded-lg bg-control/40 p-3">
      <p className="text-[13px] font-medium text-ink">{rows.length === 1 ? copy("phoneCalls.older.one") : copy("phoneCalls.older.many", { count: rows.length })}</p>
      <ul className="mt-2 space-y-1">
        {rows.map((row) => (
          <li key={row.id} className="flex items-center justify-between gap-3 text-[13px] text-ink">
            <span>{copy("phoneCalls.calls.to", { number: row.to })}{row.when ? ` · ${copy("phoneCalls.calls.when", { time: timeText(row.when, localeCode()) ?? row.when })}` : ""}</span>
            <button type="button" className={secondary} disabled={busy === row.id} onClick={() => void cancel(row.id)}>{copy("phoneCalls.cancel")}</button>
          </li>
        ))}
      </ul>
      {error && <p role="alert" className="mt-1 text-[12px] text-danger">{copy(error)}</p>}
    </div>
  );
}

function RecentCalls({ copy }: { copy: PhoneCopy }) {
  const [calls, setCalls] = useState<PhoneCallCard[] | null>(null);
  useEffect(() => watchRecentCalls(api, setCalls), []);
  if (!calls) return null;
  return (
    <div className="space-y-2">
      <div className="text-[13px] font-medium text-ink">{copy("phoneCalls.calls.title")}</div>
      {calls.length === 0 && <p className={note}>{copy("phoneCalls.calls.none")}</p>}
      {calls.map((card) => <ResultCard key={card.id} copy={copy} card={card} />)}
    </div>
  );
}

const STATUS_KEYS: Record<string, PhoneCopyKey> = {
  abandoned: "phoneCalls.status.abandoned", uncertain: "phoneCalls.status.uncertain", scheduled: "phoneCalls.status.scheduled", ringing: "phoneCalls.status.ringing", in_progress: "phoneCalls.status.in_progress", ended: "phoneCalls.status.ended", cancelled: "phoneCalls.status.cancelled",
};
const OUTCOME_KEYS: Record<string, PhoneCopyKey> = {
  done: "phoneCalls.outcome.done", not_done: "phoneCalls.outcome.not_done", no_answer: "phoneCalls.outcome.no_answer", voicemail: "phoneCalls.outcome.voicemail", busy: "phoneCalls.outcome.busy", failed: "phoneCalls.outcome.failed",
};

/** Section 4, the owner's card: everything the engine gets plus the reference, the Vapi link and the transcript one tap away. */
export function ResultCard({ copy, card: initialCard }: { copy: PhoneCopy; card: PhoneCallCard }) {
  const [card, setCard] = useState(initialCard);
  const [cancelling, setCancelling] = useState(false);
  useEffect(() => setCard(initialCard), [initialCard]);
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const [shareLine, setShareLine] = useState<PhoneCopyKey | null>(null);
  const locale = localeCode();
  const outcome = card.outcome && OUTCOME_KEYS[card.outcome];
  const statusKey = STATUS_KEYS[card.status];
  const length = lengthText(card.length_seconds);
  const cost = costText(card.cost, locale);
  const dashboard = dashboardLink(card);
  const cancel = async () => {
    setCancelling(true); setShareLine(null);
    try {
      await cancelScheduledCall(api, card.id);
      const refreshed = (await recentCalls(api)).find(row => row.id === card.id);
      if (refreshed) setCard(refreshed);
    } catch (error) { setShareLine(phoneErrorKey(error)); }
    finally { setCancelling(false); }
  };
  const share = async () => {
    setShareLine(null);
    // the chat on screen, else the Chief's chat
    const chief = chiefFor(state.bots ?? []);
    const onScreen = composerReferenceTarget();
    const target: ComposerReferenceTarget | undefined = onScreen ?? (chief ? { botId: chief.id, threadId: chief.threadId, draftId: `bot:${chief.id}:${chief.threadId}` } : undefined);
    try {
      const result = await shareTranscript(api, card.id, target);
      if (result.status === "added") {
        setShareLine("phoneCalls.calls.shared");
        if (!onScreen && result.target.botId) dispatch({ type: "select", id: result.target.botId });
        dispatch({ type: "toggleAppSettings", open: false });
        const botId = result.target.botId;
        requestAnimationFrame(() => requestAnimationFrame(() => window.dispatchEvent(new CustomEvent(FOCUS_COMPOSER_EVENT, { detail: botId ? { botId } : {} }))));
      } else if (result.status === "no-chat") setShareLine("phoneCalls.calls.noChat");
      else if (result.status === "none") setShareLine("phoneCalls.calls.noTranscript");
      else setShareLine("phoneCalls.error.generic");
    } catch (error) { setShareLine(phoneErrorKey(error)); }
  };
  return (
    <div data-testid="phone-result-card" className="rounded-lg border border-hairline/40 p-3 text-[13px] text-ink">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">{outcome ? copy(outcome) : statusKey ? copy(statusKey) : card.status}</span>
        <span className="text-ink-secondary">{copy("phoneCalls.calls.to", { number: card.to })}</span>
        {card.status === "scheduled" && card.when && <span className="text-ink-secondary">{copy("phoneCalls.calls.when", { time: timeText(card.when, locale) ?? card.when })}</span>}
      </div>
      {card.goal && <p className="mt-1 text-ink-secondary">{card.goal}</p>}
      <div className="mt-1 flex flex-wrap gap-x-3 text-[12px] text-ink-secondary">
        {card.reference && <span>{copy("phoneCalls.calls.reference", { reference: card.reference })}</span>}
        {card.time && <span>{timeText(card.time, locale)}</span>}
        {length && <span>{copy("phoneCalls.calls.length", { time: length })}</span>}
        {cost && <span>{copy("phoneCalls.calls.cost", { cost })}</span>}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {(card.status === "scheduled" || card.status === "uncertain") && <button type="button" className={secondary} disabled={cancelling} onClick={() => void cancel()}>{copy("phoneCalls.cancel")}</button>}
        {dashboard && <a className={link} href={dashboard} target="_blank" rel="noreferrer">{copy("phoneCalls.viewInVapi")}</a>}
        <button type="button" className={link} aria-expanded={open} onClick={() => setOpen(!open)}>{copy(open ? "phoneCalls.calls.hideTranscript" : "phoneCalls.calls.showTranscript")}</button>
        {card.transcript && <button type="button" className={secondary} onClick={() => void share()}>{copy("phoneCalls.shareTranscript")}</button>}
      </div>
      {open && (card.transcript
        ? <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-control/40 p-2 text-[12px]">{card.transcript}</pre>
        : <p className={`${note} mt-2`}>{copy("phoneCalls.calls.noTranscript")}</p>)}
      {shareLine && <p role="status" className="mt-1 text-[12px] text-ink-secondary">{copy(shareLine)}</p>}
    </div>
  );
}
