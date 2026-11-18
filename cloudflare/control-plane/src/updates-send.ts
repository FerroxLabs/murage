// Updates consent (design UPDATES-CONSENT-1020-CP-v5.md v5.6.1). B1 holds only the one definition of the RFC 8058 one-click header pair,
// used by the prove-mail outbox sender now and by the batch builder in B3, so there is exactly one text for both.

/** Exactly `List-Unsubscribe: <url>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (3.3). Refuses a URL that is not https. */
export function oneClickHeaders(url: string): Readonly<Record<string, string>> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("one_click_url_invalid");
  }
  if (parsed.protocol !== "https:") throw new Error("one_click_url_not_https");
  return Object.freeze({
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  });
}
