// Generic ACP (Agent Client Protocol) driver core — one JSON-RPC-2.0-over-
// stdio session runtime that every ACP CLI harness (Grok Build, Gemini CLI,
// …) rides. Modeled on t3code's AcpSessionRuntime + per-agent AcpSupport
// split: the protocol mechanics live here, the per-harness quirks (spawn
// argv, auth method, model catalog, sign-in check) live in a small support
// object. Adding a harness = write server/drivers/acp/<name>.ts.
//
// ACP has no `turn/completed` notification: the `session/prompt` RPC *result*
// is the completion signal (it carries stopReason + usage). Permission
// requests arrive as server→client `session/request_permission` and surface
// as canonical request.opened events, answered fail-closed (nothing approved
// unless the agent explicitly offered an `allow`-kind option — option ORDER
// is never a security contract). session/load REPLAYS history as ordinary
// session/update notifications, so updates are double-gated: nothing emits
// before the prompt is sent, and `_meta.isReplay` updates are dropped.
import { applyProviderRoute, grokResumeBinding, validateProviderTurnRoute } from "../../provider-routing.ts";
import { isQuestionTool } from "../../auto-approve.ts";
import { fuigoMemoryAllowOnce, newFuigoMemoryAlias } from "./fuigo-memory-permission.ts";
import {
  fromElicitationForm,
  fromElicitationUrl,
  fromFuigo,
  toElicitationContent,
  toFuigoAnswers,
  type QuestionAnswer,
  type QuestionSpec,
} from "../../question-normalize.ts";
import { QUESTION_TIMEOUT_MS } from "../../../shared/questions.ts";
import {
  folderTrustDecision,
  folderTrustQuestion,
  folderTrustLateName,
  folderTrustWithheldName,
  type FolderTrustDecision,
} from "../../../shared/folder-trust.ts";
import { hostStoppedActivityName } from "../../../shared/host-stop.ts";
import { resolveToolIdentity, resolveToolLabel, toolFailureText } from "../../../shared/tool-activity.ts";
import { normalizeAgentPlan } from "../../../shared/agent-plan.ts";
import { extractMcpImages } from "../../mcp-tool-images.ts";
import { folderTrustKindNames } from "../../folder-trust.ts";
import { homedir } from "node:os";
import { stripVTControlCharacters } from "node:util";

import { PROVIDER_CREDENTIAL_ENV, stripRoutingEnv, WORKSPACE_CREDENTIAL_ENV } from "../../config.ts";
import { decodeInjectId } from "../local-inject.ts";
import { createFuigoFailureObservations, failureKind } from "./failure-diagnostics.ts";
import { DIAGNOSTIC_RPC_METHODS, parseRuntimeErrorDiagnostic } from "../../../shared/error-diagnostic.ts";
import { describeSpawnFailure, execCli, killCliTree, spawnCli } from "../../procs.ts";
import { ProviderStopUnconfirmedError, providerCloseDeadlineMs, TurnTeardowns, type TeardownWait } from "../child-teardown.ts";
import {
  createLifecycleRecorder,
  errnoCategory,
  type LifecycleFields,
  type LifecycleStopReason,
} from "../lifecycle-diagnostic.ts";

/** Lifecycle facts of a JSON-RPC error: validated numbers only, and a method
 * only when the response matched a pending request (R1-T8). */
function reasoningOnlyData(data: unknown): boolean {
  // Legacy string-only compatibility. Fuigo 1.0.18 object kinds are never inferred from prose.
  return typeof data === "string" && data.trim().toLowerCase() === "empty response from model (reasoning_only)";
}
function lifecycleRejection(error: unknown, rpcId: unknown, method?: string): LifecycleFields {
  const fields: LifecycleFields = {};
  if (typeof rpcId === "number" && Number.isSafeInteger(rpcId) && rpcId >= 0) fields.rpcId = rpcId;
  if (method !== undefined) fields.method = method;
  const { code, data } = (error && typeof error === "object" ? error : {}) as { code?: unknown; data?: unknown };
  if (typeof code === "number" && Number.isSafeInteger(code)) fields.rpcCode = code;
  const status = data && typeof data === "object" && !Array.isArray(data) ? (data as { http_status?: unknown }).http_status : undefined;
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) fields.httpStatus = status;
  const terminalKind=(data&&typeof data==="object"&&!Array.isArray(data)?failureKind((data as {error_kind?:unknown}).error_kind):undefined) ?? (reasoningOnlyData(data)?"empty_response":undefined);
  if(terminalKind)fields.terminalKind=terminalKind;
  return fields;
}
/** Project matched diagnostic facts; never spread an engine-owned object. */
export function acpErrorDiagnostic(base:{eventId:string;turnId:string},processGeneration:string,error?:unknown){
  const candidate=(error&&typeof error==="object"?error:{}) as {acpRpcId?:unknown;acpMethod?:unknown;fuigoObservedKind?:unknown};
  const method=typeof candidate.acpMethod==="string"&&(DIAGNOSTIC_RPC_METHODS as readonly string[]).includes(candidate.acpMethod)?candidate.acpMethod:undefined;
  const facts=lifecycleRejection(error,candidate.acpRpcId,method);
  return parseRuntimeErrorDiagnostic({version:1,diagnosticId:base.eventId,turnId:base.turnId,processGeneration,
    rpcId:facts.rpcId,method:facts.method,rpcCode:facts.rpcCode,httpStatus:facts.httpStatus,terminalKind:facts.terminalKind,observedKind:failureKind(candidate.fuigoObservedKind)});
}
import { classifyProviderError, ENGINE_ERROR_KIND_PREFIX, ERROR_MESSAGE_MAX } from "../../../shared/provider-error.ts";
import { redactSecretsInText } from "../../redact.ts";

import { toolFilePaths } from "../../own-workspace-approval.ts";

/** The files an ACP permission request names, for the own-workspace check.
 *
 * A bot's writes inside its OWN managed folders no longer ask, but only
 * the Claude driver reported the paths, so every ACP engine — including the
 * bundled Fuigo the Chief of Staff runs on — still raised all three cards and
 * still stalled an unattended routine. This is the same fact, read off the
 * ACP wire.
 *
 * Two sources, and BOTH must be readable or this answers undefined:
 *   - `locations`, the protocol's own "files this call touches";
 *   - `rawInput`, the engine's structured tool input, via the same reader the
 *     Claude driver uses.
 * The union is returned, never one in preference to the other, so a call that
 * names an innocent path in one place and an escaping path in the other is
 * judged on both. `undefined` means "a shape this cannot read", and every
 * caller treats that as "ask" — never as "allow". */
export function acpToolFilePaths(toolCall: { locations?: unknown; rawInput?: unknown }): string[] | undefined {
  const paths: string[] = [];
  const { locations } = toolCall;
  if (locations !== undefined) {
    // Present but not a non-empty array of `{path: string}` is a shape this
    // does not understand, and the entry it could not read is precisely the
    // one that would escape.
    if (!Array.isArray(locations) || locations.length === 0) return undefined;
    for (const entry of locations) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
      const path = (entry as { path?: unknown }).path;
      if (typeof path !== "string" || !path) return undefined;
      paths.push(path);
    }
  }
  if (toolCall.rawInput !== undefined) {
    const fromInput = toolFilePaths(toolCall.rawInput);
    // `toolFilePaths` answers undefined both for "names no path" and for "a
    // path key it could not read". Only the second is dangerous, and it is
    // the one where a path key is actually present.
    if (fromInput === undefined) {
      const input = toolCall.rawInput;
      const named = Boolean(input) && typeof input === "object" && !Array.isArray(input)
        && ["file_path", "filePath", "notebook_path", "notebookPath", "path"].some(key => key in (input as Record<string, unknown>));
      if (named) return undefined;
    } else paths.push(...fromInput);
  }
  return paths.length ? paths : undefined;
}

/** Some ACP providers wrap actionable billing failures in "Internal error".
 * Classify only the observed shape; never copy nested provider data or URLs
 * into the transcript, where they may contain credentials or request text. */
export function acpRpcErrorMessage(error: { message?: unknown; data?: unknown }): string {
  const info = classifyProviderError(error);
  if (info?.kind === "payment") return "Your model provider rejected this request with HTTP 402. Check its billing and account access; this response does not establish that credits are exhausted.";
  // A ceiling the account reached, not a balance it spent. Saying "add
  // credits" here would be advice the provider itself contradicts.
  if (info?.kind === "spend-cap") {
    return info.provider === "flux-router"
      ? "Your Flux Router account has reached its monthly spending limit. Adding credit will not lift it; ask Flux Router to raise it, or use another engine."
      : "This account has reached its monthly spending limit with the model provider. Adding credit will not lift it — ask them to raise it, or use another engine.";
  }
  if (info?.kind === "credits") {
    if (info.provider === "flux-router") {
      return "Flux Router is out of credits. Add credits in Flux Router, then retry—or choose another configured provider.";
    }
    return "Your model provider's credit balance is exhausted (HTTP 402). Review billing with your provider or choose another configured engine.";
  }
  if (reasoningOnlyData(error.data)) return "The model returned reasoning without a visible answer. No reply was produced.";
  return typeof error.message === "string" && error.message ? error.message : "ACP request failed";
}

/** C0/C1 controls, zero-width characters and bidi overrides: none belongs in one line of error text. */
// eslint-disable-next-line no-control-regex -- matching them is the point
const INVISIBLE_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]+/g;
/** Locators that can carry a credential. A scheme is not what makes one
 * dangerous: engines write `host/path?api_key=…` and `user:pass@host` as
 * readily as an https:// URL, and the transcript must hold neither.
 *
 * Each form is deliberately narrow, because "a dot and a slash" describes a
 * source path at least as often as a host and replacing real diagnostic prose
 * with "[link removed]" makes an error less useful: `src/core.ts:93/foo`, a
 * `retry:2@worker` pair and a sentence ending in `config.json?` all survive.
 *
 * Each entry is the rule and what replaces its match. The rules run on
 * REDACTED text (see `acpEngineErrorText`) whose masks have been made into
 * single tokens, so a `?key=«redacted 8 chars»` is one `\S+` to them, and
 * their input is bounded only by ENGINE_FRAME_MAX_BYTES (32 MiB). So each
 * has to be linear in that input, and each is clocked on its own, on every
 * hostile shape, in acp.test.ts — no rule here is called linear on the
 * strength of how it reads. Round 10 called four of them linear "as
 * written" and two were not: the user:pass@ rule's token class was wider
 * than its lookbehind, so a run of `%`, `~` or `+` was a start position at
 * every character (2.2 s of CPU at 64 KiB, measured, and 40 s at 256 KiB);
 * the host?query rule retried `\S*=` from every `?` after a path (1.9 s at
 * 64 KiB of `host.com/?????…`) and, with only that fixed by ending the path
 * at the first `?`, still scanned to the end of the word from every `/` or
 * `?` a dotted host followed (967 ms at 64 KiB and 3.0 s at 128 KiB of
 * `ab.cd/ab.cd/…`; 1.8 s at 128 KiB of `?ab.cd/?ab.cd/…`).
 * Four of the five are now in the sparse-start form redact.ts uses: a match
 * may begin only where a run of the rule's own characters begins (the
 * user:pass@ rule also at the first `~`, `%` or `+` after an `@host`, for
 * the authority that directly follows another — its comment says why that
 * is still one candidate per run); a lookahead there decides once per run
 * whether anything in it can match; and a lazy group walks to the position
 * the round-10 rule matched at, which is re-emitted in front of the marker.
 * The test that each removes exactly the spans its round-10 form removed is
 * in acp.test.ts. */
/** An IP-literal authority: a dotted IPv4 quad or a bracketed IPv6. Neither
 * ends in an alphabetic TLD, so the dotted-host rules below cannot see one —
 * and a self-hosted engine (Ollama, vLLM, LM Studio on a LAN address) is
 * addressed exactly this way, which makes it where a credential in an
 * authority actually shows up. */
const IP_HOST = String.raw`(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]{2,45}\])`;
/** What may follow a `user:pass@`: a dotted or IP-literal host, with or
 * without a port and a path, or any host with a path. */
