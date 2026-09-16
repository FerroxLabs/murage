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

/** Key names whose value is a credential. Matched case-insensitively as a
 * substring, so KEY catches ANTHROPIC_API_KEY and x-api-key. */
const SECRET_KEY_PARTS = ["token", "secret", "password", "passwd", "apikey", "api_key", "authorization", "auth_token"];

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

const KEY_PREFIXES: RegExp[] = [
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, // anthropic / openai / stripe
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, // github classic
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // github fine-grained
  /\bxox[abposr]-[A-Za-z0-9-]{20,}/g, // slack
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
  /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b)([A-Za-z0-9_-]*?)\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b)/g;
const BEARER = /(\bBearer\s+)([A-Za-z0-9._~+/=-]{12,})/g;
/** A PEM private-key block: the header, everything up to the FIRST footer,
 * the footer. The original `(-----BEGIN …)([\s\S]*?)(-----END …)` scanned
 * from every header to the end of the text when no footer followed, so n
 * headers cost n passes over the text. `redactPemBlocks` below does what
 * that regex did, in one pass: find the next header, find the first footer
 * after it, mask what lies between, continue after the footer — and stop at
 * the first header with no footer, because no later header can have one. */
const PEM_OPEN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const PEM_CLOSE = /-----END [A-Z ]*PRIVATE KEY-----/g;
function redactPemBlocks(text: string): string {
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
    out += `${text.slice(pos, open.index)}${open[0]}\n${mask(text.slice(bodyAt, close.index).trim())}\n${close[0]}`;
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
 * called linear without a measured number for that rule. */
export const TEXT_RULES: readonly (readonly [string, (text: string) => string])[] = [
  ["PEM_BLOCK", redactPemBlocks],
  ...KEY_PREFIXES.map((re, index) => [`KEY_PREFIXES[${index}]`, (text: string) => text.replace(re, (m) => mask(m))] as const),
  ["JWT", (text) => text.replace(JWT, (_m, lead: string, tok: string) => `${lead}${mask(tok)}`)],
  ["BEARER", (text) => text.replace(BEARER, (_m, lead: string, tok: string) => `${lead}${mask(tok)}`)],
  ["KEY_VALUE", (text) => text.replace(
    KEY_VALUE,
    (_m, _q: string, leadA: string | undefined, keyA: string | undefined, leadB: string | undefined, keyB: string | undefined, sep: string, quote: string, value: string) =>
      `${leadA ?? leadB}${keyA ?? keyB}${sep}${quote}${mask(value)}${quote}`,
  )],
  ["QUERY_KEY", (text) => text.replace(QUERY_KEY, (match: string, lead: string, value: string) => (NUMERIC_VALUE.test(value) ? match : `${lead}${mask(value)}`))],
];

export function redactSecretsInText(text: string): string {
  if (!text || text.length < 8) return text;
  let out = text;
  for (const [, rule] of TEXT_RULES) out = rule(out);
  return out;
}

/** Deep copy with credential VALUES replaced. Handles the two shapes that
 * actually carry them: a plain object of env vars ({KEY: "v"}) and the ACP
 * wire shape (env: [{name, value}]). Anything unrecognised is copied as-is. */
/** How deep the structural walk goes before it stops descending.
 *
 * Twelve is far past any real provider payload. What matters is what happens
 * AT the limit: see below. */
const MAX_DEPTH = 12;

export function redactSecrets(input: unknown, depth = 0): unknown {
  if (typeof input === "string") return redactSecretsInText(input);
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
      return redactSecretsInText(JSON.stringify(input) ?? "");
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
        const scrubbed = redactSecrets({ ...entry }, depth + 1) as Record<string, unknown>;
        // A non-secret-shaped name (a custom env var, a feature flag) does
        // not clear the value of suspicion — the same content pass every
        // other string in this tree gets is what catches a credential
        // someone stashed under an ordinary-looking name.
        return {
          ...scrubbed,
          value: isSecretName(entry.name) ? mask(entry.value) : redactSecretsInText(entry.value),
        };
      }
      return redactSecrets(item, depth + 1);
    });
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string" && isSecretName(key)) {
      out[key] = mask(value);
      continue;
    }
    // any other string may still CONTAIN a credential (a command line, a
    // header value, a bot's reply) — the content pass catches those
    out[key] = redactSecrets(value, depth + 1);
  }
  return out;
}
