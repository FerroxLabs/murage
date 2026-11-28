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
import { useCallback, useEffect, useRef, useState } from "react";
import { Phone } from "lucide-react";
import { Card, Switch } from "./SettingsPrimitives";
import { api, useStore } from "@/state/store";
import { localeCode, languageCode, t } from "@/lib/i18n";
import { prefillBotChat } from "@/lib/compose-link";
import { chiefFor } from "@/lib/help-ask-chief";
import { FOCUS_COMPOSER_EVENT } from "@/lib/composer-focus";
import { composerReferenceTarget, type ComposerReferenceTarget } from "@/lib/image-reference";
import {
  CALL_LANGUAGES, cancelHeldCall, cancelScheduledCall, costText, dashboardLink, defaultPhoneSettings, deleteCall, editLanguage, findNumbers, getRetention,
  keepHeldCall, keyErrorKey, lengthText, listBots, minutesToSeconds, phoneActionEffect, phoneCallsAvailable, phoneErrorKey, phoneKeyBridge, readPhoneStatus,
  recentCalls, resultReasonKey, savePhoneSettings, setBotAllowed, setRetention, shareTranscript, timeText, usePhoneCopy, watchRecentCalls, withLineWords,
  type PhoneAction, type PhoneBotRow, type PhoneCallCard, type PhoneCopy, type PhoneCopyKey, type PhoneNumberInfo, type PhoneRetention, type PhoneSettings,
  type PhoneStatus, type RecentCallsWatch,
} from "@/lib/phone-calls";

const VAPI_HOME = "https://vapi.ai";
const VAPI_HELP = "https://docs.vapi.ai";
const button = "min-h-9 rounded-lg px-3 text-[13px] font-medium disabled:opacity-60";
const primary = `${button} bg-accent text-white`;
const secondary = `${button} bg-control text-ink`;
const input = "min-h-11 w-full min-w-0 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink focus-visible:ring-2 focus-visible:ring-accent-border disabled:opacity-50";
const note = "text-[12px] leading-relaxed text-ink-secondary";
const link = "text-[13px] text-accent underline-offset-2 hover:underline";

type Load = { kind: "loading" } | { kind: "ready"; status: PhoneStatus | null } | { kind: "failed"; error?: ReturnType<typeof phoneErrorKey> };

/** The full card needs a connected voice account, or (FABLE-DESIGN 2060 H1) a call history the owner still holds. Without a key
 *  it holds the key box first, then that history and its controls (Call history, Delete, Keep transcripts for, Upcoming calls,
 *  Which bots may phone). An owner who never set phone calls up keeps the compact connection entry and nothing reads or polls. */
export function phoneCallsCardShown(load: Load, bridge: ReturnType<typeof phoneKeyBridge>): boolean {
  return load.kind === "ready" && (load.status?.keyPresent === true || load.status?.hasCalls === true) && phoneCallsAvailable(load.status, bridge);
}

