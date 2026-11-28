// Keeping secrets out of the native protocol log.
//
// The native tee writes every provider message verbatim, which is what makes
// protocol drift diagnosable — but the messages that set a session up carry
// the credentials the agent is handed: the box token and the comms token
// travel inside `session/new`'s mcpServers env, and a Composio consumer key
// travels in an MCP header. Those logs sit in ~/.murage/native as
// ordinary files, are read by anyone debugging, and get pasted into issues.
//
// So the log keeps the SHAPE and loses the VALUES: a redacted entry still
// tells you a token was passed, under which name, and how long it was —
// enough to debug "the proxy got no token" without the token being there.

import { maskFinancialIdentifiers } from "../shared/financial-ids.ts";
import { maskSecretLabelsToEnd, scan, SECRET_SCAN_BUDGET, type ScanCharge, type SecretScanResult, type SecretSpan } from "../shared/md-secret-label.mjs";

import { basicSpans, basicStage, tracked, runStages, maskVendorLast, replaceTracked, type EditCollector, type TrackedRule } from "../shared/basic-auth-mask.ts";
import * as secretLabels from "../shared/md-secret-label.mjs";

/** Key names whose value is a credential. Matched case-insensitively as a
 * substring, so KEY catches ANTHROPIC_API_KEY and x-api-key. */
const SECRET_KEY_PARTS = ["token", "secret", "password", "passwd", "apikey", "api_key", "authorization", "auth_token", "cookie"];

/** `key` alone is too broad — it matches `keyboard`, `keys`, `hotkey`. Only
 * treat it as a credential when it stands alone or is a suffix, which is how
 * every real one is spelled (API_KEY, consumer-key, xai_key). */
function isSecretName(name: string): boolean {
  const lower = name.toLowerCase();
  if (["workspacekey", "fileworkspacekey", "ambientworkspacekey"].includes(lower)) return true;
  if (SECRET_KEY_PARTS.some((part) => lower.includes(part))) return true;
  return /(^|[_.-])keys?$/.test(lower);
}

const REDACTION_MARKER = /^«redacted \d+ chars»$/;

/** Keep repeated redaction byte-for-byte stable. Persisted payloads can pass
 * through both a content scrub and the store-wide scrub; re-masking our own
 * marker would change its reported length (and any hash over the payload). */
const mask = (value: string) => (REDACTION_MARKER.test(value) ? value : `«redacted ${value.length} chars»`);

// ── content-shaped secrets ────────────────────────────────────────────
// What a bot's own reply, a tool title, or a permission card can carry —
// and, since the rebuild replays activity into every handed-over context,
// what would otherwise become permanent. High precision on purpose: a
// generic "long hex/base64" heuristic would rewrite real code in the
// transcript, so only shapes that are unmistakably credentials match.

export const KEY_PREFIXES: RegExp[] = [
  // SendGrid SG.<22-char key id>.<43-char secret> and PyPI/TestPyPI macaroons with
  // upstream's 85-character floor after "pypi-". Adapted from OpenMausBot 7dea8644e,
  // 5bce12634 and 09856b05b.
  // They run first: an earlier prefix rule (sk-, gsk_) found inside one would
  // mask only part of it and leave the rest readable (Astra r2 Medium).
  /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, // SendGrid
  /\bpypi-AgE[A-Za-z0-9_-]{82,}/g, // PyPI
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, // anthropic / openai / stripe
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, // github classic
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // github fine-grained
  // GitLab personal (glpat-), deploy (gldt-) and runner (glrt-, glrtr-) tokens;
  // routable ones carry dot-separated parts. Adapted from OpenMausBot 3a5af9486.
  /\bgl(?:pat|dt|rtr?)-[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+)*/g,
  /\bxox[abposr]-[A-Za-z0-9-]{20,}/g, // slack
  // Slack app-level (Socket Mode) tokens. Adapted from OpenMausBot 0fdb32dfb.
  /\bxapp-\d-[A-Za-z0-9-]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g, // aws access key id
  /\bAIza[0-9A-Za-z_-]{30,}/g, // google api key
  /\bnpm_[A-Za-z0-9]{20,}/g, // npm
  // Bare provider keys adapted from OpenMausBot PR #987 (Apache-2.0,
  // merge 391f0b2b). Minimum suffix lengths follow upstream exactly: Groq's
  // is 40, not a weaker 36, so shorter look-alikes in prose stay readable.
  /\bxai-[A-Za-z0-9_-]{20,}/g, // xAI
  /\bgsk_[A-Za-z0-9]{40,}/g, // Groq
  /\bhf_[A-Za-z0-9]{30,}/g, // Hugging Face
];

// ── linear time ───────────────────────────────────────────────────────
// Since the ACP engine-error path stopped cutting text before it is
// redacted (server/drivers/acp/core.ts, round 10), this function sees an
// engine's error text WHOLE — bounded only by ENGINE_FRAME_MAX_BYTES, 32 MiB —
// on the server's single event loop, and a rule whose cost is quadratic in
// its input is a way to freeze every room in the app with one error body.
//
// Three rules were. Each had the same shape: a `\b` in front of a character
// class that contains `-`, so on text like `a-a-a-…` EVERY other position is
// a place to start, and from each the engine rescans the run to its end
// before giving up. Measured before the rewrite, on this function:
//   KEY_VALUE  `a-a-…` + `api_key=`             3.3 s at 64 KiB, 15 s at 128 KiB
//   JWT        `eyJ-eyJ-…`                       3.1 s at 64 KiB
//   PEM_BLOCK  `-----BEGIN PRIVATE KEY-----` × n  2.9 s at 1 MiB (no END: each
//              BEGIN's lazy body scans to the end of the text)
// Every other rule was single-digit milliseconds at 1 MiB.
//
// The rewrites keep the MATCHES identical — same spans, same output — and
// change only where the engine is allowed to start. A match may start only
// where a run of the class begins (`(?<![class])`); a cheap lookahead decides
// ONCE per run whether anything in it can match; and a lazy group in front of
// the original pattern walks to the position the original would have matched
// at, which is re-emitted unchanged. Start positions are then sparse, each
// run is scanned a bounded number of times, and the first candidate the lazy
// group reaches is the one that matches — so the cost is linear. The proof
// that the outputs are the same is server/redact.test.ts, which runs the
// original rules as an oracle over a fixed fuzz corpus and the shapes this
// argument was made on.

