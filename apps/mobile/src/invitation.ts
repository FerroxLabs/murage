// What the launcher accepts as "a computer to pair with" (spec §3.1): the QR
// code's `https://<host>/enter#<credential>`, or a typed address and the six
// digits. Native checks both again (WorkspaceOrigin, PairingLink); this is
// where the person gets a sentence instead of an error code.

export interface Pairing {
  origin: string;
  credential: string;
}

export type PairingResult = Pairing | { error: string; insecure?: true };

/** PairingLink.validCredential on both native sides. */
const CREDENTIAL = /^[A-Za-z0-9_-]{1,512}$/;

export const COPY = {
  notACode: "That isn't a Murage pairing code. On your computer, open Murage, then Settings, then Phone and other devices, and scan the code shown there.",
  insecure: "This address isn't secure. Murage only connects over HTTPS.",
  badAddress: "That doesn't look like your computer's address. It looks like your-computer.tail1234.ts.net.",
  badCode: "The code is the six digits beside the QR code on your computer.",
} as const;

/**
 * Java's WorkspaceOrigin.trimInput exactly: Unicode Z*, U+0009 to U+000D, U+0085.
 * Apple's .whitespacesAndNewlines also holds U+200B ZERO WIDTH SPACE, so this
 * is a little stricter than iOS: an edge ZWSP is refused here, never let through.
 */
const EDGE = /^[\p{Z}\u0009-\u000D\u0085]+|[\p{Z}\u0009-\u000D\u0085]+$/gu;

/** What open() and remove() do to their input natively (see EDGE); the launcher trims typed and pasted text this way. */
export function trimInput(text: string): string {
  return text.replace(EDGE, "");
}

/** Anything a lenient parser would drop or rewrite (Unsafe.java). */
const UNSAFE = /[\p{Cc}\p{Z}\\]/u;

/**
 * WorkspaceOrigin.parse on both native sides, rule for rule
 * (contract/origins.json). Not `new URL`, which accepts IP literals, "\" and
 * escapes a WebView reads differently. Trims U+0020 only: launcher input goes
 * through trimInput first.
 */
export function originFromText(input: string): string | null {
  const text = input.replace(/^ +| +$/g, "");
  if (UNSAFE.test(text)) return null;
  const url = /^https:\/\/([^/?#]*)(?:[/?#].*)?$/is.exec(text);
  if (!url || url[1]!.includes("@")) return null;
  const authority = /^([^:]*)(?::([0-9]*))?$/.exec(url[1]!);
  if (!authority) return null;
  // ASCII first, then lower-case: U+212A KELVIN SIGN lower-cases to "k".
  if (!/^[A-Za-z0-9.-]+$/.test(authority[1]!)) return null;
  const host = authority[1]!.toLowerCase();
  const labels = host.replace(/\.$/, "").split(".");
  if (labels.some((label) => !label || label.startsWith("-") || label.endsWith("-"))) return null;
  if (/^[0-9]/.test(labels[labels.length - 1]!)) return null; // an IP literal
  const port = authority[2] ? Number(authority[2]) : 443;
  if (!(port >= 1 && port <= 65535)) return null;
  return port === 443 ? `https://${host}` : `https://${host}:${port}`;
}

/** PairingLink.parse: exactly `<origin>/enter#<credential>`, at most 4096 characters. */
function pairingLink(text: string): Pairing | null {
  if ([...text].length > 4096) return null;
  const origin = originFromText(text);
  if (!origin) return null;
  // originFromText has checked "https://" and an ASCII authority.
  const rest = text.replace(/^ +| +$/g, "").slice("https://".length);
  const hash = rest.indexOf("#");
  if (hash < 0) return null;
  const head = rest.slice(0, hash);
  const path = head.search(/[/?]/);
  if (path < 0 || head.slice(path) !== "/enter") return null;
  const credential = rest.slice(hash + 1);
  return CREDENTIAL.test(credential) ? { origin, credential } : null;
}

const HTTP = /^http:\/\//i;
const asHttps = (text: string) => text.replace(HTTP, "https://");

export function parseInvitation(text: string): PairingResult {
  const trimmed = trimInput(text);
  const link = pairingLink(trimmed);
  if (link) return link;
  // Spec §7: the same link over http is refused for being insecure, not for being wrong.
  if (HTTP.test(trimmed) && pairingLink(asHttps(trimmed))) return { error: COPY.insecure, insecure: true };
  return { error: COPY.notACode };
}

export function parseTypedPairing(address: string, code: string): PairingResult {
  const trimmed = trimInput(address);
  if (!trimmed) return { error: COPY.badAddress };
  if (HTTP.test(trimmed)) return originFromText(asHttps(trimmed)) ? { error: COPY.insecure, insecure: true } : { error: COPY.badAddress };
  // Any other scheme is not an address. A bare name gets https:// in front, so
  // it must not start like a scheme ("https:", "https//", "ftp:/"): that would
  // become a computer called "https". A colon is only ever a port's.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  if (hasScheme && !/^https:\/\//i.test(trimmed)) return { error: COPY.badAddress };
  if (!hasScheme && (/^[^/?#]*:(?![0-9]+(?:[/?#]|$))/.test(trimmed) || /^[a-z][a-z0-9+.-]*\/\//i.test(trimmed))) return { error: COPY.badAddress };
  const origin = originFromText(hasScheme ? trimmed : `https://${trimmed}`);
  if (!origin) return { error: COPY.badAddress };
  const digits = trimInput(code).replace(/[\s.-]/g, "");
  if (!/^\d{6}$/.test(digits)) return { error: COPY.badCode };
  return { origin, credential: digits };
}
