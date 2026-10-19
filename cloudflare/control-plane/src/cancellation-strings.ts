// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloud checkout WP8: every customer-facing word of the 312k BGB cancellation (plan 5.2) and the pure date helpers it needs.
// The English and German sentences are copied from STRIPE-HOSTED-PLAN.md r13c 5.2 word for word (a script checks them against the plan).
// Where the plan gives no German, `de` is null: the English text is sent and the string is listed in MISSING_DE (a launch gate, not
// something to translate here).
export type Lang = "en" | "de";
export type CancelKind = "ordinary_earliest" | "ordinary_date" | "extraordinary";
export type CancelType = "end_of_paid_month" | "on_date" | "now_for_cause";
export const KIND_OF_TYPE: Record<CancelType, CancelKind> = { end_of_paid_month: "ordinary_earliest", on_date: "ordinary_date", now_for_cause: "extraordinary" };
export const TYPE_OF_KIND: Record<CancelKind, CancelType> = { ordinary_earliest: "end_of_paid_month", ordinary_date: "on_date", extraordinary: "now_for_cause" };

type Pair = { en: string; de: string | null };
export const S = {
  declaration: { en: "This is your cancellation declaration, made by pressing Cancel now on {received_at}, the time we received it.",
    de: "Dies ist Ihre Kündigungserklärung, abgegeben durch Drücken von „Jetzt kündigen“ am {received_at}, dem Zeitpunkt, zu dem wir sie erhalten haben." },
  endMonth: { en: "Your plan ends on {period_end}.", de: "Ihr Plan endet am {period_end}." },
  onDate: { en: "You asked to end your plan on {requested_date}. It ends on {effective_at}, the end of the month you have paid for that includes that date.",
    de: "Sie haben verlangt, Ihren Plan am {requested_date} zu beenden. Er endet am {effective_at}, dem Ende des bezahlten Monats, in den dieses Datum fällt." },
  now: { en: "You asked to end your plan now, on {received_at}. We check your reason within 3 working days. If we accept it, your plan ended on {received_at} and we refund the unused days. If not, it ends on {period_end} and we tell you why.",
    de: "Sie haben verlangt, Ihren Plan sofort zu beenden, zum {received_at}. Wir prüfen Ihren Grund innerhalb von 3 Werktagen. Wenn wir ihn annehmen, endete Ihr Plan am {received_at} und wir erstatten die ungenutzten Tage. Wenn nicht, endet er am {period_end} und wir sagen Ihnen, warum." },
  wasntMe: { en: "If this wasn't you, press This wasn't me.", de: "Falls Sie das nicht waren, drücken Sie Das war ich nicht." },
  unmatched: { en: "We received your cancellation on {received_at}. You asked to end your plan {asked}. Your plan ends {ends}. We are finding your plan and will send the exact date.",
    de: "Wir haben Ihre Kündigung am {received_at} erhalten. Sie haben verlangt, Ihren Plan {asked} zu beenden. Ihr Plan endet {ends}. Wir suchen Ihren Plan und senden Ihnen das genaue Datum." },
  askedEarliest: { en: "at the end of the month you have paid for", de: "zum Ende des bezahlten Monats" },
  askedDate: { en: "on {requested_date}", de: "am {requested_date}" },
  askedNow: { en: "now, for a serious reason", de: "sofort aus wichtigem Grund" },
  endsEarliest: { en: "at the end of the month you have paid for that was running on {received_at}", de: "am Ende des bezahlten Monats, der am {received_at} lief" },
  endsDate: { en: "at the end of the paid month that includes {requested_date}", de: "am Ende des bezahlten Monats, in den der {requested_date} fällt" },
  endsNow: { en: "on {received_at} if we accept your reason, otherwise at the end of the month you have paid for",
    de: "am {received_at}, wenn wir Ihren Grund annehmen, sonst am Ende des bezahlten Monats" },
  heldMail: { en: "We've put the cancellation on hold and your plan continues. If you do want to cancel, use Cancel your contract here or your account page.",
    de: "Wir haben die Kündigung angehalten, und Ihr Plan läuft weiter. Wenn Sie doch kündigen möchten, nutzen Sie „Verträge hier kündigen“ oder Ihre Kontoseite." },
  tooLateExecuting: { en: "This cancellation is already being carried out, so we could not put it on hold. We have opened a case and will look at it.",
    de: "Diese Kündigung wird bereits ausgeführt, deshalb konnten wir sie nicht anhalten. Wir haben einen Fall eröffnet und prüfen ihn." },
  tooLateCompleted: { en: "This cancellation already took effect on {effective_at}, so we could not put it on hold. We have opened a case and will look at it. You can start a new plan at any time.",
    de: "Diese Kündigung ist bereits am {effective_at} wirksam geworden, deshalb konnten wir sie nicht anhalten. Wir haben einen Fall eröffnet und prüfen ihn. Sie können jederzeit einen neuen Plan starten." },
  // Receipt field labels (plan 5.2 Confirmation page; German given there for these).
  lblAccountEmail: { en: "Email address of your Murage account", de: "E-Mail-Adresse Ihres Murage-Kontos" },
  lblName: { en: "Your name", de: "Ihr Name" },
  lblIdentifier: { en: "Something else that identifies your plan (optional): invoice number, or the email on your receipt",
    de: "Etwas anderes, das Ihren Plan identifiziert (optional): Rechnungsnummer oder die E-Mail-Adresse auf Ihrer Quittung" },
  lblConfirmEmail: { en: "Email for your confirmation", de: "E-Mail-Adresse für Ihre Bestätigung" },
  download: { en: "Download", de: "Herunterladen" },
  choiceEarliest: { en: "End my plan at the end of the month I've paid for", de: "Zum Ende des bezahlten Monats kündigen" },
  choiceDate: { en: "End my plan on this date", de: "Zu diesem Datum kündigen" },
  choiceNow: { en: "End my plan now for a serious reason", de: "Sofort kündigen aus wichtigem Grund (außerordentliche Kündigung)" },
  // Not in the plan; the German below came from the 2026-10-11 review (checkout/MISSING-DE-TRANSLATIONS.md).
  title: { en: "Your cancellation declaration", de: "Ihre Kündigungserklärung" },
  lblReference: { en: "Reference", de: "Referenz" },
  lblReceived: { en: "Received", de: "Eingang" },
  lblType: { en: "What you asked for", de: "Was Sie verlangt haben" },
  lblDate: { en: "Date you asked for", de: "Gewünschtes Datum" },
  lblReason: { en: "Reason", de: "Grund" },
  subjectReceipt: { en: "Your Murage Cloud cancellation", de: "Ihre Murage-Cloud-Kündigung" },
  subjectHeld: { en: "Your Murage Cloud cancellation is on hold", de: "Ihre Murage-Cloud-Kündigung ist angehalten" },
  subjectRejected: { en: "Your Murage Cloud cancellation: we could not accept the reason", de: "Ihre Murage-Cloud-Kündigung: wir konnten den Grund nicht annehmen" },
  subjectAccepted: { en: "Your Murage Cloud plan has ended", de: "Ihr Murage-Cloud-Plan ist beendet" },
  subjectLate: { en: "Your Murage Cloud cancellation: a charge was refunded", de: "Ihre Murage-Cloud-Kündigung: eine Abbuchung wurde erstattet" },
  wasntMeLink: { en: "This wasn't me:", de: "Das war ich nicht:" },
  rejectedMail: { en: "We checked the reason you gave and could not accept it as a serious reason. Your cancellation still counts from {received_at}: your plan ends on {period_end}, the end of the month you have paid for. Why: {note}", de: "Wir haben Ihren Grund geprüft und konnten ihn nicht als wichtigen Grund annehmen. Ihre Kündigung gilt weiterhin ab {received_at}: Ihr Plan endet am {period_end}, dem Ende des bezahlten Monats. Warum: {note}" },
  acceptedMail: { en: "We accepted your reason. Your plan ended on {effective_at} and we are refunding the unused days.", de: "Wir haben Ihren Grund angenommen. Ihr Plan endete am {effective_at}, und wir erstatten die ungenutzten Tage." },
  lateMail: { en: "A renewal was charged after your plan ended on {effective_at}. We have refunded it in full and your service has ended.", de: "Nach dem Ende Ihres Plans am {effective_at} wurde eine Verlängerung abgebucht. Wir haben sie vollständig erstattet, und Ihr Dienst ist beendet." },
  // r2 (Astra WP8-2 #7, P2 #8): execution and refund told apart. Not in the plan's German either; German from the 2026-10-11 review (checkout/MISSING-DE-TRANSLATIONS.md).
  lateMailDelayed: { en: "A renewal was charged after your plan ended on {effective_at}. Your service has ended. We are refunding that charge in full; the refund is delayed and we are trying again.", de: "Nach dem Ende Ihres Plans am {effective_at} wurde eine Verlängerung abgebucht. Ihr Dienst ist beendet. Wir erstatten diese Abbuchung vollständig; die Erstattung ist verzögert, und wir versuchen es erneut." },
  // r3 (Astra WP8-3 #6): the subject follows the same ledger state as the body; a delayed refund never has a "refunded" subject. Not in the
  // plan's German; German from the 2026-10-11 review (checkout/MISSING-DE-TRANSLATIONS.md).
  subjectLateDelayed: { en: "Your Murage Cloud cancellation: a refund is delayed", de: "Ihre Murage-Cloud-Kündigung: eine Erstattung ist verzögert" },
  // r3 (Astra WP8-3 #3): a renewal that straddles the end is refunded only for the time after it. No plan German; German from the 2026-10-11 review (checkout/MISSING-DE-TRANSLATIONS.md).
  lateMailPart: { en: "A renewal covering time after your plan ended on {effective_at} was charged. We have refunded the part for the time after that date, and your service has ended.", de: "Es wurde eine Verlängerung abgebucht, die Zeit nach dem Ende Ihres Plans am {effective_at} abdeckt. Wir haben den Teil für die Zeit nach diesem Datum erstattet, und Ihr Dienst ist beendet." },
  lateMailPartDelayed: { en: "A renewal covering time after your plan ended on {effective_at} was charged. Your service has ended. We are refunding the part for the time after that date; the refund is delayed and we are trying again.", de: "Es wurde eine Verlängerung abgebucht, die Zeit nach dem Ende Ihres Plans am {effective_at} abdeckt. Ihr Dienst ist beendet. Wir erstatten den Teil für die Zeit nach diesem Datum; die Erstattung ist verzögert, und wir versuchen es erneut." },
  acceptedMailNoRefund: { en: "We accepted your reason. Your plan ended on {effective_at}. Nothing was paid for the time after that, so there is nothing to refund.", de: "Wir haben Ihren Grund angenommen. Ihr Plan endete am {effective_at}. Für die Zeit danach wurde nichts bezahlt, deshalb gibt es nichts zu erstatten." },
} as const satisfies Record<string, Pair>;
export type StringKey = keyof typeof S;