/** A JSON Web Token: three base64url segments, the first beginning `eyJ`.
 * Anchored at the start of a run of segment characters; the lookahead asks
 * once per run whether it is followed by two more segments of at least eight
 * characters; the lazy group then walks to the first `\b`+`eyJ` inside the
 * run, exactly where the original `\beyJ…` started. */
const JWT =
  /(?<!:\/\/)(?<!@)(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b)([A-Za-z0-9_-]*?)\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b)/g;
const BEARER = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{12,})/g;
/** A bearer-looking token on its own (`Bearer abc…`), for screens that refuse
 * rather than mask (server/mcp-bot-add.ts). Same shape as BEARER. */
export const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i;
/** A PEM private-key block: the header, everything up to the FIRST footer,
 * the footer. The original `(-----BEGIN …)([\s\S]*?)(-----END …)` scanned
 * from every header to the end of the text when no footer followed, so n
 * headers cost n passes over the text. `redactPemBlocks` below does what
 * that regex did, in one pass: find the next header, find the first footer
 * after it, mask what lies between, continue after the footer — and stop at
 * the first header with no footer, because no later header can have one. */
const PEM_OPEN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
/** A PEM private-key header anywhere, for screens that refuse rather than mask. */
export const PEM_PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const PEM_CLOSE = /-----END [A-Z ]*PRIVATE KEY-----/g;
function redactPemBlocks(text: string, edits?: EditCollector): string {
  let out = "";
  let pos = 0;
  for (;;) {
    PEM_OPEN.lastIndex = pos;
    const open = PEM_OPEN.exec(text);
    if (!open) break;
    const bodyAt = open.index + open[0].length;
    PEM_CLOSE.lastIndex = bodyAt;
    const close = PEM_CLOSE.exec(text);
    if (!close) break;
    const replacement = `${open[0]}\n${mask(text.slice(bodyAt, close.index).trim())}\n${close[0]}`;
    edits?.({ start: open.index, end: close.index + close[0].length, length: replacement.length });
    out += text.slice(pos, open.index) + replacement;
    pos = close.index + close[0].length;
  }
  return out + text.slice(pos);
}
/** key=value / key: value / key="value" where the key is secret-shaped.
 * The value must be a single token of some length; prose after a colon
 * ("password: leave blank…") has spaces and does not match.
 *
 * The original: `\b((?:[A-Za-z0-9_-]*_)?NAME s?)(SEP)(QUOTE)(VALUE)\3`,
 * where NAME is the alternation below. The name always ends where its run of
 * `[A-Za-z0-9_-]` ends, because every separator character is outside that
 * class — so whether a run can match is a property of the RUN, not of the
 * position inside it, and the output is the same wherever inside the run the
 * match starts, because the text in front of the name is emitted unchanged
 * either way. Two forms, anchored at the run start:
 *   A. the name has an underscored prefix: a lookahead asks once whether the
 *      run ends in `_NAME` followed by a separator and a value; if it does
 *      the first `\b` in the run matches, exactly as the original did there;
 *   B. no prefix: the lazy group walks to the first `\b` at which NAME itself
 *      begins, with the separator and value after it.
 * Groups: 1 the lookahead's quote, 2/3 form A's prefix and name, 4/5 form
 * B's, 6 separator, 7 quote, 8 value. */
const NAME = String.raw`(?:api[_-]?key|apikey|secret|token|password|passwd|authorization|auth[_-]?token|access[_-]?key|private[_-]?key)s?`;
const KEY_VALUE = new RegExp(
  String.raw`(?<![A-Za-z0-9_-])(?:(?=[A-Za-z0-9_-]*_${NAME}["']?\s*[=:]\s*(["']?)[A-Za-z0-9._~+/=-]{8,}\1)([A-Za-z0-9_-]*?)\b([A-Za-z0-9_-]*_${NAME})|([A-Za-z0-9_-]*?)\b(${NAME}))(["']?\s*[=:]\s*)(["']?)([A-Za-z0-9._~+/=-]{8,})\7`,
  "gi",
);

/** `?key=…` / `&key=…` / `?token=…`. A bare `key` is refused everywhere else
 * (see isSecretName: "the key: value pair" is ordinary English), but in a
 * query string it names a credential as often as `api_key` does — and it is
 * the spelling a self-hosted engine's URL uses, on hosts (an IP literal, a
 * bare `localhost`) that no link rule recognises.
 *
 * No length floor: the floor the rules above carry exists to keep prose
 * readable, and here the parameter's NAME has already settled what the value
 * is. A short key is still a key, and this rule is the only thing standing
 * between one and the native protocol log. `token` rides along for the same
 * reason: it IS in the secret-name vocabulary, but KEY_VALUE's eight-character
 * floor let a short one through, and in query position that floor buys
 * nothing.
 *
 * Three narrowings keep that breadth off ordinary prose, and they are the
 * whole of what this rule does NOT mask:
 *  1. Query position only. The match must start at `?` or `&`, so
 *     "the token: leave this prose alone" and `const token = await getToken()`
 *     read as written.
 *  2. The optional prefix must end in `_` or `-`, so `?access_token=` and
 *     `?x-api-key=` match while `?notoken=` and `?monkey=` do not.
 *  3. A purely numeric value is left alone: no provider issues a number as a
 *     credential, and `?max_tokens=4096` — the commonest parameter in this
 *     product's domain — is the most diagnostic part of an engine's own
 *     request line. `?max_keys=10` goes the same way. */