const AUTHORITY_HOST = String.raw`(?:(?:[a-z0-9-]+\.)+[a-z]{2,24}(?::\d{1,5})?(?:[/?]\S*)?|${IP_HOST}(?::\d{1,5})?(?:[/?]\S*)?|[a-z0-9-]+(?::\d{1,5})?[/?]\S*)`;
export const LOCATORS: readonly (readonly [RegExp, string])[] = [
  // scheme://… — as `\b[a-z][a-z0-9+.-]*:\/\/\S+`, which is what this rule
  // matches, but that form is quadratic: on `a.a.a.a…` every other position
  // is a `\b`, and from each the engine walks the dotted run to its end
  // looking for `://` and backtracks over it. Round 9 measured it at 4.3 s
  // for 128 KiB and 312 s for 1 MiB. This form may start only where a run of
  // scheme characters begins; the lookahead asks once per run whether it is
  // followed by `://` and something; and the lazy group walks to the first
  // `\b`+letter in the run — exactly where the original started — and is
  // put back in front of the marker. The test that round 9's rule and this
  // one remove the same spans is in acp.test.ts.
  [/(?<![a-z0-9+.-])(?=[a-z0-9+.-]*:\/\/\S)([a-z0-9+.-]*?)\b(?:[a-z][a-z0-9+.-]*:\/\/\S+)/gi, "$1[link removed]"],
  // user:pass@ authority, before a dotted or IP-literal host, or before any
  // host with a path. An IP literal needs no path: nothing else is shaped
  // like a dotted quad, so `retry:2@worker` and `attempt:3@10` still survive.
  //
  // As round 10 wrote it: `(?<![\w.@-])[\w.~%+-]+:[^\s:@/\\]+@HOST`. The
  // token class holds `~`, `%` and `+` and the lookbehind does not, so in a
  // run of them every character was a start and each start rescanned the
  // run to its end. This form starts only where a run of token characters
  // begins, asks once whether the run ends in `:pass@HOST`, and walks — the
  // lazy group, under the round-10 lookbehind — to the first character
  // round 10 could start at, which is the run's start unless an `@`
  // precedes it (`x@~u:p@h.io` starts at `u`, as before). Widening the
  // lookbehind alone would have left that shape unmasked.
  //
  // Round 11 started ONLY there, and that was not round 10 either. A match
  // ends where its host does, and a host with no path ends in a letter or a
  // digit, so when a second authority follows the first with one token
  // character between them — `u:p@h.io~v:q@k.io`, `u:p@10.0.0.1+v:q@k.io`,
  // `u:p@h.io:81%v:q@k.io/path` — the scan resumes inside the run `h.io~v`,
  // whose start the first match consumed, and the start round 10 took at
  // `v` (after a `~`) was never tried: the second password reached the card.
  // The second alternative of the start is that position — after a `~`, `%`
  // or `+` from which a walk back over host and token characters (`[\w.:\[\]-]`
  // is what a pathless host and the rest of its run are spelled in) reaches
  // an `@`: the first such character after an `@host`. Any position round 10
  // could start at can be added here without changing a match, because the
  // lazy group is empty there and what follows it is round 10's own body;
  // what the walk-back buys is the clock. It cannot cross a `~`, `%` or `+`,
  // so each of them is walked over by one candidate at most, at most one
  // candidate per run reaches an `@`, and only that one pays for the
  // lookahead. Equivalence (0 diffs over 147 787 shapes, adjacent
  // authorities behind every printable separator among them) and the clock
  // are both in acp.test.ts.
  [new RegExp(
    String.raw`(?:(?<![\w.~%+-])|(?<=@[\w.:\[\]-]*[~%+]))(?=[\w.~%+-]*:[^\s:@/\\]+@${AUTHORITY_HOST})([\w.~%+-]*?)(?<![\w.@-])[\w.~%+-]+:[^\s:@/\\]+@${AUTHORITY_HOST}`,
    "gi",
  ), "$1[link removed]"],
  // sub.domain.tld[:port]/path — three or more labels name a host, not a file.
  // As written: its `\S*` is last, so nothing is retried behind it, and a
  // start inside a dotted run is refused by the lookbehind.
  [/(?<![\w.@-])(?:[a-z0-9-]+\.){2,}[a-z]{2,24}(?::\d{1,5})?[/?]\S*/gi, "[link removed]"],
  // host[:port][/path]?key=value — a query that names a value can carry one.
  //
  // As round 10 wrote it: `(?<![\w.@-])HOST(?:\/\S*)?\?\S*=\S*`, which
  // retried `\S*=` from every `?` the path held, and — the path ended at
  // the first `?` — still scanned to the end of the word from every `/` a
  // dotted host followed. A match here always runs to the end of the word,
  // so a word holds at most one, at the FIRST position round 10 matched at:
  // the first dotted host (with its port) that a `/` or `?` follows. If the
  // query after that one has no `=`, no later one in the word has either,
  // because the first `?` after a later start is the same `?` or one after
  // it. So: start at a word, find that host in a lookahead (its lazy walk
  // costs each start at most its own host; the lookahead is atomic, so a
  // failed query is not retried from the next host), re-emit the prefix and
  // host, and ask the query question once.
  [/(?<!\S)(?=(\S*?)(?<![\w.@-])((?:[a-z0-9-]+\.)+[a-z]{2,24}(?::\d{1,5})?)(?=[/?]))\1\2(?:\/[^\s?]*)?\?[^\s=]*=\S*/gi, "$1[link removed]"],
  // The same query, on a host the rule above cannot recognise: an IP literal
  // or a single dotless label (`localhost:11434/api/chat?key=…`). The query
  // is what makes it dangerous, so a bare address with no query still reads.
  //
  // The host half is anchored as tightly as every other rule here: a dotless
  // label only names a host when it carries a port or a path, because
  // `mode?retry=true` is how an engine writes about its own settings and
  // blanking that prose is the cost this file keeps paying. A credential in a
  // query on a bare label (`localhost?key=…`) is still masked by
  // `redactSecretsInText`'s query-position rule, which does not need a host.
  //
  // Same construction as the rule above, for the same reason (`ab/?ab/?…`
  // was a start at every `ab`, each scanning to the end of the word). The
  // three host alternatives spell out what round 10's nesting allowed after
  // each: an IP literal with or without a port before `/` or `?`; a label,
  // with or without a port, before `/`; a label with a port before `?`.
  [new RegExp(
    String.raw`(?<!\S)(?=(\S*?)(?<![\w.@-])(${IP_HOST}(?::\d{1,5})?(?=[/?])|[a-z0-9-]{2,}(?::\d{1,5})?(?=\/)|[a-z0-9-]{2,}:\d{1,5}(?=\?)))\1\2(?:\/[^\s?]*)?\?[^\s=]*=\S*`,
    "gi",
  ), "$1[link removed]"],
];
/** Where a JSON object or array (a provider response body) starts, truncated or not. */
const JSON_START = /[{[]\s*["{[]/;

/** How `acpEngineErrorText` treats the two shapes its callers disagree
 * about. The defaults are what an engine's own error message needs; the
 * engine-exit path, which quotes a crash's stderr, asks for the others. */
type EngineTextOptions = {
  /** `cut` (default) ends the text where a JSON body starts: an `error.data`
   * message that runs into a provider response must not spill it onto the
   * card. `keep` is what the exit path asks for — see `acpEngineExitStderrText`. */
  json?: "cut" | "keep";
  /** Which end of a text longer than the display budget survives. `head`
   * (default) is how a sentence is read: an engine's error message says what
   * it has to say first. `tail` is how a crash log is read: the fatal line is
   * the LAST one, and everything above it is the run-up. */
  keep?: "head" | "tail";
};

/** What the sanitiser puts in a locator's place, and the mask
 * `redactSecretsInText` leaves behind: neither says anything about the
 * failure on its own. */
const SUBSTITUTIONS = /\[link removed\]|«redacted \d+ chars»/g;
/** The mask `redactSecretsInText` leaves, and the same mask with its spaces
 * turned to hyphens for the locator pass, so a masked value inside a
 * locator (`?key=«redacted 8 chars»`) is one token to `\S+` and the whole
 * locator goes, rather than "[link removed] 8 chars»". */
const MASK = /«redacted (\d+) chars»/g;
const MASK_TOKEN = /«redacted-(\d+)-chars»/g;

/** Whether a sanitised line still tells the reader something. Everything can
 * be consumed on the way through — 300 full stops are cut to the length cap
 * and then stripped as trailing punctuation, a message that is only a link
 * becomes only the marker — and a card showing "…" or "[link removed]" says
 * less than the JSON-RPC message it replaced. Punctuation and whitespace
 * around the markers do not count; letters, digits and symbols (an engine
 * that answers in emoji is still answering) do. */
function carriesInformation(text: string): boolean {
  return /[^\s\p{P}]/u.test(text.replace(SUBSTITUTIONS, " "));
}

/** Cut at a UTF-16 index without splitting a surrogate pair: half a pair
 * renders as a replacement glyph, so an unbroken astral token is cut before
 * the character rather than through it. `keep` says which end is kept: the
 * first `limit` units, or the last. */
function cutCodePoints(text: string, limit: number, keep: "head" | "tail" = "head"): string {
  if (text.length <= limit) return text;
  if (keep === "head") {
    const lead = text.charCodeAt(limit - 1);
    return text.slice(0, lead >= 0xd800 && lead <= 0xdbff ? limit - 1 : limit);
  }
  const start = text.length - limit;
  const trail = text.charCodeAt(start);
  return text.slice(trail >= 0xdc00 && trail <= 0xdfff ? start + 1 : start);
}

/** The engine's own explanation of a failed request: Fuigo 1.0.18 sends
 * `error.data` as `{ message, error_kind }`, Fuigo <=1.0.17 as a plain string.
 * Made safe for one line of transcript text: terminal escapes and controls,
 * any JSON body, links and credential-shaped values are removed, whitespace
 * collapses and the length is capped. Any other shape yields nothing.
 *
 * ORDER IS THE SAFETY ARGUMENT, and it is the shipped 0.1.53's: redact the
 * WHOLE text first, cut afterwards. Nothing here — no character, token, line
 * or boundary cut, and no window in front of this function — runs on
 * unredacted text. That is the only rule under which every redaction rule
 * still matches, and it is not a matter of keeping the head or cutting on
 * whitespace: PEM_BLOCK is anchored at BOTH ends, so a cut that keeps
 * `-----BEGIN PRIVATE KEY-----` and drops `-----END PRIVATE KEY-----` leaves
 * a rule that no longer matches and a key that reaches the card, whichever
 * end was kept and wherever the cut landed. Rounds 7, 8 and 9 each shipped a
 * cut that was safe for the rule in front of it and unsafe for that one.
 *
 * What makes "no cut" affordable is that every regex on this path is linear
 * in its input: the locator rules above, and `redactSecretsInText`'s rules,
 * three of which were rewritten for it (server/redact.ts). The input is an
 * engine's error text off a frame bounded only by ENGINE_FRAME_MAX_BYTES
 * (32 MiB), sanitised synchronously on the server's single event loop, and
 * measured (CPU time, the clock in acp.test.ts) at 1-16 ms for 64 KiB,
 * 2-10 ms for 128 KiB and 9-75 ms for 1 MiB of each shape that makes a
 * backtracking engine rescan — dotted, hyphenated, `eyJ-` and header-only
 * runs and a mix of them. Round 8's unbounded pipeline took 4.3 s and 312 s
 * on the first of those at 128 KiB and 1 MiB.
 *
 * The cuts that remain both run on redacted text. The JSON cut ends the text
 * at an ASCII brace or bracket; the display cut lands on a word boundary or,
 * failing one, on a code-point boundary (`cutCodePoints`), so no surrogate
 * pair is split. The display cut cannot leave nothing where the engine wrote
 * something: when the end it keeps is only punctuation (a progress bar of
 * `#` before a crash), the floor below cuts that run instead and keeps the
 * text that carries the information, from the same end. The JSON cut can —
 * a message that is only a JSON body yields nothing — and that is the
 * point of it. */
export function acpEngineErrorText(data: unknown, options: EngineTextOptions = {}): string | undefined {
  const raw = typeof data === "string"
    ? data
    : data && typeof data === "object" && !Array.isArray(data) ? (data as { message?: unknown }).message : undefined;
  if (typeof raw !== "string") return undefined;
  const keep = options.keep ?? "head";
  let text = redactSecretsInText(stripVTControlCharacters(raw).replace(INVISIBLE_CONTROLS, " "));
  const json = options.json === "keep" ? -1 : text.search(JSON_START);
  if (json >= 0) text = text.slice(0, json);
  text = text.replace(MASK, "«redacted-$1-chars»");
  for (const [locator, replacement] of LOCATORS) text = text.replace(locator, replacement);
  // The trailing-punctuation trim is found from the run's own start (the
  // lookbehind), as `informativeEnd` finds its run: anchored at `$` alone,
  // `[…]+$` was tried from every character of a run that did not reach the
  // end and walked to the end of the run each time — 1.9 s of CPU for 64 KiB
  // of `:` before one word (round 12, measured), on the error-data path
  // whose input is the engine frame.
  text = text.replace(MASK_TOKEN, "«redacted $1 chars»").replace(/\s+/g, " ").replace(/(?<![\s:;,\-–—])[\s:;,\-–—]+$/, "").trim();
  if (!carriesInformation(text)) return undefined;
  if (text.length <= ERROR_MESSAGE_MAX) return text;
  // One character of the budget belongs to the ellipsis. Prefer a word
  // boundary inside it, so the visible message ends (or begins) on a word
  // rather than wherever the transcript's own cut happened to land. Half a
  // budget is the most either end will give up looking for one.
  const limit = ERROR_MESSAGE_MAX - 1;
  if (keep === "tail") {
    const line = `…${cutTail(text, limit).replace(/^[\s.,;:!?\-–—]+/, "")}`;
    if (carriesInformation(line)) return line;
    // The floor. The kept end was only punctuation — a progress bar of `#`,
    // `.` or `-` is ordinary stderr before a crash — and the reason is in
    // front of it. Cut the run instead, and keep the tail of what is left,
    // which ends on a character that says something by construction; a
    // second ellipsis marks the run that was cut.
    const body = text.slice(0, informativeEnd(text));
    return body.length <= limit ? `${body}…` : `…${cutTail(body, limit - 1).replace(/^[\s.,;:!?\-–—]+/, "")}…`;
  }
  const line = `${cutHead(text, limit).replace(/[\s.,;:!?\-–—]+$/, "")}…`;
  if (carriesInformation(line)) return line;
  const body = text.slice(informativeStart(text));
  return body.length <= limit ? `…${body}` : `…${cutHead(body, limit - 1).replace(/[\s.,;:!?\-–—]+$/, "")}…`;
}

/** The last `limit` characters of `text`, from a word boundary inside the
 * second half of them when there is one. */
function cutTail(text: string, limit: number): string {
  const start = text.length - limit;
  const boundary = text.indexOf(" ", start - 1);
  return boundary >= 0 && boundary < text.length - limit / 2 ? text.slice(boundary + 1) : cutCodePoints(text, limit, "tail");
}

/** The first `limit` characters of `text`, to a word boundary inside the
 * second half of them when there is one. */
function cutHead(text: string, limit: number): string {
  const boundary = text[limit] === " " ? limit : text.lastIndexOf(" ", limit);
  return boundary > limit / 2 ? text.slice(0, boundary) : cutCodePoints(text, limit);
}

/** Where the information in `text` ends: the index past its last character
 * that is not whitespace, punctuation or part of a sanitiser marker — the
 * same notion `carriesInformation` uses. The trailing run is found from its
 * own start only (the lookbehind), so a long run of punctuation that is not
 * at the end is scanned once, not from every character in it. */
function informativeEnd(text: string): number {
  const blanked = text.replace(SUBSTITUTIONS, (marker) => " ".repeat(marker.length));
  const tail = /(?<![\s\p{P}])[\s\p{P}]+$/u.exec(blanked);
  return tail ? tail.index : blanked.length;
}

/** Where the information in `text` begins: the index of its first character
 * that is not whitespace, punctuation or part of a sanitiser marker. */
function informativeStart(text: string): number {
  const blanked = text.replace(SUBSTITUTIONS, (marker) => " ".repeat(marker.length));
  return /^[\s\p{P}]+/u.exec(blanked)?.[0].length ?? 0;
}

/** The reason quoted on the `exited <code> before the prompt result` line:
 * the failed engine's bounded stderr capture, prepared before redaction
 * by `acpEngineStderrCapture`, sanitised as the
 * engine's `error.data` and JSON-RPC `error.message` are, and quoted from
 * its END, because the last lines of a crash are the ones worth quoting.
 *
 * No window is taken in front of the sanitiser, for the reason
 * `acpEngineErrorText` gives: rounds 6-9 took the last 2 KiB of the ring on
 * a line boundary first, and a private key longer than that lost its
 * `-----BEGIN` line, stopped matching PEM_BLOCK, and reached the card.
 *
 * The driver passes its bounded capture through `acpEngineStderrCapture`
 * first. It retains the stream's beginning so a PEM header cannot scroll
 * out before redaction, closes an unfinished PEM only for masking, and
 * explicitly marks any omitted suffix. No headerless raw ring is passed here.
 *
 * The text is stripped of terminal escapes ONCE, inside `acpEngineErrorText`.
 * Rounds 6-10 stripped it here as well, and `stripVTControlCharacters` is
 * not idempotent: a lone ESC that the first pass leaves is consumed together
 * with the character after it by the second, when that character is one of
 * `[\dA-PR-TZcf-nq-uy=><~]` — which covers `t`, `s`, `A`, `g`, `h` and `n`
 * — so `ESC ESC[0mtoken=…` reached redaction as `oken=…`, a name no rule
 * knows, and the value was printed. Redaction depends on the strip being a
 * strip and not a cut; one pass is one.
 *
 * The JSON rule is asked for `keep`, always. MU-R8-2 decided that this path
 * prefers the `cut` form only when the cut would discard NOTHING — a crash
 * whose stderr is a JSON record, or ends in one, keeps the record, because
 * on the crash path the record usually IS the reason, and one line of
 * start-up prose in front of it must not be quoted as the reason with the
 * record thrown away. A cut that discards nothing is the keep form; so the
 * two branches rounds 8 and 9 chose between were the same text, and the
 * predicate that chose between them was the identity. `keep` says so.
 *
 * The accepted consequence stands: an engine that dumps a provider response
 * body to stderr as it dies shows that body, redacted, on the EXIT card —
 * and it is this path only. `error.data` and the JSON-RPC `message` keep
 * `json: "cut"`, where a message running into a provider body must not spill
 * it. Do not fix this back.
 *
 * The floor stays underneath: a card reading only `<engine> exited 1 before
 * the prompt result` is the generic error with no explanation this file
 * exists to remove, and stderr that says anything at all is quoted. */
export function acpEngineExitStderrText(stderr: string): string | undefined {
  return acpEngineErrorText(stderr, { keep: "tail", json: "keep" });
}

/** Prepare the existing bounded stderr prefix for both redaction sinks.
 * A capture cut may remove a PEM footer. Close only that unfinished block
 * for masking; never recover or display its body. Detection strips a COPY,
 * while the original raw text goes to each sink's existing single strip pass.
 * The diagnostic is a prefix once capped, so say explicitly that later output
 * was omitted instead of presenting its last line as the process's final line. */
export function acpEngineStderrCapture(stderr: string, truncated: boolean): string {
  // A cap-cut token may no longer match its redaction rule. Retain only
  // complete raw lines at that boundary, before closing an unfinished PEM.
  if (truncated && !stderr.endsWith("\n")) stderr = stderr.slice(0, stderr.lastIndexOf("\n") + 1);
  const stripped = stripVTControlCharacters(stderr);
  const markers = /-----(BEGIN|END) [A-Z ]*PRIVATE KEY-----/g;
  let open = false;
  for (const marker of stripped.matchAll(markers)) open = marker[1] === "BEGIN";
  return stderr + (open ? "\n-----END PRIVATE KEY-----\n[Unfinished private-key block masked]" : "")
    + (truncated ? "\n[Stderr capture truncated; later output omitted]" : "");
}

/** Fuigo's typed failure kind, a snake_case token. Read only from
 * `error.data.error_kind`: it travels as its own field so nothing has to
 * recover it from text the engine wrote. */
export function acpEngineErrorKind(data: unknown): string | undefined {
  const kind = data && typeof data === "object" && !Array.isArray(data)
    ? (data as { error_kind?: unknown }).error_kind : undefined;
  return typeof kind === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(kind) ? kind : undefined;
}

const ACP_DIAGNOSTIC_METHODS:ReadonlySet<string> = new Set(DIAGNOSTIC_RPC_METHODS);

/** Preserve diagnostic facts without copying response bodies, requests or URLs. */
export function acpRpcErrorDetails(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return;
  const { code, data, acpMethod } = error as { code?: unknown; data?: unknown; acpMethod?: unknown };
  const { http_status: status } = data && typeof data === "object" && !Array.isArray(data)
    ? data as { http_status?: unknown } : {};
  const kind = acpEngineErrorKind(data);
  const facts: string[] = [];
  if (typeof acpMethod === "string" && ACP_DIAGNOSTIC_METHODS.has(acpMethod)) facts.push(`ACP request: ${acpMethod}`);
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) facts.push(`Provider response: HTTP ${status}`);
  // The same kind the event carries in `errorKind`, kept in the details so a
  // pasted diagnostic still names it.
  if (kind) facts.push(`${ENGINE_ERROR_KIND_PREFIX}${kind}`);
  if (typeof code === "number" && Number.isSafeInteger(code)) facts.push(`Engine error code: ${code}`);
  if (!kind && reasoningOnlyData(data)) facts.push("Engine failure category: empty_response");
  return facts.length ? facts.join("\n") : undefined;
}

/**
 * A `host::model` pick talks to a loopback server with its own key.
 * Subscription ACP login (grok.com cached_token) must not fail that turn.
 */
export function skipSubscriptionAuthForLocalInject(model: string | undefined): boolean {
  return Boolean(decodeInjectId(model));
}

/** Never copy CLI stderr/error.message: a version failure can contain secrets. */
export function acpVersionFailureDetail(error: Error | null): string {
  if (!error) return "returned no version from --version";
  const { code, killed, signal } = error as Error & { code?: string | number; killed?: boolean; signal?: string };
  if (killed && signal === "SIGTERM") return "--version timed out after 8 seconds";
  if (code === "ENOENT") return "CLI not found (ENOENT)";
  if (code === "EACCES" || code === "EPERM") return `is not executable (${code}); check its file permissions`;
  if (typeof code === "number") return `--version failed (exit ${code})`;
  if (typeof code === "string" && /^E[A-Z0-9_]+$/.test(code)) return `--version failed (${code})`;
  return "--version failed; check the engine installation";
}

import type {
  DriverCreateInput,
  EffortLevel,
  EngineInstall,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  ModelCatalog,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
  ProviderErrorCode,
} from "../../contracts.ts";
import { newEventId, newId } from "../../contracts.ts";
import { computerProxyEnv } from "../../container-computer.ts";
import { augmentedPath } from "../../env-path.ts";
import { isHarnessOwnedMcpEnvName } from "../../mcp-registry.ts";

// Resolved from the server root, never relative to this file: bundling inlines
// this module two directories up, so the `".."` pair here would climb past the
// packaged server dir entirely. See server/proxy-paths.ts.
const COMPUTER_PROXY_PATH = SPAWNED_PROXIES.computer;
import { appendNative } from "../native.ts";
import { createBoundedLineSplitter, FRAME_TOO_LARGE, frameOverflowMessage } from "../bounded-lines.ts";
import { SPAWNED_PROXIES } from "../../proxy-paths.ts";

export interface AcpConfig {
  cli: string;
  fullAuto: boolean;
  /** Optional home for this instance's sessions. */
  workspace?: string;
}

/** Per-harness specifics — everything that differs between Grok, Gemini, … */
export interface AcpSupport {
  driverKind: string;
  displayName: string;
  /** Omit for subscription CLIs (the default). Custom-only CLIs sit below
   *  the picker-rail divider and have no first-party cloud catalog. */
  access?: "subscription" | "custom";
  models: { default: string; options: Array<{ id: string; label: string }> };
  /** Effort levels this harness's CLI accepts, ascending. Omit when it has
   * no reasoning-effort control. Static for the same reason `models` is:
   * describe() runs before any session exists, so there is no _meta to read
   * — eventually both should come from initialize's _meta.modelState. */
  effortLevels?: readonly EffortLevel[];
  /** Default CLI binary name if the instance config doesn't override it. */
  defaultCli: string;
  /** Optional live model catalog. A failed lookup keeps the last usable catalog.
   *  `config` is the instance decode so a support can ask the same binary it
   *  will spawn (custom `cli` paths), not whatever happens to be named on PATH. */
  resolveModels?(
    environment: Record<string, string | undefined>,
    config: AcpConfig,
  ): ModelCatalog | Promise<ModelCatalog>;
  /** Native-protocol log label, e.g. "grok.acp". */
  nativeSource: string;
  /** Whether models behind this ACP harness can consume a referenced image.
   * Most coding agents can open local files; opt out for text-only agents. */
  images?: boolean;
  /** Message shown when the CLI is present but not signed in. */
  loginNote: string;
  /** How a user installs this harness's CLI; surfaced by the setup UI. */
  install?: EngineInstall;
  /** Add engine-specific repair guidance after a failed version probe. */
  versionFailure?(
    env: Record<string, string | undefined>, config: AcpConfig, detail: string,
  ): { reason: string; setupAction?: "repair" } | undefined;
  /** CLI argv AFTER the binary name to enter ACP stdio mode. `turn.model` is
   *  the CLI-native id `resolveTurnModel` settled on; `ctx.requestedModel` is
   *  the id the picker asked for (a `host::model` local pick keeps its host
   *  only there), for a driver whose argv has to differ for a local turn. */
  spawnArgs(config: AcpConfig, turn: SendTurnInput, ctx?: { requestedModel?: string; folderTrusted?: boolean }): string[];
  /** The engine gates a folder's repo-local sources (instructions, MCP,
   *  skills, hooks) behind a per-folder trust decision, as Fuigo 1.0.13 does
   *  (0.1.52 FUIGOTRUST1). The core then decides trust BEFORE the spawn from
   *  `turn.folderTrust` — the server's record, or a question card the owner
   *  answers — and passes `ctx.folderTrusted` to `spawnArgs`; it also
   *  advertises `fuigo/folderTrust.interactive` and answers the engine's own
   *  `fuigo/folder_trust/request` from the same decision. */
  folderTrust?: boolean;
  /** Provider credential variables this ACP child is allowed to inherit. */
  credentialEnv?: readonly string[];
  /** Select the model through a session config option instead of argv, for
   *  harnesses whose ACP subcommand takes no -m (opencode). The agent must
   *  CONFIRM the requested model before we prompt: silently running a model
   *  other than the one the picker shows is the failure this guards. */
  selectModel?: { configId: string };
  /** Mutate the child env in place: strip a key, inject a policy. Receives the
   *  instance config so a support can vary with fullAuto. */
  transformEnv?(env: Record<string, string | undefined>, config: AcpConfig): void;
  /** Mutate the child env after the turn model is known. Catalog refresh and
   *  snapshot share `transformEnv` and must not see a per-turn overlay. */
  applyTurnEnv?(
    env: Record<string, string | undefined>,
    ctx: { model?: string; requestedModel?: string },
  ): void;
  /** Pick the ACP authenticate methodId from initialize's advertised
   * authMethods; return null to skip the authenticate step. */
  pickAuthMethod(authMethods: Array<{ id?: string }>): string | null;
  /** "fail": abort the turn if auth is missing/errors (subscription CLIs).
   *  "continue": proceed anyway (CLIs that work off an ambient login). */
  authFailure: "fail" | "continue";
  /** snapshot(): can this harness actually run a turn? (env already carries the
   *  merged config). May be async for harnesses that have to ask the CLI. */
  isAuthenticated(env: Record<string, string | undefined>, config: AcpConfig): boolean | Promise<boolean>;
  /** Refuse a first-party cloud turn before spawning when snapshot auth is
   * false. Local injected models deliberately bypass this subscription gate. */
  requireAuthenticationBeforeSpawn?: boolean;
  /** Evidence that a turn will probably run even though `isAuthenticated` says
   *  no — consulted ONLY by the pre-spawn gate, never by the snapshot.
   *
   *  These two questions had been answered by one predicate, and the weaker
   *  one won: a driver that wanted to be permissive at spawn time had to widen
   *  `isAuthenticated`, and the widening was then reported to the user as
   *  "signed in". That is F2 — engines that claimed to be ready when they were
   *  not. Splitting them lets the gate stay exactly as permissive as it was
   *  while the Engines screen tells the truth. */
  mayRunUnauthenticated?(env: Record<string, string | undefined>, config: AcpConfig): boolean | Promise<boolean>;
  /** Classify provider-native failures without coupling the core to messages. */
  classifyError?(error: unknown): ProviderErrorCode | undefined;
  /** Compose the session/prompt text. Default prepends the persona. */
  buildPromptText?(turn: SendTurnInput): string;
  /** Rewrite a picker id (`omlx::model`) into the CLI-native id before spawn
   * and session/select. Local inject writers live here so the child sees a
   * model it already knows. */
  resolveTurnModel?(
    model: string | undefined,
    env: Record<string, string | undefined>,
  ): string | undefined;
  /** Apply per-session settings between session/new (or session/load) and the
   * first session/prompt. Some CLIs ignore argv and take the model/mode over
   * the wire instead (droid), so this is the only place the pick can land; a
   * throw here fails the turn rather than silently running another model. */
  configureSession?(ctx: {
    request: (method: string, params: unknown, timeoutMs?: number) => Promise<any>;
    sessionId: string;
    config: AcpConfig;
    turn: SendTurnInput;
    /** `session/new` (or `session/load`) advertised model list, verbatim. Some
     * CLIs namespace their ACP model ids differently from their argv `--model`
     * slugs (Cursor answers `default[]` where the CLI calls it `auto`), so a
     * driver that only knows the argv slug cannot form a valid set_model
     * without this. Empty when the agent advertised none. */
    sessionModels: Array<{ modelId?: string; name?: string }>;
  }): Promise<void>;
  /** Extension notification the engine sends, per session, once every MCP
   *  server of that session has settled (connected or unavailable). Fuigo
   *  answers `session/new` before the `mcpServers` it was handed are
   *  connected and tells the model on its first request that they are still
   *  connecting, so a prompt sent at once cannot use Murage's tools on its
   *  first step. When set, the core holds the first `session/prompt` of a
   *  session that was given a non-empty `mcpServers` list until this
   *  notification names the session, or `MCP_READY_WAIT_MS` passes. */
  mcpReadyNotification?: string;
}

/** Handshake budgets, overridable per box. A cold `npx`-shaped agent, a slow
 *  disk or a first run that downloads its own runtime blows the old 20s ceiling
 *  and the turn dies before the agent ever speaks; these are generous enough to
 *  cover that and still short enough that a genuinely wedged CLI surfaces as an
 *  error instead of a hang. A non-numeric or non-positive override is ignored
 *  rather than passed through as NaN, which would disarm the timeout entirely. */
const envOr = (key: string, fallback: number): number => {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const INIT_TIMEOUT = envOr("MURAGE_ACP_INIT_MS", 60_000);
/** Longest the first prompt waits for `AcpSupport.mcpReadyNotification`.
 *  Past it the prompt is sent anyway (the model is told the servers are still
 *  connecting, which is the old behaviour) and a `mcp_ready_timeout`
 *  lifecycle row records that MCP was not ready. Far below the 60 s floor of
 *  the server's stall watchdog, so the wait can never read as a stall. */
export const MCP_READY_WAIT_MS = 15_000;
/** Read per turn so a box (or a test) can shorten it without a reload. */
const mcpReadyWaitMs = () => envOr("MURAGE_ACP_MCP_READY_MS", MCP_READY_WAIT_MS);

/** Settles one server→client ask. A permission takes allow/deny/cancel; a
 * question (Fuigo's ask_user_question, an ACP elicitation) takes `answer`
 * with the owner's validated picks, or a deny that is an explicit skip
 * (0.1.52 ASK3). */
type AcpAskFinish = (behavior: string, source?: "user" | "timeout" | "system", answers?: QuestionAnswer[]) => boolean | void;

/** Fuigo's ACP extension request for its AskUserQuestion tool. The ACP wire
 * prefixes extension methods with `_`; the leader gateway may nest the real
 * params as `{method, params}`, which fromFuigo tolerates. */
const FUIGO_ASK_METHOD = "_fuigo/ask_user_question";
/** Fuigo forwards an MCP server's elicitation as its own extension request
 * (`fuigo-tools/src/mcp_elicitation/types.rs`): the ACP form/url fields plus
 * `serverName`, answered `{outcome: "accept", content}` / `decline` /
 * `cancel`. */
const FUIGO_ELICIT_METHOD = "_fuigo/mcp/elicit";
/** Fuigo's interactive folder-trust round-trip (fuigo-shell
 * mvp_agent/folder_trust_prompt.rs): sent after session/new or session/load
 * when the client advertised `fuigo/folderTrust.interactive`, the workspace
 * has repo-local sources and the trust store has no grant. Params carry
 * `sessionId`, `cwd`, `workspace` and `configKinds`; the answer is
 * `{outcome: "trust" | "reject"}`, and anything else decodes to reject. */
const FUIGO_FOLDER_TRUST_METHODS = new Set(["_fuigo/folder_trust/request", "fuigo/folder_trust/request"]);
/** The card's tool name; the server keys the folder-trust record on it. */
const FOLDER_TRUST_TOOL = "folder_trust";
/** ACP v1 names it `elicitation/create`; the Rust crate that some agents
 * embed still spells it `session/elicitation`. Both are the same request. */
const ELICITATION_METHODS = new Set(["elicitation/create", "session/elicitation"]);
const SESSION_CONFIG_TIMEOUT = envOr("MURAGE_ACP_SESSION_CONFIG_MS", 60_000); // configureSession's per-request default
const NEW_SESSION_TIMEOUT = envOr("MURAGE_ACP_SESSION_NEW_MS", 90_000);
const LOAD_SESSION_TIMEOUT = envOr("MURAGE_ACP_SESSION_LOAD_MS", 120_000); // history replay on a long thread is slow
/** Longest `session/prompt` may go COMPLETELY silent before the turn is
 * failed. Read lazily (not at import) so a fixture can shorten the window.
 *
 * Unlike the handshake budgets above this is not a wall-clock deadline:
 * session/prompt legitimately streams for minutes, so a deadline from the
 * request would kill long answers. The clock restarts on every inbound line
 * and on every answer Murage sends, and an open permission or question card
 * holds it off entirely, so it trips only on an agent that has stopped
 * speaking for good — a wedged OpenCode turn streams thought chunks and then
 * goes silent forever without ever answering the RPC.
 *
 * The server's stall watchdog (server/turn-watchdog.ts, 20 minutes) already
 * bounds this; the guard here ends it sooner, with a message that names the
 * engine and this knob instead of "no activity for 20 minutes". 0 turns it
 * off and leaves the watchdog as the only bound. */
const promptIdleTimeoutMs = (): number => {
  const raw = process.env.MURAGE_ACP_PROMPT_IDLE_MS;
  if (raw === undefined) return 180_000;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
};
/** After session/cancel the agent may still answer the prompt; past this the
 * turn settles as cancelled and the child is terminated. */
const ACP_CANCEL_GRACE_MS = 5_000;
/** Most engine stderr lines one failed turn keeps in its native log. */
const ENGINE_STDERR_LINES = 100;
/** A stop that starts with session/cancel reaches the kill only after the
 * grace period, so its close budget is measured from there. */
const acpStopBudget = (): TeardownWait => {
  const closeMs = providerCloseDeadlineMs();
  return { closeMs, maxMs: ACP_CANCEL_GRACE_MS + closeMs };
};

function decodeAcpConfig(defaultCli: string) {
  return (raw: unknown): AcpConfig => {
    const o = (raw ?? {}) as Record<string, unknown>;
    return {
      cli: typeof o.cli === "string" ? o.cli : defaultCli,
      fullAuto: o.fullAuto === true,
      workspace: typeof o.workspace === "string" ? o.workspace : undefined,
    };
  };
}

/**
 * ACP JSON-RPC-over-stdio driver. Harness differences (argv, auth, catalog)
 * live in `support`; this is the shared handshake and turn runtime.
 */
export function createAcpDriver(support: AcpSupport): ProviderDriver<AcpConfig> {
  const DRIVER_KIND = support.driverKind;
  const SOURCE = support.nativeSource;
  const decodeConfig = decodeAcpConfig(support.defaultCli);
  const DENY_TIMEOUT_NOTE =
    "Murage: nobody answered this permission request in time. Skip this action and finish what you can without it.";

  return {
    driverKind: DRIVER_KIND,
    metadata: {
      displayName: support.displayName,
      supportsMultipleInstances: true,
      access: support.access ?? "subscription",
    },
    install: support.install,
    models: support.models,
    decodeConfig,
    defaultConfig: () => decodeConfig({}),

    async create(input: DriverCreateInput<AcpConfig>): Promise<ProviderInstance> {
      const { instanceId, config } = input;
      const childEnv = () => {
        const env: Record<string, string | undefined> = {
          ...process.env,
          ...input.environment,
          PATH: augmentedPath(),
        };
        const allowedCredentials = new Set(support.credentialEnv ?? []);
        // two lists, one rule: foreign PROVIDER keys must not flip a CLI's
        // billing off its own login, and WORKSPACE credentials (box token,
        // voice key, …) are the harness's secrets — riding along in
        // `...process.env` is not a grant. A driver keeps only what its
        // credentialEnv allowlist names.
        for (const key of [...PROVIDER_CREDENTIAL_ENV, ...WORKSPACE_CREDENTIAL_ENV]) {
          if (!allowedCredentials.has(key)) delete env[key];
        }
        // Routing switches are a third list, stripped unconditionally: a
        // `credentialEnv` allowlist grants a driver a key, never the right to
        // be pointed at someone else's endpoint, so this must not be folded
        // into the loop above. Before transformEnv so a driver that sets its
        // own routing (kimi) still wins.
        stripRoutingEnv(env);
        support.transformEnv?.(env, config);
        return env;
      };
      let models = support.models;
      const refreshModels = async () => {
        if (!support.resolveModels) return;
        try {
          const resolved = await support.resolveModels(childEnv(), config);
          if (resolved.options.length) models = resolved;
        } catch {
          // Keep the last usable catalog when an optional discovery source is down.
        }
      };
      await refreshModels();
      const listeners = new Set<RuntimeEventListener>();
      interface Turn {
        stop: (reason: LifecycleStopReason) => void;
        interrupt: () => void;
        turnId: string;
        asks: Map<string, AcpAskFinish>;
      }
      const active = new Map<string, Turn>();
      // Settlement removes a turn from `active` before its child has exited.
      // Ownership of that child lasts until close is observed (A2).
      const teardowns = new TurnTeardowns();

      const emit = (event: RuntimeEvent) => {
        for (const l of [...listeners]) l(event);
      };

      // ACP content blocks may carry a complete raster image inline. Keep the
      // bytes available to the normalizer, but never duplicate megabytes of
      // base64 into the provider-native diagnostic log.
      const nativeLogMessage = (msg: any): unknown => {
        if (msg?.method === "session/prompt" && Array.isArray(msg?.params?.prompt)) {
          return { ...msg, params: { ...msg.params, prompt: msg.params.prompt.map((block: any) =>
            block?.type === "image" ? { ...block, data: "[image data omitted]" } : block) } };
        }
        const content = msg?.params?.update?.content;
        if (
          msg?.method !== "session/update" ||
          msg?.params?.update?.sessionUpdate !== "agent_message_chunk" ||
          content?.type !== "image" ||
          typeof content.data !== "string"
        ) return msg;
        return {
          ...msg,
          params: {
            ...msg.params,
            update: {
              ...msg.params.update,
              content: { ...content, data: `[image data: ${content.data.length} base64 chars]` },
            },
          },
        };
      };
      const base = (threadId: string, turnId: string) => ({
        eventId: newEventId(),
        provider: DRIVER_KIND,
        threadId,
        turnId,
        createdAt: new Date().toISOString(),
      });

      // ACP session mcpServers: stdio is the baseline every ACP agent
      // supports (mcpCapabilities.http/.sse only add EXTRA transports), so
      // an injected stdio proxy — e.g. the peer-agent comms tool — attaches
      // fine here. env is the ACP {name,value}[] shape.
      const acpMcpServers = (turn: SendTurnInput, memoryName = "murage-memory") => {
        const servers: Array<{ name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }> = [];
        const acpEnv = (env: Record<string, string>) =>
          Object.entries(env).map(([name, value]) => ({ name, value: String(value) }));
        const agents = turn.integrations?.agents;
        if (agents) {
          servers.push({ name: "agents", command: agents.command, args: agents.args, env: acpEnv(agents.env) });
        }
        const memory = turn.integrations?.memory;
        if (memory) {
          servers.push({ name: memoryName, command: memory.command, args: memory.args, env: acpEnv(memory.env) });
        }
        const composio = turn.integrations?.composio;
        if (composio) {
          servers.push({
            name: "composio",
            command: composio.command,
            args: composio.args,
            env: acpEnv(composio.env),
          });
        }
        const browser = turn.integrations?.browser;
        if (browser) {
          servers.push({ name: "browser", command: browser.command, args: browser.args, env: acpEnv(browser.env) });
        }
        // The bot's computer, mounted exactly like the Claude driver does.
        // Cloud boxes use the REST adapter; host and sandbox Cua connections
        // expose Cua Driver's official MCP server directly.
        const computer = turn.integrations?.computer;
        if (computer) {
          servers.push({
            name: "computer",
            command: process.execPath,
            args: [COMPUTER_PROXY_PATH],
            env: acpEnv({ ELECTRON_RUN_AS_NODE: "1", ...computerProxyEnv(computer) }),
          });
        } else if (turn.integrations?.localComputer) {
          const local = turn.integrations.localComputer;
          servers.push({
            name: "computer",
            command: local.command,
            args: local.args,
            env: acpEnv(local.env ?? {}),
          });
        }
        // user-configured servers, after the built-ins: a residual name
        // collision keeps the built-in (reserved names are filtered at the
        // config boundary; this is defense in depth).
        for (const [name, server] of Object.entries(turn.integrations?.custom ?? {})) {
          if (name === "murage-memory" || name === memoryName) continue;
          if (servers.some((existing) => existing.name === name)) continue;
          if (Object.keys(server.env).some(isHarnessOwnedMcpEnvName)) continue;
          servers.push({ name, command: server.command, args: server.args, env: acpEnv(server.env) });
        }
        return servers;
      };

      const sendTurn = async (turn: SendTurnInput) => {
        const { threadId } = turn;
        if (active.has(threadId)) throw new Error("a turn is already running on this thread");
        if (support.driverKind === "grokAgent") {
          const closed = await teardowns.wait(threadId, undefined, acpStopBudget());
          if (!closed.closeConfirmed) throw new ProviderStopUnconfirmedError(DRIVER_KIND, closed);
          if (active.has(threadId)) throw new Error("a turn is already running on this thread");
        }
        const controlsHost = turn.integrations?.localComputer?.scope === "local-computer";
        if (controlsHost && config.fullAuto) {
          throw new Error("local computer control requires interactive provider approvals");
        }
        const turnId = newId();
        const cwd = turn.cwd ?? config.workspace ?? homedir();
        const env = childEnv();
        if (
          support.requireAuthenticationBeforeSpawn
          && !turn.providerRoute
          && !skipSubscriptionAuthForLocalInject(turn.model)
          && !(await support.isAuthenticated(env, config))
          && !(await support.mayRunUnauthenticated?.(env, config))
        ) {
          emit({ ...base(threadId, turnId), type: "turn.started" });
          emit({ ...base(threadId, turnId), type: "runtime.error", message: support.loginNote, setup: true });
          emit({ ...base(threadId, turnId), type: "turn.completed", ok: false, stopReason: "auth_required", cost: null });
          return { turnId };
        }
        if (turn.providerRoute) validateProviderTurnRoute(support.driverKind, turn.providerRoute);
        const providerBinding = turn.providerRoute ? applyProviderRoute(support.driverKind, env, turn.providerRoute, { threadId, memoryTools: Boolean(turn.integrations?.memory) }) : null;
        const grokBinding = support.driverKind === "grokAgent" ? grokResumeBinding(threadId, providerBinding?.identity ?? null, turn.resumeCursor) : null;
        if (grokBinding?.replay && !turn.transcript) throw new Error("Grok provider binding changed. Reload the conversation before continuing.");
        const replayGrokTurn = () => ({ ...turn, text: ["[The provider session binding changed. Continue from this authorised conversation history:]", "",
          ...turn.transcript!.map(item => `${item.role === "user" ? "User" : "Assistant"}: ${item.text}`), "", "[Latest message:]", turn.text].join("\n") });
        let promptTurn = grokBinding?.replay ? replayGrokTurn() : turn;
        const resolvedModel = providerBinding?.model ?? support.resolveTurnModel?.(turn.model, env);
        if (!providerBinding) support.applyTurnEnv?.(env, { model: resolvedModel, requestedModel: turn.model });
        const cliTurn =
          resolvedModel !== undefined && resolvedModel !== turn.model
            ? { ...turn, model: resolvedModel }
            : turn;
        const ownedMemoryAlias = support.driverKind === "fuigoAgent" && turn.integrations?.memory && !providerBinding
          ? newFuigoMemoryAlias() : null;
        const mcpServers = acpMcpServers(turn, ownedMemoryAlias ?? "murage-memory");

        // R1-T8: one bounded, allowlisted lifecycle trace per child generation.
        const lifecycle = createLifecycleRecorder({ threadId, driver: DRIVER_KIND, instanceId, turnId });
        // The child is spawned by `launch()` below — synchronously for most
        // turns, and only after the owner has answered a folder-trust card
        // when the folder needs one (FUIGOTRUST1). Until then there is no
        // process: stop/settle are no-ops on the child and the turn's
        // teardown has nothing to wait for.
        let child: ReturnType<typeof spawnCli> | null = null;
        let teardown: ReturnType<TurnTeardowns["track"]> | null = null;
        let spawned = false;
        // `producedItem`: the turn emitted something a person can see (a reply,
        // an image, a tool result). An end_turn without one is a lost turn.
        const state = { settled: false, finished: false, failed: false, promptSent: false, cancelRequested: false, text: "", producedItem: false };
        // Existing 256 KiB diagnostic cap, preserving the start before any
        // redaction. Never keep a second raw tail that can lose a PEM header.
        let stderrDiagnostic = "", stderrDiagnosticTruncated = false;
        const STDERR_DIAGNOSTIC_CHARS = 256 * 1024;
        const asks = new Map<string, AcpAskFinish>();
        // A tool_call_update need not repeat the call's title, and whether an
        // image in its output is a deliverable or one of Murage's own screen
        // frames turns on the tool's name. Kept from the opening tool_call and
        // dropped when the terminal update consumes it. Two names, because the
        // chip's is a display string and retention cannot be decided on it.
        const toolNames = new Map<string, { label: string; identity?: string }>();
        let nextId = 1;
        let sessionId: string | null = null;
        let promptStartedAt: number | null = null;
        // Sessions the engine has reported MCP-ready. Recorded from the first
        // byte of the child's stdout, so a notification that arrives BEFORE
        // the session/new response is kept, not lost. One child per turn, so
        // this holds one or two ids at most.
        const mcpReadySessions = new Set<string>();
        let releaseMcpWait: (() => void) | null = null;
        const failureObservations = createFuigoFailureObservations();
        let interruptTimer: ReturnType<typeof setTimeout> | null = null;
        const rpcPending = new Map<
          number,
          {
            method: string;
            resolve: (v: any) => void;
            reject: (e: Error) => void;
            timer: ReturnType<typeof setTimeout> | null;
            /** live idle deadline, read for clearing; see `armIdle` */
            readonly idleTimer: ReturnType<typeof setTimeout> | null;
            /** restart this request's idle deadline (no-op without one) */
            armIdle: () => void;
          }
        >();
        // The folder-trust decision this turn runs under: the server's record
        // for the folder, or the owner's answer to the card raised below. It
        // also answers the engine's own request should one still arrive.
        let folderTrusted: FolderTrustDecision | "skipped" | null = turn.folderTrust?.decision ?? null;
        const folderSources = () => turn.folderTrust?.sources ?? [];
        // The user's own Fuigo install already trusts the folder (its
        // trusted_folders.toml, FUIGOTRUST2): the engine runs trusted from
        // its store whatever Murage recorded, so there is nothing to ask
        // and nothing was withheld. `--trust` is still passed only on
        // Murage's own decision: the engine's store needs no rewriting.
        const upstreamTrusted = support.folderTrust === true && turn.folderTrust?.upstreamTrusted === true;

        const send = (obj: unknown) => {
          // Answering a server→client request (a permission decision, a file
          // read) hands the agent back the thing it was blocked on, so its
          // silence up to here was ours, not its: restart every idle deadline.
          const message = obj as { id?: unknown; result?: unknown; error?: unknown };
          if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
            for (const pending of rpcPending.values()) pending.armIdle();
          }
          try {
            child?.stdin.write(JSON.stringify(obj) + "\n");
          } catch {}
          appendNative(threadId, { dir: "out", source: SOURCE, msg: nativeLogMessage(obj) });
        };
        /** `timeoutMs` is a hard deadline measured from the request. `idleMs`
         *  is for `session/prompt` alone — the one call that legitimately
         *  streams for minutes, so a wall-clock deadline would false-positive
         *  on a long answer. It restarts on every inbound line and on every
         *  answer we send, so it trips only on total silence; `idleMessage`
         *  becomes the rejection. */
        const request = (
          method: string,
          params: unknown,
          timeoutMs?: number,
          idleMs?: number,
          idleMessage?: string,
        ) =>
          new Promise<any>((resolve, reject) => {
            const id = nextId++;
            let timer: ReturnType<typeof setTimeout> | null = null;
            if (timeoutMs) {
              timer = setTimeout(() => {
                rpcPending.delete(id);
                reject(new Error(`${method} timed out`));
              }, timeoutMs);
              timer.unref?.();
            }
            let idleTimer: ReturnType<typeof setTimeout> | null = null;
            const armIdle = () => {
              if (!(idleMs && idleMs > 0)) return;
              if (idleTimer) clearTimeout(idleTimer);
              idleTimer = setTimeout(() => {
                // Waiting on a person is not an unresponsive agent: an open
                // permission or question card holds the engine, so restart
                // instead of failing the turn under someone's cursor.
                if (asks.size) { armIdle(); return; }
                rpcPending.delete(id);
                const error = new Error(idleMessage ?? `${method} stopped responding`);
                Object.assign(error, { acpPromptStall: true });
                reject(error);
              }, idleMs);
              idleTimer.unref?.();
            };
            armIdle();
            rpcPending.set(id, {
              method,
              resolve,
              reject,
              timer,
              get idleTimer() { return idleTimer; },
              armIdle,
            });
            lifecycle.record("rpc_requested", { rpcId: id, method });
            send({ jsonrpc: "2.0", id, method, params });
          });

        // Requesting termination is not closure; the teardown observes close.
        const stop = (reason: LifecycleStopReason) => {
          lifecycle.record("stop_requested", {
            reason,
            pid: child?.pid ?? null,
            settled: state.settled,
            cancelRequested: state.cancelRequested,
            promptSent: state.promptSent,
          });
          teardown?.markStopRequested();
          if (child) killCliTree(child, lifecycle.observeStopRoute);
        };

        /** Emit buffered assistant text as its own item, then clear it. */
        const flushAssistantText = () => {
          const text = state.text;
          state.text = "";
          if (!text.trim()) return;
          state.producedItem = true;
          emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
        };

        /** A failed turn keeps the engine's last stderr lines in the thread's
         * native log as one bounded, redacted record for support; otherwise
         * the ring is gone with the process. */
        const persistEngineStderr = (stopReason: string | null) => {
          const captured = acpEngineStderrCapture(stderrDiagnostic, stderrDiagnosticTruncated);
          let lines = redactSecretsInText(stripVTControlCharacters(captured)).split(/\r?\n/);
          // eslint-disable-next-line no-control-regex -- matching them is the point
          lines = lines.map((line) => line.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trimEnd()).filter(Boolean);
          if (!lines.length) return;
          const kept = lines.slice(-ENGINE_STDERR_LINES);
          appendNative(threadId, {
            dir: "in",
            source: SOURCE,
            msg: { engineStderr: { stopReason, lines: kept, truncated: stderrDiagnosticTruncated || kept.length < lines.length } },
          });
        };

        const settle = (
          ok: boolean,
          stopReason: string | null,
          cause: LifecycleStopReason = ok ? "turn_complete" : "turn_failure",
        ) => {
          if (state.settled) return;
          state.settled = true;
          state.finished = ok && stopReason === null;
          state.failed = !ok;
          lifecycle.record("turn_settled", {
            reason: cause,
            settled: true,
            cancelRequested: state.cancelRequested,
            promptSent: state.promptSent,
          });
          if (!ok) persistEngineStderr(stopReason);
          if (interruptTimer) clearTimeout(interruptTimer);
          releaseMcpWait?.();
          // FUIGOTRUST2 (1): a routed turn's per-turn FUIGO_HOME is removed
          // on the child's close — but a turn that never spawned (its card
          // timed out, was stopped, or its launch threw) has no child.
          if (!child) providerBinding?.cleanup();
          for (const finish of [...asks.values()]) finish("cancel", "system");
          for (const p of rpcPending.values()) {
            if (p.timer) clearTimeout(p.timer);
            if (p.idleTimer) clearTimeout(p.idleTimer);
            p.reject(new Error("turn settled"));
          }
          rpcPending.clear();
          active.delete(threadId);
          flushAssistantText();
          emit({ ...base(threadId, turnId), type: "turn.completed", ok, stopReason, cost: null });
          stop(cause); // the agent process does not exit on its own
        };

        // A question for the owner (Fuigo's `_fuigo/ask_user_question`, an ACP
        // `elicitation/create` form or URL) → canonical request.opened with
        // `questions`. Never auto-answered in any mode; a skip, the 30-minute
        // timeout or the turn ending sends the engine its own honest
        // no-answer (Fuigo `cancelled`, elicitation `decline`/`cancel`).
        const handleQuestionRequest = (msg: any, kind: "fuigo" | "elicitation" | "fuigo-elicit") => {
          const params = msg.params ?? {};
          const urlMode = kind !== "fuigo" && params.mode === "url";
          const normalized =
            kind === "fuigo"
              ? fromFuigo(params)
              : urlMode
                ? fromElicitationUrl(params.message, params.url)
                : fromElicitationForm(params.message, params.requestedSchema);
          // the three reply vocabularies: Fuigo's ask tool, ACP elicitation, Fuigo's MCP bridge
          const reply = (action: "accept" | "decline" | "cancel", content?: unknown) =>
            kind === "fuigo"
              ? action === "accept" ? content : { outcome: "cancelled" }
              : kind === "fuigo-elicit"
                ? { outcome: action, ...(content !== undefined ? { content } : {}) }
                : { action, ...(content !== undefined ? { content } : {}) };
          const cancelled = reply("cancel");
          if (!normalized.ok) {
            emit({
              ...base(threadId, turnId),
              type: "runtime.error",
              message: `${DRIVER_KIND} asked a question Murage could not show (${normalized.error}); it was told nobody answered`,
            });
            return send({ jsonrpc: "2.0", id: msg.id, result: cancelled });
          }
          flushAssistantText();
          const questions: QuestionSpec[] = normalized.questions;
          const requestId = newId();
          const finish: AcpAskFinish = (behavior, source = "user", answers) => {
            if (!asks.delete(requestId)) return;
            clearTimeout(timer);
            const answered = behavior === "answer" && answers?.length ? answers : null;
            let result: unknown;
            if (answered) {
              result =
                kind === "fuigo"
                  ? reply("accept", toFuigoAnswers(questions, answered))
                  : urlMode
                    ? reply("accept")
                    : reply("accept", toElicitationContent(params.requestedSchema, questions, answered));
            } else if (kind !== "fuigo" && source === "user") {
              result = reply("decline");
            } else {
              result = cancelled;
            }
            send({ jsonrpc: "2.0", id: msg.id, result });
            emit({
              ...base(threadId, turnId),
              type: "request.resolved",
              requestId,
              behavior: answered ? "answer" : "deny",
              source,
            });
          };
          const timer = setTimeout(() => finish("deny", "timeout"), QUESTION_TIMEOUT_MS);
          timer.unref?.();
          asks.set(requestId, finish);
          emit({
            ...base(threadId, turnId),
            type: "request.opened",
            requestId,
            requestType: "question",
            tool: kind === "fuigo" ? "ask_user_question" : "elicitation",
            summary: questions[0]!.question.slice(0, 300),
            // the first question's labels keep voice and older clients working
            choices: questions[0]!.options.map((option) => option.label),
            questions,
          });
        };

        // A folder-trust notice in the conversation: an activity chip under the
        // "untrusted folder:" / "trusted folder:" convention (shared/folder-
        // trust.ts), rendered as a neutral notice that stays visible with Tool
        // calls off. ok:true — the turn is fine, the folder's files were
        // simply left out (or apply next time).
        let noticeSeq = 0;
        const noteFolderTrust = (name: string) => {
          const itemId = `folder-trust-${turnId}-${++noticeSeq}`;
          emit({ ...base(threadId, turnId), type: "item.started", itemId, itemType: "tool", title: name });
          emit({ ...base(threadId, turnId), type: "item.completed", itemId, itemType: "tool", ok: true });
        };

        // The folder-trust card (FUIGOTRUST1): one question, two answers, a
        // decision about the folder. Never auto-answered in any mode, exactly
        // like a question (ASK1/ASK2): auto mode does not trust folders. The
        // engine's timeout is the question timeout; what happens when nobody
        // answers is the caller's rule (`onDecided("unanswered")`).
        const askFolderTrust = (
          sources: string[],
          onDecided: (decision: FolderTrustDecision | "skipped" | "unanswered") => void,
          late = false,
        ) => {
          const folder = turn.folderTrust?.folder ?? cwd;
          const key = turn.folderTrust?.key ?? cwd;
          const question = folderTrustQuestion({ key, folder, sources });
          const requestId = newId();
          const finish: AcpAskFinish = (behavior, source = "user", answers) => {
            if (!asks.delete(requestId)) return;
            clearTimeout(timer);
            const decision = behavior === "answer" ? folderTrustDecision(answers) : null;
            // FUIGOTRUST2 (6): a late card (the engine had already started)
            // closed by nobody: the turn finished, was stopped, or the ask
            // timed out while the turn ran on — untrusted in every case.
            // FUIGOTRUST3 (3): a turn that FAILED (spawn or rpc error, an
            // early exit) is named as such, not as stopped.
            const folderTrustLate = late && source !== "user"
              ? source === "timeout" ? "timeout" : state.finished ? "finished" : state.failed ? "failed" : "stopped"
              : undefined;
            emit({
              ...base(threadId, turnId),
              type: "request.resolved",
              requestId,
              behavior: decision ? "answer" : "deny",
              source,
              ...(folderTrustLate ? { folderTrustLate } : {}),
            });
            if (decision) onDecided(decision);
            else onDecided(source === "user" ? "skipped" : "unanswered");
          };
          const timer = setTimeout(() => finish("deny", "timeout"), QUESTION_TIMEOUT_MS);
          timer.unref?.();
          asks.set(requestId, finish);
          emit({
            ...base(threadId, turnId),
            type: "request.opened",
            requestId,
            requestType: "question",
            tool: FOLDER_TRUST_TOOL,
            summary: question.question.slice(0, 300),
            choices: question.options.map((option) => option.label),
            questions: [question],
            folderTrust: { key, folder, sources },
          });
        };

        // The engine's own trust request (Fuigo's `_fuigo/folder_trust/request`),
        // which arrives only because this client advertised the capability. The
        // decision taken before the spawn answers it; when there is none — the
        // engine gated something the server's scan did not name, such as a
        // `~/.claude.json` project entry — the owner is asked now, from the
        // engine's own `configKinds`. The engine reloads MCP servers, hooks and
        // plugins on a grant but reads instructions and skills at start, so a
        // late grant is noted as applying from the next turn.
        const handleFolderTrustRequest = (msg: any) => {
          const raw = msg.params ?? {};
          const params = raw.params && typeof raw.params === "object" ? raw.params : raw;
          const reply = (decision: FolderTrustDecision | "skipped") =>
            send({ jsonrpc: "2.0", id: msg.id, result: { outcome: decision === "trust" ? "trust" : "reject" } });
          const kinds = Array.isArray(params.configKinds) ? params.configKinds : [];
          const sources = folderSources().length ? folderSources() : folderTrustKindNames(kinds);
          // FUIGOTRUST3 (1): the engine asks ONLY when its own store did not
          // trust the folder, so a request on an `upstreamTrusted` turn means
          // Murage's reading of trusted_folders.toml and the engine's
          // disagree (a hand-edited document Murage's parser accepts but the
          // engine's rejects). The engine's reading is the one that runs;
          // a grant is never given on Murage's reading alone — the owner's
          // own record answers, else the owner is asked now.
          if (folderTrusted) {
            reply(folderTrusted);
            // the turn runs untrusted after all: the chip `upstreamTrusted`
            // suppressed before the spawn is owed now
            if (upstreamTrusted && folderTrusted === "reject" && sources.length && !state.settled) noteFolderTrust(folderTrustWithheldName(sources));
            return;
          }
          flushAssistantText();
          askFolderTrust(sources, (decision) => {
            folderTrusted = decision === "trust" || decision === "reject" ? decision : "skipped";
            reply(folderTrusted);
            // FUIGOTRUST2 (6): nobody decided while the engine ran — it ran
            // untrusted, so the chip names what it asked about. A settle
            // closes the ask BEFORE it emits turn.completed, so the chip
            // still lands inside the turn.
            if (decision === "unanswered") return noteFolderTrust(folderTrustWithheldName(sources));
            if (state.settled) return;
            noteFolderTrust(decision === "trust" ? folderTrustLateName(sources) : folderTrustWithheldName(sources));
          }, true);
        };

        // server→client permission request → canonical request.opened
        const handleServerRequest = (msg: any) => {
          if (FUIGO_FOLDER_TRUST_METHODS.has(msg.method)) return handleFolderTrustRequest(msg);
          if (msg.method === FUIGO_ASK_METHOD) return handleQuestionRequest(msg, "fuigo");
          if (msg.method === FUIGO_ELICIT_METHOD) return handleQuestionRequest(msg, "fuigo-elicit");
          if (ELICITATION_METHODS.has(msg.method)) return handleQuestionRequest(msg, "elicitation");
          if (msg.method !== "session/request_permission") {
            // never leave an unknown server request hanging — the agent blocks
            return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
          }
          const params = msg.params ?? {};
          flushAssistantText();
          const options: Array<{ optionId?: string; kind?: string }> = Array.isArray(params.options) ? params.options : [];
          // A card answers only this request. Never widen it to an engine's
          // standing grant when the matching one-time option is unavailable.
          // Explicit fullAuto retains its existing broader fallback.
          const optionFor = (want: "allow" | "reject", allowStanding = false) => {
            const usable = options.filter((o) => typeof o.optionId === "string" && String(o.kind ?? "").startsWith(want));
            return (usable.find((o) => o.kind === `${want}_once`) ?? (allowStanding ? usable[0] : undefined))?.optionId ?? null;
          };
          const cancelled = { outcome: { outcome: "cancelled" } };
          const missing = (want: string) =>
            emit({
              ...base(threadId, turnId),
              type: "runtime.error",
              message: `${DRIVER_KIND} offered no "${want}" permission option — cancelling the request instead of guessing`,
            });

          const toolCall = params.toolCall ?? {};
          const kind = String(toolCall.kind ?? "");
          // An agent that routes its question tool (e.g. AskUserQuestion)
          // through request_permission names it in the tool call. That tool
          // asks the OWNER, so fullAuto must not select "allow" for it — that
          // would answer the question with nothing — and the harness receives
          // the tool's own name so its policy recognizes it too.
          const title = String(toolCall.title ?? "");
          const questionTool = isQuestionTool(title) ? title : isQuestionTool(kind) ? kind : undefined;
          if (ownedMemoryAlias && !config.fullAuto && !questionTool && state.promptSent &&
            sessionId && params.sessionId === sessionId && !state.settled && !state.cancelRequested &&
            Array.from(rpcPending.values()).some(pending => pending.method === "session/prompt")) {
            const allow = fuigoMemoryAllowOnce(toolCall, options, ownedMemoryAlias);
            if (allow) return send({ jsonrpc: "2.0", id: msg.id,
              result: { outcome: { outcome: "selected", optionId: allow } } });
          }
          if (config.fullAuto && !questionTool) {
            const allow = optionFor("allow", true);
            if (!allow) missing("allow");
            return send({
              jsonrpc: "2.0",
              id: msg.id,
              result: allow ? { outcome: { outcome: "selected", optionId: allow } } : cancelled,
            });
          }
          const tool = questionTool ?? (kind === "execute" ? "shell" : kind === "edit" ? "edit" : kind || "tool");
          const summary = String(toolCall.rawInput?.command ?? toolCall.title ?? tool).slice(0, 200);
          const requestId = newId();
          const finish: AcpAskFinish = (behavior, source = "user") => {
            if (!asks.delete(requestId)) return;
            clearTimeout(timer);
            const want = behavior === "allow" ? "allow" : "reject";
            const optionId = behavior === "cancel" ? null : optionFor(want);
            if (behavior !== "cancel" && !optionId) missing(want);
            send({
              jsonrpc: "2.0",
              id: msg.id,
              result: optionId ? {
                outcome: { outcome: "selected", optionId },
                // Fuigo 1.0.13 treats a bare reject_once as turn cancellation.
                // Its response-level feedback extension keeps the tool denied
                // while allowing a safe explanation in this same native turn.
                ...(support.driverKind === "fuigoAgent" && !config.fullAuto && !questionTool &&
                  behavior === "deny" && source === "user" &&
                  options.some(option => option.optionId === optionId && option.kind === "reject_once")
                  ? { _meta: { followup_message: "The user denied this operation. Do not retry it, bypass the denial, or perform an equivalent action through another tool. Keep the operation unexecuted and explain the limitation and any safe alternatives without taking further action." } }
                  : {}),
              } : cancelled,
            });
            emit({
              ...base(threadId, turnId),
              type: "request.resolved",
              requestId,
              behavior: optionId && behavior === "allow" ? "allow" : "deny",
              source: optionId ? source : "system",
              approvalScope: controlsHost ? "local-computer" : undefined,
            });
            return Boolean(optionId);
          };
          const timer = setTimeout(() => {
            emit({ ...base(threadId, turnId), type: "runtime.error", message: DENY_TIMEOUT_NOTE });
            finish("deny", "timeout");
          }, 15 * 60_000);
          timer.unref?.();
          asks.set(requestId, finish);
          emit({
            ...base(threadId, turnId),
            type: "request.opened",
            requestId,
            requestType: "permission",
            tool,
            summary,
            approvalScope: controlsHost ? "local-computer" : undefined,
            ...(questionTool ? { questionTool: true as const } : {}),
            // Structured, off the wire — never parsed back out of `summary`,
            // which is composed from what the model wrote.
            ...(() => { const filePaths = acpToolFilePaths(toolCall); return filePaths ? { filePaths } : {}; })(),
          });
        };

        const handleNotification = (msg: any) => {
          failureObservations.observe(msg, {
            source: SOURCE, sessionId, promptStartedAt,
            pendingPrompts: [...rpcPending.values()].filter(p => p.method === "session/prompt").length,
            promptSent: state.promptSent, settled: state.settled, cancelRequested: state.cancelRequested,
          });
          if (support.mcpReadyNotification && msg.method === support.mcpReadyNotification) {
            const readyId = msg.params?.sessionId;
            if (typeof readyId === "string" && readyId) {
              mcpReadySessions.add(readyId);
              if (readyId === sessionId) releaseMcpWait?.();
            }
            return;
          }
          // Vendor side-channels (e.g. grok's `_x.ai/*`) are teed to the
          // native log but never normalized: the prompt result is the settle.
          if (msg.method !== "session/update") return;
          const p = msg.params ?? {};
          if (!state.promptSent || p._meta?.isReplay === true) return;
          const u = p.update ?? {};
          switch (u.sessionUpdate) {
            case "agent_message_chunk": {
              const content = u.content;
              const delta = content?.text;
              if (content?.type === "image" && typeof content.data === "string" && content.data) {
                flushAssistantText();
                state.producedItem = true;
                emit({
                  ...base(threadId, turnId),
                  type: "item.completed",
                  itemType: "assistant_image",
                  data: content.data,
                  alt: "Generated image",
                });
              } else if (typeof delta === "string" && delta) {
                state.text += delta;
                emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta });
              }
              break;
            }
            case "agent_thought_chunk": {
              const delta = u.content?.text;
              if (typeof delta === "string" && delta) {
                emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "reasoning_text", delta });
              }
              break;
            }
            case "plan": {
              // The protocol's structured to-do list. Every update carries the
              // whole list, so it is forwarded whole and never joins the answer.
              const entries = normalizeAgentPlan(u.entries);
              if (entries) emit({ ...base(threadId, turnId), type: "plan.updated", entries });
              break;
            }
            case "tool_call": {
              flushAssistantText();
              // Engines that route every call through a wrapper ("use a tool")
              // put the real tool in the arguments. Name that, not the wrapper.
              const label = resolveToolLabel(u.title, u.rawInput);
              // `resolveToolLabel` shows a shell command in place of the tool
              // for any call that carries one, so its name cannot be used to
              // decide whether this tool is one of Murage's screen surfaces.
              // Keep the tool the engine actually named alongside it.
              const identity = resolveToolIdentity(u.title, u.rawInput);
              if (typeof u.toolCallId === "string" && toolNames.size < 512) toolNames.set(u.toolCallId, { label: label.name, identity });
              emit({
                ...base(threadId, turnId),
                type: "item.started",
                itemType: "tool",
                itemId: u.toolCallId,
                title: label.name,
                summary: label.summary,
              });
              break;
            }
            case "tool_call_update": {
              if (u.status === "completed" || u.status === "failed") {
                // The reason a tool failed arrives with the result. It used to
                // go only into the model's context; the person who has to act
                // on it never saw it.
                const detail = u.status === "failed" ? redactSecretsInText(toolFailureText(u) ?? "") || undefined : undefined;
                state.producedItem = true;
                emit({
                  ...base(threadId, turnId),
                  type: "item.completed",
                  itemType: "tool",
                  itemId: u.toolCallId,
                  ok: u.status !== "failed",
                  detail,
                });
                // Only the chip was ever read out of this update. An image in
                // the tool's output had no route at all: not the message, not
                // Files. ACP wraps each output part as {type:"content",…}, and
                // engines that pass the raw MCP result put it in `rawOutput`.
                const called = typeof u.toolCallId === "string" ? toolNames.get(u.toolCallId) : undefined;
                if (typeof u.toolCallId === "string") toolNames.delete(u.toolCallId);
                for (const image of extractMcpImages(u.content ?? u.rawOutput, called?.identity)) {
                  emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_image", data: image.data, alt: called?.label });
                }
              }
              break;
            }
          }
        };

        // Byte-bounded framing (A4): the splitter decodes UTF-8 only for
        // complete lines, so multibyte characters that straddle two reads stay
        // intact, and one frame can never hold more than ENGINE_FRAME_MAX_BYTES
        // of this shared process's memory.
        const stdoutLines = createBoundedLineSplitter({
          onLine: (line) => handleStdoutLine(line),
          onOverflow: (overflow) => {
            appendNative(threadId, { dir: "in", source: SOURCE, msg: { frameOverflow: overflow } });
            if (state.settled) return;
            emit({ ...base(threadId, turnId), type: "runtime.error", message: frameOverflowMessage(support.displayName, overflow) });
            settle(false, FRAME_TOO_LARGE);
          },
        });
        const handleStdoutLine = (line: string) => {
          if (!line.trim()) return;
          let msg: any;
          try {
            msg = JSON.parse(line);
          } catch {
            return;
          }
          appendNative(threadId, { dir: "in", source: SOURCE, msg: nativeLogMessage(msg) });
          // Any inbound line proves the child is alive and making progress, so
          // every idle deadline restarts. Only total silence trips one.
          for (const pending of rpcPending.values()) pending.armIdle();
          if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
            const pend = rpcPending.get(msg.id);
            if (!pend && msg.error) {
              // No pending request matches: never attach a method to it.
              lifecycle.record("rpc_rejected", lifecycleRejection(msg.error, msg.id));
            }
            if (pend) {
              rpcPending.delete(msg.id);
              if (pend.timer) clearTimeout(pend.timer);
              if (pend.idleTimer) clearTimeout(pend.idleTimer);
              if (msg.error) {
                const observedKind=pend.method==="session/prompt"&&!state.settled&&!state.cancelRequested?failureObservations.kind():undefined;
                lifecycle.record("rpc_rejected", {...lifecycleRejection(msg.error, msg.id, pend.method),...(observedKind?{observedKind}:{})});
                const error = new Error(acpRpcErrorMessage(msg.error));
                Object.assign(error, { code: msg.error.code, data: msg.error.data, acpMethod: pend.method, acpRpcId:msg.id });
                if (pend.method === "session/prompt" && !state.settled && !state.cancelRequested) {
                  Object.assign(error, { fuigoFailureObservation: failureObservations.details(),fuigoObservedKind:observedKind });
                }
                pend.reject(error);
              } else {
                pend.resolve(msg.result);
              }
            }
          } else if (msg.id !== undefined && msg.method) {
            handleServerRequest(msg);
          } else if (msg.method) {
            handleNotification(msg);
          }
        };

        const attachChild = (proc: NonNullable<typeof child>) => {
        proc.stdout.on("data", (chunk: Buffer) => stdoutLines.push(chunk));
        proc.stderr.on("data", (c) => {
          const text = String(c), remaining = STDERR_DIAGNOSTIC_CHARS - stderrDiagnostic.length;
          stderrDiagnostic += text.slice(0, Math.max(0, remaining));
          if (text.length > remaining) stderrDiagnosticTruncated = true;
        });
        proc.on("error", (e) => {
          if (!spawned) lifecycle.record("spawn_failed", { errno: errnoCategory(e) });
          emit({ ...base(threadId, turnId), type: "runtime.error", ...describeSpawnFailure(e, config.cli) });
          settle(false, "spawn_error");
        });
        proc.on("close", (code, signal) => {
          // Redact before splitting records, so a credential crossing a chunk
          // boundary is not exposed. A capped partial final line is omitted.
          const captured = acpEngineStderrCapture(stderrDiagnostic, stderrDiagnosticTruncated);
          const diagnostic = redactSecretsInText(stripVTControlCharacters(captured));
          for (let offset = 0; offset < diagnostic.length; offset += 4096) appendNative(threadId, { dir: "in", source: `${SOURCE}.stderr`, msg: { type: "engine_stderr", turnId, processGeneration: lifecycle.generation, text: diagnostic.slice(offset, offset + 4096) } });
          if (stderrDiagnosticTruncated) appendNative(threadId, { dir: "in", source: `${SOURCE}.stderr`, msg: { type: "engine_stderr_truncated", turnId, limitChars: STDERR_DIAGNOSTIC_CHARS } });
          // Observed before settle() clears pending RPC state. A close with no
          // earlier stop_requested is unsolicited; its initiator stays unknown.
          lifecycle.record("closed", {
            code,
            signal,
            pid: proc.pid ?? null,
            pendingMethods: [...rpcPending.values()].map((pending) => pending.method),
            pendingCount: rpcPending.size,
            settled: state.settled,
            cancelRequested: state.cancelRequested,
            promptSent: state.promptSent,
          });
          if (!state.settled) {
            if (state.cancelRequested) {
              settle(true, "cancelled");
              stderrDiagnostic = "";
              return;
            }
            // Engine stderr is engine-controlled text like `error.data` and
            // the JSON-RPC `error.message`, and it lands in the same two
            // places: the card and messages.db. So it is sanitised by the
            // same function — controls and bidi out, credential-bearing
            // locators and secrets removed, one line, inside the
            // transcript's own length — and quoted from its END, which is
            // where a crash's fatal line is.
            const detail = acpEngineExitStderrText(captured);
            emit({
              ...base(threadId, turnId),
              type: "runtime.error",
              message: `${DRIVER_KIND} exited ${code} before the prompt result${detail ? `: ${detail}` : ""}`,
            });
            settle(false, "exit_before_result");
          }
          stderrDiagnostic = "";
        });
        };

        // interruptTurn cannot tell a user's Stop from a watchdog or a settings
        // change, so the requested stop is recorded as `unspecified`.
        const interrupt = () => {
          if (state.settled) return;
          state.cancelRequested = true;
          // A turn still waiting for MCP readiness has sent no prompt: the
          // waiter wakes and settles it as cancelled at once.
          releaseMcpWait?.();
          if (!child) {
            // Nothing spawned yet: the turn is waiting on its folder-trust
            // card. Stop settles it as cancelled at once (the card is closed
            // by settle as a system non-answer); there is no process to wait for.
            lifecycle.record("stop_requested", { reason: "user_cancel", pid: null, settled: false, cancelRequested: true, promptSent: false });
            settle(true, "cancelled", "user_cancel");
            return;
          }
          if (sessionId) {
            lifecycle.record("stop_requested", {
              reason: "unspecified",
              pid: child.pid ?? null,
              settled: false,
              cancelRequested: true,
              promptSent: state.promptSent,
            });
            send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
          } else stop("unspecified");
          if (interruptTimer) clearTimeout(interruptTimer);
          interruptTimer = setTimeout(() => settle(true, "cancelled", "cancel_timeout"), ACP_CANCEL_GRACE_MS);
          interruptTimer.unref?.();
        };
        /** Resolve when `id` is MCP-ready, the bound passes, or the turn ends.
         * The timer and the release hook are always cleared together. */
        const awaitMcpReady = (id: string) =>
          new Promise<"ready" | "timeout" | "aborted">((resolve) => {
            if (mcpReadySessions.has(id)) return resolve("ready");
            if (state.settled || state.cancelRequested) return resolve("aborted");
            const finish = (outcome: "ready" | "timeout" | "aborted") => {
              if (releaseMcpWait !== release) return;
              releaseMcpWait = null;
              clearTimeout(timer);
              resolve(outcome);
            };
            const release = () => finish(mcpReadySessions.has(id) ? "ready" : "aborted");
            releaseMcpWait = release;
            const timer = setTimeout(() => finish("timeout"), mcpReadyWaitMs());
            timer.unref?.();
          });

        let started = false;
        const start = () => {
          if (started) return;
          started = true;
          active.set(threadId, { stop, interrupt, turnId, asks });
          emit({ ...base(threadId, turnId), type: "turn.started" });
        };

        /** Spawn the engine under the folder-trust decision and run the
         * handshake. A synchronous spawn failure throws to the caller, as it
         * always did for a turn that needs no card. */
        const launch = (trusted: boolean) => {
        lifecycle.record("spawn_requested");
        const proc = (() => {
          try {
            return spawnCli(config.cli, support.spawnArgs(config, cliTurn, { requestedModel: turn.model, folderTrusted: trusted }), {
              cwd,
              env,
              stdio: ["pipe", "pipe", "pipe"],
            });
          } catch (error) {
            lifecycle.record("spawn_failed", { errno: errnoCategory(error) });
            throw error;
          }
        })();
        child = proc;
        proc.once("spawn", () => {
          spawned = true;
          lifecycle.record("spawned", { pid: proc.pid ?? null });
        });
        teardown = teardowns.track(threadId, turnId, proc);
        teardown.onClosed(() => providerBinding?.cleanup());
        attachChild(proc);
        start();

        (async () => {
          try {
            const init = await request(
              "initialize",
              {
                protocolVersion: 1,
                // form and URL elicitation are advertised because both become
                // question cards (ASK3); a URL is shown, never fetched. An engine
                // that gates folders is told this client can ask the owner
                // (FUIGOTRUST1), so it never has to decide "untrusted" alone.
                clientCapabilities: {
                  fs: { readTextFile: false, writeTextFile: false },
                  elicitation: { form: {}, url: {} },
                  ...(support.folderTrust ? { _meta: { "fuigo/folderTrust": { interactive: true } } } : {}),
                },
              },
              INIT_TIMEOUT,
            );
            const methods: Array<{ id?: string }> = Array.isArray(init?.authMethods) ? init.authMethods : [];
            const methodId = support.pickAuthMethod(methods);
            if (!(support.driverKind === "grokAgent" && providerBinding) && !skipSubscriptionAuthForLocalInject(turn.model)) {
              if (methodId) {
                try {
                  await request("authenticate", { methodId }, INIT_TIMEOUT);
                } catch {
                  if (support.authFailure === "fail") throw new Error(support.loginNote);
                  // else: proceed on an ambient login
                }
              } else if (support.authFailure === "fail") {
                throw new Error(support.loginNote);
              }
            }

            const cursor = grokBinding ? grokBinding.cursor : typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
            let sessionResult: any = null;
            if (cursor) {
              try {
                sessionResult = await request(
                  "session/load",
                  { sessionId: cursor, cwd, mcpServers },
                  LOAD_SESSION_TIMEOUT,
                );
                // An agent is allowed to ANSWER session/load with null when the
                // session is gone. Taking the cursor on that answer pinned
                // sessionId to a dead id, skipped the session/new below, and
                // prompted a session the agent had already forgotten.
                if (sessionResult) sessionId = cursor;
              } catch {
                /* session gone, load unsupported, or too slow — start fresh */
              }
            }
            if (!sessionId) {
              if (grokBinding && cursor) {
                if (!turn.transcript) throw new Error("Grok session could not be restored. Reload the conversation before continuing.");
                promptTurn = replayGrokTurn();
              }
              sessionResult = await request("session/new", { cwd, mcpServers }, NEW_SESSION_TIMEOUT);
              sessionId = typeof sessionResult?.sessionId === "string" ? sessionResult.sessionId : null;
              if (!sessionId) throw new Error("session/new returned no sessionId");
            }
            let selectedModel: string | null = null;
            let sessionStarted = false;
            const emitSessionStarted = () => {
              if (sessionStarted) return;
              if (sessionId) grokBinding?.record(sessionId);
              sessionStarted = true;
              emit({
                ...base(threadId, turnId),
                type: "session.started",
                sessionId,
                model: selectedModel ?? init?._meta?.modelState?.currentModelId ?? cliTurn.model ?? null,
              });
            };

            try {
              if (support.selectModel) {
                const { configId } = support.selectModel;
                const currentOf = (r: any) =>
                  (Array.isArray(r?.configOptions) ? r.configOptions : []).find((o: any) => o?.id === configId)
                    ?.currentValue ?? null;
                selectedModel = currentOf(sessionResult);
                if (cliTurn.model && cliTurn.model !== selectedModel) {
                  selectedModel = currentOf(
                    await request(
                      "session/set_config_option",
                      { sessionId, configId, value: cliTurn.model },
                      INIT_TIMEOUT,
                    ),
                  );
                  // an agent that answers OK but keeps its old model is worse than
                  // one that errors: it burns a paid turn on the wrong thing
                  if (selectedModel !== cliTurn.model) {
                    throw new Error(
                      `${DRIVER_KIND} did not switch to ${cliTurn.model} (still ${selectedModel ?? "unknown"})`,
                    );
                  }
                }
              }

              if (support.configureSession) {
                await support.configureSession({
                  request: (method, params, timeoutMs) =>
                    request(method, params, timeoutMs ?? SESSION_CONFIG_TIMEOUT),
                  sessionId,
                  config,
                  turn: cliTurn,
                  sessionModels: Array.isArray(sessionResult?.models?.availableModels)
                    ? sessionResult.models.availableModels
                    : [],
                });
                // initialize's currentModelId is the CLI default (grok-4.6),
                // not the model this turn asked for. After a successful pin,
                // report the slug we set so the UI does not claim otherwise.
                if (!selectedModel && cliTurn.model) selectedModel = cliTurn.model;
              }
            } catch (error) {
              // session.started is the only place the resume cursor is recorded,
              // so a rejected setting must not orphan a session we just created.
              emitSessionStarted();
              throw error;
            }
            emitSessionStarted();
            // Fuigo: the servers in `mcpServers` start connecting at
            // session/new; prompting before they settle hands the model a
            // "currently connecting, do not use" reminder on its first step.
            if (support.mcpReadyNotification && mcpServers.length && sessionId) {
              const outcome = await awaitMcpReady(sessionId);
              if (state.settled) return;
              if (state.cancelRequested) { settle(true, "cancelled"); return; }
              lifecycle.record(outcome === "ready" ? "mcp_ready" : "mcp_ready_timeout");
            }
            if (!(support.driverKind === "grokAgent" && providerBinding)) {
              state.promptSent = true;
              promptStartedAt = Date.now();
            }
            const text = support.buildPromptText
              ? support.buildPromptText(promptTurn)
              : promptTurn.system
                ? `${promptTurn.system}\n\n${promptTurn.text}`
                : promptTurn.text;
            if (support.driverKind === "grokAgent" && providerBinding) {
              turn.beforeSubmit?.();
              state.promptSent = true;
              promptStartedAt = Date.now();
            }
            const promptIdleMs = promptIdleTimeoutMs();
            const result = await request(
              "session/prompt",
              {
                sessionId,
                prompt: [{ type: "text", text }, ...(turn.images ?? []).map(image => ({ type: "image", ...image }))],
              },
              undefined,
              promptIdleMs,
              // Kept inside ERROR_MESSAGE_MAX so the card shows all of it.
              `${DRIVER_KIND} went silent for ${Math.round(promptIdleMs / 1000)} s and the turn was stopped. `
                + "Raise MURAGE_ACP_PROMPT_IDLE_MS if it needs longer.",
            );
            // opencode 1.18.18 reports usage at the result root; grok and
            // gemini put it under _meta. Read both rather than lose the count.
            const usage = result?.usage ?? result?._meta ?? {};
            if (typeof usage.inputTokens === "number" || typeof usage.outputTokens === "number") {
              emit({
                ...base(threadId, turnId),
                type: "thread.token-usage.updated",
                input: usage.inputTokens ?? 0,
                output: usage.outputTokens ?? 0,
              });
            }
            const reason = result?.stopReason;
            // Flushed here, not in settle, so the check below sees a reply
            // that was still buffered as streamed text.
            if (reason === "end_turn") flushAssistantText();
            if (reason === "end_turn" && !state.producedItem) {
              // `end_turn` with nothing to show for it (no reply, no image,
              // no tool result) is a lost turn, not a success. A provider can
              // cut a reasoning-only stream and still answer end_turn, and
              // ok:true ended the thread quietly with the person's message
              // unanswered: no error card, no Inbox item, no team incident.
              // Report it as a failure so those paths see it (upstream
              // b679798f, #1623).
              const eventBase=base(threadId,turnId);
              emit({
                ...eventBase,
                type: "runtime.error",
                message: `${support.displayName} finished without a reply, an image or a tool result, so nothing came back.`,
                diagnostic:acpErrorDiagnostic(eventBase,lifecycle.generation),
              });
              settle(false, "empty_turn");
            }
            else if (reason === "end_turn") settle(true, null);
            else if (reason === "cancelled") settle(true, "cancelled");
            // An interrupt already sent session/cancel. An engine that ends
            // the cancelled request under its own stop reason stopped because
            // it was asked to, exactly as the rejection and close paths treat
            // it: a cancellation, never an error card.
            //
            // Deliberately broad: `cancelRequested` is set by every
            // interrupter — a user's Stop, a room deadline, the stall watchdog
            // (server/index.ts ~2507) and a provider-settings change (~512) —
            // and the driver cannot tell them apart (the stop is recorded as
            // `unspecified`). A turn that was interrupted is a cancellation
            // whoever interrupted it; calling one of them an engine failure
            // would be the false-failure bug this guard exists to remove.
            else if (state.cancelRequested) settle(true, "cancelled");
            else {
              const errorMessage = typeof result?.error === "string" && result.error
                ? result.error
                : typeof result?.message === "string" && result.message
                  ? result.message
                  : `Model turn failed: ${reason ?? "unknown error"}`;
              const eventBase=base(threadId,turnId);
              emit({
                ...eventBase,
                type: "runtime.error",
                message: errorMessage,
                diagnostic:acpErrorDiagnostic(eventBase,lifecycle.generation),
              });
              settle(false, reason ?? "failed");
            }
          } catch (e) {
            if (!state.settled) {
              if (state.cancelRequested) { settle(true, "cancelled"); return; }
              const message = e instanceof Error ? e.message : String(e);
              const code = support.classifyError?.(e);
              const providerError = classifyProviderError(e);
              // Authentication setup is a user action, not a retry. The
              // classifier is preferred; loginNote remains a compatibility
              // fallback for existing ACP supports.
              const needsAuth = code === "invalid_credentials" || code === "inactive_subscription"
                || message === support.loginNote;
              const eventBase=base(threadId,turnId);
              // An RPC rejection shows the engine's own explanation (its
              // `error.data`) when it sent one; fixed credit copy still wins.
              // Classification above keeps reading the JSON-RPC message.
              const rpc = e as { acpMethod?: unknown; data?: unknown };
              const engineText = providerError?.kind !== "credits" && providerError?.kind !== "payment" && providerError?.kind !== "spend-cap" && !reasoningOnlyData(rpc?.data) && typeof rpc?.acpMethod === "string"
                ? acpEngineErrorText(rpc.data) : undefined;
              // The kind travels structurally. The card reads this field, not
              // the error text, so an engine cannot claim a kind in prose.
              const errorKind = acpEngineErrorKind(rpc?.data);
              // The JSON-RPC `error.message` is engine-controlled text too —
              // `acpRpcErrorMessage` returns it verbatim — and it reaches the
              // card and messages.db by the same route as `error.data`. So it
              // is sanitised by the same function: controls, embedded JSON
              // bodies, credential-bearing locators and secrets out, one line,
              // inside the transcript's own length. Classification above still
              // reads the raw message, and a line that sanitises to nothing is
              // the generic failure text rather than the raw one.
              emit({
                ...eventBase,
                type: "runtime.error",
                message: engineText ?? acpEngineErrorText(message) ?? "ACP request failed",
                ...(errorKind ? { errorKind } : {}),
                diagnostic:acpErrorDiagnostic(eventBase,lifecycle.generation,e),
                details: [acpRpcErrorDetails(e), e instanceof Error
                  ? (e as Error & { fuigoFailureObservation?: string }).fuigoFailureObservation : undefined]
                  .filter(Boolean).join("\n") || undefined,
                ...(providerError ? { providerError } : {}),
                ...(needsAuth ? { setup: true } : {}),
              });
              settle(false, needsAuth ? "auth_required" : "rpc_error");
            }
          }
        })();
        };

        // Folder trust, decided before the engine starts (FUIGOTRUST1). The
        // engine reads the folder's instructions and skills when it builds its
        // session, so a decision made after the spawn would only reach the
        // NEXT turn; asking first makes this turn honour the answer. A folder
        // with nothing to gate, or with a remembered decision, never sees a
        // card. "Don't trust" (or a skip) runs the turn untrusted with a chip
        // naming what was left out; no answer in time ends the turn as a
        // stopped turn (STOP2), never a hang and never a guess.
        const gate = turn.folderTrust;
        const needsCard = Boolean(support.folderTrust && gate && !gate.decision && gate.sources.length && !upstreamTrusted);
        if (!needsCard) {
          try {
            launch(folderTrusted === "trust");
          } catch (error) {
            providerBinding?.cleanup();
            throw error;
          }
          if (support.folderTrust && folderTrusted === "reject" && gate?.sources.length && !upstreamTrusted) noteFolderTrust(folderTrustWithheldName(gate.sources));
          return { turnId };
        }
        start();
        askFolderTrust(gate!.sources, (decision) => {
          if (state.settled) return;
          if (decision === "unanswered") {
            noteFolderTrust(hostStoppedActivityName(`nobody decided whether to trust ${gate!.folder} in time; send the message again to be asked`));
            settle(true, "cancelled", "cancel_timeout");
            return;
          }
          folderTrusted = decision;
          try {
            launch(decision === "trust");
          } catch (error) {
            emit({ ...base(threadId, turnId), type: "runtime.error", ...describeSpawnFailure(error as NodeJS.ErrnoException, config.cli) });
            settle(false, "spawn_error");
            return;
          }
          if (decision !== "trust") noteFolderTrust(folderTrustWithheldName(gate!.sources));
        });
        return { turnId };
      };

      const snapshot = async (): Promise<ProviderSnapshot> => {
        const env = childEnv();
        const probe = await new Promise<{ error: Error | null; version: string }>((resolve) => {
          execCli(config.cli, ["--version"], { timeout: 8000, env }, (error, stdout) =>
            resolve({ error, version: stdout.trim() }),
          );
        });
        if (probe.error || !probe.version) {
          const detail = acpVersionFailureDetail(probe.error);
          return { state: "unavailable", ...(support.versionFailure?.(env, config, detail)
            ?? { reason: `\`${config.cli}\` ${detail}` }) };
        }
        return { state: "available", version: probe.version, authenticated: await support.isAuthenticated(env, config) };
      };

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        displayName: input.displayName,
        enabled: input.enabled,
        get models() {
          return models;
        },
        refreshModels: support.resolveModels ? refreshModels : undefined,
        snapshot,
        adapter: {
          provider: DRIVER_KIND,
          capabilities: {
            sessionModelSwitch: "unsupported",
            agentsMcp: true,
            memoryMcp: true,
        customMcp: true,
            computerMcp: true,
            composioMcp: true,
            browserMcp: true,
            images: support.images !== false,
            // The ACP session/prompt carries real image parts (see sendTurn),
            // so an engine that takes images at all is shown them.
            imagesInline: support.images !== false,
            effortLevels: support.effortLevels,
            localComputerMcp: !config.fullAuto,
            folderTrust: support.folderTrust === true,
          },
          sendTurn,
          // Close-confirmed stop (A2): resolve only once the child that served
          // this thread has closed; reject at the bounded deadline while the
          // process stays owned. A thread with no live child is already closed.
          interruptTurn: async (threadId, turnId) => {
            active.get(threadId)?.interrupt();
            const result = await teardowns.wait(threadId, turnId, acpStopBudget());
            if (!result.closeConfirmed) throw new ProviderStopUnconfirmedError(DRIVER_KIND, result);
            return result;
          },
          awaitTurnTeardown: (threadId, turnId) => teardowns.wait(threadId, turnId, acpStopBudget()),
          respondToRequest: async (threadId, requestId, decision) => {
            const turn = active.get(threadId);
            const finish = turn?.asks.get(requestId);
            if (!finish) return "unavailable"; // settled, timed out, or turn gone
            if (decision.behavior === "answer") {
              // only a question ask carries the owner's picks to the engine
              if (!decision.answers?.length) return "unavailable";
              finish("answer", "user", decision.answers);
              return "answered";
            }
            const delivered = finish(decision.behavior === "allow" ? "allow" : "deny", "user");
            if (delivered === false) return "unavailable";
            return decision.behavior === "allow" ? "allowed-once" : "rejected";
          },
          hasSession: (threadId) => active.has(threadId),
          stopAll: async () => {
            for (const { stop } of active.values()) stop("driver_dispose");
            const result = await teardowns.waitAll({ closeMs: providerCloseDeadlineMs(), maxMs: providerCloseDeadlineMs() });
            if (!result.closeConfirmed) throw new ProviderStopUnconfirmedError(DRIVER_KIND, result);
          },
          onEvent: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
        dispose: async () => {
          for (const { stop } of active.values()) stop("driver_dispose");
          const result = await teardowns.waitAll({ closeMs: providerCloseDeadlineMs(), maxMs: providerCloseDeadlineMs() });
          // Same as codex: an unconfirmed close keeps listeners attached so
          // the owned child's late events are still accounted for.
          if (!result.closeConfirmed) throw new ProviderStopUnconfirmedError(DRIVER_KIND, result);
          listeners.clear();
        },
      };
    },
  };
}