export default function PhoneCallsSettings() {
  const copy = usePhoneCopy();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const refresh = useCallback(async () => {
    try { setLoad({ kind: "ready", status: await readPhoneStatus(api) }); } catch (error) { setLoad({ kind: "failed", error: phoneErrorKey(error) }); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const bridge = phoneKeyBridge();
  if (!bridge) return null;
  if (load.kind === "loading") return <p role="status" className={note}>{copy("phoneCalls.checking")}</p>;
  if (load.kind === "failed") return (
    <div className="flex flex-wrap items-center gap-2">
      <p role="alert" className="text-[13px] text-danger">{copy(load.error ?? "phoneCalls.error.generic")}</p>
      <button type="button" className={secondary} onClick={() => { setLoad({ kind: "loading" }); void refresh(); }}>{t("providerError.retry")}</button>
    </div>
  );
  const { status } = load;
  if (!status) return null;
  if (!phoneCallsCardShown(load, bridge)) {
    if (!phoneCallsAvailable(status, bridge)) return null;
    return (
      <details className="px-1 text-[13px] text-ink">
        <summary className="min-h-9 cursor-pointer py-2 font-medium">{copy("phoneCalls.title")}</summary>
        <p className={note}>{copy("phoneCalls.step.key")}</p>
        <a className={link} href={VAPI_HOME} target="_blank" rel="noreferrer">{copy("phoneCalls.link.vapi")}</a>
        <KeyBox copy={copy} keyPresent={false} onChanged={refresh} />
      </details>
    );
  }
  return (
    <Card>
      <div data-setting-control="phone-calls-heading" tabIndex={-1} className="flex items-center gap-2 text-[15px] font-medium text-ink outline-none"><Phone className="h-4 w-4" aria-hidden />{copy("phoneCalls.title")}</div>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{copy("phoneCalls.intro")}</p>
      {status.storeUnavailable && <p role="alert" className="mt-2 text-[13px] text-danger">{copy("phoneCalls.error.store")}</p>}
      {status.paused && <p role="alert" className="mt-2 text-[13px] text-danger">{copy("phoneCalls.error.upgrade")}</p>}
      <div className="mt-4 space-y-4">
        <Setup copy={copy} status={status} onChanged={refresh} />
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
  const history = !status.storeUnavailable;
  if (!status.keyPresent) return (
    <>
      <div>
        <div className="text-[13px] text-ink">{copy("phoneCalls.step.key")}</div>
        <a className={link} href={VAPI_HOME} target="_blank" rel="noreferrer">{copy("phoneCalls.link.vapi")}</a>
        <KeyBox copy={copy} keyPresent={false} onChanged={onChanged} />
      </div>
      {history && <OwnerHistory copy={copy} status={status} onChanged={onChanged} />}
    </>
  );
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
        <SettingsSteps copy={copy} status={status} ownerName={state.config?.profile?.name ?? ""} onChanged={onChanged} />
      </ol>
      <p className={note}>{copy("phoneCalls.mcpNote")}</p>
      <p className={note}>{copy("phoneCalls.askNote")}</p>
      {history && <OwnerHistory copy={copy} status={status} onChanged={onChanged} />}
    </>
  );
}

/** What the owner keeps with or without a key (S4): upcoming calls, which bots may phone, retention and the call history. */
function OwnerHistory({ copy, status, onChanged }: { copy: PhoneCopy; status: PhoneStatus; onChanged: () => Promise<void> }) {
  return (
    <>
      <OlderScheduled copy={copy} status={status} onChanged={onChanged} />
      <BotSwitches copy={copy} />
      <RetentionPicker copy={copy} />
      <RecentCalls copy={copy} keyPresent={status.keyPresent} />
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
export function SettingsSteps({ copy, status, ownerName, onChanged }: { copy: PhoneCopy; status: PhoneStatus; ownerName: string; onChanged: () => Promise<void> }) {
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
          <p data-testid="phone-responsibility" className={note}>{copy("phoneCalls.settings.responsibility")}</p>
          <label className="block space-y-1">
            <span className={note}>{copy("phoneCalls.form.ownerName")}</span>
            <input className={input} maxLength={80} value={form.ownerName} onChange={(event) => set({ ownerName: event.target.value })} />
          </label>
          <label className="block space-y-1">
            <span className={note}>{copy("phoneCalls.form.language")}</span>
            <select className={input} value={form.language} onChange={(event) => set({ language: event.target.value })}>
              <option value="auto">{copy("phoneCalls.form.languageAuto")}</option>
              {CALL_LANGUAGES.map((code) => <option key={code} value={code}>{languageName(code)}</option>)}
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
          {form.recordAudio && !form.notice.on && <p role="note" data-testid="phone-recording-warning" className={note}>{copy("phoneCalls.settings.recordingNoNotice")}</p>}
          <button type="button" className={primary} disabled={saving || !form.phoneNumberId} onClick={() => void save()}>{copy("phoneCalls.form.save")}</button>
          {saved !== null && <p role="status" className="text-[13px] text-ink">{copy("phoneCalls.form.saved")}</p>}
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
      <label className="flex items-center gap-2"><input type="checkbox" checked={line.on} onChange={(event) => onChange({ ...line, on: event.target.checked })} />{label}<span className="text-ink-secondary">({copy("phoneCalls.settings.recommended")})</span></label>
      {children}
      {line.on && <input className={input} maxLength={300} aria-label={`${label}: ${copy("phoneCalls.form.ownWords")}`} placeholder={copy("phoneCalls.form.ownWords")} value={line.edits[language] ?? ""} onChange={(event) => onChange(withLineWords(line, language, event.target.value))} />}
    </div>
  );
}

function OlderScheduled({ copy, status, onChanged }: { copy: PhoneCopy; status: PhoneStatus; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<PhoneCopyKey | null>(null);
  const rows = status.olderScheduled;
  const count = status.olderScheduledCount ?? rows.length;
  if (rows.length === 0 && count === 0) return null;
  const cancel = async (id: string) => {
    setBusy(id); setError(null);
    try { await cancelScheduledCall(api, id); await onChanged(); } catch (e) { setError(phoneErrorKey(e)); } finally { setBusy(null); }
  };
  return (
    <div data-testid="phone-older-scheduled" className="rounded-lg bg-control/40 p-3">
      <p className="text-[13px] font-medium text-ink">{count === 1 ? copy("phoneCalls.older.one") : copy("phoneCalls.older.many", { count })}</p>
      <ul className="mt-2 space-y-1">
        {rows.map((row) => (
          <li key={row.id} className="flex items-center justify-between gap-3 text-[13px] text-ink">
            <span>{copy("phoneCalls.calls.to", { number: row.to })}{row.when ? ` · ${copy("phoneCalls.calls.when", { time: timeText(row.when, localeCode()) ?? row.when })}` : ""}</span>
            {status.keyPresent && <button type="button" className={secondary} disabled={busy === row.id} onClick={() => void cancel(row.id)}>{copy("phoneCalls.cancel")}</button>}
          </li>
        ))}
      </ul>
      {error && <p role="alert" className="mt-1 text-[12px] text-danger">{copy(error)}</p>}
    </div>
  );
}

function RecentCalls({ copy, keyPresent }: { copy: PhoneCopy; keyPresent: boolean }) {
  const [calls, setCalls] = useState<PhoneCallCard[] | null>(null);
  const [storeDown, setStoreDown] = useState(false);
  const watch = useRef<RecentCallsWatch | null>(null);
  useEffect(() => {
    // a history that cannot be read says so; it is never shown as "no calls"
    const stop = watchRecentCalls(api, (next) => { setStoreDown(false); setCalls(next); }, (error) => setStoreDown(phoneErrorKey(error) === "phoneCalls.error.store"));
    watch.current = stop;
    return () => { watch.current = null; stop(); };
  }, []);
  if (!calls) return null;
  return (
    <div className="space-y-2">
      <div className="text-[13px] font-medium text-ink">{copy("phoneCalls.calls.title")}</div>
      {storeDown && <p role="alert" data-testid="phone-store-down" className="text-[12px] text-danger">{copy("phoneCalls.error.store")}</p>}
      {calls.length === 0 && !storeDown && <p className={note}>{copy("phoneCalls.calls.none")}</p>}
      {calls.map((card) => <ResultCard key={card.id} copy={copy} card={card} keyPresent={keyPresent} onRefresh={() => watch.current?.refreshNow()} />)}
    </div>
  );
}

/** One language's name in the app language (the code itself where the platform has none). */
function languageName(code: string): string {
  try { return new Intl.DisplayNames([localeCode()], { type: "language" }).of(code) ?? code; } catch { return code; }
}

const PAGE_KEEP: { days: PhoneRetention; key: PhoneCopyKey }[] = [
  { days: 30, key: "phoneCalls.settings.keep30" }, { days: 90, key: "phoneCalls.settings.keep90" }, { days: null, key: "phoneCalls.settings.keepForever" },
];

/** "Keep transcripts for": 30 days, 90 days or until the owner deletes. The select shows what the server holds. */
function RetentionPicker({ copy }: { copy: PhoneCopy }) {
  const [days, setDays] = useState<PhoneRetention | undefined>(undefined);
  const [error, setError] = useState<PhoneCopyKey | null>(null);
  useEffect(() => { let live = true; getRetention(api).then((d) => { if (live) setDays(d); }, (e) => { if (live) setError(phoneErrorKey(e)); }); return () => { live = false; }; }, []);
  if (days === undefined) return error ? <p role="alert" className="text-[12px] text-danger">{copy(error)}</p> : null;
  const change = async (value: string) => {
    setError(null);
    try { setDays(await setRetention(api, value === "30" ? 30 : value === "90" ? 90 : null)); } catch (e) { setError(phoneErrorKey(e)); }
  };
  return (
    <label className="block space-y-1">
      <span className={note}>{copy("phoneCalls.settings.keepTranscripts")}</span>
      <select data-testid="phone-retention" className={input} value={days === null ? "forever" : String(days)} onChange={(event) => void change(event.target.value)}>
        {PAGE_KEEP.map((o) => <option key={String(o.days)} value={o.days === null ? "forever" : String(o.days)}>{copy(o.key)}</option>)}
      </select>
      {error && <p role="alert" className="text-[12px] text-danger">{copy(error)}</p>}
    </label>
  );
}

/** "Which bots may phone businesses": pages of 200 with Show more, one switch each that shows the server's answer. */
function BotSwitches({ copy }: { copy: PhoneCopy }) {
  const [bots, setBots] = useState<PhoneBotRow[] | null>(null);
  const [next, setNext] = useState<string | undefined>(undefined);
  const [error, setError] = useState<PhoneCopyKey | null>(null);
  const [paging, setPaging] = useState(false);
  const load = useCallback(async (after: string | undefined, restarted = false): Promise<void> => {
    setPaging(true);
    try {
      const page = await listBots(api, after);
      setNext(page.next);
      setBots((prev) => (after && prev ? [...prev, ...page.bots] : page.bots));
    } catch (e) {
      // a bot deleted between pages: start again from the first page, once
      if (phoneActionEffect("other", e).restartBots && !restarted) return load(undefined, true);
      setError(phoneErrorKey(e));
    } finally { setPaging(false); }
  }, []);
  useEffect(() => { void load(undefined); }, [load]);
  if (!bots) return error ? <p role="alert" className="text-[12px] text-danger">{copy(error)}</p> : null;
  const flip = async (bot: PhoneBotRow) => {
    setError(null);
    try {
      const allowed = await setBotAllowed(api, bot.id, !bot.allowed);
      setBots((prev) => prev?.map((b) => (b.id === bot.id ? { ...b, allowed } : b)) ?? prev);
    } catch (e) {
      // a bot deleted elsewhere (404) or a lost answer: read the list again, never keep a value the server may not hold
      const effect = phoneActionEffect("other", e);
      if (effect.refresh) await load(undefined, true); else setError(phoneErrorKey(e));
    }
  };
  return (
    <div data-testid="phone-bots" className="space-y-1">
      <div className="text-[13px] font-medium text-ink">{copy("phoneCalls.settings.whichBots")}</div>
      {bots.map((bot) => (
        <div key={bot.id} className="flex items-center justify-between gap-3 text-[13px] text-ink">
          <span>{bot.name}</span>
          <Switch checked={bot.allowed} aria-label={copy("phoneCalls.settings.botAria", { bot: bot.name })} onClick={() => void flip(bot)} />
        </div>
      ))}
      {next && <button type="button" className={secondary} disabled={paging} onClick={() => { if (!paging) void load(next); }}>{copy("phoneCalls.settings.showMore")}</button>}
      {error && <p role="alert" className="text-[12px] text-danger">{copy(error)}</p>}
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
export function ResultCard({ copy, card: initialCard, keyPresent = true, onRefresh }: { copy: PhoneCopy; card: PhoneCallCard; keyPresent?: boolean; onRefresh?: () => void }) {
  const [card, setCard] = useState(initialCard);
  const [cancelling, setCancelling] = useState(false);
  const [actionLine, setActionLine] = useState<PhoneCopyKey | null>(null);
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
  // Every owner action: a refusal shows its own line under the row, a 404 only reads the list again, and the fresh list (never the
  // action's answer) decides whether the row exists and in which state.
  const act = async (action: PhoneAction, run: () => Promise<void>) => {
    setCancelling(true); setShareLine(null); setActionLine(null);
    try {
      await run();
      if (onRefresh) onRefresh();
      else {
        const refreshed = (await recentCalls(api)).find(row => row.id === card.id);
        if (refreshed) setCard(refreshed);
      }
    } catch (error) {
      const effect = phoneActionEffect(action, error);
      setActionLine(effect.line);
      if (effect.refresh) onRefresh?.();
    } finally { setCancelling(false); }
  };
  const cancel = () => act("cancel", () => (card.state === "held" ? cancelHeldCall(api, card.id) : cancelScheduledCall(api, card.id)));
  const keep = () => act("keep", () => keepHeldCall(api, card.id));
  const remove = () => act("delete", () => deleteCall(api, card.id));
  // Controls come from the server's `state` alone. A card with no `state` (an older server) keeps the shipped rule.
  const rowState = card.state;
  const canCancel = rowState === undefined ? (card.status === "scheduled" || card.status === "uncertain") : rowState === "held" || (rowState === "live" && keyPresent);
  const canKeep = rowState === "held" && card.canKeep === true && keyPresent;
  const canDelete = rowState === "settled";
  const stateLine: PhoneCopyKey | null = rowState === "live" && !keyPresent ? "phoneCalls.delete.needKey"
    : rowState === "checking" ? (keyPresent ? "phoneCalls.delete.checking" : "phoneCalls.delete.needKey")
    : rowState === "cancelling" ? (keyPresent ? "phoneCalls.delete.cancelPending" : "phoneCalls.delete.needKey") : null;
  const reasonKey = resultReasonKey(card.reason);
  const language = card.language ? languageName(card.language) : null;
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
    <div data-testid="phone-result-card" data-call-id={card.id} className="rounded-lg border border-hairline/40 p-3 text-[13px] text-ink">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">{outcome ? copy(outcome) : statusKey ? copy(statusKey) : card.status}</span>
        <span className="text-ink-secondary">{copy("phoneCalls.calls.to", { number: card.to })}</span>
        {card.status === "scheduled" && card.when && <span className="text-ink-secondary">{copy("phoneCalls.calls.when", { time: timeText(card.when, locale) ?? card.when })}</span>}
      </div>
      {card.goal && <p className="mt-1 text-ink-secondary">{card.goal}</p>}
      {reasonKey && <p data-testid="phone-result-reason" className="mt-1 text-ink-secondary">{copy(reasonKey)}</p>}
      {card.bookingState && <p data-testid="phone-booking" className="mt-1 text-ink-secondary">{copy(card.bookingState === "unclear" ? "phoneCalls.booking.unclear" : `phoneCalls.booking.${card.bookingState}`)}</p>}
      {language && <p className="mt-1 text-[12px] text-ink-secondary">{copy("phoneCalls.card.language", { language })}</p>}
      {card.languageFallback && <p data-testid="phone-language-fallback" className="mt-1 text-[12px] text-ink-secondary">{copy("phoneCalls.card.languageFallback", { wanted: languageName(card.languageFallback.wanted), language: languageName(card.languageFallback.language) })}</p>}
      <div className="mt-1 flex flex-wrap gap-x-3 text-[12px] text-ink-secondary">
        {card.reference && <span>{copy("phoneCalls.calls.reference", { reference: card.reference })}</span>}
        {card.time && <span>{timeText(card.time, locale)}</span>}
        {length && <span>{copy("phoneCalls.calls.length", { time: length })}</span>}
        {cost && <span>{copy("phoneCalls.calls.cost", { cost })}</span>}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {canCancel && <button type="button" className={secondary} disabled={cancelling} onClick={() => void cancel()}>{copy("phoneCalls.cancel")}</button>}
        {canKeep && <button type="button" className={secondary} disabled={cancelling} onClick={() => void keep()}>{copy("phoneCalls.held.keep")}</button>}
        {canDelete && <button type="button" className={secondary} disabled={cancelling} onClick={() => void remove()}>{copy("phoneCalls.delete.action")}</button>}
        {dashboard && <a className={link} href={dashboard} target="_blank" rel="noreferrer">{copy("phoneCalls.viewInVapi")}</a>}
        <button type="button" className={link} aria-expanded={open} onClick={() => setOpen(!open)}>{copy(open ? "phoneCalls.calls.hideTranscript" : "phoneCalls.calls.showTranscript")}</button>
        {card.transcript && <button type="button" className={secondary} onClick={() => void share()}>{copy("phoneCalls.shareTranscript")}</button>}
      </div>
      {open && (card.transcript
        ? <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-control/40 p-2 text-[12px]">{card.transcript}</pre>
        : <p className={`${note} mt-2`}>{copy("phoneCalls.calls.noTranscript")}</p>)}
      {stateLine && <p data-testid="phone-state-line" className="mt-1 text-[12px] text-ink-secondary">{copy(stateLine)}</p>}
      {actionLine && <p role="status" data-testid="phone-action-line" className="mt-1 text-[12px] text-ink-secondary">{copy(actionLine)}</p>}
      {shareLine && <p role="status" className="mt-1 text-[12px] text-ink-secondary">{copy(shareLine)}</p>}
    </div>
  );
}
