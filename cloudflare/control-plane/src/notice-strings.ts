// SPDX-License-Identifier: AGPL-3.0-or-later
// Cloud checkout WP9: every customer-facing word of the emailed withdrawal notices (plan 5.3 (2), (2a), (3), (4), (5a)).
// GENERATED from STRIPE-HOSTED-PLAN.md r13c by a script, never retyped: the English and German sentences are byte for byte the plan's.
// Where the plan gives no German (the acknowledgement, subjects, the alert, the queue item), `de` is null: the English text is sent and
// the key is listed in MISSING_DE (a launch gate, not something to translate here).
import { fmtReceived, type Lang } from "./cancellation-strings";

type Pair = { en: string; de: string | null };
export const S = {
  trusted: { en: "We received your withdrawal from this email address on {received_at}. If it was you, you don't need to do anything. Your plan ends and your server is deleted, with everything on it. Save anything you need first. We refund everything you paid for the plan. We send the refund to your payment provider by the end of {execute_by_date} at the latest. To have it done now, press Confirm withdrawal (no sign-in needed). Your bank may take 5 to 10 business days to show the refund. If this wasn't you, press This wasn't me and we stop.",
    de: "Wir haben Ihren Widerruf von dieser E-Mail-Adresse am {received_at} erhalten. Wenn er von Ihnen kam, müssen Sie nichts tun. Ihr Plan endet und Ihr Server wird gelöscht, mit allem darauf. Sichern Sie vorher, was Sie brauchen. Wir erstatten alles, was Sie für den Plan bezahlt haben. Wir senden die Erstattung bis spätestens zum Ende des {execute_by_date} an Ihren Zahlungsanbieter. Wenn Sie es sofort erledigt haben möchten, drücken Sie Widerruf bestätigen (keine Anmeldung nötig). Ihre Bank kann 5 bis 10 Werktage brauchen, bis die Erstattung sichtbar ist. Falls Sie das nicht waren, drücken Sie Das war ich nicht, dann stoppen wir den Widerruf." },
  sameAddress: { en: "We received a withdrawal request for your Murage Cloud plan on {received_at}. We could not confirm it came from you. If it was you, press Confirm withdrawal (no sign-in needed); nothing happens until you do. If it wasn't you, press This wasn't me to tell us.",
    de: "Wir haben am {received_at} einen Widerruf für Ihren Murage-Cloud-Plan erhalten. Wir konnten nicht bestätigen, dass er von Ihnen kam. Wenn er von Ihnen kam, drücken Sie Widerruf bestätigen (keine Anmeldung nötig); vorher passiert nichts. Falls nicht, drücken Sie Das war ich nicht." },
  otherSender: { en: "We received a withdrawal request for your Murage Cloud plan on {received_at}, from another email address. If it was you, press Confirm withdrawal. No sign-in needed. Nothing happens until you press it. If it wasn't you, you can ignore this email, or press This wasn't me to tell us.",
    de: "Wir haben am {received_at} von einer anderen E-Mail-Adresse einen Widerruf für Ihren Murage-Cloud-Plan erhalten. Wenn er von Ihnen kam, drücken Sie Widerruf bestätigen. Keine Anmeldung nötig. Vorher passiert nichts. Falls nicht, können Sie diese E-Mail ignorieren oder uns mit Das war ich nicht Bescheid geben." },
  stopped: { en: "We've stopped this withdrawal and your plan continues. If you do want to withdraw, use Withdraw from contract on your account page.",
    de: "Wir haben diesen Widerruf gestoppt, und Ihr Plan läuft weiter. Wenn Sie doch widerrufen möchten, nutzen Sie „Vertrag widerrufen“ auf Ihrer Kontoseite." },
  tooLateExecuting: { en: "This withdrawal is already being carried out, so we could not stop it. We have opened a case and will look at it.",
    de: "Dieser Widerruf wird bereits ausgeführt, deshalb konnten wir ihn nicht stoppen. Wir haben einen Fall eröffnet und prüfen ihn." },
  tooLateCompleted: { en: "This withdrawal was already carried out on {completed_at}, so we could not stop it. We have opened a case and will look at it.",
    de: "Dieser Widerruf wurde bereits am {completed_at} ausgeführt, deshalb konnten wir ihn nicht stoppen. Wir haben einen Fall eröffnet und prüfen ihn." },
  unmatchedReply: { en: "We received your withdrawal on {received_at}. To confirm it, sign in and use Withdraw from contract on your account page, or tell us the email address on your Murage account and we'll send a confirmation link there.",
    de: "Wir haben Ihren Widerruf am {received_at} erhalten. Um ihn zu bestätigen, melden Sie sich an und nutzen Sie „Vertrag widerrufen“ auf Ihrer Kontoseite, oder nennen Sie uns die E-Mail-Adresse Ihres Murage-Kontos; wir senden den Bestätigungslink dorthin." },
  lblConfirm: { en: "Confirm withdrawal",
    de: "Widerruf bestätigen" },
  lblWasntMe: { en: "This wasn't me",
    de: "Das war ich nicht" },
  subjectVerify: { en: "Murage Cloud: we received your withdrawal",
    de: "Murage Cloud: wir haben Ihren Widerruf erhalten" },
  subjectStopped: { en: "Murage Cloud: your withdrawal was stopped",
    de: "Murage Cloud: Ihr Widerruf wurde gestoppt" },
  subjectTooLate: { en: "Murage Cloud: your request to stop a withdrawal",
    de: "Murage Cloud: Ihre Bitte, einen Widerruf zu stoppen" },
  subjectAck: { en: "Murage Cloud: your withdrawal was carried out",
    de: "Murage Cloud: Ihr Widerruf wurde ausgeführt" },
  subjectUnmatched: { en: "Murage Cloud: your withdrawal",
    de: "Murage Cloud: Ihr Widerruf" },
  ack: { en: "We carried out your withdrawal from your Murage Cloud plan, effective {received_at}, the time we received it. Your plan has ended and your server is deleted. We sent your refund to your payment provider on {submitted_on}. Your bank may take 5 to 10 business days to show it.",
    de: "Wir haben Ihren Widerruf Ihres Murage-Cloud-Plans ausgeführt, wirksam zum {received_at}, dem Zeitpunkt, zu dem wir ihn erhalten haben. Ihr Plan ist beendet und Ihr Server ist gelöscht. Wir haben Ihre Erstattung am {submitted_on} an Ihren Zahlungsanbieter gesendet. Ihre Bank kann 5 bis 10 Werktage brauchen, bis sie sichtbar ist." },
  alertDue: { en: "Refund due today: withdrawal {id} (received {received_at}). Execute withdrawal by the end of {execute_by_date}.",
    de: null },
  alertOverdue: { en: "Withdrawal overdue: {id} (received {received_at}). The deadline of {execute_by_date} has passed; the refund is still owed.",
    de: null },
  queueItem: { en: "Execute withdrawal. Deadline: {execute_by_date}",
    de: null },
  // WP10: clarify links, the ask and correction emails and the clarify page (plan 5.3 "Candidate withdrawal", "Clarification links", "Correction after the trusted email").
  ask: { en: "We got your message on {received_at} about your {plan_name} plan (started {plan_started_on}). Please tell us which you want: [End now, delete my server with everything on it, and get everything back] or [End at the end of the month I've paid for]. No sign-in needed. Either way we count from {received_at}, when we received your message. If we don't hear from you, your plan ends at the end of the month you have paid for and does not renew.",
    de: "Wir haben Ihre Nachricht zu Ihrem Plan {plan_name} (gestartet am {plan_started_on}) am {received_at} erhalten. Bitte sagen Sie uns, was Sie möchten: [Jetzt beenden, meinen Server mit allem darauf löschen und alles zurückbekommen] oder [Zum Ende des bezahlten Monats beenden]. Keine Anmeldung nötig. In beiden Fällen zählen wir ab dem {received_at}, dem Eingang Ihrer Nachricht. Wenn wir nichts von Ihnen hören, endet Ihr Plan zum Ende des bezahlten Monats und verlängert sich nicht." },
  correctionCancellation: { en: "We read your message again. You asked to end your plan at the end of the month you have paid for, so we treat it as a cancellation: your plan runs until {effective_at} and then stops. Nothing is refunded. Our earlier email no longer applies. If you meant to withdraw now and get everything back, press [Withdraw now and delete my server] (no sign-in needed). Withdrawing now ends your {plan_name} plan (started {plan_started_on}) at once and deletes your server with everything on it. We count from {received_at}, when we received your message, either way.",
    de: "Wir haben Ihre Nachricht noch einmal gelesen. Sie haben verlangt, Ihren Plan zum Ende des bezahlten Monats zu beenden. Wir behandeln das als Kündigung: Ihr Plan läuft bis zum {effective_at} und endet dann. Es wird nichts erstattet. Unsere frühere E-Mail gilt nicht mehr. Wenn Sie jetzt widerrufen und alles zurückbekommen möchten, drücken Sie [Jetzt widerrufen und Server löschen] (keine Anmeldung nötig). Ein Widerruf beendet Ihren Plan {plan_name} (gestartet am {plan_started_on}) sofort und löscht Ihren Server mit allem darauf. In beiden Fällen zählen wir ab dem {received_at}, dem Eingang Ihrer Nachricht." },
  correctionSupport: { en: "We read your message again and we are not sure you wanted to end your plan, so your plan continues for now. Our earlier email no longer applies. If you do want to end it now and get everything back, press [Withdraw now and delete my server] (no sign-in needed). Withdrawing now ends your {plan_name} plan (started {plan_started_on}) at once and deletes your server with everything on it. If you only had a question, we answer it in a separate email.",
    de: "Wir haben Ihre Nachricht noch einmal gelesen und sind nicht sicher, ob Sie Ihren Plan beenden wollten. Ihr Plan läuft deshalb vorerst weiter. Unsere frühere E-Mail gilt nicht mehr. Wenn Sie ihn jetzt beenden und alles zurückbekommen möchten, drücken Sie [Jetzt widerrufen und Server löschen] (keine Anmeldung nötig). Ein Widerruf beendet Ihren Plan {plan_name} (gestartet am {plan_started_on}) sofort und löscht Ihren Server mit allem darauf. Wenn Sie nur eine Frage hatten, beantworten wir sie in einer eigenen E-Mail." },
  clarifyNowHeading: { en: "Withdraw from your {plan_name} plan (started {plan_started_on})",
    de: "Widerruf Ihres Plans {plan_name} (gestartet am {plan_started_on})" },
  clarifyNowText: { en: "This ends your plan now. Your server is deleted, with everything on it. Save anything you need first. We refund everything you paid for the plan.",
    de: "Damit endet Ihr Plan sofort. Ihr Server wird gelöscht, mit allem darauf. Sichern Sie vorher, was Sie brauchen. Wir erstatten alles, was Sie für den Plan bezahlt haben." },
  clarifyNowButton: { en: "Withdraw now and delete my server",
    de: "Jetzt widerrufen und Server löschen" },
  clarifyEndHeading: { en: "End your {plan_name} plan (started {plan_started_on}) at the end of the month you have paid for",
    de: "Ihren Plan {plan_name} (gestartet am {plan_started_on}) zum Ende des bezahlten Monats beenden" },
  clarifyEndText: { en: "Your plan runs until {effective_at} and then stops. Your server keeps running until then. Nothing is refunded.",
    de: "Ihr Plan läuft bis zum {effective_at} und endet dann. Ihr Server läuft bis dahin weiter. Es wird nichts erstattet." },
  clarifyEndButton: { en: "End at the end of the paid month",
    de: "Zum Ende des bezahlten Monats beenden" },
  clarifyExpired: { en: "This link no longer works. Sign in: your account page shows this notice with the same choices, and your original dates still count.",
    de: "Dieser Link funktioniert nicht mehr. Melden Sie sich an: Ihre Kontoseite zeigt diese Mitteilung mit denselben Auswahlmöglichkeiten, und Ihre ursprünglichen Daten gelten weiter." },
  // WP10 r1-6: the plan has no words for a notice moved from withdrawal to candidate after the trusted email went. No plan German; German from the 2026-10-11 review (checkout/MISSING-DE-TRANSLATIONS.md).
  askRetract: { en: "We read your message again. Our earlier email no longer applies: we have not carried out a withdrawal and nothing has been refunded.",
    de: "Wir haben Ihre Nachricht noch einmal gelesen. Unsere frühere E-Mail gilt nicht mehr: Wir haben keinen Widerruf ausgeführt, und es wurde nichts erstattet." },
  askRetractOther: { en: "We read your message again. Our earlier email no longer applies: we have not carried out a withdrawal, nothing has been refunded, and your plan continues for now. We got your message on {received_at} about your {plan_name} plan (started {plan_started_on}). Please tell us which you want: [End now, delete my server with everything on it, and get everything back] or [End at the end of the month I've paid for]. No sign-in needed. Either way we count from {received_at}, when we received your message.",
    de: "Wir haben Ihre Nachricht noch einmal gelesen. Unsere frühere E-Mail gilt nicht mehr: Wir haben keinen Widerruf ausgeführt, es wurde nichts erstattet, und Ihr Plan läuft vorerst weiter. Wir haben Ihre Nachricht zu Ihrem Plan {plan_name} (gestartet am {plan_started_on}) am {received_at} erhalten. Bitte sagen Sie uns, was Sie möchten: [Jetzt beenden, meinen Server mit allem darauf löschen und alles zurückbekommen] oder [Zum Ende des bezahlten Monats beenden]. Keine Anmeldung nötig. In beiden Fällen zählen wir ab dem {received_at}, dem Eingang Ihrer Nachricht." },
  // WP10 r2-3: the ask rendered from the cancellation's committed status (the plan's ask promises a stop that a hold, or no stop, contradicts).
  // German from the 2026-10-11 review (checkout/MISSING-DE-TRANSLATIONS.md).
  askHeld: { en: "We got your message on {received_at} about your {plan_name} plan (started {plan_started_on}). Please tell us which you want: [End now, delete my server with everything on it, and get everything back] or [End at the end of the month I've paid for]. No sign-in needed. Either way we count from {received_at}, when we received your message. The renewal stop is on hold because you told us it wasn't you, so your plan continues and renews until you choose.",
    de: "Wir haben Ihre Nachricht zu Ihrem Plan {plan_name} (gestartet am {plan_started_on}) am {received_at} erhalten. Bitte sagen Sie uns, was Sie möchten: [Jetzt beenden, meinen Server mit allem darauf löschen und alles zurückbekommen] oder [Zum Ende des bezahlten Monats beenden]. Keine Anmeldung nötig. In beiden Fällen zählen wir ab dem {received_at}, dem Eingang Ihrer Nachricht. Der Stopp der Verlängerung ist angehalten, weil Sie uns gesagt haben, dass es nicht Sie waren. Ihr Plan läuft deshalb weiter und verlängert sich, bis Sie wählen." },
  askOpen: { en: "We got your message on {received_at} about your {plan_name} plan (started {plan_started_on}). Please tell us which you want: [End now, delete my server with everything on it, and get everything back] or [End at the end of the month I've paid for]. No sign-in needed. Either way we count from {received_at}, when we received your message. Until you answer, your plan continues.",
    de: "Wir haben Ihre Nachricht zu Ihrem Plan {plan_name} (gestartet am {plan_started_on}) am {received_at} erhalten. Bitte sagen Sie uns, was Sie möchten: [Jetzt beenden, meinen Server mit allem darauf löschen und alles zurückbekommen] oder [Zum Ende des bezahlten Monats beenden]. Keine Anmeldung nötig. In beiden Fällen zählen wir ab dem {received_at}, dem Eingang Ihrer Nachricht. Bis Sie antworten, läuft Ihr Plan weiter." },
  // WP10 r2-7: the ask while the stop is filed but not scheduled yet, and after the plan has ended. No plan German; German from the 2026-10-11 review (checkout/MISSING-DE-TRANSLATIONS.md).
  askPending: { en: "We got your message on {received_at} about your {plan_name} plan (started {plan_started_on}). Please tell us which you want: [End now, delete my server with everything on it, and get everything back] or [End at the end of the month I've paid for]. No sign-in needed. Either way we count from {received_at}, when we received your message. We are stopping your plan from renewing and will email you the date it ends.",
    de: "Wir haben Ihre Nachricht zu Ihrem Plan {plan_name} (gestartet am {plan_started_on}) am {received_at} erhalten. Bitte sagen Sie uns, was Sie möchten: [Jetzt beenden, meinen Server mit allem darauf löschen und alles zurückbekommen] oder [Zum Ende des bezahlten Monats beenden]. Keine Anmeldung nötig. In beiden Fällen zählen wir ab dem {received_at}, dem Eingang Ihrer Nachricht. Wir stoppen die Verlängerung Ihres Plans und senden Ihnen per E-Mail das Datum, an dem er endet." },
  askEnded: { en: "We got your message on {received_at} about your {plan_name} plan (started {plan_started_on}). Your plan has already ended, so there is nothing left to cancel. If you meant to withdraw and get everything back, press [End now, delete my server with everything on it, and get everything back] (no sign-in needed). We count from {received_at}, when we received your message.",
    de: "Wir haben Ihre Nachricht zu Ihrem Plan {plan_name} (gestartet am {plan_started_on}) am {received_at} erhalten. Ihr Plan ist bereits beendet, es gibt also nichts mehr zu kündigen. Wenn Sie widerrufen und alles zurückbekommen möchten, drücken Sie [Jetzt beenden, meinen Server mit allem darauf löschen und alles zurückbekommen] (keine Anmeldung nötig). Wir zählen ab dem {received_at}, dem Eingang Ihrer Nachricht." },
  // WP10 r1-7: a correction to `cancellation` while that cancellation is held (or kept), or after the contract had already ended. No plan German; German from the 2026-10-11 review (checkout/MISSING-DE-TRANSLATIONS.md).
  correctionHeld: { en: "We read your message again. You asked to end your plan at the end of the month you have paid for, but that cancellation is on hold because you told us it wasn't you, so your plan continues and renews. Our earlier email no longer applies. If you meant to withdraw now and get everything back, press [Withdraw now and delete my server] (no sign-in needed). Withdrawing now ends your {plan_name} plan (started {plan_started_on}) at once and deletes your server with everything on it. We count from {received_at}, when we received your message, either way.",
    de: "Wir haben Ihre Nachricht noch einmal gelesen. Sie haben verlangt, Ihren Plan zum Ende des bezahlten Monats zu beenden. Diese Kündigung ist aber angehalten, weil Sie uns gesagt haben, dass es nicht Sie waren. Ihr Plan läuft deshalb weiter und verlängert sich. Unsere frühere E-Mail gilt nicht mehr. Wenn Sie jetzt widerrufen und alles zurückbekommen möchten, drücken Sie [Jetzt widerrufen und Server löschen] (keine Anmeldung nötig). Ein Widerruf beendet Ihren Plan {plan_name} (gestartet am {plan_started_on}) sofort und löscht Ihren Server mit allem darauf. In beiden Fällen zählen wir ab dem {received_at}, dem Eingang Ihrer Nachricht." },
  correctionEnded: { en: "We read your message again. Your {plan_name} plan (started {plan_started_on}) has already ended, so there is nothing left to cancel. Our earlier email no longer applies. If you meant to withdraw and get everything back, press [Withdraw now and delete my server] (no sign-in needed). We count from {received_at}, when we received your message.",
    de: "Wir haben Ihre Nachricht noch einmal gelesen. Ihr Plan {plan_name} (gestartet am {plan_started_on}) ist bereits beendet, es gibt also nichts mehr zu kündigen. Unsere frühere E-Mail gilt nicht mehr. Wenn Sie widerrufen und alles zurückbekommen möchten, drücken Sie [Jetzt widerrufen und Server löschen] (keine Anmeldung nötig). Wir zählen ab dem {received_at}, dem Eingang Ihrer Nachricht." },
  subjectAsk: { en: "Murage Cloud: please tell us what you want",
    de: "Murage Cloud: bitte sagen Sie uns, was Sie möchten" },
  subjectCorrection: { en: "Murage Cloud: we read your message again",
    de: "Murage Cloud: Ihre Nachricht noch einmal gelesen" },
  subjectClarified: { en: "Murage Cloud: your plan",
    de: "Murage Cloud: Ihr Plan" },
} as const satisfies Record<string, Pair>;
export type StringKey = keyof typeof S;
/** The strings that still lack German: the launch gate for this package. */
// operator digest/queue texts, English by decision 2026-10-11
export const OPERATOR_ONLY: ReadonlySet<StringKey> = new Set<StringKey>(["alertDue", "alertOverdue", "queueItem"]);
export const MISSING_DE: StringKey[] = (Object.keys(S) as StringKey[]).filter((k) => S[k].de === null && !OPERATOR_ONLY.has(k));

export const t = (key: StringKey, lang: Lang, vars: Record<string, string> = {}): string => {
  const p: Pair = S[key];
  const text = (lang === "de" ? p.de : null) ?? p.en;
  return text.replace(/\{([a-z_]+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
};

const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTHS_DE = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
/** {execute_by_date}: the UTC date of the cutoff with the time zone named ONCE, in the value ("14 November 2026 (UTC)", de "14. November 2026 (UTC)").
 *  The templates carry no second UTC label. */
export function fmtExecuteByDate(ms: number, lang: Lang): string {
  const d = new Date(ms);
  return lang === "de" ? `${d.getUTCDate()}. ${MONTHS_DE[d.getUTCMonth()]} ${d.getUTCFullYear()} (UTC)` : `${d.getUTCDate()} ${MONTHS_EN[d.getUTCMonth()]} ${d.getUTCFullYear()} (UTC)`;
}
export { fmtReceived };