const QUERY_KEY = /([?&](?:[A-Za-z0-9_-]*[_-])?(?:keys?|tokens?)=)([A-Za-z0-9._~+/=-]+)/gi;
/** Narrowing 3 above: a bare number is not a credential. */
const NUMERIC_VALUE = /^\d+$/;

/** The rules of `redactSecretsInText`, in the order it runs them, each by
 * name and on its own. This is the list the function runs, and the list the
 * clock in redact.test.ts puts a number on rule by rule: no rule here is
 * called linear without a measured number for that rule.
 *
 * Whole spans first, shapes after. A shape rule stops at the first character
 * outside its class, and its mask has spaces and guillemets that no span rule
 * can run across: with the shapes first, `token=sk-…/rest` kept `/rest`, the
 * rest of the same credential. Every shape class fits inside the span value
 * class, so a span rule takes all of a credential or none of it, and the shape
 * rules still run over whatever the span rules leave.
 *
 * BEARER stays ahead of KEY_VALUE: the value of `token=x-x-x-x-Bearer abc…` ends
 * in the word `Bearer`, and masking that first would hide the token after it
 * from BEARER. JWT stays ahead of the prefixes for the reason above: a `-sk-…`
 * run inside a signature must not split the token. */
/** The rules that mask the VALUE after a key or label (`api_key=v`, `?token=v`), with the value's mask passed in: `mask` for every
 * strict reader, the owner-zone floor (ownerZoneMask) for the owner's own direct chat. */
const labelValueRules = (maskValue: (value: string, key?: string) => string): readonly (readonly [string, TrackedRule])[] => [
  ["KEY_VALUE", (text, edits) => replaceTracked(text,
    KEY_VALUE,
    (_m, _q: string, leadA: string | undefined, keyA: string | undefined, leadB: string | undefined, keyB: string | undefined, sep: string, quote: string, value: string) =>
      `${leadA ?? leadB}${keyA ?? keyB}${sep}${quote}${maskValue(value, keyA ?? keyB)}${quote}`, edits,
  )],
  ["QUERY_KEY", (text, edits) => replaceTracked(text, QUERY_KEY, (match: string, lead: string, value: string) => (NUMERIC_VALUE.test(value) ? match : `${lead}${maskValue(value)}`), edits)],
];
export const TEXT_RULES: readonly (readonly [string, TrackedRule])[] = [
  ["PEM_BLOCK", redactPemBlocks],
  ["BEARER", (text, edits) => replaceTracked(text, BEARER, (_m, lead: string, tok: string) => `${lead}${mask(tok)}`, edits)],
  ...labelValueRules(mask),
  ["JWT", (text, edits) => replaceTracked(text, JWT, (_m, lead: string, tok: string) => `${lead}${mask(tok)}`, edits)],
  ...KEY_PREFIXES.map((re, index) => [`KEY_PREFIXES[${index}]`, (text: string, edits?: EditCollector) => replaceTracked(text, re, (m) => mask(m), edits)] as const),
  // Bank, card, account and personal id numbers keep their shape and lose
  // their digits, byte for byte (shared/financial-ids.ts). Last, so a secret
  // rule above sees the text as typed.
  ["FINANCIAL_ID", (text, edits) => {
    const shown = keepDecimalNumbers(text, maskFinancialIdentifiers(text));
    for (let at = 0; at < text.length;) {
      if (text[at] === shown[at]) { at++; continue; }
      const start = at++; while (at < text.length && text[at] !== shown[at]) at++;
      edits?.({ start, end: at, length: at - start });
    }
    return shown;
  }],
];


/** A decimal number is not a card. The card rule reads any 13 to 19 digit
 * Luhn-valid run "wherever it stands" and takes a dot as a group separator, so
 * about one float in ten with a long fraction (a search score such as
 * `4.718623638153076` in a tool's JSON result) was masked as a card, and that
 * one hit latched the whole turn for its audience. Kept as typed: a digit run
 * that is exactly ONE decimal literal (one to three digits, one dot, ten to
 * eighteen digits; no digit, letter, `_` or further group joined on either
 * side) and that the rules mask standing alone, i.e. with no context word. A
 * card in any real grouping (three or more groups, spaces, dashes, a four
 * digit first group) and every number beside a bank or id word stay masked. */
const DECIMAL_LITERAL = /(?<![A-Za-z0-9_])(?<!\d[ \t.\/-]{1,2})\d{1,3}\.\d{10,18}(?![A-Za-z0-9_])(?![ \t.\/-]{1,2}\d)/g;
function keepDecimalNumbers(text: string, shown: string): string {
  if (shown === text) return shown;
  let out = shown;
  for (const m of text.matchAll(DECIMAL_LITERAL)) {
    const start = m.index, end = start + m[0].length;
    if (shown.slice(start, end) === m[0]) continue;
    // Only the context-free hit: the literal alone masks the same way.
    if (maskFinancialIdentifiers(m[0]) !== shown.slice(start, end)) continue;
    out = out.slice(0, start) + m[0] + out.slice(end);
  }
  return out;
}

const USER_TEXT_WORK = 1_048_576;
/** MAIN-RULING cause22-no-transport-caps (1.0.21): a reply of any size is redacted and shown, never swapped whole for
 * the marker because it is long. Ordinary text costs about 3 work units a character; the allowance per character keeps
 * the scan linear in the text, so only work out of proportion to the text (not its size) still fails closed. */