/** Every string that has no German yet. A launch gate: the test prints it, nothing here translates it. */
export const MISSING_DE: StringKey[] = (Object.keys(S) as StringKey[]).filter((k) => S[k].de === null);

export const t = (key: StringKey, lang: Lang, vars: Record<string, string> = {}): string => {
  const p: Pair = S[key];
  const base = lang === "de" && p.de !== null ? p.de : p.en;
  return base.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
};

// --- dates ---------------------------------------------------------------------------------------------------------------------------

const p2 = (n: number) => String(n).padStart(2, "0");
/** UTC date of an instant: "2026-11-10" (en), "10.11.2026" (de). */
export function fmtDate(ms: number, lang: Lang): string {
  const d = new Date(ms);
  return lang === "de" ? `${p2(d.getUTCDate())}.${p2(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}` : `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}
/** "YYYY-MM-DD" as typed -> the same date in the language's format. */
export const fmtYmd = (ymd: string, lang: Lang): string => lang === "de" ? ymd.split("-").reverse().join(".") : ymd;
const lastSundayUtc = (year: number, monthIndex: number): number => {
  const last = new Date(Date.UTC(year, monthIndex + 1, 0, 1));
  return last.getTime() - last.getUTCDay() * 86_400_000;
};
/** Europe/Berlin at an instant: MESZ (UTC+2) from 01:00 UTC on the last Sunday of March to 01:00 UTC on the last Sunday of October, else MEZ (UTC+1). */
export function berlin(ms: number): { label: "MEZ" | "MESZ"; offsetMs: number } {
  const y = new Date(ms).getUTCFullYear();
  const summer = ms >= lastSundayUtc(y, 2) && ms < lastSundayUtc(y, 9);
  return summer ? { label: "MESZ", offsetMs: 7_200_000 } : { label: "MEZ", offsetMs: 3_600_000 };
}
const clock = (ms: number) => { const d = new Date(ms); return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`; };
/** received_at with its time zone: UTC in English; MEZ/MESZ (Europe/Berlin) followed by UTC in German (plan r8, Fable P3-3). */
export function fmtReceived(ms: number, lang: Lang): string {
  if (lang === "en") return `${fmtDate(ms, "en")} ${clock(ms)} UTC`;
  const b = berlin(ms);
  return `${fmtDate(ms + b.offsetMs, "de")} ${clock(ms + b.offsetMs)} ${b.label} (${clock(ms)} UTC)`;
}

