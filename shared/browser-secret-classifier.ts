// SPDX-License-Identifier: AGPL-3.0-or-later
// Round 8: the server-side face of the ONE secret classifier. The source text lives in browser-secret-classifier-source.ts (the extension and the
// page scripts embed it as text; the extension must not compile code, so it never imports this file). Everything that lets a value leave a page
// asks this classifier: the recipient scan, intent and approval lines, the action digest, screenshot masks and the protected-document guard.
import { SECRET_CLASSIFIER_SOURCE } from "./browser-secret-classifier-source.ts";

export { SECRET_CLASSIFIER_SOURCE };

interface SecretClassifier {
  normalize(value: unknown): string;
  digitsOnly(value: unknown): string;
  looksLikeSecretValue(value: unknown): boolean;
  secretName(text: unknown): boolean;
  secretContext(text: unknown): boolean;
  ordinaryNumber(value: unknown): boolean;
  ssnShape(value: unknown): boolean;
  opaqueToken(value: unknown): boolean;
  luhn(digits: string): boolean;
}
const classifier = new Function(`return ${SECRET_CLASSIFIER_SOURCE};`)() as SecretClassifier;

/** True when the value is shaped like a secret: a PIN, a one-time code, an SSN, a card number or a half of one, in any digit script. */
export const looksLikeSecretValue = (value: unknown): boolean => classifier.looksLikeSecretValue(value);
/** True when a field's name, label, id, type or autocomplete says it holds a secret, in the common languages. */
export const looksLikeSecretName = (text: unknown): boolean => classifier.secretName(text);
/** Round 10: the classifier's own normalisation (digit scripts, invisible and combining marks removed), for callers that compare text with a secret. */
export const normalizeSecretText = (value: unknown): string => classifier.normalize(value);
/** Round 10 (R10-04): a URL with every component that carries a secret replaced by "~". Scheme and host are kept; each path segment, query name and value is
 * decoded and judged by the classifier, and a run of six or more digits anywhere in it counts. Never throws. */
export function redactSecretUrl(raw: string): string {
  const text = String(raw ?? "");
  const split = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)?([\s\S]*)$/i.exec(text);
  const head = split?.[1] ?? "", rest = split?.[2] ?? text;
  return head + rest.replace(/[^?&=/#;:@]+/g, piece => {
    let decoded = piece;
    for (let i = 0; i < 3; i++) { try { const next = decodeURIComponent(decoded); if (next === decoded) break; decoded = next; } catch { break; } }
    const compact = classifier.normalize(decoded).replace(/[\s._\-,']/g, "");
    return classifier.looksLikeSecretValue(decoded) || /\d{6,}/.test(compact) ? "~" : piece;
  });
}
/** The value with digits and separators normalised, for callers that need to compare. Empty when the value is not a plain number. */
export const secretDigits = (value: unknown): string => classifier.digitsOnly(value);
/** True when the text around a number says it is a code (verification, one-time, PIN, security, in the common languages). */
export const looksLikeSecretContext = (text: unknown): boolean => classifier.secretContext(text);
/** A year, a date or a price with cents: ordinary text unless a code word sits beside it. */
export const looksLikeOrdinaryNumber = (value: unknown): boolean => classifier.ordinaryNumber(value);
/** A social security number grouped 3-2-4 in any digit script. */
export const looksLikeSsn = (value: unknown): boolean => classifier.ssnShape(value);
/** A long string of letters and digits with no spaces: an API key or a session id. */
export const looksLikeOpaqueToken = (value: unknown): boolean => classifier.opaqueToken(value);
/** The Luhn check for a run of digits (a payment card number passes it). */
export const luhnValid = (digits: string): boolean => classifier.luhn(digits);