const USER_TEXT_WORK_PER_CHAR = 64;
type TextScanResult = ReturnType<typeof scan>;
/** A long text is scanned whole now (no size cap), and one owner line reaches this pass from several sinks in the same turn (row
 * store, transcript, search, the engine's copy). The scan is a pure function of the text, so the last few long results are reused:
 * the same answer, without re-paying a linear scan per sink that pushed a 900 KB steer past its 4 s acknowledgement window. */
const USER_SCAN_MEMO_MIN = 65_536, USER_SCAN_MEMO_ENTRIES = 4, USER_SCAN_MEMO_CHARS = 16 * 1_048_576;
const userScanMemo = new Map<string, TextScanResult>();
function redactUserLabels(text: string): TextScanResult {
  const memo = text.length >= USER_SCAN_MEMO_MIN && text.length <= USER_SCAN_MEMO_CHARS;
  if (memo) {
    const hit = userScanMemo.get(text);
    if (hit) { userScanMemo.delete(text); userScanMemo.set(text, hit); return hit; }
  }
  let result: TextScanResult;
  try { result = scan(text, { mode: "user", providers: false, budget: USER_TEXT_WORK, perChar: USER_TEXT_WORK_PER_CHAR }); }
  catch { return { text: "«redacted»", detected: true, exhausted: true, candidates: [], spans: [], workUnits: USER_TEXT_WORK }; }
  if (memo) {
    userScanMemo.set(text, Object.freeze(result));
    let chars = 0; for (const key of userScanMemo.keys()) chars += key.length;
    for (const key of userScanMemo.keys()) {
      if (userScanMemo.size <= USER_SCAN_MEMO_ENTRIES && chars <= USER_SCAN_MEMO_CHARS) break;
      userScanMemo.delete(key); chars -= key.length;
    }
  }
  return result;
}
/** Forward the shared scanner's original spans through subsequent Basic masking. */
const trackedUserLabels: TrackedRule = (text, edits) => {
  const result = redactUserLabels(text);
  if (result.exhausted) {
    edits?.({ start: 0, end: text.length, length: result.text.length });
    return result.text;
  }
  for (const span of result.spans ?? []) {
    const detail = span as typeof span & { wrapped?: boolean; pem?: boolean };
    const rest = text.slice(span.from, span.to);
    if ((detail.wrapped || detail.pem) && secretLabels.isExactMarker(rest.trim())) continue;
    const length = detail.pem ? 2 + `«redacted ${rest.trim().length} chars»`.length
      : (detail.wrapped ? 1 : 0) + `«redacted ${rest.length} chars»`.length;
    edits?.({ start: span.from, end: span.to, length });
  }
  return result.text;
};

/** Credential pass for complete engine diagnostic captures. The audience boundary applies the turn policy after this formatting pass. */
const textMarker = (n:number) => `«redacted ${n} chars»`;
const textRules = TEXT_RULES.map(([,rule])=>rule);
export const TEXT_SECRET_STAGES = [basicStage([trackedUserLabels,...textRules],textMarker)];
const sinkMask = (rest:string)=>`«redacted ${rest.length} chars»`;
export const SINK_SECRET_STAGES = [basicStage([
  (value,edits,discardCarry)=>maskSecretLabelsToEnd(value,sinkMask,undefined,edits,discardCarry),...textRules,
],textMarker)];
const formatDiagnostic:TrackedRule=(text,edits)=>replaceTracked(text,
  /((?:api[ _-]?key|apikey|secret|token|password|passwd|authorization|auth[ _-]?token|access[ _-]?key|private[ _-]?key)s?)[ \t]*[=:][ \t]*(«redacted \d{1,9} chars»)/gi,
  (_m,name,mark)=>`${name} ${mark}`,edits);
export const DIAGNOSTIC_SECRET_STAGES = [basicStage(textRules,textMarker),tracked(formatDiagnostic),...TEXT_SECRET_STAGES];
export const baseSecretsInText=(text:string)=>runStages(text,TEXT_SECRET_STAGES);
/** q1023-ownermask (MAIN PREPARED OPTION B, the owner's own private direct chat, as upstream OpenMausBot): only the high-precision
 * credential SHAPES are masked in place (a PEM private-key block, a Bearer token, a JWT, the vendor-prefix keys of KEY_PREFIXES and
 * the vendor rules of shared/provider-secret-mask.mjs), each as the same «redacted N chars» marker. Label, key=value, query, financial
 * and user-label rules are not run: an unsure value is shown. Every other reader keeps redactSecretsInText. */
const CREDENTIAL_SHAPE_RULES = TEXT_RULES.filter(([name]) => name === "PEM_BLOCK" || name === "BEARER" || name === "JWT" || name.startsWith("KEY_PREFIXES[")).map(([,rule])=>rule);
export const CREDENTIAL_SHAPE_STAGES = [basicStage(CREDENTIAL_SHAPE_RULES,textMarker)];
export function redactCredentialShapesInText(text:string):string {
  if(!text)return text;
  return maskVendorLast(text,CREDENTIAL_SHAPE_STAGES,textMarker);
}
/** q1023-ownershow (MAIN option B + MAIN-RULING 2026-11-27T03:17:37Z labelled-value floor): THE owner-zone rule, the one test every
 * masker on the owner's own direct-chat path applies to a value after a credential label: it is masked in place only when it is
 * LABEL_FLOOR (16) or more characters or itself holds a credential shape; a shorter labelled value (`token: D-4821`) is shown.
 * harness/masked-values.ts grades the turn's recorded values with it; redactOwnerZone masks the owner's reply text with it. */
export const LABEL_FLOOR = 16;
/** The value's own characters: the quotes, backticks, brackets and Markdown emphasis around it and the punctuation after it are not
 * counted (`token: D-4821`, **token:** D-4821). */