// --- paid months ----------------------------------------------------------------------------------------------------------------------

/** `ms` shifted by whole calendar months in UTC; the day is clamped to the target month's length (the 31st -> the 30th). */
export function addMonthsUtc(ms: number, months: number): number {
  const d = new Date(ms);
  const first = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
  const target = new Date(first);
  const days = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d.getUTCDate(), days), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}
/** `ms`'s time of day on day `anchorDay` of the month `months` away, clamped to that month's length: the billing anchor applied to one month
 *  (anchor 31: Nov 30, then Dec 31 again; never drifting to the 30th). */
export function anchoredMonthUtc(ms: number, months: number, anchorDay: number): number {
  const d = new Date(ms);
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(anchorDay, days), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}
/** The billing anchor's day of month as one known period shows it: a clamped month never lowers it (Oct 31 -> Nov 30 has anchor 31, and so
 *  has Nov 30 -> Dec 31), since two consecutive months are never both shorter than the anchor. */
export const anchorDayOf = (period: { start: number; end: number }): number => Math.max(new Date(period.start).getUTCDate(), new Date(period.end).getUTCDate());

/** The monthly paid period that contains `t`, given any one ACTUAL period [start, end) of the same plan and its billing anchor day (Stripe's
 *  billing_cycle_anchor when known, else the day the period shows). Each period boundary is the anchor day of its month, clamped, so a plan
 *  anchored on the 31st ends Oct 31 -> Nov 30 -> Dec 31 (Astra WP8-1 #6). null: more than 60 months away (the caller waits and ops hears). */
export function periodContaining(period: { start: number; end: number }, t: number, anchorDay: number = anchorDayOf(period)): { start: number; end: number } | null {
  if (t >= period.start && t < period.end) return period;
  // Boundary k: the known period's own start (k = -1) and end (k = 0), else the anchor day k months from its end. Period k = [B(k-1), B(k)).
  const boundary = (k: number) => k === 0 ? period.end : k === -1 ? period.start : anchoredMonthUtc(period.end, k, anchorDay);
  for (let k = -60; k <= 60; k += 1) {
    const start = boundary(k - 1); const end = boundary(k);
    if (t >= start && t < end) return { start, end };
  }
  return null;
}

// --- deadlines --------------------------------------------------------------------------------------------------------------------

/** The end (00:00 UTC of the next day) of the `n`th working day (Monday to Friday, UTC calendar) after the day of `ms`. Public holidays are
 *  not modelled: the deadline can only come earlier than the legal one, never later. */
export function workingDaysAfter(ms: number, n: number): number {
  const d = new Date(ms);
  let day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  for (let counted = 0; counted < n;) {
    day += 86_400_000;
    const wd = new Date(day).getUTCDay();
    if (wd !== 0 && wd !== 6) counted += 1;
  }
  return day + 86_400_000;
}
