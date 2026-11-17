// Vendor additions have one vocabulary for server logs, turn detection and
// feedback. Patterns identify credentials for redaction, not API validation.
// Prefixes follow the vendors' public documentation; the floors below are
// redaction precision choices, not promised credential validation formats.
const FOLD = String.raw`\r?\n[ \t]*`;
const ALNUM = "[A-Za-z0-9]";
/** A bounded lookahead counts material across line wraps. The body
 * consumes disjoint alphanumeric runs separated by LF/CRLF and optional indentation.
 * Prefixes contain punctuation outside ALNUM, so failed candidates cannot
 * repeatedly rescan the same suffix. No nested ambiguous repetitions. */
function foldedValue(chars, minimum) {
  return String.raw`(?=(?:${chars}(?:${FOLD})?){${minimum - 1}}${chars})${chars}+(?:${FOLD}${chars}+)*`;
}
const insensitive = s => s.replace(/[A-Za-z]/g, c => `[${c.toLowerCase()}${c.toUpperCase()}]`);
const sessionNames = ["AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN", "SessionToken", "X-Amz-Security-Token"].map(insensitive).join("|");
export const VENDOR_SECRET_RULES = Object.freeze([
  // Wrapped IDs omit a trailing boundary so completion probes can append
  // material while deciding whether to hold an unfinished stream value.
  ["AWS_WRAPPED_ACCESS_KEY_ID", new RegExp(String.raw`\b(?:AKIA|ASIA)(?=[A-Z0-9]{0,15}${FOLD})(?:${FOLD})?(?:[A-Z0-9](?:${FOLD})?){15}[A-Z0-9]`, "g")],
  ["AWS_ACCESS_KEY_ID", new RegExp(String.raw`\b(?:AKIA|ASIA)(?:[A-Z0-9](?:${FOLD})?){15}[A-Z0-9](?![A-Za-z0-9_])`, "g")],
  // Neither vendor promises a fixed suffix size. Notion uses a 43-character
  // material floor to preserve long words after the common secret_ spelling;
  // Perplexity uses 32 to preserve short model names.
  ["NOTION_INTEGRATION_TOKEN", new RegExp(String.raw`\b(?:secret_|ntn_)${foldedValue(ALNUM, 43)}`, "g")],
  ["PERPLEXITY_API_KEY", new RegExp(String.raw`\bpplx-${foldedValue(ALNUM, 32)}`, "g")],
  // STS tokens are opaque and variable-length: recognize the AWS field, not
  // arbitrary base64. Capture 1 is the label/separator, which stays visible.
  // Percent escapes cover presigned query values without decoding the text.
  ["AWS_SESSION_TOKEN", new RegExp(String.raw`(\b(?:${sessionNames})["']?[ \t]*[=:][ \t]*["']?)${foldedValue("[A-Za-z0-9+/=_%~-]", 8)}`, "g")],
]);
// Detection sees the original input once. No legacy provider or scalar tail
// participates: those belong exclusively to each caller's release-base pipeline.
export const VENDOR_SECRET_PATTERN = new RegExp(VENDOR_SECRET_RULES.map(([, re]) => re.source).join("|"), "g");
export function vendorSecretValueOffset(match) { return match[1]?.length ?? 0; }
/** Sorted, disjoint original UTF-16 value extents; session labels are excluded. */
export function vendorSecretSpans(text) {
  const spans = [];
  VENDOR_SECRET_PATTERN.lastIndex = 0;
  for (let m; (m = VENDOR_SECRET_PATTERN.exec(text));) {
    spans.push({ start: m.index + vendorSecretValueOffset(m), end: m.index + m[0].length });
  }
  return spans;
}