const ownValueOf = (value: string) => {
  // a bold label's closer before the value (`** D-4821`), then quotes/backticks/brackets and trailing punctuation, then emphasis only
  // as a matched pair around the value (`**D-4821**`): a lone `_` or `*` at one edge is part of the value and counted
  const bare = value.trim().replace(/^[*_~]+(?=\s)/, "").trim().replace(/^[`'"([{<]+/, "").replace(/[`'")\]}>.,;:!?]+$/, "");
  return (/^([*_~]+)(.+?)\1$/.exec(bare)?.[2] ?? bare).trim();
};
const credentialShapeIn = (value: string) => { try { return redactCredentialShapesInText(value) !== value; } catch { return true; } };
/** One token of key characters with letters AND digits at or over the floor: key material, never a word of a sentence, a URL or
 * another `name=value` pair. */
const keyLikeToken = (token: string) => /^[A-Za-z0-9+/_-]{16,}={0,2}$/.test(token) && /[A-Za-z]/.test(token) && /\d/.test(token);
/** The grade of ONE token (a value with no spaces in it): a credential shape, or its own characters at or over the floor. A value
 * with words in it is never graded here by its length (q1024-ownermaskboot: that cut the owner's reply after a short value); the
 * owner zone cuts such a value token by token (ownerValueCuts below). */
export function ownerZoneGrade(value: string): boolean {
  if (credentialShapeIn(value)) return true;
  const own = ownValueOf(value);
  return !/\s/.test(own) && own.length >= LABEL_FLOOR;
}
/** MAIN-RULING ownermask 2026-11-27 (H2): the labels whose value is ALWAYS masked in place in the owner's own chat, whatever its
 * length or shape. Every other label (token, key, authorization, ...) shows its value as typed unless the value itself is key-like. */
const STRONG_LABEL = /(?:password|passwd|passphrase|pwd|pin|secret|private[ _-]?key)s?$/i;
export const ownerZoneStrongLabel = (name: string) => STRONG_LABEL.test(name.replace(/[*`~«»"']/g, "").trim());
const ownerZoneMask = (value: string, key = "") => ownerZoneStrongLabel(key) || ownerZoneGrade(value) ? mask(value) : value;
/** A label the strict scanner knows (shared/md-secret-label.mjs SECRET_NAME) or one of the strong labels it does not (passphrase,
 * pwd, pin), with the marks a Markdown label carries (`**Password:**`), ending at its separator. */
const OWNER_LABEL_END = /(?<![A-Za-z0-9])((?:api[ _-]?key|apikey|secret|token|password|passwd|passphrase|pwd|pin|authorization|auth[ _-]?token|access[ _-]?key|private[ _-]?key)s?)[*`~_ \t]*[=:]$/i;
const OWNER_EXTRA_LABEL = /(?<![A-Za-z0-9_-])(?:passphrase|pwd|pin)s?[*`~ \t]*[=:]/gi;
type OwnerCut = { start: number; end: number };
/** One whitespace token's own characters: the quotes, brackets and emphasis at its edges and the punctuation after it stay in the text. */
const tokenCore = (token: string): [lead: number, length: number] => {
  const lead = /^[`'"([{<*_~]*/.exec(token)![0].length, tail = /[`'")\]}>.,;:!?*_~]*$/.exec(token.slice(lead))![0].length;
  return [lead, token.length - lead - tail];
};
/** MAIN-RULING ownermask 2026-11-27 (H1 + H2): what the owner's own chat masks of ONE label's value on one line, as cuts of that
 * line. Only the secret's own characters are cut; the words after it are never dropped.
 * The value is what the writer delimited (the inline code the label stands in, or the quotes/backticks around the value); else its
 * first token. A strong label masks its value whatever it is; an undelimited one is the whole phrase up to
 * the first punctuation mark, bracket or dash, or the end of its line (`Password: correct horse battery staple`, `Password: summer is
 * here 2024, as before.` keeps `, as before.`), on a record line or in prose alike. No word ends it: nothing tells a passphrase's word
 * from a sentence's, so the rule fails closed (H2 ALWAYS, whatever its shape) and words that run on after an undelimited password
 * with no punctuation between are masked with it; what the writer delimits (quotes, backticks, inline code) loses only itself, and so
 * does a real key (a key-like first token is the whole value: `password: <16+ letters and digits> and then restart`, H1). The phrase
 * also ends before the next secret label of the line (`nextLabel`, where that label's name starts, from the label scan's own list:
 * `DB_PASSWORD=a b API_TOKEN=c`, `Password: a and token = c`, `pin: 1 then private key: d` leave the second label, whole, to its own rule). Any other
 * label masks its value only when it is key-like: a token at or over the floor, or a delimited value whose joined tokens are key
 * material. A key-like token later on the line is masked in place too. */
function ownerValueCuts(line: string, from: number, strong: boolean, inCode: boolean, nextLabel = Infinity): OwnerCut[] {
  const cuts: OwnerCut[] = [];
  let at = from + /^\s*(?:[*_~]+(?=\s|$))?\s*/.exec(line.slice(from))![0].length;
  if (at >= line.length || line.startsWith("«redacted", at)) return cuts;
  let after = at;
  const close = inCode ? line.indexOf("`", at) : "`\"'".includes(line[at]!) ? line.indexOf(line[at]!, at + 1) : -1;
  if (close > (inCode ? at : at + 1)) {
    let start = inCode ? at : at + 1, end = close;
    while (start < end && /\s/.test(line[start]!)) start++;
    while (end > start && /\s/.test(line[end - 1]!)) end--;
    const value = line.slice(start, end), tokens = value.split(/\s+/).filter(Boolean);
    if (value && !value.startsWith("«redacted") && (strong || credentialShapeIn(value) || tokens.some(token => tokenCore(token)[1] >= LABEL_FLOOR) || keyLikeToken(tokens.join("")))) cuts.push({ start, end });
    after = close + 1;
  } else {
    const tokens = [...line.slice(at).matchAll(/\S+/g)].map(m => ({ at: at + m.index, text: m[0] }));
    const first = tokens[0]!, core = tokenCore(first.text);
    // H2 "whatever its length or shape": a strong value of punctuation only (`pwd: !!!!`) has no core; the token itself is the value
    const [lead, length] = strong && core[1] === 0 ? [0, first.text.length] : core;
    after = first.at + first.text.length;
    if (length > 0 && strong) {
      let last = 0;
      // a real key (ruling H1: "a real key with words after it keeps those words"): the key-like token is the whole value
      const keyFirst = keyLikeToken(first.text.slice(lead, lead + length)) || credentialShapeIn(first.text.slice(lead, lead + length));
      while (!keyFirst && last + 1 < tokens.length && tokens[last + 1]!.at + tokens[last + 1]!.text.length <= nextLabel && !/[.,;:!?)\]}]$/.test(tokens[last]!.text) && /^[\p{L}\p{N}]/u.test(tokens[last + 1]!.text)) last++;
      const [endLead, endLength] = tokenCore(tokens[last]!.text);
      cuts.push({ start: first.at + lead, end: last === 0 ? first.at + lead + length : tokens[last]!.at + endLead + endLength });
      after = tokens[last]!.at + tokens[last]!.text.length;
    } else if (length >= LABEL_FLOOR) cuts.push({ start: first.at + lead, end: first.at + lead + length });
  }
  for (const m of line.slice(after).matchAll(/\S+/g)) {
    const [lead, length] = tokenCore(m[0]);
    if (keyLikeToken(m[0].slice(lead, lead + length))) cuts.push({ start: after + m.index + lead, end: after + m.index + lead + length });
  }
  return cuts;
}
/** Every cut the owner's own chat makes for the labelled values of a text (absolute offsets, sorted, not overlapping), or undefined
 * when the label scan ran out of budget (the caller fails closed to the strict text). Walks the text line by line, every label of
 * every line (the strict scanner stops at the first label it cannot bound and masks to the end of the text: the cut reply of the
 * field report). A label with nothing after it on its line takes the next non-empty line as its value; after any label, a later
 * line that is one key-like token (a key wrapped below its label) is masked in place. */
function ownerLabelCuts(text: string, pem: readonly Readonly<{ from: number; to: number }>[]): OwnerCut[] | undefined {
  const cuts: OwnerCut[] = pem.map(span => ({ start: span.from, end: span.to }));
  try {
    let pending: { strong: boolean } | undefined, seen = false;
    for (let start = 0; start <= text.length;) {
      let end = text.indexOf("\n", start); if (end < 0) end = text.length;
      const line = text.slice(start, end);
      if (line.trim() && !/^\s*(?:```|~~~)[\w-]*\s*$/.test(line)) {
        const ends = new Set(secretLabels.findSecretLabels(line).map(label => label.sepEnd));
        OWNER_EXTRA_LABEL.lastIndex = 0;
        for (let m; (m = OWNER_EXTRA_LABEL.exec(line));) ends.add(m.index + m[0].length);
        const labels = [...ends].sort((x, y) => x - y);
        if (pending && !labels.length) for (const cut of ownerValueCuts(line, 0, pending.strong, false)) cuts.push({ start: start + cut.start, end: start + cut.end });
        else if (seen && !labels.length) {
          const own = ownValueOf(line), at = line.indexOf(own);
          // a UUID line is an ordinary id of a listing, never key material (q1023-heldscan, MAIN-RULING 2026-11-26T17:44Z)
          if (own && at >= 0 && !/\s/.test(own) && keyLikeToken(own) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(own)) cuts.push({ start: start + at, end: start + at + own.length });
        }
        pending = undefined;
        for (const sepEnd of labels) {
          seen = true;
          const head = line.slice(0, sepEnd), name = OWNER_LABEL_END.exec(head), labelAt = name ? name.index : sepEnd;
          const strong = name ? ownerZoneStrongLabel(name[1]!) : false;
          const inCode = (line.slice(0, labelAt).match(/`/g)?.length ?? 0) % 2 === 1;
          if (!/[^\s*_~`]/.test(line.slice(sepEnd))) { if (sepEnd === labels.at(-1)) pending = { strong }; continue; }
          const next = labels.find(later => later > sepEnd), nextName = next === undefined ? null : OWNER_LABEL_END.exec(line.slice(0, next));
          const nextLabel = next === undefined ? undefined : nextName ? nextName.index : next - 1;
          for (const cut of ownerValueCuts(line, sepEnd, strong, inCode, nextLabel)) cuts.push({ start: start + cut.start, end: start + cut.end });
        }
      }
      start = end + 1;
    }
  } catch { return undefined; }
  cuts.sort((x, y) => x.start - y.start || y.end - x.end);
  const merged: OwnerCut[] = [];
  for (const cut of cuts) { const last = merged.at(-1); if (last && cut.start < last.end) last.end = Math.max(last.end, cut.end); else if (cut.end > cut.start) merged.push({ ...cut }); }
  return merged;
}
/** The label scan's PEM-body spans (masked as for every reader) and whether the scan ran out of budget. */
function ownerLabelScan(text: string): { cuts: OwnerCut[]; pem: Set<number> } | undefined {
  const result = redactUserLabels(text);
  if (result.exhausted) return undefined;
  const pem = (result.spans ?? []).filter(span => (span as typeof span & { pem?: boolean }).pem === true && !secretLabels.isExactMarker(text.slice(span.from, span.to).trim()));
  const cuts = ownerLabelCuts(text, pem);
  return cuts && { cuts, pem: new Set(pem.map(span => span.from)) };
}
/** The labelled values the owner's own chat masks in place in this text, each as written (harness/masked-values.ts marks exactly
 * these credential grade, never the line they stand on: the words kept after a value must not count as parts of it). */
export function ownerZoneLabelValues(text: string, joinAt = -1): string[] {
  const scanned = ownerLabelScan(text);
  // `joinAt`: the text is two texts read as one (the recorder's reading of a reply after the end of the one before it). A value that
  // runs across the join is no value either text wrote (`Your password: ab12` + `Short link: ...` is not the password `ab12Short`):
  // it is not taken, each side's own values are.
  return scanned ? scanned.cuts.filter(cut => !scanned.pem.has(cut.start) && !(cut.start < joinAt && cut.end > joinAt)).map(cut => text.slice(cut.start, cut.end)) : [];
}
/** A strong label stands in the text (MAIN-RULING ownermask H2). The strict projection of such a reply can be clean (passphrase, pwd
 * and pin are no labels of the strict scanner, and it passes a password of plain words), and the owner's own chat still masks the
 * value: owner-display.ts ownerMaskedReplyText enters the owner zone on it. */
const STRONG_LABEL_IN = /(?<![A-Za-z0-9])(?:password|passwd|passphrase|pwd|pin|secret|private[ _-]?key)s?[*`~_ \t]*[=:]/i;
export function ownerZoneStrongLabelIn(text: string): boolean { return STRONG_LABEL_IN.test(text); }
/** The owner's own chat, labelled values (MAIN-RULING ownermask 2026-11-27): each secret value is replaced in place by its marker and
 * nothing else of the text changes. Fail closed to the strict text only when the label scan itself ran out of budget. */
const ownerZoneUserLabels: TrackedRule = (text, edits) => {
  const scanned = ownerLabelScan(text);
  if (!scanned) return trackedUserLabels(text, edits);
  const parts: string[] = []; let at = 0;
  for (const cut of scanned.cuts) {
    const rest = text.slice(cut.start, cut.end);
    const shown = scanned.pem.has(cut.start) ? `\n«redacted ${rest.trim().length} chars»\n` : `«redacted ${rest.length} chars»`;
    parts.push(text.slice(at, cut.start), shown); at = cut.end;
    edits?.({ start: cut.start, end: cut.end, length: shown.length });
  }
  parts.push(text.slice(at));
  return parts.join("");
};
const ownerZoneLabelRules = new Map(labelValueRules(ownerZoneMask));
// the strict chain (TEXT_SECRET_STAGES) rule for rule, in the same order; only the labelled-value rules take the floor
const OWNER_ZONE_RULES = [ownerZoneUserLabels, ...TEXT_RULES.map(([name, rule]) => ownerZoneLabelRules.get(name) ?? rule)];
const OWNER_ZONE_STAGES = [basicStage(OWNER_ZONE_RULES, textMarker)];
/** The owner's own direct chat (owner-display.ts ownerMaskedReplyText, the store's write of an ownerMasked row, the owner's own read
 * and live frame of it): the strict pass (redactSecretsInText) with every labelled value graded by ownerZoneGrade. Credential shapes,
 * vendor keys, basic-auth and financial ids are masked as for every reader. Shared rooms, channels, diagnostics and logs never use it. */
export function redactOwnerZone(text: string): string {
  if (!text) return text;
  return maskVendorLast(text, OWNER_ZONE_STAGES, textMarker);
}
export const baseSecretsForSink=(text:string)=>runStages(text,SINK_SECRET_STAGES);
export const baseDiagnosticCredentials=(text:string)=>runStages(text,DIAGNOSTIC_SECRET_STAGES);
export function redactEngineDiagnosticCredentials(text:string):string {
  return maskVendorLast(text,DIAGNOSTIC_SECRET_STAGES,textMarker);
}
export function redactSecretsInText(text:string):string {
  if(!text)return text;
  return maskVendorLast(text,TEXT_SECRET_STAGES,textMarker);
}
export function redactSecretsForSink(text:string):string {
  if(!text)return text;
  return maskVendorLast(text,SINK_SECRET_STAGES,textMarker);
}

/** `redactSecrets` for machine sinks: every string leaf, the depth fallback and
 * env-array values go through `redactSecretsForSink`. */
export function redactSecretsForSinkWalk(input: unknown): unknown {
  return redactWalk(input, 0, false, true);
}

/** Deep copy with credential VALUES replaced. Handles the two shapes that
 * actually carry them: a plain object of env vars ({KEY: "v"}) and the ACP
 * wire shape (env: [{name, value}]). Anything unrecognised is copied as-is. */
/** How deep the structural walk goes before it stops descending.
 *
 * Twelve is far past any real provider payload. What matters is what happens
 * AT the limit: see below. */
const MAX_DEPTH = 12;

/** Approval cards show the owner what is asked, so a name-shaped key with a
 * short plain value ({token: "USDC"}) stays readable; the text rules still
 * catch real credentials. These names are always masked. */
const ALWAYS_MASK_NAMES = new Set(["password", "passwd", "authorization", "cookie"]);
const CARD_NAME_MIN_VALUE = 8;

export function redactSecretsForCard(input: unknown): unknown {
  return redactWalk(input, 0, true);
}

export function redactSecrets(input: unknown, depth = 0): unknown {
  return redactWalk(input, depth, false);
}

function redactWalk(input: unknown, depth: number, card: boolean, sink = false): unknown {
  const secretName = (name: string, value: string) =>
    isSecretName(name) && (!card || ALWAYS_MASK_NAMES.has(name.toLowerCase()) || value.length >= CARD_NAME_MIN_VALUE);
  const redactText = sink ? redactSecretsForSink : redactSecretsInText;
  if (typeof input === "string") return redactText(input);
  if (input === null || typeof input !== "object") return input;
  if (depth > MAX_DEPTH) {
    // FAIL CLOSED. This used to `return input`, which handed the entire
    // remaining subtree back unscrubbed — `{token: "…"}` nested thirteen deep
    // was written verbatim into ~/.murage/events/*.ndjson, the file people
    // paste into bug reports. Exhausting a traversal budget is not evidence
    // that the subtree is safe.
    //
    // The content pass still runs over the serialised form, so a credential
    // down here is masked and the shape stays legible for debugging.
    // Serialisation can throw on a cycle or a BigInt; that is exactly the
    // case where guessing is worst, so it collapses to a marker.
    try {
      return redactText(JSON.stringify(input) ?? "");
    } catch {
      return "«redacted: unserialisable subtree past depth budget»";
    }
  }

  if (Array.isArray(input)) {
    return input.map((item) => {
      // ACP env entries: {name: "MURAGE_COMMS_TOKEN", value: "…"}
      if (
        item !== null &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        typeof (item as { name?: unknown }).name === "string" &&
        typeof (item as { value?: unknown }).value === "string"
      ) {
        const entry = item as { name: string; value: string } & Record<string, unknown>;
        // Scrub the WHOLE entry first, then decide about `value`.
        //
        // This used to spread `{...entry}` and rewrite only `value`, so every
        // other property rode through untouched — and the shortcut is not
        // limited to ACP env arrays, it fires on ANY array element that
        // happens to have string `name` and `value`. An element like
        // `{name, value, authorization: "Bearer …", metadata: {password}}`
        // therefore defeated the only scrub standing between a provider
        // payload and the on-disk log.
        const scrubbed = redactWalk({ ...entry }, depth + 1, card, sink) as Record<string, unknown>;
        // A non-secret-shaped name (a custom env var, a feature flag) does
        // not clear the value of suspicion — the same content pass every
        // other string in this tree gets is what catches a credential
        // someone stashed under an ordinary-looking name.
        return {
          ...scrubbed,
          value: secretName(entry.name, entry.value) ? mask(entry.value) : redactText(entry.value),
        };
      }
      return redactWalk(item, depth + 1, card, sink);
    });
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string" && secretName(key, value)) {
      out[key] = mask(value);
      continue;
    }
    // any other string may still CONTAIN a credential (a command line, a
    // header value, a bot's reply) — the content pass catches those
    out[key] = redactWalk(value, depth + 1, card, sink);
  }
  return out;
}

/** B3: each native compatibility pass reserves its input traversal before it
 * runs. A single dispatch scan avoids twenty passes over ordinary prose.
 * Original-coordinate spans keep a prior replacement from hiding a match. */
function compatibilitySpans(text: string, spend: ScanCharge): SecretSpan[] {
  spend(text.length);
  const hints = new Set<string>();
  for (const m of text.matchAll(/authorization|Bearer|[=:]|[?&]|eyJ|-----BEGIN|sk-|(?:ghp|gho|ghu|ghs|ghr)_|github_pat_|gl(?:pat|dt|rtr?)-|xox[abposr]-|xapp-|AKIA|AIza|npm_|xai-|gsk_|hf_|[0-9]/gi)) hints.add(m[0].toLowerCase());
  const out: SecretSpan[] = [];
  if (hints.has("authorization")) {
    // basicSpans exposes bounded visits; reserve the native input pass, then
    // charge its additional counted visits under the very same cap.
    spend(text.length);
    const work = { visits: 0, allocations: 0 };
    const spans = basicSpans(text, work); spend(work.visits - text.length);
    out.push(...spans.map(s => ({ from: s.start, to: s.end })));
  }
  // The primary scanner already performed every per-line label scan, on the
  // original input. Repeating maskSecretLabelsToEnd would duplicate that work.
  for (const [name, rule] of TEXT_RULES) {
    const needed = name === "PEM_BLOCK" ? hints.has("-----begin")
      : name === "BEARER" ? hints.has("bearer")
      : name === "KEY_VALUE" ? hints.has(":") || hints.has("=")
      : name === "QUERY_KEY" ? hints.has("?") || hints.has("&")
      : name === "JWT" ? hints.has("eyj")
      : name === "FINANCIAL_ID" ? [...hints].some(h => /^[0-9]$/.test(h))
      : [...hints].some(h => /^(sk-|gh[pousr]_|github_pat_|gl|xox|xapp-|akia|aiza|npm_|xai-|gsk_|hf_)/.test(h));
    if (!needed) continue;
    spend(text.length);
    rule(text, e => { spend(); out.push({ from: e.start, to: e.end }); });
  }
  return out;
}

/** The complete turn checker has ONE SSB cap, including all legacy passes.
 * Meter totals are returned by scan(), even when a later pass exhausts. */
export function scanTurnText(text: string, options: { mode?: "turn"; budget?: number; perChar?: number; vendor?: boolean } = {}): SecretScanResult {
  return scan(text, { mode: "turn", budget: options.budget ?? SECRET_SCAN_BUDGET, perChar: options.perChar, vendor: options.vendor, turnComplete: true }, (original, result, spend) => {
    const spans = [...(result.spans ?? []), ...compatibilitySpans(original, spend)];
    spend(spans.length * (1 + Math.ceil(Math.log2(spans.length + 1))));
    spans.sort((a, b) => a.from - b.from || b.to - a.to);
    const merged: { from: number; to: number }[] = [];
    for (const span of spans) {
      const last = merged.at(-1);
      if (last && span.from <= last.to) last.to = Math.max(last.to, span.to);
      else merged.push({ ...span });
    }
    const parts: string[] = []; let at = 0;
    for (const span of merged) { parts.push(original.slice(at, span.from), "«redacted»"); at = span.to; }
    parts.push(original.slice(at));
    return { ...result, spans: merged, text: parts.join(""), detected: merged.length > 0 };
  });
}
