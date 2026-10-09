import { renderDriverReplay } from "../../turn-context.ts";
import { boundedEnvMs } from "../env-ms.ts";
import { FUIGO_TOOL_SURFACE, NEUTRAL_TOOL_SURFACE, renderMurageTurn } from "../../murage-tool-surface.ts";
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
import { applyProviderRoute, FUIGO_ALLOW_UPSTREAM_ENV, grokResumeBinding, validateProviderTurnRoute } from "../../provider-routing.ts";
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
import { approvalSummary } from "../../../shared/approval-summary.ts";
import { boundedToolInput, commandText } from "../../approval-text.ts";
import { extractMcpImages } from "../../mcp-tool-images.ts";
import { folderTrustKindNames } from "../../folder-trust.ts";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { stripVTControlCharacters } from "node:util";

import { deleteEnvNames, PROVIDER_CREDENTIAL_ENV, stripRoutingEnv, WORKSPACE_CREDENTIAL_ENV } from "../../config.ts";
import { decodeInjectId } from "../local-inject.ts";
import { createFuigoFailureObservations, failureKind } from "./failure-diagnostics.ts";
import { DIAGNOSTIC_RPC_METHODS, parseRuntimeErrorDiagnostic } from "../../../shared/error-diagnostic.ts";
import { describeSpawnFailure, execCli, killCliTree, spawnCli } from "../../procs.ts";
import { ProviderStopUnconfirmedError, providerCloseDeadlineMs, TurnTeardowns, type ChildTeardown, type TeardownWait } from "../child-teardown.ts";
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

/** Built-in ACP tool kinds that name what they do. None of them is a call
 * into the computer MCP server, which reaches the engine as an MCP tool. */
const ACP_BUILTIN_KINDS = new Set(["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode"]);
const COMPUTER_TOOL = /^(?:mcp__)?computer(?:__|$)/;

/** Whether an ACP permission ask is the host computer's own control tool.
 * With the host computer attached, only these keep the local-computer
 * treatment (no remembered grants, the computer card); a shell command or
 * another MCP tool on the same turn is judged like any other ask, so a stop
 * line card keeps its scoped choices. A call that names no tool at all
 * stays a computer action: a name this cannot read is never widened. */
export function acpAskControlsComputer(toolCall: unknown): boolean {
  if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) return true;
  const call = toolCall as { kind?: unknown; title?: unknown; rawInput?: unknown; _meta?: unknown };
  const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
  const meta = call._meta && typeof call._meta === "object" ? (call._meta as Record<string, unknown>)["fuigo/tool"] : undefined;
  const identity = meta && typeof meta === "object" && !Array.isArray(meta) ? meta as Record<string, unknown> : undefined;
  const input = call.rawInput && typeof call.rawInput === "object" && !Array.isArray(call.rawInput) ? call.rawInput as Record<string, unknown> : undefined;
  const names = [
    identity?.namespace === "mcp" ? text(identity.name) : "",
    text(input?.tool_name),
    text(call.title),
  ].filter(Boolean);
  if (names.some(name => COMPUTER_TOOL.test(name))) return true;
  // Another MCP tool the engine named, through its dispatcher or directly.
  if (identity?.namespace === "mcp" && text(identity.name)) return false;
  if (identity?.name === "use_tool" && text(input?.tool_name)) return false;
  // One of the engine's own tools.
  if (identity?.namespace === "fuigo_build" && identity.name !== "use_tool" && text(identity.name)) return false;
  if (ACP_BUILTIN_KINDS.has(text(call.kind))) return false;
  // An MCP-shaped name for another server ("browser__open").
  return !names.some(name => /^[\w.-]+__[\w.-]+$/.test(name));
}

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
      : "This account has reached its monthly spending limit with the model provider. Adding credit will not lift it: ask them to raise it, or use another engine.";
  }
  if (info?.kind === "credits") {
    if (info.provider === "flux-router") {
      return "Flux Router is out of credits. Add credits in Flux Router, then retry, or choose another configured provider.";
    }
    return "Your model provider's credit balance is exhausted (HTTP 402). Review billing with your provider or choose another configured engine.";
  }
  if (reasoningOnlyData(error.data)) return "The model returned reasoning without a visible answer. No reply was produced.";
  // "Request failed." is the generic line the error card already recognises.
  return typeof error.message === "string" && error.message ? error.message : "Request failed.";
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

/** Whether a session/load rejection is a refusal to surface rather than a
 * missing session to replace. `classifyError` is the engine's own reading of
 * a sign-in failure; -32602 is JSON-RPC invalid params, except OpenCode's
 * ACPSessionNotFoundError, which is invalid params carrying only the
 * rejected session id. */
function loadRefusal(error: unknown, cursor: string, classify?: (error: unknown) => string | undefined): boolean {
  const kind = classify?.(error);
  if (kind === "invalid_credentials" || kind === "inactive_subscription") return true;
  const { code, data } = (error && typeof error === "object" ? error : {}) as { code?: unknown; data?: unknown };
  if (code !== -32602) return false;
  const missingSession = data !== null && typeof data === "object" && !Array.isArray(data)
    && Object.keys(data).length === 1 && (data as { sessionId?: unknown }).sessionId === cursor;
  return !missingSession;
}

/** The engine's own explanation of a failed request: Fuigo 1.0.18 sends
 * `error.data` as `{ message, error_kind }`, Fuigo <=1.0.17 as a plain string,
 * OpenCode as `{ details }` and some vendors as `{ error: { message } }`.
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
  // Named text fields only, never a response body or config dump (upstream
  // c61d7c86).
  const record = data && typeof data === "object" && !Array.isArray(data)
    ? data as { message?: unknown; details?: unknown; error?: { message?: unknown } }
    : undefined;
  const raw = typeof data === "string"
    ? data
    : typeof record?.message === "string" ? record.message
      : typeof record?.details === "string" ? record.details
        : record?.error && typeof record.error === "object" ? record.error.message : undefined;
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

/** The reason quoted on the `closed (exit code N) before it finished its reply` line:
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
/** The banner an ACP CLI prints for `--version`. Hermes writes its whole banner
 *  to stderr with an empty stdout, so a stdout-only read reports a working
 *  install as "CLI not found". Prefer stdout; fall back to the first stderr
 *  line; empty when both are empty. Upstream OpenMausBot #1524. */
export function versionFromProbe(stdout: string | undefined, stderr: string | undefined): string {
  const out = (stdout ?? "").trim();
  if (out) return out;
  return (stderr ?? "").trim().split(/\r\n|\n|\r/, 1)[0]?.trim() ?? "";
}

/** Plain words for Settings > Engines: never a raw code such as "(ENOENT)"
 * or "(exit 7)" (0.1.60 Linux D13). Read after the program's name. */
export function acpVersionFailureDetail(error: Error | null): string {
  if (!error) return "gave no version when Murage checked it; check the engine installation";
  const { code, killed, signal } = error as Error & { code?: string | number; killed?: boolean; signal?: string };
  if (killed && signal === "SIGTERM") return "did not answer within 8 seconds when Murage checked its version";
  if (code === "ENOENT") return "is not installed, or Murage cannot find it on this computer";
  if (code === "EACCES" || code === "EPERM") return "is not executable; check its file permissions";
  return "did not start when Murage checked its version; check the engine installation";
}

import type {
  DriverCreateInput,
  EffortLevel,
  EngineInstall,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  ModelCatalog,
  ModelRefreshOptions,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
  ProviderErrorCode,
  SteerDelivery,
} from "../../contracts.ts";
import { newEventId, newId } from "../../contracts.ts";
import { computerProxyEnv } from "../../container-computer.ts";
import { augmentedPath } from "../../env-path.ts";
import { customMountEntries } from "../../custom-mcp-mounts.ts";

// Resolved from the server root, never relative to this file: bundling inlines
// this module two directories up, so the `".."` pair here would climb past the
// packaged server dir entirely. See server/proxy-paths.ts.
const COMPUTER_PROXY_PATH = SPAWNED_PROXIES.computer;
import { appendNative } from "../native.ts";
import { descendantIdentities, processParentsAndArgs, untrackedIdentified, type ProcessIdentities } from "../process-tree.ts";
import { endTurnTrace, turnTrace } from "../../turn-trace.ts";
import { createBoundedLineSplitter, FRAME_TOO_LARGE, frameOverflowMessage, type FrameOverflow } from "../bounded-lines.ts";
import { SPAWNED_PROXIES } from "../../proxy-paths.ts";
import { normalizeEngineCommands } from "../../engine-commands.ts";
import { engineCommandText } from "../../../shared/engine-commands.ts";
import { engineClosedLine, plainDuration } from "../stop-copy.ts";
import { createPrewarmGate, createTurnMemory, spawnInputsOf, TAKEOVER_FAILED_MESSAGE, warmPool, pastWarmMaxAge, spawnedAtOf } from "../warm-pool.ts";
import { backgroundCapNote, backgroundWaitCapMs, SubtaskTracker } from "../../subtasks.ts";

/** Fuigo runs an interjection that missed its turn's final drain as its own
 *  prompt turn under this id prefix (fuigo-shell interjection.rs). */
const isFallbackPromptId = (id: unknown): id is string => typeof id === "string" && id.startsWith("interject-fallback-");
/** A fallback turn still running or queued when the hold reached its cap. */
export const FALLBACK_CAP_LINE = "The bot stopped before it finished your follow-up message.";

export interface AcpConfig {
  cli: string;
  fullAuto: boolean;
  /** Optional home for this instance's sessions. */
  workspace?: string;
  /** Hermes only: the profile this instance runs (`hermes -p <profile>`).
   *  Decoded by the support's `decodeExtra`; see server/hermes-profiles.ts. */
  profile?: string;
  /** Hermes only: "sticky" when 0.1.61 pinned the profile Hermes' own sticky
   *  default resolved to on upgrade (owner decision O12). */
  profileOrigin?: "sticky";
  /** OpenClaw only: the isolated agent this instance runs
   *  (`openclaw acp --session agent:<agent>:main`). Decoded by the support's
   *  `decodeExtra`; see server/openclaw-profiles.ts. */
  agent?: string;
}

/** Per-harness specifics — everything that differs between Grok, Gemini, … */
export interface AcpSupport {
  driverKind: string;
  /** The engine runs on its own tools and approvals (OpenClaw): Murage hands
   * `session/new` no `mcpServers` and declares no Murage mount capability, so
   * no teammates, memory, computer, browser or connected-apps tool is
   * promised, and Murage's stop-line is not claimed. */
  ownTools?: boolean;
  /** Extra `_meta` on every session/prompt (Fuigo: `verbatim`, so the
   * engine does not cut a long prompt and offload the rest to a file). */
  promptMeta?: Record<string, unknown>;
  /** PIP reflection (design 3.3): a text-only structured turn for this engine, spawned headless and
   * isolated. Only Fuigo and Grok provide one; other ACP engines stay unsupported. */
  textOnlyExecutable?(config: AcpConfig): string;
  textOnlyTurn?(turn: import("../../memory/pip-transport.ts").TextOnlyTurnInput, config: AcpConfig): Promise<import("../../memory/pip-transport.ts").TextOnlyTurnResult>;
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
    options?: ModelRefreshOptions,
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
  spawnArgs(config: AcpConfig, turn: SendTurnInput, ctx?: { requestedModel?: string; folderTrusted?: boolean; env?: Record<string, string | undefined> }): string[];
  /** Read harness-specific instance fields (Hermes `profile`) off the raw
   *  config. Invalid values are dropped, never passed through. */
  decodeExtra?(raw: Record<string, unknown>): Partial<AcpConfig>;
  /** A native profile that owns this instance's identity. Provider and Flux
   *  routing replace the harness home wholesale, so the core refuses a
   *  provider route for it rather than answer as someone else. */
  boundProfile?(config: AcpConfig): string | null;
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
    ctx: { model?: string; requestedModel?: string; cwd?: string },
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
    config?: AcpConfig,
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
    /** `models.currentModelId` from the same session/new or session/load
     * response, when the agent reported one. */
    currentModelId?: string;
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
  /** Per-session progress extension the engine sends while its servers
   *  connect, `{sessionId, total, connected}` (counts only, no names).
   *  `total` includes servers the engine discovered itself (plugins), so it
   *  can exceed the `mcpServers` Murage handed over. The first prompt does
   *  not wait for those: it is released once `connected` reaches the number
   *  of Murage's own mounts, or after `MCP_OWN_READY_WAIT_MS`, whichever
   *  comes first (R3, turn latency independent of external servers). */
  mcpProgressNotification?: string;
  /** Keep one engine process per thread alive between turns (upstream
   *  4b0dabc6, #1575), so a turn on a thread whose last turn finished cleanly
   *  skips the spawn, `initialize` and `authenticate`. Opt-in per harness:
   *  it is only safe for an engine whose `session/load` on a session that is
   *  already live in the process re-applies the `mcpServers` it is handed,
   *  because the harness mints fresh capability tokens for them every turn.
   *  See the pool notes inside `createAcpDriver`. */
  pooledSessions?: boolean;
}

/** Handshake budgets, overridable per box. A cold `npx`-shaped agent, a slow
 *  disk or a first run that downloads its own runtime blows the old 20s ceiling
 *  and the turn dies before the agent ever speaks; these are generous enough to
 *  cover that and still short enough that a genuinely wedged CLI surfaces as an
 *  error instead of a hang. A non-numeric or non-positive override is ignored
 *  rather than passed through as NaN, which would disarm the timeout entirely. */
const envOr = (key: string, fallback: number): number => boundedEnvMs(process.env[key], fallback);
const INIT_TIMEOUT = envOr("MURAGE_ACP_INIT_MS", 60_000);
/** How long an unanswered permission card waits before it is denied. Read
 * lazily so a fixture can shorten it; a routine run's cards never use it
 * (SendTurnInput.holdPermissionAsks). */
const permissionDenyMs = (): number => envOr("MURAGE_PERMISSION_DENY_MS", 15 * 60_000);
/** Longest the first prompt waits for `AcpSupport.mcpReadyNotification`.
 *  Past it the prompt is sent anyway (the model is told the servers are still
 *  connecting, which is the old behaviour) and a `mcp_ready_timeout`
 *  lifecycle row records that MCP was not ready. Far below the 60 s floor of
 *  the server's stall watchdog, so the wait can never read as a stall. */
export const MCP_READY_WAIT_MS = 15_000;
/** Longest the first prompt waits when the engine reports progress but not
 *  full readiness: external/plugin servers that hang or crash-loop must not
 *  hold a turn for the whole `MCP_READY_WAIT_MS`. Murage's own mounts are
 *  local stdio processes and connect well inside it. Tools load lazily
 *  (tool search), so a server that is still connecting after this is
 *  picked up by a later step. */
export const MCP_OWN_READY_WAIT_MS = 4_000;
/** Read per turn so a box (or a test) can shorten it without a reload. */
const mcpReadyWaitMs = () => envOr("MURAGE_ACP_MCP_READY_MS", MCP_READY_WAIT_MS);
/** The bound once the engine has reported progress for the session. Never
 *  longer than the full bound, so the one override shortens both. */
const mcpOwnReadyWaitMs = () => Math.min(mcpReadyWaitMs(), envOr("MURAGE_ACP_MCP_OWN_READY_MS", MCP_OWN_READY_WAIT_MS));

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
/** A hosted tool row (Fuigo `_meta.backend`) whose attempt the engine threw
 * away mid-call: no completion will come for it. Neutral words, not an error. */
const HOSTED_ROW_INTERRUPTED = "Interrupted when the reply restarted.";
/** Keep a turn's set of running tool calls in step with the agent's
 * `tool_call` / `tool_call_update` notifications: a call is running from
 * the first update that is not terminal until one that is. A `tool_call`
 * without a status is pending (ACP's default); a `tool_call_update` without
 * one leaves the call as it was. */
function trackRunningTool(running: Set<string>, update: { toolCallId?: unknown; status?: unknown }, defaultStatus?: "pending"): void {
  if (typeof update.toolCallId !== "string" || !update.toolCallId) return;
  const status = update.status ?? defaultStatus;
  if (status === "completed" || status === "failed") running.delete(update.toolCallId);
  else if (status === "pending" || status === "in_progress") running.add(update.toolCallId);
}
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
 * Off by default (0.1.61): the thread's silence watch (server/turn-watchdog.ts,
 * 20 minutes, or the room's own setting) is the one place silence is judged.
 * A three-minute guard here cut long tool calls short and ignored the owner's
 * setting. Setting the knob turns it back on for an engine that needs a
 * sooner, engine-named failure; 0 or unset leaves the watch as the only bound. */
export const acpPromptIdleTimeoutMs = (): number => {
  const raw = process.env.MURAGE_ACP_PROMPT_IDLE_MS;
  if (raw === undefined) return 0;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
};
/** Longest the guard keeps waiting on a running tool while the engine is
 * otherwise silent. A tool the engine never reports finished would hold the
 * guard off forever and the turn would hang; past this the turn ends with a
 * stall, the same way a silent engine does. Read lazily so a fixture can
 * shorten it. About ten minutes, well past a long build. */
export const acpToolMaxMs = (): number => envOr("MURAGE_ACP_TOOL_MAX_MS", 600_000);
/** Ask the OS, not Node's exit event: on Windows a process that crashed while
 * idle is gone some milliseconds before its exit reaches this event loop, and
 * a turn that adopted it then failed as closed before it finished its reply. */
function osProcessAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** What the owner reads when an engine does not answer one of Murage's
 * requests in time: the engine and the step in plain words, never the
 * JSON-RPC method. "timed out" stays in it: the Inbox groups it with other
 * passing provider trouble (server/inbox-rollup.ts). */
export function acpRequestTimeoutMessage(engine: string, method: string): string {
  const step = method === "initialize" || method === "authenticate" ? " while starting"
    : method === "session/new" || method === "session/load" ? " while opening the conversation"
    : method === "session/prompt" ? " while answering"
    : method.startsWith("session/") ? " while applying this conversation's settings"
    : "";
  return `${engine} timed out${step}.`;
}
/** A turn the engine ended itself for a reason other than finishing. */
export function acpStopReasonMessage(engine: string, reason: string | null | undefined): string {
  const why = reason === "max_tokens" ? "reached its reply length limit"
    : reason === "max_turn_requests" ? "reached its limit of steps for one turn"
    : reason === "refusal" ? "declined to continue"
    : "stopped before it finished";
  return `${engine} ${why}, so this turn ended early.`;
}
/** How long a pooled engine process may sit idle before it is closed. Read
 * lazily so a fixture can shorten it; a non-positive or non-numeric value
 * keeps the default rather than disarming the close. */
const poolIdleMs = (): number => envOr("MURAGE_ACP_POOL_IDLE_MS", 15 * 60_000);
/* The count of idle processes is the shared warm pool's business (../warm-pool.ts). */
/** OFF by default for 1.0: an ACP engine runs per turn (spawn, answer, close), as
 * before #1575. `MURAGE_ACP_POOL=1` opts in to the shared warm pool (activity window,
 * one spare, scale to zero, no spare after a background turn).
 * Why it is off: live Fuigo evidence (FUIGO-LIVE-EVIDENCE.md at the repo root) shows work
 * and self-started model turns after `end_turn`, and a parked process stays runnable, so
 * in-process work can write without any detection. Polling cannot make a parked process
 * quiescent. The guards below (tree guard, close on any parked update, cross-thread
 * fence) only narrow the opt-in path; they do not make it safe.
 * A reused process keeps the baseline its park check verified: before its next
 * prompt, a new descendant is admitted only as a verified MCP server replacement
 * (argv is one of this turn's servers, parent is the engine); anything else is a
 * leftover, and the turn closes that process and spawns fresh.
 * Even per turn, ACP turns still count toward user activity and background
 * classification. */
// Windows: the opt-in pool stays off. Its activity window and tree checks lean on
// process listing, which on Windows is a PowerShell CIM query (hundreds of ms per
// call) with no argv probe, so the pool's checks are unreliable there. Re-enable
// when the native job helper's `list` mode replaces the CIM query (the default,
// per turn, is unchanged on every OS).
let poolWin32Logged = false;
export function acpPoolingEnabled(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (env.MURAGE_ACP_POOL !== "1") return false;
  if (platform !== "win32") return true;
  if (!poolWin32Logged) {
    poolWin32Logged = true;
    console.info("[murage] MURAGE_ACP_POOL is ignored on Windows; ACP engines run per turn");
  }
  return false;
}
const poolingEnabled = (): boolean => acpPoolingEnabled();
/** Off by default for 1.0: an ACP process is only ever reused by the thread that
 * spawned it. `MURAGE_ACP_CROSS_THREAD_SPARE=1` lets another thread adopt an idle
 * spare to load its own session on it (never to open a new one). */
const crossThreadSpareEnabled = (): boolean => process.env.MURAGE_ACP_CROSS_THREAD_SPARE === "1";
/** While parked, how often the process tree is checked for new children. */
const PARKED_TREE_CHECK_MS = 5_000;
/** How long a park check waits for the turn's process-tree baseline. */
const TREE_BASELINE_WAIT_MS = 5_000;
/** The only frames a parked process may still send: pure text or usage updates
 * trailing the turn that just ended, within TRAILING_FRAME_MS of its end. Every
 * other session update or engine request while parked (a tool call, a helper's
 * report, turn_completed, a new prompt cycle Fuigo started on its own) is the
 * engine working with nobody watching, and closes it. */
const TRAILING_FRAME_UPDATES = new Set(["agent_message_chunk", "agent_thought_chunk", "usage_update", "last_turn_summary"]);
/** Title notifications real Fuigo sends after a turn: allowed at any time while parked,
 * but only as pure metadata (no tool call, no prompt, no request id). */
const METADATA_FRAME_UPDATES = new Set(["session_summary_generated", "session_info_update"]);
/** A frame that carries work (a tool call, a prompt, or a request id) is never let
 * through while parked, whatever its update type says. */
const carriesWork = (msg: any): boolean => msg.id !== undefined
  || !!msg.params?.toolCall || !!msg.params?.update?.toolCall || !!msg.params?.prompt || !!msg.params?.update?.prompt
  || !!msg.params?.update?.toolCallId || !!msg.params?.update?.prompt_id;
const isPureMetadata = (msg: any, name: unknown): boolean => typeof name === "string" && METADATA_FRAME_UPDATES.has(name) && !carriesWork(msg);
const TRAILING_FRAME_MS = 500;
/** A stable digest, so neither the spawn environment's secrets nor the
 * per-turn capability tokens in `mcpServers` are ever held as a key. */
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
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

function decodeAcpConfig(defaultCli: string, decodeExtra?: AcpSupport["decodeExtra"]) {
  return (raw: unknown): AcpConfig => {
    const o = (raw ?? {}) as Record<string, unknown>;
    return {
      cli: typeof o.cli === "string" ? o.cli : defaultCli,
      fullAuto: o.fullAuto === true,
      workspace: typeof o.workspace === "string" ? o.workspace : undefined,
      ...decodeExtra?.(o),
    };
  };
}

/**
 * ACP JSON-RPC-over-stdio driver. Harness differences (argv, auth, catalog)
 * live in `support`; this is the shared handshake and turn runtime.
 */
/** Fuigo 1.0.22+ advertises a precise retry discard at initialize. */
export function acpRetryDiscard(init: any): boolean {
  return init?.agentCapabilities?._meta?.["fuigo/capabilities"]?.retryDiscard?.version === 1;
}

export function createAcpDriver(support: AcpSupport): ProviderDriver<AcpConfig> {
  const DRIVER_KIND = support.driverKind;
  const SOURCE = support.nativeSource;
  const decodeConfig = decodeAcpConfig(support.defaultCli, support.decodeExtra);
  // Fuigo reads a bare reject_once as a Stop; this note keeps the turn going
  // without the action when nobody answered the card in time.
  const DENY_TIMEOUT_FOLLOWUP =
    "Nobody answered this permission request in time. Do not retry it or perform an equivalent action through another tool. Finish what you can without it and say what was skipped.";

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
      // The engine as Settings names this instance, for every line the chat shows.
      const ENGINE = input.displayName?.trim() || support.displayName;
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
        deleteEnvNames(env, [...PROVIDER_CREDENTIAL_ENV, ...WORKSPACE_CREDENTIAL_ENV].filter(key => !allowedCredentials.has(key)));
        // Routing switches are a third list, stripped unconditionally: a
        // `credentialEnv` allowlist grants a driver a key, never the right to
        // be pointed at someone else's endpoint, so this must not be folded
        // into the loop above. Before transformEnv so a driver that sets its
        // own routing (kimi) still wins.
        stripRoutingEnv(env);
        // Fuigo's egress guard override is never inherited: only a route whose
        // host the guard blocks sets it again (applyProviderRoute), after this.
        deleteEnvNames(env, [FUIGO_ALLOW_UPSTREAM_ENV]);
        support.transformEnv?.(env, config);
        return env;
      };
      let models = support.models;
      const refreshModels = async (options?: ModelRefreshOptions) => {
        if (!support.resolveModels) return;
        try {
          const resolved = await support.resolveModels(childEnv(), config, options);
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
        /** Fuigo only: put a message into this running turn (`_fuigo/interject`). */
        interject?: (text: string, beforeWrite?: () => void, interjectionId?: string) => Promise<SteerDelivery>;
      }
      const active = new Map<string, Turn>();
      // Fuigo has no capability flag for `_fuigo/interject`. A build that answers
      // method-not-found never gets asked again by this process.
      let interjectUnsupported = false;
      // Settlement removes a turn from `active` before its child has exited.
      // Ownership of that child lasts until close is observed (A2).
      const teardowns = new TurnTeardowns();

      /** Turn ids of intent warms: the engine starts but no turn exists, so nothing carrying one reaches a listener. */
      const prewarmTurnIds = new Set<string>();
      const emit = (event: RuntimeEvent) => {
        if (prewarmTurnIds.has((event as { turnId?: string }).turnId ?? "")) return;
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
          servers.push({ name: agents.serverName ?? "agents", command: agents.command, args: agents.args, env: acpEnv(agents.env) });
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
        for (const mount of customMountEntries(
          turn.integrations?.custom,
          (name) => name === "murage-memory" || name === memoryName || servers.some((existing) => existing.name === name),
        )) {
          servers.push({ name: mount.name, command: mount.command, args: mount.args, env: acpEnv(mount.env) });
        }
        return servers;
      };

      // ── Engine process pool (upstream 4b0dabc6, #1575) ─────────────────
      //
      // A harness with `pooledSessions` keeps the process that served a
      // thread's last turn alive, idle, for the next one, so that turn skips
      // the spawn, `initialize` and `authenticate`. Every child — pooled or
      // not — is wrapped in an `AcpProcess` whose stdout/stderr/exit
      // listeners live as long as the process; the running turn plugs its
      // handlers in as `hooks`, and between turns nothing is brokered.
      //
      // What makes reuse safe (checked in `launch`, all or nothing):
      //  - the spawn contract is unchanged: binary, full argv (model, effort,
      //    permission mode and the `--trust` folder decision all ride argv),
      //    cwd, a digest of the exact child environment and, for an engine
      //    that gates folders, the turn's whole folder-trust record;
      //  - the turn resumes exactly the native session the process holds
      //    (`resumeCursor === sessionId`) and the harness did not ask for a
      //    reset (`sessionReset`, #1562): an edit, a branch switch, a memory
      //    refresh or any rebuilt context therefore never reaches a process
      //    that remembers the abandoned branch;
      //  - the turn is not provider-routed (a routed turn's per-turn home is
      //    removed when its child closes), the harness is not Grok (its
      //    resume binding waits on the previous child's close), the instance
      //    does not bypass permissions, and the turn holds no computer or
      //    browser (see `launch`: work an engine leaves running after
      //    `end_turn` must not outlive those claims);
      //  - nothing retired the thread since: `interruptTurn` and
      //    `resetSession` bump its epoch and close any idle process.
      //
      // The capability tokens the harness puts in `mcpServers` change every
      // turn, so a reused process gets them through `session/load` on its live
      // session, which re-applies the servers (Fuigo: `load_session` on a
      // resident session sends `UpdateMcpServers`); a load it refuses falls
      // back to a fresh process in the same turn.
      //
      // KNOWN LIMIT of the opt-in pool (MURAGE_ACP_POOL=1; per-turn is the default,
      // see `poolingEnabled`): Astra P1 #3, the per-prompt process-tree rebase can absorb a
      // background child that survived into an MCP re-establish. Not fixed.
      //
      // Only a turn that ends cleanly (`end_turn` with something to show)
      // parks its process. A failure, a cancel, an interrupt, a crash or a
      // frame overflow closes it exactly as before. An idle process closes
      // after `MURAGE_ACP_POOL_IDLE_MS`, on `interruptTurn` (every Stop, bot
      // delete, stall watchdog and settings change goes through it),
      // `resetSession`, a contract change, a request it sends while idle,
      // its own exit, `stopAll` and `dispose`; and the longest-idle one closes
      // when more than `MURAGE_ACP_POOL_MAX` sit idle.
      interface AcpProcessHooks {
        line(line: string): void;
        overflow(overflow: FrameOverflow): void;
        stderr(text: string): void;
        notice(text: string): void;
        error(error: Error): void;
        close(code: number | null, signal: NodeJS.Signals | null): void;
      }
      interface AcpProcess {
        readonly child: ReturnType<typeof spawnCli>;
        /** unique per process; keys its close observation */
        readonly key: string;
        /** spawn-contract digest; null when this process may never be pooled */
        readonly contractKey: string | null;
        /** JSON-RPC ids are per process, not per turn: a late answer to a
         *  settled turn's request must never match a later turn's. */
        nextId: number;
        /** `initialize`'s answer, paid once per process */
        initResult: any;
        /** the native session live in this process, once a turn parked it */
        sessionId: string | null;
        /** digest of the `mcpServers` that session was established with */
        sessionKey: string | null;
        /** sessions the engine reported MCP-ready, recorded from the first
         *  byte of stdout, so a notification that beats its response is kept */
        readonly mcpReadySessions: Set<string>;
        /** latest `{total, connected}` the engine reported per session */
        readonly mcpProgress: Map<string, { total: number; connected: number }>;
        /** Who this process serves right now: one mutable record, rebound atomically
         *  when a turn (of any thread) adopts it. `sessionId` is the native session the
         *  owner established on it (null while it is being established); `hooks` are the
         *  running turn's handlers, null while idle. Every inbound frame is checked
         *  against it before anything logs, normalizes or brokers it. */
        owner: { threadId: string; sessionId: string | null; hooks: AcpProcessHooks | null };
        /** sessions this process served for an earlier owner: their frames are foreign */
        readonly retiredSessions: Set<string>;
        /** true once a second thread adopted it: a frame naming no session is then ambiguous */
        transferred: boolean;
        /** the process tree as the running turn's prompt went out, as identities
         *  (pid plus start time; null: none taken) */
        turnBaseline: Promise<ProcessIdentities | null> | null;
        /** the settle-time process-tree check of a parked process */
        parkCheck: Promise<void> | null;
        /** bumped on every park; an async park check answers for its own generation only */
        parkGen: number;
        /** the park generation whose settle check succeeded: only that one may be adopted */
        parkVerified: number;
        /** when it last parked (its turn's end), for the trailing-frame grace */
        parkedAt: number;
        /** why a check that answered after a turn adopted it found it unfit to keep:
         *  that turn's settle closes it instead of parking it */
        unfit: string | null;
        /** the parked process-tree sweep */
        treeTimer: ReturnType<typeof setInterval> | null;
        /** engine requests not yet answered: a process with one open never moves */
        readonly openRequests: Set<string>;
        /** helper (subagent) sessions the engine announced, by child id, with their parent */
        readonly childSessions: Map<string, string>;
        idleTimer: ReturnType<typeof setTimeout> | null;
        closing: boolean;
        dead: boolean;
        /** the close observation `stopAll`/`dispose`/`interruptTurn` wait on
         *  once no turn owns the process */
        poolTeardown: ChildTeardown | null;
      }
      /** Idle processes, by thread. A process owned by a running turn is
       *  never in here. */
      const pool = new Map<string, AcpProcess>();
      /** Close observations of processes no turn owns any more. */
      const poolTeardowns = new TurnTeardowns();
      /** Bumped by interruptTurn/resetSession: a turn that started under an
       *  older epoch never parks its process. */
      const threadEpochs = new Map<string, number>();
      /** Fuigo keeps the whole conversation, so the system stack (persona, rules,
       *  skills, tool how-to) that rides the first message of a session is
       *  already in it. Per `thread + native session`, the hash of the stack
       *  that session last accepted; an unchanged stack is not sent again. */
      const systemDelivered = new Map<string, string>();
      const epochOf = (threadId: string) => threadEpochs.get(threadId) ?? 0;
      const retireThread = (threadId: string) => threadEpochs.set(threadId, epochOf(threadId) + 1);
      let processSeq = 0;
      let disposed = false;

      const writeTo = (threadId: string, proc: AcpProcess, obj: unknown) => {
        const out = obj as { id?: unknown; method?: unknown; result?: unknown; error?: unknown } | null;
        if (out && out.id !== undefined && out.method === undefined && (out.result !== undefined || out.error !== undefined)) {
          proc.openRequests.delete(String(out.id));
        }
        try {
          proc.child.stdin.write(JSON.stringify(obj) + "\n");
        } catch {}
        appendNative(threadId, { dir: "out", source: SOURCE, msg: nativeLogMessage(obj) });
      };

      /** Remove this exact process from the driver pool, under whatever thread it is
       *  parked. True if it was there. */
      const unpool = (proc: AcpProcess): boolean => {
        let found = false;
        for (const [key, parked] of [...pool]) if (parked === proc) { pool.delete(key); found = true; }
        return found;
      };

      /** The ownership fence: a frame is the current owner's only when it names the
       *  owner's session (or, while that is still being established, any session but one
       *  this process served before). A foreign notification is dropped and a foreign
       *  request refused with an error, both logged without their content. A request
       *  that names no session on a process that has served another owner is ambiguous,
       *  and refused the same way. Engine MCP-readiness reports are bookkeeping per
       *  session id and pass. True when the frame may go on. */
      const fenceFrame = (proc: AcpProcess, msg: any): boolean => {
        if (!msg || typeof msg !== "object" || typeof msg.method !== "string") return true; // a response: matched by id
        if (msg.id === undefined && (msg.method === support.mcpReadyNotification || msg.method === support.mcpProgressNotification)) return true;
        const named = msg.params?.sessionId;
        // a helper's own session speaks for the session that started it
        const sid = typeof named === "string" && named ? proc.childSessions.get(named) ?? named : null;
        const owned = proc.owner.sessionId;
        // A process that has served more than one owner admits only frames that name
        // the current owner's (pinned) session: a sessionless one, or one naming any
        // other session, is ambiguous and refused.
        const foreign = proc.transferred
          ? !sid || !owned || sid !== owned
          : sid
            ? (owned ? sid !== owned : proc.retiredSessions.has(sid))
            : msg.id !== undefined && proc.retiredSessions.size > 0;
        // A helper announcement keeps its real owner, even an earlier one: a late
        // helper of a retired session stays mapped to that session, never adopted.
        const announced = msg.params?.update?.child_session_id;
        if (sid && typeof announced === "string" && announced && announced !== sid && !proc.childSessions.has(announced)) {
          proc.childSessions.set(announced, sid);
        }
        if (!foreign) {
          if (msg.id !== undefined) proc.openRequests.add(String(msg.id));
          return true;
        }
        const threadId = proc.owner.threadId;
        appendNative(threadId, { dir: "in", source: SOURCE, msg: { acpForeignFrame: { method: msg.method, request: msg.id !== undefined } } });
        console.info(`acp foreign frame dropped thread=${threadId} method=${msg.method} request=${msg.id !== undefined}`);
        if (msg.id !== undefined) {
          writeTo(threadId, proc, { jsonrpc: "2.0", id: msg.id, error: { code: -32002, message: "that session is not active on this connection" } });
        }
        return false;
      };

      /** Close a process nobody may use again. `keepHooks` leaves the running
       *  turn's handlers attached, so the turn still observes the exit it
       *  asked for (its stop path); otherwise the process is detached first. */
      const closeProcess = (
        threadId: string,
        proc: AcpProcess,
        why: string,
        options: { keepHooks?: boolean; observer?: Parameters<typeof killCliTree>[1] } = {},
      ) => {
        if (proc.idleTimer) clearTimeout(proc.idleTimer);
        proc.idleTimer = null;
        stopTreeSweep(proc);
        unpool(proc);
        warmPool.release(proc);
        if (!options.keepHooks) {
          proc.owner.hooks = null;
          proc.poolTeardown ??= poolTeardowns.track(threadId, proc.key, proc.child);
        }
        proc.poolTeardown?.markStopRequested();
        const first = !proc.closing;
        proc.closing = true;
        // Only a process that could have been pooled logs its close: every other
        // harness keeps exactly the native log it had.
        if (first && proc.contractKey !== null) {
          appendNative(threadId, { dir: "out", source: SOURCE, msg: { acpPool: "close", reason: why } });
          console.info(`acp close thread=${threadId} reason=${why}`);
        }
        // A turn's own stop may repeat, as it always could (an interrupt
        // before the session existed, then its settle); a pool close does not.
        if (first || options.keepHooks) killCliTree(proc.child, options.observer);
      };

      /** Wrap a freshly spawned child. Its listeners outlive any one turn. */
      const openProcess = (threadId: string, child: ReturnType<typeof spawnCli>, contractKey: string | null): AcpProcess => {
        const proc: AcpProcess = {
          child,
          key: `acp-process-${++processSeq}`,
          contractKey,
          nextId: 1,
          initResult: null,
          sessionId: null,
          sessionKey: null,
          mcpReadySessions: new Set(),
          mcpProgress: new Map(),
          owner: { threadId, sessionId: null, hooks: null },
          retiredSessions: new Set(),
          transferred: false,
          turnBaseline: null,
          parkCheck: null,
          parkGen: 0,
          parkVerified: -1,
          unfit: null,
          parkedAt: 0,
          treeTimer: null,
          openRequests: new Set(),
          childSessions: new Map(),
          idleTimer: null,
          closing: false,
          dead: false,
          poolTeardown: null,
        };
        // Byte-bounded framing (A4): the splitter decodes UTF-8 only for
        // complete lines, so multibyte characters that straddle two reads
        // stay intact, and one frame can never hold more than
        // ENGINE_FRAME_MAX_BYTES of this shared process's memory. One per
        // process, so a line cut across two turns is not lost.
        const lines = createBoundedLineSplitter({
          onLine: (line) => {
            if (!line.trim()) return;
            let msg: any;
            try { msg = JSON.parse(line); } catch { msg = null; }
            // Parked: retirement on any activity runs BEFORE the ownership filter, whichever
            // session sent the frame (a retired owner's late update, a sessionless one).
            // The fence only protects the handlers of a running turn.
            if (msg && proc.owner.hooks && !fenceFrame(proc, msg)) return;
            if (proc.owner.hooks) proc.owner.hooks.line(line); else idleLine(proc.owner.threadId, proc, line);
          },
          onOverflow: (overflow) => {
            if (proc.owner.hooks) return proc.owner.hooks.overflow(overflow);
            appendNative(proc.owner.threadId, { dir: "in", source: SOURCE, msg: { frameOverflow: overflow } });
            closeProcess(proc.owner.threadId, proc, "frame_overflow");
          },
        });
        child.stdout.on("data", (chunk: Buffer) => lines.push(chunk));
        let noticeCount = 0;
        const notices = createBoundedLineSplitter({
          maxBytes: 64 * 1024,
          onLine: (line) => {
            if (!proc.owner.hooks || proc.closing || proc.dead || noticeCount >= 3 || !line.startsWith("Fuigo: ")) return;
            noticeCount++;
            // Fuigo's one-time user notices are single lines starting exactly "Fuigo: "
            // (its log output never does). Redact the complete line before the display limit,
            // which keeps a whole memory-move notice including its folder paths.
            proc.owner.hooks.notice(redactSecretsInText(stripVTControlCharacters(line)).trim().slice(0, 1200));
          },
          onOverflow: () => {},
        });
        child.stderr.on("data", (chunk: Buffer) => {
          proc.owner.hooks?.stderr(String(chunk));
          if (SOURCE === "fuigo.acp" && noticeCount < 3) notices.push(chunk);
        });
        // Exit or error: this exact process leaves the driver pool and the shared warm
        // pool, whichever thread it serves now.
        child.on("error", (error) => {
          proc.dead = true;
          if ([...pool.values()].includes(proc)) closeProcess(proc.owner.threadId, proc, "error");
          warmPool.release(proc);
          proc.owner.hooks?.error(error);
        });
        child.on("close", (code, signal) => {
          proc.dead = true;
          notices.close();
          if (proc.idleTimer) clearTimeout(proc.idleTimer);
          proc.idleTimer = null;
          stopTreeSweep(proc);
          if (unpool(proc)) appendNative(proc.owner.threadId, { dir: "in", source: SOURCE, msg: { acpPool: "exited", code, signal } });
          warmPool.release(proc);
          proc.owner.hooks?.close(code, signal);
        });
        return proc;
      };

      /** Output of a process no turn owns. Notifications are only recorded;
       *  a request means the engine is acting with nobody to answer it, so it
       *  is answered (never left blocking) and the process is retired. */
      const idleLine = (threadId: string, proc: AcpProcess, line: string) => {
        if (!line.trim()) return;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        appendNative(threadId, { dir: "in", source: SOURCE, msg: nativeLogMessage(msg) });
        if (msg.id !== undefined && msg.method) {
          // answered (never left blocking), never handed to a handler
          writeTo(threadId, proc, msg.method === "session/request_permission"
            ? { jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "cancelled" } } }
            : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no turn is running" } });
          closeProcess(threadId, proc, `post-turn-activity frame=${String(msg.method).slice(0, 64)}`);
          return;
        }
        // The turn is over: any session update now (a tool call, a helper's report,
        // turn_completed, a new prompt cycle) is the engine acting with nobody
        // watching, after its folder lease is gone. It is closed at once, its whole
        // tree, and never adopted. Only pure text/usage trailing the turn's end by
        // under TRAILING_FRAME_MS is let through.
        const idleUpdate = msg.params?.update?.sessionUpdate;
        const isUpdate = msg.method === "session/update" || typeof idleUpdate === "string";
        if (msg.method && isUpdate) {
          const trailing = (typeof idleUpdate === "string" && TRAILING_FRAME_UPDATES.has(idleUpdate) && Date.now() - proc.parkedAt < TRAILING_FRAME_MS && !carriesWork(msg))
            || isPureMetadata(msg, typeof idleUpdate === "string" ? idleUpdate : msg.method);
          if (!trailing) {
            const frame = String(typeof idleUpdate === "string" ? idleUpdate : msg.method).slice(0, 64);
            closeProcess(threadId, proc, `post-turn-activity frame=${frame}`);
            return;
          }
        }
        if (support.mcpReadyNotification && msg.method === support.mcpReadyNotification) {
          const readyId = msg.params?.sessionId;
          if (typeof readyId === "string" && readyId) proc.mcpReadySessions.add(readyId);
        }
        if (support.mcpProgressNotification && msg.method === support.mcpProgressNotification) recordMcpProgress(proc, msg.params);
      };

      /** Keep the engine's latest connect counts for a session. */
      const recordMcpProgress = (proc: AcpProcess, params: any) => {
        const id = params?.sessionId;
        const total = Number(params?.total), connected = Number(params?.connected);
        if (typeof id !== "string" || !id || !Number.isFinite(total) || !Number.isFinite(connected)) return;
        proc.mcpProgress.set(id, { total, connected });
      };

      const stopTreeSweep = (proc: AcpProcess) => {
        if (proc.treeTimer) clearInterval(proc.treeTimer);
        proc.treeTimer = null;
      };
      /** Still parked and untouched: nobody adopted or closed it meanwhile. */
      const stillParked = (proc: AcpProcess) => !proc.closing && !proc.dead && proc.owner.hooks === null && [...pool.values()].includes(proc);
      /** The process-tree guard of a parked process. A child beyond the turn's
       *  baseline (a shell a tool left running) closes it and its whole tree; a
       *  probe that cannot answer means it is not proven idle, and it closes too. */
      const guardParkedTree = (threadId: string, proc: AcpProcess) => {
        const pid = proc.child.pid;
        const pending = proc.turnBaseline;
        const gen = proc.parkGen;
        if (!pid || !pending) { closeProcess(threadId, proc, "process probe has no baseline"); return; }
        const check = (async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const baseline = await Promise.race([
            pending,
            new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), TREE_BASELINE_WAIT_MS); }),
          ]).finally(() => clearTimeout(timer));
          const verdict = async (): Promise<string | null> => {
            if (!baseline) return "process probe has no baseline";
            const tree = await untrackedIdentified(pid, baseline);
            if (!tree) return "process probe unavailable";
            return tree.fresh.size ? "post-turn-descendant" : null;
          };
          const first = await verdict().catch(() => "process probe failed");
          // a later park of the same process owns its own check; this answer is stale
          if (proc.parkGen !== gen) return;
          if (!stillParked(proc)) {
            // Adopted before the answer came (a send right after the settle): the
            // turn runs, and its settle closes the process rather than keep it.
            if (first && !proc.closing && !proc.dead) proc.unfit = first;
            return;
          }
          if (first) { closeProcess(proc.owner.threadId, proc, first); return; }
          proc.parkVerified = gen;
          stopTreeSweep(proc);
          proc.treeTimer = setInterval(() => {
            void verdict().catch(() => "process probe failed").then((why) => {
              if (why && stillParked(proc)) closeProcess(proc.owner.threadId, proc, why);
            });
          }, PARKED_TREE_CHECK_MS);
          proc.treeTimer.unref?.();
        })().catch(() => { if (stillParked(proc)) closeProcess(proc.owner.threadId, proc, "process probe failed"); })
          .finally(() => { if (proc.parkCheck === check) proc.parkCheck = null; });
        proc.parkCheck = check;
      };

      /** A reused process's tree against the baseline its park check verified.
       *  A new pid is admitted only as a verified MCP server replacement: its
       *  parent is the engine, and its argv is exactly one of the servers this
       *  turn hands over (command plus args). Anything else is a leftover (a
       *  child that started after the park check). A probe that cannot answer
       *  admits nothing and reports why. The returned baseline holds only
       *  identities (pid plus start time) this listing confirmed alive, plus the
       *  admitted replacements: an exited MCP server's pid is dropped, so a
       *  process that later gets that pid is never exempt. */
      const reconcileReusedTree = async (proc: AcpProcess, servers: ReadonlyArray<{ command: string; args: string[] }>): Promise<{ baseline: ProcessIdentities; leftover: string | null }> => {
        const pid = proc.child.pid;
        const verified = proc.turnBaseline ? await proc.turnBaseline.catch(() => null) : null;
        if (!pid || !verified) return { baseline: new Map(), leftover: "process probe has no baseline" };
        const tree = await untrackedIdentified(pid, verified).catch(() => null);
        if (!tree) return { baseline: new Map(), leftover: "process probe unavailable" };
        const baseline: ProcessIdentities = new Map(tree.alive);
        if (!tree.fresh.size) return { baseline, leftover: null };
        const seen = await processParentsAndArgs(tree.fresh.keys()).catch(() => null);
        if (!seen) return { baseline: new Map(), leftover: "process probe unavailable" };
        // ps gives only the joined command line, never the argv array, so
        // this is an exact match of the space-joined string: argv that differ
        // only in how spaces split them (["a b"] against ["a", "b"]) compare
        // equal. The other checks (parent is the engine, started after the
        // park check as this same process) still apply.
        const wanted = new Set(servers.map((server) => [server.command, ...server.args].join(" ")));
        let leftover: string | null = null;
        for (const [child, start] of tree.fresh) {
          const entry = seen.get(child);
          if (!entry) continue; // the OS confirmed it exited since the listing
          // the same process the listing saw (a known start that still matches)
          const same = start !== "" && entry.start === start;
          if (same && entry.ppid === pid && wanted.has(entry.args)) baseline.set(child, start);
          else leftover = "pre-prompt-leftover";
        }
        return { baseline, leftover };
      };

      /** Hand a still-healthy process back to the pool for this thread. */
      const parkProcess = (threadId: string, proc: AcpProcess, sessionId: string, hold = false) => {
        // the next intent warm resumes this conversation
        lastTurns.patch(threadId, { resumeCursor: sessionId, sessionReset: false });
        proc.owner.hooks = null;
        proc.parkedAt = Date.now();
        proc.parkGen += 1;
        proc.sessionId = sessionId;
        proc.owner.sessionId = sessionId;
        proc.poolTeardown ??= poolTeardowns.track(threadId, proc.key, proc.child);
        const previous = pool.get(threadId);
        if (previous && previous !== proc) closeProcess(threadId, previous, "replaced");
        pool.set(threadId, proc);
        // The shared warm pool keeps at most one idle spare for this engine
        // kind (and none past the activity window or after a background turn).
        void warmPool.markIdle(proc, {
          engine: "acp", threadId, pid: () => proc.child.pid, spawnedAt: spawnedAtOf(proc.child),
          background: backgroundThreads.has(threadId), hold,
          // adopted by a turn (or replaced): not idle, whatever the shared pool holds
          busy: () => pool.get(threadId) !== proc || proc.owner.hooks !== null,
          close: (reason) => closeProcess(threadId, proc, reason),
        });
        if (proc.idleTimer) clearTimeout(proc.idleTimer);
        proc.idleTimer = setTimeout(() => closeProcess(threadId, proc, "idle"), poolIdleMs());
        proc.idleTimer.unref?.();
        appendNative(threadId, { dir: "out", source: SOURCE, msg: { acpPool: "park" } });
        // An intent warm sends no prompt: its tree as it parks is its baseline.
        if (hold || !proc.turnBaseline) proc.turnBaseline = proc.child.pid ? descendantIdentities(proc.child.pid).catch(() => null) : Promise.resolve(null);
        guardParkedTree(threadId, proc);
      };

      /** Close the idle process of one thread (none is fine). */
      const closeIdle = (threadId: string, why: string) => {
        const idle = pool.get(threadId);
        if (idle) closeProcess(threadId, idle, why);
      };

      const backgroundThreads = new Set<string>();
      /** The spawn inputs of each thread's last user turn, memory only (never written to
       * disk): what an intent warm starts the next engine from. */
      const lastTurns = createTurnMemory<SendTurnInput>();
      const prewarming = createPrewarmGate();
      /** The process each in-flight prewarm owns right now (read live from the turn, so a
       *  replacement is followed), for a takeover to end through its owned process tree. */
      const prewarmChildren = new Map<string, () => ReturnType<typeof spawnCli> | null>();
      const sendTurn = async (turn: SendTurnInput) => {
        const { threadId } = turn;
        if (!turn.prewarm) {
          if (turn.background) backgroundThreads.add(threadId); else backgroundThreads.delete(threadId);
          if (!turn.background) { warmPool.noteUserActivity(); warmPool.sent(threadId); lastTurns.remember(threadId, spawnInputsOf(turn)); }
          // An intent warm is still starting this thread's engine: take it over, never fail as busy.
          if (prewarming.has(threadId) && !(await prewarming.wait(threadId))) {
            // cancel it, wait for its slot, end the process it owns if it will not go: all
            // within one hard bound, after which this send fails clearly (never "already running")
            const freed = await prewarming.takeOver(threadId, {
              stop: () => active.get(threadId)?.stop("unspecified"),
              child: () => prewarmChildren.get(threadId)?.(),
              slotBusy: () => active.has(threadId),
            });
            if (!freed) {
              console.warn(`acp prewarm takeover thread=${threadId} failed=true reason=prewarm did not stop within bound`);
              throw new Error(TAKEOVER_FAILED_MESSAGE);
            }
          }
        }
        // Murage's Full access still stops before deleting outside its
        // folder, paying and messaging someone new (server/stop-line.ts). That
        // holds only if the engine asks, so under it a fullAuto instance runs
        // this turn as a normal one (argv, session mode, permission replies)
        // and Murage answers every ask that is not one of the three at once.
        const turnConfig: AcpConfig = (turn.stopLine || turn.routeAsks) && config.fullAuto ? { ...config, fullAuto: false } : config;
        if (active.has(threadId)) throw new Error("a turn is already running on this thread");
        if (support.driverKind === "grokAgent") {
          const closed = await teardowns.wait(threadId, undefined, acpStopBudget());
          if (!closed.closeConfirmed) throw new ProviderStopUnconfirmedError(DRIVER_KIND, closed);
          if (active.has(threadId)) throw new Error("a turn is already running on this thread");
        }
        const controlsHost = turn.integrations?.localComputer?.scope === "local-computer";
        if (controlsHost && turnConfig.fullAuto) {
          throw new Error("local computer control requires interactive provider approvals");
        }
        const turnId = newId();
        if (turn.prewarm) prewarmTurnIds.add(turnId);
        /** The warm is over: waiting sends may go. The turn id stays silenced until the final
         * event of the warm has been dropped (`forgetPrewarm`). */
        const endPrewarm = () => { if (turn.prewarm) { prewarmChildren.delete(threadId); prewarming.end(threadId); } };
        const forgetPrewarm = () => { if (turn.prewarm) prewarmTurnIds.delete(turnId); };
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
          endPrewarm(); forgetPrewarm();
          return { turnId };
        }
        if (turn.providerRoute) validateProviderTurnRoute(support.driverKind, turn.providerRoute);
        const providerBinding = turn.providerRoute ? applyProviderRoute(support.driverKind, env, turn.providerRoute, { threadId, memoryTools: Boolean(turn.integrations?.memory), nativeProfile: support.boundProfile?.(config) ?? null }) : null;
        const grokBinding = support.driverKind === "grokAgent" ? grokResumeBinding(threadId, providerBinding?.identity ?? null, turn.resumeCursor) : null;
        if (grokBinding?.replay && !turn.transcript) throw new Error("Grok provider binding changed. Reload the conversation before continuing.");
        const replayTurn = (preamble: string) => ({ ...turn, text: [preamble, "",
          renderDriverReplay(turn.transcript ?? [], turn.replayMetadata), "", "[Latest message:]", turn.text].join("\n") });
        const replayGrokTurn = () => replayTurn("[The provider session binding changed. Continue from this authorised conversation history:]");
        let promptTurn = grokBinding?.replay ? replayGrokTurn() : turn;
        const resolvedModel = providerBinding?.model ?? support.resolveTurnModel?.(turn.model, env, config);
        if (!providerBinding) support.applyTurnEnv?.(env, { model: resolvedModel, requestedModel: turn.model, cwd });
        const cliTurn =
          resolvedModel !== undefined && resolvedModel !== turn.model
            ? { ...turn, model: resolvedModel }
            : turn;
        const ownedMemoryAlias = support.driverKind === "fuigoAgent" && turn.integrations?.memory && !providerBinding
          ? newFuigoMemoryAlias() : null;
        const mcpServers = support.ownTools ? [] : acpMcpServers(turn, ownedMemoryAlias ?? "murage-memory");
        const toolSurface = support.driverKind === "fuigoAgent" || support.driverKind === "grokAgent" ? FUIGO_TOOL_SURFACE : NEUTRAL_TOOL_SURFACE;
        const mounts = { servers: mcpServers.map(server => server.name), agents: mcpServers.find(server => turn.integrations?.agents && server.command === turn.integrations.agents.command && server.args === turn.integrations.agents.args)?.name,
          memory: mcpServers.find(server => turn.integrations?.memory && server.command === turn.integrations.memory.command && server.args === turn.integrations.memory.args)?.name,
          browser: mcpServers.find(server => turn.integrations?.browser && server.command === turn.integrations.browser.command && server.args === turn.integrations.browser.args)?.name };
        turn = renderMurageTurn(turn, toolSurface, mounts, ownedMemoryAlias ? "murage-memory" : undefined);
        promptTurn = renderMurageTurn(promptTurn, toolSurface, mounts, ownedMemoryAlias ? "murage-memory" : undefined);

        // A pooled candidate is unavailable until its park check has succeeded: wait
        // for every pending settle check (bounded by TREE_BASELINE_WAIT_MS plus one
        // probe) BEFORE any handler is attached. A failed or stale check leaves it
        // unverified, so adoption rejects and closes it.
        if (poolingEnabled()) {
          const pendingChecks = [...pool.values()].map((p) => p.parkCheck).filter((c): c is Promise<void> => c !== null);
          if (pendingChecks.length) {
            await Promise.all(pendingChecks);
            if (active.has(threadId)) throw new Error("a turn is already running on this thread");
          }
        }

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
        // The process this turn is using (see the pool notes above), whether
        // it adopted it from the pool (`reused`), and the thread epoch it
        // started under. `poolable` and `contractKey` are settled in launch().
        let proc: AcpProcess | null = null;
        let reused = false;
        let poolable = false;
        let contractKey: string | null = null;
        const startEpoch = epochOf(threadId);
        // `producedItem`: the turn emitted something a person can see (a reply,
        // an image, a tool result). An end_turn without one is a lost turn.
        const state = { settled: false, finished: false, failed: false, promptSent: false, cancelRequested: false, text: "", producedItem: false };
        // Existing 256 KiB diagnostic cap, preserving the start before any
        // redaction. Never keep a second raw tail that can lose a PEM header.
        let stderrDiagnostic = "", stderrDiagnosticTruncated = false;
        const STDERR_DIAGNOSTIC_CHARS = 256 * 1024;
        const asks = new Map<string, AcpAskFinish>();
        // Tool calls the agent started and has not yet reported finished. A
        // tool such as `sleep` or a quiet build sends nothing while it runs,
        // so the prompt's silence guard waits for these as it does for asks.
        const runningTools = new Set<string>();
        // A tool_call_update need not repeat the call's title, and whether an
        // image in its output is a deliverable or one of Murage's own screen
        // frames turns on the tool's name. Kept from the opening tool_call and
        // dropped when the terminal update consumes it. Two names, because the
        // chip's is a display string and retention cannot be decided on it.
        const toolNames = new Map<string, { label: string; identity?: string }>();
        let sessionId: string | null = null;
        // Interjections sent to this turn that the engine has not echoed yet.
        const interjectionsPending = new Set<string>();
        // Echo waiters of interjections still deciding delivery (P2), and ids
        // that got neither a response nor an echo in time. Those are
        // uncertain, never resent: a later echo confirms one (steer.confirmed).
        const interjectionEchoes = new Map<string, () => void>();
        const interjectionsUncertain = new Set<string>();
        // An interjection Fuigo accepted can miss the turn's final drain and run
        // as its own `interject-fallback-` turn after the prompt result. Murage
        // keeps its turn open through that turn so the reply lands in it.
        const fallback = {
          accepted: false,
          holding: false,
          running: null as string | null,
          /** a queued `interject-fallback-` prompt not yet running */
          queued: false,
          /** helpers already open when the first steer was accepted; anything opened
           * after that belongs to the follow-up. Any wake still owed after an accepted
           * steer counts as unfinished follow-up work (a wake can't be attributed). */
          helpersAtAccept: null as Set<string> | null,
          grace: undefined as ReturnType<typeof setTimeout> | undefined,
          cap: undefined as ReturnType<typeof setTimeout> | undefined,
        };
        const markAccepted = () => {
          if (!fallback.helpersAtAccept) fallback.helpersAtAccept = new Set(helpers.open);
          fallback.accepted = true;
        };
        let promptStartedAt: number | null = null;
        // Sessions the engine has reported MCP-ready live on the process
        // (`proc.mcpReadySessions`), recorded from the first byte of its
        // stdout, so a notification that arrives BEFORE the session/new
        // response is kept, not lost.
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
          if (proc) return writeTo(threadId, proc, obj);
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
          toolStallMessage?: string,
        ) =>
          new Promise<any>((resolveRpc, rejectRpc) => {
            // MURAGE_TURN_TRACE: time every engine round trip; a no-op when off.
            const rpcTrace = turnTrace(threadId);
            const rpcDone = rpcTrace.enabled ? rpcTrace.span(`rpc.${method}`) : null;
            const resolve = rpcDone ? (value: any) => { rpcDone("ok"); resolveRpc(value); } : resolveRpc;
            const reject = rpcDone ? (error?: unknown) => { rpcDone(error instanceof Error && /timed out|did not respond/i.test(error.message) ? "timeout" : "error"); rejectRpc(error); } : rejectRpc;
            if (!proc) return reject(new Error(`${ENGINE} was not running.`));
            const id = proc.nextId++;
            let timer: ReturnType<typeof setTimeout> | null = null;
            if (timeoutMs) {
              timer = setTimeout(() => {
                rpcPending.delete(id);
                reject(new Error(acpRequestTimeoutMessage(ENGINE, method)));
              }, timeoutMs);
              timer.unref?.();
            }
            let idleTimer: ReturnType<typeof setTimeout> | null = null;
            // Silence spent waiting on a running tool; traffic resets it.
            let toolWaitedMs = 0;
            const armIdle = (waiting = false) => {
              if (!(idleMs && idleMs > 0)) return;
              if (!waiting) toolWaitedMs = 0;
              if (idleTimer) clearTimeout(idleTimer);
              idleTimer = setTimeout(() => {
                // Waiting on a person is not an unresponsive agent: an open
                // permission or question card holds the engine, so restart
                // instead of failing the turn under someone's cursor. The
                // same for a tool the agent is running: a quiet build or
                // `sleep` sends nothing until it ends.
                if (asks.size || runningTools.size) {
                  // An open card waits on a person for as long as it takes; a
                  // tool is bounded, so a tool never reported finished ends
                  // the turn instead of holding it forever.
                  if (!asks.size) toolWaitedMs += idleMs;
                  else toolWaitedMs = 0;
                  if (asks.size || toolWaitedMs < acpToolMaxMs()) { armIdle(true); return; }
                }
                rpcPending.delete(id);
                const toolCapped = !asks.size && runningTools.size > 0;
                const error = new Error((toolCapped ? toolStallMessage : undefined) ?? idleMessage ?? `${method} stopped responding`);
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
          // A process a turn stops is never pooled again; its hooks stay so
          // this turn still observes the exit it asked for.
          if (proc) closeProcess(threadId, proc, reason, { keepHooks: true, observer: lifecycle.observeStopRoute });
          else if (child) killCliTree(child, lifecycle.observeStopRoute);
        };

        // MURAGE_TURN_TRACE: tool round trips and permission waits (no-ops when off).
        const traceSpans = new Map<string, (outcome?: string) => void>();
        const traceOpen = (phase: string, key: unknown) => {
          const t = turnTrace(threadId);
          if (t.enabled && typeof key === "string") traceSpans.set(`${phase}:${key}`, t.span(phase));
        };
        const traceClose = (phase: string, key: unknown, outcome: unknown) => {
          const done = typeof key === "string" ? traceSpans.get(`${phase}:${key}`) : undefined;
          if (!done) return;
          traceSpans.delete(`${phase}:${key}`);
          done(String(outcome));
        };
        const traceToolOpen = (id: unknown) => traceOpen("tool.roundtrip", id);
        const traceToolClose = (id: unknown, status: unknown) => traceClose("tool.roundtrip", id, status);

        /** Streamed text and reasoning since the last committed item, tagged
         * for an exact retry discard (Fuigo retryDiscard). `epoch` counts
         * response boundaries and discards. `done` marks a segment whose
         * response has completed (response_completed): no discard can reach it. */
        type StreamSeg = { kind: "text" | "reasoning"; epoch: number; startMs: number | undefined; text: string; done?: boolean;
          /** The call id of a hosted tool row of the same, still open response
           * that came after this text: when the text is committed it closes an
           * item here, saved before that row (`beforeItemId`). */
          cut?: string };
        const streamSegs: StreamSeg[] = [];
        let streamEpoch = 0;
        let retryDiscard = false;
        /** Hosted (backend) tool rows still running, by call id, with the
         * streamStartMs of the attempt that started them and the response
         * epoch they started in. A discard of that attempt closes them as
         * interrupted; they are never dropped. The epoch is what a discard
         * without streamStartMs matches, so an attempt that streamed only a
         * row (no text to identify it) is still reached. */
        const hostedRows = new Map<string, { startMs: number; epoch: number }>();
        const interruptedRows = new Set<string>();
        /** The next text chunk follows a deferred tool row: show a paragraph
         * break in the live bubble (the committed items are split there). */
        let liveBreak = false;
        const dropTextSegs = () => { for (let i = streamSegs.length - 1; i >= 0; i--) if (streamSegs[i].kind === "text") streamSegs.splice(i, 1); };

        /** Emit buffered assistant text as its own item, then clear it. Text a
         * hosted tool row interrupted (`cut`) closes one item per part. */
        const flushAssistantText = () => {
          const text = state.text;
          state.text = "";
          liveBreak = false;
          const texts = streamSegs.filter(seg => seg.kind === "text");
          dropTextSegs();
          if (!text.trim()) return;
          const parts: Array<{ text: string; before?: string }> = [];
          if (texts.some(seg => seg.cut) && texts.map(seg => seg.text).join("") === text) {
            let part = "";
            for (const seg of texts) { part += seg.text; if (seg.cut) { parts.push({ text: part, before: seg.cut }); part = ""; } }
            parts.push({ text: part });
          } else parts.push({ text });
          // Committing a text item clears both renderer streams, so the reasoning
          // shown before it is retired too: a later discard must never bring it back.
          for (let i = streamSegs.length - 1; i >= 0; i--) if (streamSegs[i].kind === "reasoning") streamSegs.splice(i, 1);
          state.producedItem = true;
          // A part a hosted row cut is saved before that row, so the transcript
          // reads text, row, text in the order it streamed.
          for (const part of parts) if (part.text.trim()) emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text: part.text, ...(part.before ? { beforeItemId: part.before } : {}) });
        };
        /** Fuigo retryDiscard: text is provisional until its response
         * completes. A tool row the same open response streams (a hosted tool:
         * web_search, x_search, code_interpreter) does not commit it, because a
         * discard of that attempt must still be able to take it back; the row
         * shows at once and the text is committed when the response completes,
         * saved before the row. Only a hosted row (`_meta.backend`) tagged with
         * its streamStartMs defers; a client-executed row commits the text first,
         * as it always did. Returns true when the text was kept provisional. */
        const deferAtToolRow = (startMs: unknown, backend: boolean, callId: unknown) => {
          if (!retryDiscard || !backend || typeof startMs !== "number" || typeof callId !== "string") return false;
          const texts = streamSegs.filter(seg => seg.kind === "text");
          const last = texts[texts.length - 1];
          if (!last || last.done || last.startMs !== startMs || !state.text.trim()) return false;
          // a second row right after the first: the text still reads before the first
          if (last.cut) return true;
          last.cut = callId;
          liveBreak = true;
          return true;
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

        // Sub agents the engine runs for this turn (Fuigo: SubagentSpawned,
        // SubagentProgress and SubagentFinished on `_fuigo/session_notification`).
        // The prompt result is not the end of the turn while any still runs:
        // the turn is held open so their asks take the normal approval path.
        const helpers = { tracker: new SubtaskTracker(), open: new Set<string>(), holding: false, wakePending: false, cap: undefined as ReturnType<typeof setTimeout> | undefined };
        const emitSubtask = (subtask: ReturnType<SubtaskTracker["end"]>) => {
          if (subtask) emit({ ...base(threadId, turnId), type: "turn.subtask", subtask, subtasks: helpers.tracker.snapshot() });
        };
        let settledUsage: { input: number; output: number; cachedInput?: number } | undefined;
        let settledCharge: number | undefined;
        const settle = (
          ok: boolean,
          stopReason: string | null,
          cause: LifecycleStopReason = ok ? "turn_complete" : "turn_failure",
        ) => {
          if (state.settled) return;
          state.settled = true;
          endTurnTrace(threadId, ok ? (stopReason ?? "ok") : "failed");
          state.finished = ok && stopReason === null;
          state.failed = !ok;
          lifecycle.record("turn_settled", {
            reason: cause,
            settled: true,
            cancelRequested: state.cancelRequested,
            promptSent: state.promptSent,
          });
          if (!ok) { persistEngineStderr(stopReason); providerBinding?.keepLogs(turnId); }
          if (helpers.cap) clearTimeout(helpers.cap);
          if (fallback.grace) clearTimeout(fallback.grace);
          if (fallback.cap) clearTimeout(fallback.cap);
          for (const subtask of helpers.tracker.endAll(false)) emitSubtask(subtask);
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
          endPrewarm();
          // Only a clean finish parks the process (see the pool notes). It is
          // parked BEFORE the final events, so a listener that starts the next
          // turn at once finds it, and so the turn's teardown is already
          // released when the harness asks for it.
          // An interjection still unechoed may yet run as its own fallback turn
          // on this process; parking it would leak that turn into the next one.
          // An uncertain one may still arrive, so that process is never reused either.
          const park = proc !== null && poolable && ok && stopReason === null && !state.cancelRequested && proc.unfit === null
            && interjectionsPending.size === 0 && interjectionsUncertain.size === 0
            && fallback.running === null && !fallback.queued
            && sessionId !== null && !proc.dead && !proc.closing
            && proc.child.exitCode === null && proc.child.signalCode === null
            && !disposed && epochOf(threadId) === startEpoch;
          if (proc && proc.unfit && !proc.closing) {
            console.info(`acp close thread=${threadId} reason=${proc.unfit}`);
            appendNative(threadId, { dir: "out", source: SOURCE, msg: { acpPool: "close", reason: proc.unfit } });
          }
          if (park) {
            teardown?.detach();
            parkProcess(threadId, proc!, sessionId!, turn.prewarm === true);
          }
          flushAssistantText();
          emit({ ...base(threadId, turnId), type: "turn.completed", ok, stopReason, cost: null, ...(settledUsage ? { usage: settledUsage } : {}), ...(settledCharge !== undefined ? { charge: settledCharge } : {}) });
          if (!park) stop(cause); // the agent process does not exit on its own
          forgetPrewarm();
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
              message: `${ENGINE} asked a question Murage could not show (${normalized.error}); it was told nobody answered`,
            });
            return send({ jsonrpc: "2.0", id: msg.id, result: cancelled });
          }
          flushAssistantText();
          const questions: QuestionSpec[] = normalized.questions;
          const requestId = newId();
          const finish: AcpAskFinish = (behavior, source = "user", answers) => {
            if (!asks.delete(requestId)) return;
            traceClose("permission.wait", requestId, behavior);
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
          const timer = turn.holdProjectAsks ? undefined : setTimeout(() => finish("deny", "timeout"), QUESTION_TIMEOUT_MS);
          timer?.unref?.();
          traceOpen("permission.wait", requestId);
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
            traceClose("permission.wait", requestId, behavior);
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
          const timer = turn.holdProjectAsks ? undefined : setTimeout(() => finish("deny", "timeout"), QUESTION_TIMEOUT_MS);
          timer?.unref?.();
          traceOpen("permission.wait", requestId);
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
              message: `${ENGINE} offered no way to ${want === "allow" ? "allow" : "decline"} this request, so Murage cancelled it instead of guessing.`,
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
          if (ownedMemoryAlias && !turnConfig.fullAuto && !questionTool && state.promptSent &&
            sessionId && params.sessionId === sessionId && !state.settled && !state.cancelRequested &&
            Array.from(rpcPending.values()).some(pending => pending.method === "session/prompt")) {
            const allow = fuigoMemoryAllowOnce(toolCall, options, ownedMemoryAlias);
            if (allow) return send({ jsonrpc: "2.0", id: msg.id,
              result: { outcome: { outcome: "selected", optionId: allow } } });
          }
          if (turnConfig.fullAuto && !questionTool) {
            const allow = optionFor("allow", true);
            if (!allow) missing("allow");
            return send({
              jsonrpc: "2.0",
              id: msg.id,
              result: allow ? { outcome: { outcome: "selected", optionId: allow } } : cancelled,
            });
          }
          const tool = questionTool ?? (kind === "execute" ? "shell" : kind === "edit" ? "edit" : kind || "tool");
          // The headline is the real target: the command (an argv array is
          // joined with shell quoting) or, for a file edit, delete or move,
          // the paths the engine names. The tool's title is model-composed
          // text, so it only stands in when there is no structured target.
          const commandLine = commandText(toolCall.rawInput?.command);
          const editPaths = !commandLine && (kind === "edit" || kind === "delete" || kind === "move") ? acpToolFilePaths(toolCall) : undefined;
          const summary = approvalSummary(commandLine ?? (editPaths ? editPaths.join(", ") : String(toolCall.title ?? tool)));
          // The model's title is only a label when the engine named the real
          // target (paths); keep it, marked as the model's, so a move's
          // destination named only in the title is not lost.
          const titleText = typeof toolCall.title === "string" && toolCall.title.trim() ? toolCall.title : undefined;
          const reason = editPaths && titleText && titleText !== summary ? approvalSummary(titleText) : undefined;
          // A tool with no command and no paths (fetch, other, MCP): its arguments.
          const toolInput = !commandLine && !editPaths ? boundedToolInput(toolCall.rawInput) : undefined;
          const computerAsk = controlsHost && acpAskControlsComputer(toolCall);
          const requestId = newId();
          const finish: AcpAskFinish = (behavior, source = "user") => {
            if (!asks.delete(requestId)) return;
            traceClose("permission.wait", requestId, behavior);
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
                ...(support.driverKind === "fuigoAgent" && !turnConfig.fullAuto && !questionTool &&
                  behavior === "deny" && (source === "user" || source === "timeout") &&
                  options.some(option => option.optionId === optionId && option.kind === "reject_once")
                  ? { _meta: { followup_message: source === "timeout" ? DENY_TIMEOUT_FOLLOWUP : "The user denied this operation. Do not retry it, bypass the denial, or perform an equivalent action through another tool. Keep the operation unexecuted and explain the limitation and any safe alternatives without taking further action." } }
                  : {}),
              } : cancelled,
            });
            emit({
              ...base(threadId, turnId),
              type: "request.resolved",
              requestId,
              behavior: optionId && behavior === "allow" ? "allow" : "deny",
              source: optionId ? source : "system",
              approvalScope: computerAsk ? "local-computer" : undefined,
            });
            return Boolean(optionId);
          };
          // An unanswered card denies after 15 minutes. That is the owner not
          // answering, not an engine failure, so it raises no runtime error
          // (whose card sends people to Provider settings); request.resolved
          // with source "timeout" is the record. A routine run holds its
          // cards open instead (SendTurnInput.holdPermissionAsks).
          const timer = turn.holdPermissionAsks ? undefined : setTimeout(() => {
            finish("deny", "timeout");
          }, permissionDenyMs());
          timer?.unref?.();
          traceOpen("permission.wait", requestId);
          asks.set(requestId, finish);
          emit({
            ...base(threadId, turnId),
            type: "request.opened",
            requestId,
            requestType: "permission",
            tool,
            summary,
            ...(reason ? { reason } : {}),
            ...(toolInput ? { toolInput } : {}),
            approvalScope: computerAsk ? "local-computer" : undefined,
            ...(questionTool ? { questionTool: true as const } : {}),
            // The engine's structured kind and stamped identity (the Chief's
            // proposal turn allows its one tool by these, never by a title).
            ...(kind ? { toolKind: kind } : {}),
            ...(() => {
              const stamp = toolCall._meta?.["fuigo/tool"];
              return stamp && stamp.version === 1 && typeof stamp.namespace === "string" && typeof stamp.name === "string"
                ? { toolIdentity: { namespace: stamp.namespace, name: stamp.name, ...(typeof stamp.kind === "string" ? { kind: stamp.kind } : {}) } } : {};
            })(),
            // Structured, off the wire — never parsed back out of `summary`,
            // which is composed from what the model wrote.
            ...(() => { const filePaths = acpToolFilePaths(toolCall); return filePaths ? { filePaths } : {}; })(),
            // The engine's own call, for the stop line: a command, a delete
            // with the places it names, or a tool by its title and arguments.
            ...(questionTool ? {} : { toolCall: {
              name: kind === "execute" ? "shell" : kind === "delete" ? "delete" : title || kind || "tool",
              input: kind === "delete"
                ? { ...(toolCall.rawInput && typeof toolCall.rawInput === "object" ? toolCall.rawInput : {}), ...(Array.isArray(toolCall.locations) ? { locations: toolCall.locations } : {}) }
                : toolCall.rawInput,
            } }),
          });
        };

        /** Settle a held turn once its helpers are done (and the reply they
         * woke the engine for, if it said one would follow). */
        const settleHeld = () => {
          if (!helpers.holding || state.settled || helpers.open.size > 0 || helpers.wakePending) return;
          flushAssistantText();
          settleClean();
        };
        const fallbackGraceMs = (): number => envOr("MURAGE_FUIGO_FALLBACK_GRACE_MS", 2_000);
        const fallbackCapMs = (): number => envOr("MURAGE_FUIGO_FALLBACK_CAP_MS", 10 * 60_000);
        const noteFallback = (event: string, extra: Record<string, unknown> = {}) =>
          appendNative(threadId, { dir: "in", source: SOURCE, msg: { fuigoInterjection: event, ...extra } });
        /** Nothing of ours is left: no steer still deciding its delivery, no
         *  fallback turn running or queued, and no helper open or wake pending
         *  (the same gate a turn held for its helpers uses). */
        const fallbackQuiet = () => interjectionsPending.size === 0 && fallback.running === null && !fallback.queued
          && helpers.open.size === 0 && !helpers.wakePending;
        /** Any change to what the held turn waits on. The grace restarts from
         *  it, and the turn settles only once it has fully elapsed quiet. */
        const fallbackChanged = () => {
          if (fallback.grace) { clearTimeout(fallback.grace); fallback.grace = undefined; }
          if (state.settled || !fallback.holding || !fallbackQuiet()) return;
          fallback.grace = setTimeout(() => {
            fallback.grace = undefined;
            if (state.settled || !fallback.holding || !fallbackQuiet()) return;
            flushAssistantText();
            settle(true, null);
          }, fallbackGraceMs());
          fallback.grace.unref?.();
        };
        /** A clean finish. Once an interjection was accepted it waits for any
         *  `interject-fallback-` turn Fuigo runs for it, bounded by the cap. */
        const settleClean = () => {
          if (state.settled) return;
          if (support.driverKind !== "fuigoAgent" || (!fallback.accepted && interjectionsPending.size === 0)) {
            settle(true, null);
            return;
          }
          if (!fallback.holding) {
            fallback.holding = true;
            fallback.cap = setTimeout(() => {
              if (state.settled) return;
              noteFallback("fallback_cap", { capMs: fallbackCapMs(), running: fallback.running, queued: fallback.queued });
              flushAssistantText();
              // The cap firing is never a clean end: a fallback still running or
              // queued, or a helper or wake still open, means the follow-up the
              // owner steered in did not finish.
              emit({ ...base(threadId, turnId), type: "runtime.error", message: FALLBACK_CAP_LINE });
              settle(false, "interject_fallback_cap");
            }, fallbackCapMs());
            fallback.cap.unref?.();
          }
          fallbackChanged();
        };
        /** `_fuigo/queue/changed`: a fallback turn started, was queued, or the queue went idle. */
        const handleQueueChanged = (params: any) => {
          if (!params || typeof params !== "object") return;
          if (typeof params.sessionId === "string" && sessionId && params.sessionId !== sessionId) return;
          if (state.settled || (!fallback.accepted && interjectionsPending.size === 0)) return;
          const running = typeof params.runningPromptId === "string" ? params.runningPromptId : null;
          const entries: unknown[] = Array.isArray(params.entries) ? params.entries : [];
          fallback.queued = entries.some((entry) => isFallbackPromptId((entry as { id?: unknown } | null)?.id));
          if (isFallbackPromptId(running)) fallback.running = running;
          fallbackChanged();
        };
        /** `turn_completed` of the fallback turn this Murage turn is holding for. */
        const handleFallbackCompleted = (promptId: unknown) => {
          if (state.settled || fallback.running === null) return;
          if (typeof promptId === "string" && promptId !== fallback.running) return;
          fallback.running = null;
          fallbackChanged();
        };
        const endHeldAtCap = () => {
          if (!helpers.holding || state.settled) return;
          // An accepted follow-up still running, queued or unconfirmed did not
          // finish: the helper cap ending it is a failure, never a clean end.
          const followUpHelper = fallback.helpersAtAccept !== null
            && ([...helpers.open].some((id) => !fallback.helpersAtAccept!.has(id)) || helpers.wakePending);
          if (fallback.running !== null || fallback.queued || interjectionsPending.size > 0 || followUpHelper) {
            noteFallback("background_cap_with_fallback", { running: fallback.running, queued: fallback.queued });
            flushAssistantText();
            emit({ ...base(threadId, turnId), type: "runtime.error", message: FALLBACK_CAP_LINE });
            settle(false, "interject_fallback_cap");
            return;
          }
          const note = backgroundCapNote(backgroundWaitCapMs());
          emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: note });
          state.text += note;
          flushAssistantText();
          settle(true, "background_wait_cap");
        };
        const holdForHelpers = () => {
          helpers.holding = true;
          helpers.cap = setTimeout(endHeldAtCap, backgroundWaitCapMs());
          helpers.cap.unref?.();
        };
        /** Fuigo 1.0.21 (no retryDiscard capability): every retry_state
         * "retrying" voids all buffered text. */
        const resetForRetry = () => {
          state.text = "";
          dropTextSegs();
          providerBinding?.keepLogs(turnId);
          emit({ ...base(threadId, turnId), type: "content.reset", streamKind: "assistant_text" });
        };
        /** Fuigo 1.0.22 (retryDiscard): the engine says exactly when it threw
         * an attempt away (`discardEmitted`), and tags that attempt's chunks
         * with `streamStartMs`. Only that attempt's text and reasoning go;
         * earlier responses stay. Tool rows are never touched. */
        const discardForRetry = (u: any) => {
          const start = typeof u.streamStartMs === "number" ? u.streamStartMs : undefined;
          const doomed = (seg: StreamSeg) => start !== undefined ? seg.startMs === start : seg.epoch === streamEpoch;
          const dropped = new Set<"text" | "reasoning">();
          /** streamStartMs of the attempts this discard reached */
          const attempts = new Set<number>(start !== undefined ? [start] : []);
          for (let i = streamSegs.length - 1; i >= 0; i--) if (doomed(streamSegs[i])) {
            dropped.add(streamSegs[i].kind);
            if (typeof streamSegs[i].startMs === "number") attempts.add(streamSegs[i].startMs!);
            streamSegs.splice(i, 1);
          }
          // A hosted row the discarded attempt left running gets no completion:
          // it ends as interrupted, never a spinner; the resend runs its own.
          // Without streamStartMs on the retry, the attempt is the open
          // response (the same epoch rule the text segments use), or one whose
          // text this discard dropped.
          for (const [id, row] of hostedRows) {
            if (!attempts.has(row.startMs) && (start !== undefined || row.epoch !== streamEpoch)) continue;
            hostedRows.delete(id);
            interruptedRows.add(id);
            runningTools.delete(id);
            traceToolClose(id, "interrupted");
            toolNames.delete(id);
            state.producedItem = true;
            emit({ ...base(threadId, turnId), type: "item.completed", itemType: "tool", itemId: id, ok: false, detail: HOSTED_ROW_INTERRUPTED });
          }
          if (!streamSegs.some(seg => seg.kind === "text" && seg.cut)) liveBreak = false;
          // the discard is itself a boundary for the no-streamStartMs rule
          streamEpoch++;
          providerBinding?.keepLogs(turnId);
          const remaining = (kind: "text" | "reasoning") => streamSegs.filter(seg => seg.kind === kind).map(seg => seg.text).join("");
          if (dropped.has("text") || start === undefined) {
            state.text = remaining("text");
            emit({ ...base(threadId, turnId), type: "content.reset", streamKind: "assistant_text" });
            if (state.text) emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: state.text });
          }
          if (dropped.has("reasoning")) {
            const text = remaining("reasoning");
            emit({ ...base(threadId, turnId), type: "content.reset", streamKind: "reasoning_text" });
            if (text) emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "reasoning_text", delta: text });
          }
        };
        const onRetryState = (u: any) => {
          if (u.type !== "retrying") return;
          if (!retryDiscard) resetForRetry();
          else if (u.discardEmitted === true) discardForRetry(u);
        };
        /** Separate assistant text by response (Fuigo retryDiscard): a chunk of
         * a new response (another streamStartMs) closes the previous response's
         * text as its own item, but only once that response completed, so text
         * of an attempt that may still be discarded is never committed. Chunks
         * without streamStartMs (no retryDiscard) never split. */
        const splitAtNewResponse = (startMs: unknown) => {
          if (!retryDiscard || typeof startMs !== "number") return;
          const texts = streamSegs.filter(seg => seg.kind === "text");
          const last = texts[texts.length - 1];
          if (!last || last.startMs === startMs || !texts.every(seg => seg.done && typeof seg.startMs === "number")) return;
          flushAssistantText();
        };
        const recordSeg = (kind: "text" | "reasoning", delta: string, startMs: unknown) => {
          if (!retryDiscard) return;
          const tag = typeof startMs === "number" ? startMs : undefined;
          const last = streamSegs[streamSegs.length - 1];
          if (last && last.kind === kind && last.epoch === streamEpoch && last.startMs === tag && !last.cut) last.text += delta;
          else streamSegs.push({ kind, epoch: streamEpoch, startMs: tag, text: delta });
        };
        const handleHelperUpdate = (sid: unknown, u: any, replay: boolean) => {
          if (replay || !state.promptSent || state.settled || !u || typeof u !== "object") return;
          if (typeof sid === "string" && sessionId && sid !== sessionId) return;
          const id = typeof u.subagent_id === "string" ? u.subagent_id : null;
          switch (u.sessionUpdate) {
            case "subagent_spawned":
              if (!id) return;
              emitSubtask(helpers.tracker.start(id, u.description));
              helpers.open.add(id);
              fallbackChanged();
              break;
            case "subagent_progress":
              if (!id) return;
              emitSubtask(helpers.tracker.progress(id, { toolCount: u.tool_call_count }));
              break;
            case "subagent_finished":
              if (!id) return;
              helpers.open.delete(id);
              emitSubtask(helpers.tracker.end(id, u.status === "completed"));
              if (u.will_wake === true) helpers.wakePending = true;
              settleHeld();
              fallbackChanged();
              break;
            case "retry_state":
              // The engine is resending its request after a mid-stream failure
              // and will stream the answer again from the start. Whatever text
              // arrived since the last committed item (tool call) is void; tool
              // rows already emitted stay, they ran.
              onRetryState(u);
              break;
            case "response_completed":
              // a response boundary: a later discard without streamStartMs
              // never reaches back past it, and its text may now be closed
              for (const seg of streamSegs) seg.done = true;
              streamEpoch++;
              // text a hosted row cut is final now: save it at once, before its row
              if (streamSegs.some(seg => seg.kind === "text" && seg.cut)) flushAssistantText();
              break;
            case "turn_completed":
              // A fallback turn (an interjection that missed the final drain)
              // reports its end here too; it is not the woken reply.
              // Fuigo names the turn in snake_case (`prompt_id`) on this rail.
              const completedId = typeof u.prompt_id === "string" ? u.prompt_id : u.promptId;
              if (fallback.running !== null && (typeof completedId !== "string" || completedId === fallback.running)) {
                handleFallbackCompleted(completedId);
                break;
              }
              // a fallback whose start this turn never saw is not the woken reply either
              if (isFallbackPromptId(completedId)) break;
              // the reply the engine woke itself for has ended (a fallback can wake one too)
              if (helpers.holding || fallback.holding) { helpers.wakePending = false; settleHeld(); fallbackChanged(); }
              break;
          }
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
              proc?.mcpReadySessions.add(readyId);
              if (readyId === sessionId) releaseMcpWait?.();
            }
            return;
          }
          if (support.mcpProgressNotification && msg.method === support.mcpProgressNotification) {
            if (proc) recordMcpProgress(proc, msg.params);
            if (msg.params?.sessionId === sessionId) releaseMcpWait?.();
            return;
          }
          // Vendor side-channels (e.g. grok's `_x.ai/*`) are teed to the
          // native log but never normalized: the prompt result is the settle.
          // Fuigo and Grok Build (its upstream) send the same sub agent updates
          // The engine's echo of an interjection. Murage already recorded the
          // steered message when the owner sent it, so the echo only retires
          // the pending id; it never becomes a second user message.
          if (msg.method === "_fuigo/session/interjection" || msg.method === "fuigo/session/interjection") {
            const echoed = msg.params?.interjectionId;
            if (typeof echoed !== "string") return;
            // The echo only retires the id. It is sent when the steer is queued,
            // possibly mid-response, and that attempt can still fail and be
            // discarded, so it never commits text: the reply is split by
            // response instead (splitAtNewResponse).
            if (interjectionsUncertain.delete(echoed)) {
              // Reported uncertain (never queued again): Fuigo did take it.
              noteFallback("late_echo_confirmed", { interjectionId: echoed });
              if (!state.settled) {
                markAccepted();
                emit({ ...base(threadId, turnId), type: "steer.confirmed", interjectionId: echoed });
                fallbackChanged();
              }
              return;
            }
            if (interjectionsPending.delete(echoed)) markAccepted();
            interjectionEchoes.get(echoed)?.();
            // a newly accepted steer restarts the grace
            fallbackChanged();
            return;
          }
          if (msg.method === "_fuigo/queue/changed" || msg.method === "fuigo/queue/changed") {
            handleQueueChanged(msg.params);
            return;
          }
          // `_fuigo/session/update` is the replay carrier; its isReplay copies
          // are dropped like any other.
          if (msg.method === "_fuigo/session_notification" || msg.method === "_fuigo/session/update" || msg.method === "_x.ai/session_notification") {
            handleHelperUpdate(msg.params?.sessionId, msg.params?.update, msg.params?._meta?.isReplay === true);
            return;
          }
          if (msg.method !== "session/update") return;
          const p = msg.params ?? {};
          // The engine's own "/" commands. Fuigo and Grok Build send the list
          // right after session/new, BEFORE the prompt, so this is read ahead
          // of the prompt gate below that drops every other pre-prompt
          // update. It is the current list, not history, so a session/load
          // replay's copy counts too. Only this turn's session speaks for it.
          if (p.update?.sessionUpdate === "available_commands_update") {
            if (typeof p.sessionId !== "string" || !sessionId || p.sessionId === sessionId) {
              emit({ ...base(threadId, turnId), type: "engine.commands", commands: normalizeEngineCommands(p.update.availableCommands) });
            }
            return;
          }
          if (!state.promptSent || p._meta?.isReplay === true) return;
          const u = p.update ?? {};
          turnTrace(threadId).once("first.update", { kind: String(u.sessionUpdate) });
          switch (u.sessionUpdate) {
            case "agent_message_chunk": {
              turnTrace(threadId).once("ttft");
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
                const startMs = p._meta?.streamStartMs ?? u._meta?.streamStartMs;
                splitAtNewResponse(startMs);
                state.text += delta;
                recordSeg("text", delta, startMs);
                // live only: the committed items are split at the tool row
                if (liveBreak) { liveBreak = false; if (state.text.length > delta.length) emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: "\n\n" }); }
                emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta });
              }
              break;
            }
            case "retry_state":
              onRetryState(u);
              break;
            case "agent_thought_chunk": {
              const delta = u.content?.text;
              // The fallback status line Fuigo sends after a retry_state is
              // not reasoning and never part of a discard: with retryDiscard it
              // is kept out of the reasoning stream (and the segments); 1.0.21
              // keeps showing it as before.
              if (retryDiscard && (p._meta?.["fuigo/retryStatus"] !== undefined || u._meta?.["fuigo/retryStatus"] !== undefined)) break;
              if (typeof delta === "string" && delta) {
                const startMs = p._meta?.streamStartMs ?? u._meta?.streamStartMs;
                splitAtNewResponse(startMs);
                recordSeg("reasoning", delta, startMs);
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
              traceToolOpen(u.toolCallId);
              {
                const startMs = p._meta?.streamStartMs ?? u._meta?.streamStartMs;
                const backend = p._meta?.backend === true || u._meta?.backend === true;
                if (!deferAtToolRow(startMs, backend, u.toolCallId)) flushAssistantText();
                if (retryDiscard && backend && typeof startMs === "number" && typeof u.toolCallId === "string"
                  && u.status !== "completed" && u.status !== "failed") hostedRows.set(u.toolCallId, { startMs, epoch: streamEpoch });
              }
              trackRunningTool(runningTools, u, "pending");
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
                input: u.rawInput,
                toolKind: typeof u.kind === "string" ? u.kind : undefined,
                // Only the engine's own stamp is an identity; the proposal turn
                // treats any identity without its namespace as an unasked tool (R9-4).
                // The guard reads an unstamped execute kind as a shell call.
                ...(() => {
                  const stamp = u._meta?.["fuigo/tool"];
                  return stamp?.version === 1 && typeof stamp.namespace === "string" && typeof stamp.name === "string"
                    ? { toolIdentity: { namespace: stamp.namespace, name: stamp.name, ...(typeof stamp.kind === "string" ? { kind: stamp.kind } : {}) } }
                    : {};
                })(),
              });
              break;
            }
            case "tool_call_update": {
              // a row a discard already closed as interrupted stays closed
              if (typeof u.toolCallId === "string" && interruptedRows.has(u.toolCallId)) break;
              if (u.status === "completed" || u.status === "failed") hostedRows.delete(u.toolCallId);
              trackRunningTool(runningTools, u);
              if (u.status === "completed" || u.status === "failed") {
                traceToolClose(u.toolCallId, u.status);
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
                  result: u.rawOutput ?? u.content,
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

        // A frame over ENGINE_FRAME_MAX_BYTES (A4); the byte-bounded splitter
        // that detects it belongs to the process (`openProcess`).
        const handleOverflow = (overflow: FrameOverflow) => {
          appendNative(threadId, { dir: "in", source: SOURCE, msg: { frameOverflow: overflow } });
          if (state.settled) return;
          emit({ ...base(threadId, turnId), type: "runtime.error", message: frameOverflowMessage(support.displayName, overflow) });
          settle(false, FRAME_TOO_LARGE);
        };
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

        /** Plug this turn into a process: its output, its stderr and its
         * exit are this turn's until the turn settles and parks or stops it. */
        const attachHooks = (target: AcpProcess) => {
        target.owner.hooks = {
        line: handleStdoutLine,
        overflow: handleOverflow,
        notice: (title) => {
          if (state.settled || state.cancelRequested) return;
          const itemId = `engine-notice-${turnId}-${++noticeSeq}`;
          emit({ ...base(threadId, turnId), type: "item.started", itemId, itemType: "tool", title, toolKind: "notice" });
          emit({ ...base(threadId, turnId), type: "item.completed", itemId, itemType: "tool", ok: true });
        },
        stderr: (text) => {
          const remaining = STDERR_DIAGNOSTIC_CHARS - stderrDiagnostic.length;
          stderrDiagnostic += text.slice(0, Math.max(0, remaining));
          if (text.length > remaining) stderrDiagnosticTruncated = true;
        },
        error: (e) => {
          if (!spawned) lifecycle.record("spawn_failed", { errno: errnoCategory(e) });
          emit({ ...base(threadId, turnId), type: "runtime.error", ...describeSpawnFailure(e, config.cli) });
          settle(false, "spawn_error");
        },
        close: (code, signal) => {
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
            pid: target.child.pid ?? null,
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
            // A fallback hold ends here unfinished: the engine-exit failure below.
            if (helpers.holding && !fallback.holding && !fallback.accepted && interjectionsPending.size === 0) {
              flushAssistantText();
              settle(true, null);
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
              message: engineClosedLine(ENGINE, code, undefined, detail || undefined),
            });
            settle(false, "exit_before_result");
          }
          stderrDiagnostic = "";
        },
        };
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
            if (helpers.holding || fallback.holding) { settle(true, "cancelled", "user_cancel"); return; }
          } else stop("unspecified");
          if (interruptTimer) clearTimeout(interruptTimer);
          interruptTimer = setTimeout(() => settle(true, "cancelled", "cancel_timeout"), ACP_CANCEL_GRACE_MS);
          interruptTimer.unref?.();
        };
        /** Resolve when `id` is MCP-ready, the bound passes, or the turn ends.
         * The timer and the release hook are always cleared together. */
        const awaitMcpReady = (id: string, ownMounts: number, needsAllSettled = false) =>
          new Promise<"ready" | "own_ready" | "timeout" | "aborted">((resolve) => {
            const ready = proc?.mcpReadySessions ?? new Set<string>();
            // Murage's own mounts are up when the engine's connected count
            // reaches them. The count is not per server, so an external
            // server that connects first can satisfy it early; the cost of
            // that is the old behaviour (the model is told a server is still
            // connecting), never a hang.
            // A connector turn (Composio mounted) never takes this early release:
            // the progress count has no server names, so another mount or a
            // plugin connecting first would release the turn before Composio
            // listed its tools. The engine's all-settled notification is the
            // only signal that necessarily covers Composio; it is bounded by
            // the full wait, with no retry.
            const ownUp = () => !needsAllSettled && (proc?.mcpProgress.get(id)?.connected ?? 0) >= ownMounts;
            if (ready.has(id)) return resolve("ready");
            if (state.settled || state.cancelRequested) return resolve("aborted");
            const outcomeNow = () => (ready.has(id) ? "ready" : ownUp() ? "own_ready" : null);
            let timer: ReturnType<typeof setTimeout> | undefined;
            const finish = (outcome: "ready" | "own_ready" | "timeout" | "aborted") => {
              if (releaseMcpWait !== release) return;
              releaseMcpWait = null;
              clearTimeout(timer);
              resolve(outcome);
            };
            // Called on every readiness/progress notification and on abort.
            const startedWaiting = Date.now();
            let short = false;
            const release = () => {
              const now = outcomeNow();
              if (now) return finish(now);
              if (state.settled || state.cancelRequested) return finish("aborted");
              // First progress report after a full-length arm: tighten.
              if (!needsAllSettled && !short && proc?.mcpProgress.has(id)) {
                short = true;
                clearTimeout(timer);
                timer = setTimeout(() => finish("timeout"), Math.max(0, mcpOwnReadyWaitMs() - (Date.now() - startedWaiting)));
                timer.unref?.();
              }
            };
            releaseMcpWait = release;
            // With no progress report the engine may be a build that sends
            // none, so the full bound applies; once it reports, the short one.
            const arm = () => {
              short = !needsAllSettled && !!proc?.mcpProgress.has(id);
              const ms = short ? mcpOwnReadyWaitMs() : mcpReadyWaitMs();
              timer = setTimeout(() => finish("timeout"), ms);
              timer.unref?.();
            };
            if (outcomeNow()) return finish(outcomeNow()!);
            arm();
          });

        const interjectAckMs = (): number => envOr("MURAGE_FUIGO_INTERJECT_ACK_MS", 15_000);
        const interject = async (text: string, beforeWrite?: () => void, givenId?: string): Promise<SteerDelivery> => {
          if (interjectUnsupported || state.settled || state.cancelRequested || !state.promptSent || !sessionId) return "rejected";
          // The steer's submission fence (the same full-session check every
          // adapter write runs): no await separates it from the
          // `_fuigo/interject` write below. A refusal writes nothing and the
          // caller runs the line as its own turn.
          try { beforeWrite?.(); } catch { return "rejected"; }
          const interjectionId = givenId && givenId.length > 0 ? givenId : newId();
          interjectionsPending.add(interjectionId);
          // Delivered once EITHER the response says queued OR Fuigo echoes the
          // id, whichever comes first, within one 15 s budget (P2).
          const ackMs = interjectAckMs();
          let timer: ReturnType<typeof setTimeout> | undefined;
          const echoed = new Promise<{ kind: "echo" }>((resolve) => {
            interjectionEchoes.set(interjectionId, () => resolve({ kind: "echo" }));
          });
          const deadline = new Promise<{ kind: "timeout" }>((resolve) => {
            timer = setTimeout(() => resolve({ kind: "timeout" }), ackMs);
            timer.unref?.();
          });
          const response = request("_fuigo/interject", { sessionId, text, interjectionId }, ackMs).then(
            (res: any) => ({ kind: "response" as const, res }),
            (error: unknown) => ({ kind: "error" as const, error }),
          );
          // Every resolution changes what a held turn waits on; an acceptance
          // restarts its grace.
          const accepted = (): SteerDelivery => {
            interjectionsPending.delete(interjectionId);
            markAccepted();
            fallbackChanged();
            return "delivered";
          };
          const rejected = (): SteerDelivery => {
            interjectionsPending.delete(interjectionId);
            fallbackChanged();
            return "rejected";
          };
          try {
            const first = await Promise.race([echoed, response, deadline]);
            if (first.kind === "echo") return accepted();
            if (first.kind === "response") {
              // Fuigo 1.0.21 double-wraps extension results ({result:{status}}); accept the flat shape too.
              return (first.res?.result?.status ?? first.res?.status) === "queued" ? accepted() : rejected();
            }
            if (first.kind === "error") {
              const e = first.error as { code?: unknown; message?: unknown; acpRpcId?: unknown };
              if (e?.code === -32601 || /method not found/i.test(String(e?.message ?? ""))) {
                interjectUnsupported = true;
                return rejected();
              }
              // A JSON-RPC error is Fuigo's own answer: not taken.
              if (e?.acpRpcId !== undefined) return rejected();
              // A lost or timed-out request is uncertain: the echo still decides.
              const late = await Promise.race([echoed, deadline]);
              if (late.kind === "echo") return accepted();
            }
            // Neither within the budget: uncertain. Fuigo may still take it, so
            // the caller must not queue a copy; a late echo confirms it.
            interjectionsPending.delete(interjectionId);
            interjectionsUncertain.add(interjectionId);
            noteFallback("ack_timeout", { interjectionId, ackMs });
            fallbackChanged();
            return "uncertain";
          } finally {
            if (timer) clearTimeout(timer);
            interjectionEchoes.delete(interjectionId);
          }
        };

        let started = false;
        /** sendTurn has handed the turn id back: a refused submission from here
         * on settles the turn itself (no caller is left to stop it by id). */
        let handedBack = false;
        const start = () => {
          if (started) return;
          started = true;
          active.set(threadId, { stop, interrupt, turnId, asks, ...(support.driverKind === "fuigoAgent" ? { interject } : {}) });
          emit({ ...base(threadId, turnId), type: "turn.started" });
        };

        /** Spawn the engine under the folder-trust decision and run the
         * handshake. A synchronous spawn failure throws to the caller, as it
         * always did for a turn that needs no card. */
        const launch = (trusted: boolean) => {
        const argv = support.spawnArgs(turnConfig, cliTurn, { requestedModel: turn.model, folderTrusted: trusted, env });
        // The spawn contract (see the pool notes): everything that decides
        // which process a turn gets. The model, effort, permission mode and
        // `--trust` all ride argv; the environment is the child's exact env,
        // held only as a digest.
        // Never pooled: a provider-routed turn (its home is removed when its
        // child closes), Grok (its resume binding waits on that close), a
        // bypass-permissions instance, and a turn holding a computer or a
        // browser. An engine can leave background work running after
        // `end_turn` (Fuigo's background tasks and subagents); while the
        // process is idle, every permission request it sends is refused and
        // the process closed, but a bypass-permissions engine sends none, and
        // the computer and browser claims are released when the turn ends.
        const integrations = turn.integrations;
        poolable = poolingEnabled() && support.pooledSessions === true && !providerBinding
          && support.driverKind !== "grokAgent" && !turnConfig.fullAuto
          && !integrations?.computer && !integrations?.localComputer && !integrations?.browser;
        // The folder-trust record is in it too, whole: the engine caches its
        // trust verdict per workspace for the life of the process (Fuigo
        // `agent/folder_trust.rs`), so a change Murage can see (the owner's
        // decision, the sources the scan found, a grant added to or revoked
        // from the user's own trusted_folders.toml) must reach a new process.
        contractKey = poolable
          ? digest([config.cli, argv, cwd, env, support.folderTrust ? turn.folderTrust ?? null : null])
          : null;
        // `sessionReset` outranks the cursor (contracts.ts, #1562): the
        // rebuilt history is already in the prompt, and resuming the old
        // native session under it would hand the engine both branches.
        const resumeId = turn.sessionReset !== true && typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;

        const spawnFresh = () => {
          spawned = false;
          lifecycle.record("spawn_requested");
          const spawnedChild = (() => {
            try {
              return spawnCli(config.cli, argv, {
                cwd,
                env,
                stdio: ["pipe", "pipe", "pipe"],
              });
            } catch (error) {
              lifecycle.record("spawn_failed", { errno: errnoCategory(error) });
              throw error;
            }
          })();
          child = spawnedChild;
          spawnedChild.once("spawn", () => {
            spawned = true;
            lifecycle.record("spawned", { pid: spawnedChild.pid ?? null });
          });
          teardown = teardowns.track(threadId, turnId, spawnedChild);
          teardown.onClosed(() => providerBinding?.cleanup());
          proc = openProcess(threadId, spawnedChild, contractKey);
          reused = false;
          attachHooks(proc);
        };

        // Adopt the thread's idle process only when nothing that matters
        // changed and the turn continues exactly the session it holds; any
        // other idle process is closed, never reused.
        const idle = pool.get(threadId);
        // The ACP spare serves any thread: with none of its own, this thread takes a
        // compatible idle process (same spawn contract) another thread parked, and loads
        // its own session on it. An incompatible spare is closed, and a fresh one spawned.
        let crossThread = false;
        let donor: AcpProcess | null = null;
        // Only with MURAGE_ACP_CROSS_THREAD_SPARE=1, and only to load this thread's own
        // session (a new session always gets a fresh process). Otherwise another
        // thread's spare is left to the shared pool's one-spare limit, never adopted.
        if (!idle && poolable && crossThreadSpareEnabled() && resumeId !== null) {
          for (const [otherThread, other] of [...pool]) {
            if (otherThread === threadId) continue;
            // its previous session must be settled: no turn running on it, no engine request open
            const settledOwner = other.owner.hooks === null && other.openRequests.size === 0;
            if (!settledOwner) continue; // never moved: this turn spawns fresh
            const compatible = !donor && !other.dead && !other.closing && other.contractKey === contractKey
              && other.parkVerified === other.parkGen && other.unfit === null
              && !pastWarmMaxAge(spawnedAtOf(other.child))
              && other.child.exitCode === null && other.child.signalCode === null && osProcessAlive(other.child.pid);
            if (compatible) { donor = other; pool.delete(otherThread); crossThread = true; }
            else closeProcess(otherThread, other, other.contractKey !== contractKey ? "contract_changed"
              : pastWarmMaxAge(spawnedAtOf(other.child)) ? "max-age" : "replaced");
          }
        }
        if (idle || donor) {
          const taken = (idle ?? donor)!;
          if (idle) pool.delete(threadId);
          // Leaves the shared pool now, not when its turn settles: a pooled engine
          // that is running a turn must never be evicted as an idle spare.
          warmPool.release(taken);
          if (taken.idleTimer) clearTimeout(taken.idleTimer);
          taken.idleTimer = null;
          stopTreeSweep(taken);
          // older than the warm max age: recycled here, at a turn boundary
          const aged = !crossThread && pastWarmMaxAge(spawnedAtOf(taken.child));
          const adopt = crossThread
            ? true
            : poolable && !taken.dead && !taken.closing && taken.contractKey === contractKey
              && taken.parkVerified === taken.parkGen && taken.unfit === null
              && taken.child.exitCode === null && taken.child.signalCode === null && osProcessAlive(taken.child.pid)
              && turn.sessionReset !== true && resumeId !== null && resumeId === taken.sessionId && !aged;
          if (adopt) {
            const idle = taken;
            proc = idle;
            child = idle.child;
            spawned = true;
            reused = true;
            // Ownership moves from the pool to this turn: its close is now
            // the turn's to observe (and a reset while it runs does not wait
            // on a process the turn is still using).
            idle.poolTeardown?.detach();
            idle.poolTeardown = null;
            teardown = teardowns.track(threadId, turnId, idle.child);
            // Rebind ownership in one step: from here every frame is checked against
            // this thread, and the previous owner's session is foreign.
            // A moved process is pinned to the session it will load before session/load
            // goes out, and from now on refuses every frame that does not name it.
            if (crossThread && idle.sessionId) idle.retiredSessions.add(idle.sessionId);
            if (crossThread) idle.transferred = true;
            idle.owner = { threadId, sessionId: crossThread ? resumeId : idle.sessionId, hooks: null };
            attachHooks(idle);
            appendNative(threadId, { dir: "out", source: SOURCE, msg: { acpPool: "reuse", ...(crossThread ? { crossThread: true } : {}) } });
          } else {
            closeProcess(threadId, taken, turn.sessionReset === true ? "session_reset"
              : taken.contractKey !== contractKey ? "contract_changed" : aged ? "max-age" : "session_changed");
          }
        }
        if (!proc) spawnFresh();
        if (turn.prewarm) prewarmChildren.set(threadId, () => child);
        start();
        turnTrace(threadId).mark("engine.acquire", { cold: !reused, pooling: poolingEnabled(), poolable });

        (async () => {
          try {
            const sessionKey = digest(mcpServers);
            // Whether this turn (re-)established MCP servers and so must wait
            // for the engine to report them ready before prompting.
            let mcpEstablished = true;
            let sessionResult: any = null;
            let init: any;
            /** The engine already reported this turn's MCP servers ready. */
            let mcpReadyWaited = false;
            /** How the last MCP-ready wait ended. */
            let mcpOutcome: "ready" | "own_ready" | "timeout" | "aborted" | null = null;
            const waitMcpReady = async (): Promise<boolean> => {
              mcpReadyWaited = true;
              const mcpDone = turnTrace(threadId).span("mcp.ready.wait", { servers: mcpServers.length });
              const outcome = await awaitMcpReady(sessionId!, mcpServers.length, mcpServers.some(server => server.name === "composio"));
              mcpOutcome = outcome;
              mcpDone(outcome);
              if (state.settled) return false;
              if (state.cancelRequested) { settle(true, "cancelled"); return false; }
              lifecycle.record(outcome === "ready" ? "mcp_ready" : outcome === "own_ready" ? "mcp_ready_own" : "mcp_ready_timeout");
              return true;
            };
            /** Close a reused process this turn rejected and spawn a fresh one.
             *  Nothing bound to the rejected process survives: its session id,
             *  load answer, init result and MCP wait, so the replacement starts
             *  exactly as a cold turn does (a load that answers nothing then
             *  opens a new session). */
            const replaceReused = (live: AcpProcess, reason: string) => {
              closeProcess(threadId, live, reason);
              teardown?.detach();
              proc = null;
              spawnFresh();
              sessionId = null;
              sessionResult = null;
              init = undefined;
              mcpEstablished = true;
              mcpReadyWaited = false;
              mcpOutcome = null;
            };
            if (reused) {
              // The process and its native session are live. The harness put
              // fresh capability tokens in `mcpServers`, so unless they are
              // byte-identical to the ones the session holds, re-establish it
              // over the wire: Fuigo's session/load on a resident session
              // re-applies the servers (restarting only the changed ones) and,
              // with `noReplay`, skips re-sending a transcript this driver
              // would drop anyway. A load that fails or answers nothing gets a
              // fresh process instead, in this same turn.
              init = proc!.initResult;
              retryDiscard = acpRetryDiscard(init);
              if (!crossThread && proc!.sessionKey === sessionKey) {
                mcpEstablished = false;
                sessionId = resumeId;
              } else {
                const live = proc!;
                live.sessionKey = null;
                if (live.sessionId) { live.mcpReadySessions.delete(live.sessionId); live.mcpProgress.delete(live.sessionId); }
                if (resumeId) { live.mcpReadySessions.delete(resumeId); live.mcpProgress.delete(resumeId); }
                try {
                  if (resumeId === null) {
                    // another thread's spare, and this thread has no native session yet
                    sessionResult = await request("session/new", { cwd, mcpServers }, NEW_SESSION_TIMEOUT);
                    sessionId = typeof sessionResult?.sessionId === "string" ? sessionResult.sessionId : null;
                    if (!sessionId) throw new Error("session/new answered no session");
                  } else {
                    sessionResult = await request(
                      "session/load",
                      { sessionId: resumeId, cwd, mcpServers, _meta: { noReplay: true } },
                      LOAD_SESSION_TIMEOUT,
                    );
                    if (!sessionResult) throw new Error("session/load answered no session");
                    sessionId = resumeId;
                  }
                  live.sessionKey = sessionKey;
                } catch (error) {
                  if (state.settled) return;
                  if (state.cancelRequested) { settle(true, "cancelled"); return; }
                  appendNative(threadId, { dir: "out", source: SOURCE, msg: { acpPool: "reestablish_failed" } });
                  // The pooled process belongs to no one now: its close is
                  // observed by the pool, and this turn owns the replacement.
                  replaceReused(live, "reestablish_failed");
                }
              }
            }
            // A reused process keeps the baseline its park check verified. A
            // descendant that appeared since is admitted only as a verified MCP
            // server replacement; anything else (a child that started after the
            // park check, before the parked sweep saw it) is a leftover: the
            // process is closed and this turn spawns fresh. One listing, taken
            // once any reconnected servers report ready, so their replacements
            // are already running when it is read. Servers that did not report
            // ready in time leave the reused tree unproven: it is closed and the
            // turn spawns fresh (a fresh process that times out goes on as before).
            if (reused && poolable) {
              const live = proc!;
              if (support.mcpReadyNotification && mcpServers.length && sessionId && mcpEstablished && !(await waitMcpReady())) return;
              const tree = mcpOutcome === "timeout"
                ? { baseline: new Map() as ProcessIdentities, leftover: "mcp-ready-timeout" }
                : await reconcileReusedTree(live, mcpServers)
                  .catch(() => ({ baseline: new Map() as ProcessIdentities, leftover: "process probe failed" }));
              if (state.settled) return;
              if (state.cancelRequested) { settle(true, "cancelled"); return; }
              if (tree.leftover) {
                appendNative(threadId, { dir: "out", source: SOURCE, msg: { acpPool: tree.leftover === "mcp-ready-timeout" ? "mcp_ready_timeout" : "pre_prompt_leftover" } });
                replaceReused(live, tree.leftover);
              } else {
                live.turnBaseline = Promise.resolve(tree.baseline);
              }
            }
            if (!reused) {
            init = await request(
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
            proc!.initResult = init;
            retryDiscard = acpRetryDiscard(init);
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

            const cursor = grokBinding ? grokBinding.cursor : resumeId;
            if (cursor) {
              try {
                sessionResult = await request(
                  "session/load",
                  { sessionId: cursor, cwd, mcpServers, _meta: { noReplay: true } },
                  LOAD_SESSION_TIMEOUT,
                );
                // An agent is allowed to ANSWER session/load with null when the
                // session is gone. Taking the cursor on that answer pinned
                // sessionId to a dead id, skipped the session/new below, and
                // prompted a session the agent had already forgotten.
                if (sessionResult) sessionId = cursor;
              } catch (error) {
                // A refusal is not a missing session (upstream c61d7c86,
                // #1705). Starting fresh on a sign-in refusal or on invalid
                // params (a bad model or config) silently dropped the
                // conversation and hid the reason; fail the turn with the
                // engine's own explanation instead. OpenCode reports a
                // session it no longer has as invalid params whose data is
                // exactly the rejected id, and that one IS a missing session.
                if (loadRefusal(error, cursor, support.classifyError)) throw error;
                /* session gone, load unsupported, or too slow — start fresh */
              }
            }
            if (!sessionId) {
              if (grokBinding && cursor) {
                if (!turn.transcript) throw new Error("Grok session could not be restored. Reload the conversation before continuing.");
                promptTurn = replayGrokTurn();
              } else if (cursor && turn.transcript?.length) {
                // The new session has no history. Sending only the latest
                // message made the bot forget the whole thread; replay the
                // transcript the harness sent, which it has already passed
                // through the memory replay filter (upstream c61d7c86).
                promptTurn = replayTurn("[Your previous session could not be restored. Continue from this conversation history:]");
              }
              sessionResult = await request("session/new", { cwd, mcpServers }, NEW_SESSION_TIMEOUT);
              sessionId = typeof sessionResult?.sessionId === "string" ? sessionResult.sessionId : null;
              if (!sessionId) throw new Error(`${ENGINE} did not open a conversation.`);
            }
            proc!.sessionKey = sessionKey;
            }
            if (!sessionId) throw new Error(`${ENGINE} did not open a conversation.`);
            // the owner's session is now known: only its frames are this turn's
            proc!.owner.sessionId = sessionId;
            proc!.retiredSessions.delete(sessionId);
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
                      `${ENGINE} did not switch to ${cliTurn.model} (still ${selectedModel ?? "unknown"})`,
                    );
                  }
                }
              }

              if (support.configureSession) {
                await support.configureSession({
                  request: (method, params, timeoutMs) =>
                    request(method, params, timeoutMs ?? SESSION_CONFIG_TIMEOUT),
                  sessionId,
                  config: turnConfig,
                  turn: cliTurn,
                  sessionModels: Array.isArray(sessionResult?.models?.availableModels)
                    ? sessionResult.models.availableModels
                    : [],
                  ...(typeof sessionResult?.models?.currentModelId === "string"
                    ? { currentModelId: sessionResult.models.currentModelId }
                    : {}),
                });
                // initialize's currentModelId is the CLI default,
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
            // A reused session whose servers did not change was not
            // re-established, and the engine sends nothing for it.
            // A reused process already waited, before its tree check.
            if (support.mcpReadyNotification && mcpServers.length && sessionId && mcpEstablished && !mcpReadyWaited) {
              if (!(await waitMcpReady())) return;
            }
            // Intent warm: the engine is up with its session established and its MCP
            // servers ready. Settle parks it (held for one window); no prompt is sent.
            if (turn.prewarm) {
              console.info(`acp prewarm thread=${threadId} engine=${DRIVER_KIND}`);
              settle(true, null, "turn_complete");
              return;
            }
            // The process tree before the prompt goes out (MCP servers included): a
            // child beyond it once the turn settles is the turn's leftover work.
            // A fresh process takes its listing now; a reused one already holds
            // its verified baseline (plus verified MCP replacements) from the
            // check above. The listing must FINISH before the prompt is written:
            // one read after it can already hold the turn's own leftover child
            // and count it as baseline.
            if (proc && poolable && !reused) {
              proc.turnBaseline = proc.child.pid ? descendantIdentities(proc.child.pid).catch(() => null) : Promise.resolve(null);
              await proc.turnBaseline;
              if (state.settled) return;
              if (state.cancelRequested) { settle(true, "cancelled"); return; }
            }
            // A command turn is the command alone. Fuigo and Grok Build
            // recognise "/name" only when it opens the FIRST text block
            // (fuigo-shell slash_authority::parse_slash_prefix), so the
            // persona that every other turn carries in front of the message
            // would turn the command into chat. Nothing is lost: the persona
            // rides in front of an ordinary turn that needs it, including the next one.
            // Fuigo only: send the system stack once per native session and
            // again only when it changes. Any engine command (/compact can
            // summarise the stack away) forgets the session's record.
            const stackKey = DRIVER_KIND === "fuigoAgent" && sessionId ? `${threadId}\0${sessionId}` : null;
            if (stackKey && turn.engineCommand) systemDelivered.delete(stackKey);
            const stackHash = stackKey && !turn.engineCommand && promptTurn.system
              ? createHash("sha256").update(promptTurn.system).digest("hex") : null;
            const stackAlreadySent = stackKey !== null && stackHash !== null && systemDelivered.get(stackKey) === stackHash;
            const textTurn = stackAlreadySent ? { ...promptTurn, system: undefined } : promptTurn;
            const text = turn.engineCommand
              ? engineCommandText(turn.engineCommand)
              : support.buildPromptText
              ? support.buildPromptText(textTurn)
              : textTurn.system
                ? `${textTurn.system}\n\n${textTurn.text}`
                : textTurn.text;
            // The submission fence (SendTurnInput.beforeSubmit), for every
            // ACP engine: no await separates it from the session/prompt write
            // below. A refusal writes nothing. Before sendTurn handed the id
            // back the harness stops the turn by it; after, the turn settles
            // failed here and the harness re-runs it on a reset session.
            try {
              turn.beforeSubmit?.();
            } catch (refusal) {
              if (!handedBack) throw refusal;
              settle(false, "submission_refused");
              return;
            }
            state.promptSent = true; turnTrace(threadId).once("prompt.sent");
            promptStartedAt = Date.now();
            const promptIdleMs = acpPromptIdleTimeoutMs();
            const result = await request(
              "session/prompt",
              {
                sessionId,
                prompt: [{ type: "text", text }, ...(turn.images ?? []).map(image => ({ type: "image", ...image }))],
                ...(support.promptMeta ? { _meta: support.promptMeta } : {}),
              },
              undefined,
              promptIdleMs,
              // Shown in the chat: the engine as Settings names it, and a
              // plain duration. Never the knob's name or the driver's kind.
              `${ENGINE} went silent for ${plainDuration(promptIdleMs)} with no tool running, so the turn was stopped.`,
              `${ENGINE} had a tool running for ${plainDuration(acpToolMaxMs())} without a word, so the turn was stopped.`,
            );
            if (stackKey && stackHash && !stackAlreadySent) {
              systemDelivered.delete(stackKey);
              systemDelivered.set(stackKey, stackHash);
              if (systemDelivered.size > 2000) systemDelivered.delete(systemDelivered.keys().next().value!);
            }
            // opencode 1.18.18 reports usage at the result root; grok and
            // gemini put it under _meta. Read both rather than lose the count.
            // The root is ACP per-prompt usage. Fuigo's nested usage is the
            // whole prompt; its sibling fields describe only the last call.
            const promptUsage = result?.usage ?? (DRIVER_KIND === "fuigoAgent" ? result?._meta?.usage : undefined);
            if (promptUsage && Number.isSafeInteger(promptUsage.inputTokens) && promptUsage.inputTokens >= 0
              && Number.isSafeInteger(promptUsage.outputTokens) && promptUsage.outputTokens >= 0) {
              settledUsage = { input: promptUsage.inputTokens, output: promptUsage.outputTokens,
                ...(Number.isSafeInteger(promptUsage.cachedReadTokens) && promptUsage.cachedReadTokens >= 0 ? { cachedInput: promptUsage.cachedReadTokens } : {}) };
              if (DRIVER_KIND === "fuigoAgent" && !promptUsage.costIsPartial && !promptUsage.usageIsIncomplete
                && Number.isFinite(promptUsage.costUsdTicks) && promptUsage.costUsdTicks >= 0) settledCharge = promptUsage.costUsdTicks / 1e10;
            }
            const usage = promptUsage ?? result?._meta ?? {};
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
            if (reason === "end_turn" && !state.cancelRequested && (helpers.open.size > 0 || helpers.wakePending)) holdForHelpers();
            else if (reason === "end_turn" && !state.producedItem) {
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
            else if (reason === "end_turn") settleClean();
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
                  : acpStopReasonMessage(ENGINE, reason);
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
                message: engineText ?? acpEngineErrorText(message) ?? `${ENGINE} could not finish this turn.`,
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
        // A warm on intent never raises a card: with no decision recorded there is nothing to warm.
        if (turn.prewarm && needsCard) { endPrewarm(); forgetPrewarm(); return { turnId }; }
        if (!needsCard) {
          try {
            launch(folderTrusted === "trust");
          } catch (error) {
            providerBinding?.cleanup();
            throw error;
          }
          if (support.folderTrust && folderTrusted === "reject" && gate?.sources.length && !upstreamTrusted) noteFolderTrust(folderTrustWithheldName(gate.sources));
          handedBack = true;
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
        handedBack = true;
        return { turnId };
      };

      /** Intent warm: start this thread's engine the way its next turn would (the last real
       * turn's cwd, env, MCP config, settings and contract) with its session established,
       * and park it in the pool, held for one window. A no-op without remembered inputs,
       * for an engine that is never pooled, when an idle process or a turn already holds
       * the thread, or when the folder still needs a trust decision. */
      const prewarm = async (threadId: string): Promise<boolean> => {
        const mem = lastTurns.get(threadId);
        if (!mem || support.pooledSessions !== true || !poolingEnabled() || support.driverKind === "grokAgent") return false;
        if (active.has(threadId) || pool.has(threadId) || !prewarming.begin(threadId)) return false;
        try {
          await sendTurn({ ...mem, prewarm: true, background: false, sessionReset: false });
        } catch {
          prewarming.end(threadId);
          return false;
        }
        if (!active.has(threadId)) prewarming.end(threadId);
        await prewarming.wait(threadId);
        const parked = pool.get(threadId);
        return Boolean(parked && !parked.closing);
      };

      /** Every child this instance spawned — turn-owned or pooled — closed. */
      const waitAllClosed = async () => {
        const budget = { closeMs: providerCloseDeadlineMs(), maxMs: providerCloseDeadlineMs() };
        const [turns, pooled] = await Promise.all([teardowns.waitAll(budget), poolTeardowns.waitAll(budget)]);
        return turns.closeConfirmed ? pooled : turns;
      };

      const snapshot = async (): Promise<ProviderSnapshot> => {
        const env = childEnv();
        const probe = await new Promise<{ error: Error | null; version: string }>((resolve) => {
          execCli(config.cli, ["--version"], { timeout: 8000, env }, (error, stdout, stderr) =>
            resolve({ error, version: versionFromProbe(stdout, stderr) }),
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
          mcpToolSurface: support.driverKind === "fuigoAgent" || support.driverKind === "grokAgent" ? FUIGO_TOOL_SURFACE : NEUTRAL_TOOL_SURFACE,
          capabilities: {
            sessionModelSwitch: "unsupported",
            agentsMcp: !support.ownTools,
            memoryMcp: !support.ownTools,
            customMcp: !support.ownTools,
            computerMcp: !support.ownTools,
            composioMcp: !support.ownTools,
            browserMcp: !support.ownTools,
            ...(support.ownTools ? { runsOnOwnTools: true } : {}),
            images: support.images !== false,
            // The ACP session/prompt carries real image parts (see sendTurn),
            // so an engine that takes images at all is shown them.
            imagesInline: support.images !== false,
            effortLevels: support.effortLevels,
            localComputerMcp: !config.fullAuto && !support.ownTools,
            folderTrust: support.folderTrust === true,
            ...(support.textOnlyTurn ? { textOnlyTurn: true as const } : {}),
            ...(support.driverKind === "fuigoAgent" ? { queueing: true } : {}),
          },
          ...(support.textOnlyTurn ? { textOnlyExecutable: () => support.textOnlyExecutable?.(config) ?? config.cli, textOnlyTurn: (turn: import("../../memory/pip-transport.ts").TextOnlyTurnInput) => support.textOnlyTurn!(turn, config) } : {}),
          sendTurn,
          prewarm,
          // Close-confirmed stop (A2): resolve only once the child that served
          // this thread has closed; reject at the bounded deadline while the
          // process stays owned. A thread with no live child is already closed.
          // Every stop of a thread also retires its idle pooled process (a
          // Stop, a bot delete, the stall watchdog and a settings change all
          // arrive here), and the answer waits for that process's close too.
          interruptTurn: async (threadId, turnId) => {
            retireThread(threadId);
            active.get(threadId)?.interrupt();
            closeIdle(threadId, "interrupt");
            const [turnClosed, poolClosed] = await Promise.all([
              teardowns.wait(threadId, turnId, acpStopBudget()),
              poolTeardowns.wait(threadId, undefined, acpStopBudget()),
            ]);
            const result = turnClosed.closeConfirmed ? poolClosed : turnClosed;
            if (!result.closeConfirmed) throw new ProviderStopUnconfirmedError(DRIVER_KIND, result);
            return result;
          },
          // The harness calls this whenever it rebuilds or drops a thread's
          // context outside a turn (memory refresh, relaunch): the idle
          // process must not carry the old native session into the next turn,
          // and a turn already running must not park its process afterwards.
          resetSession: async (threadId) => {
            retireThread(threadId);
            closeIdle(threadId, "reset");
            const closed = await poolTeardowns.wait(threadId, undefined, acpStopBudget());
            if (!closed.closeConfirmed) throw new ProviderStopUnconfirmedError(DRIVER_KIND, closed);
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
          ...(support.driverKind === "fuigoAgent" ? {
            // A message into the running turn; "rejected" (the caller queues it)
            // when there is no live, unsettled turn or the engine cannot take it,
            // "uncertain" when Fuigo neither answered nor echoed it in time.
            steer: async (threadId: string, text: string, beforeWrite?: () => void, interjectionId?: string): Promise<SteerDelivery> => {
              const turn = active.get(threadId);
              return turn?.interject ? turn.interject(text, beforeWrite, interjectionId) : "rejected";
            },
          } : {}),
          stopAll: async () => {
            for (const threadId of [...active.keys(), ...pool.keys()]) retireThread(threadId);
            for (const { stop } of active.values()) stop("driver_dispose");
            for (const threadId of [...pool.keys()]) closeIdle(threadId, "stop_all");
            const result = await waitAllClosed();
            if (!result.closeConfirmed) throw new ProviderStopUnconfirmedError(DRIVER_KIND, result);
          },
          onEvent: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
        dispose: async () => {
          disposed = true;
          for (const { stop } of active.values()) stop("driver_dispose");
          for (const threadId of [...pool.keys()]) closeIdle(threadId, "dispose");
          const result = await waitAllClosed();
          // Same as codex: an unconfirmed close keeps listeners attached so
          // the owned child's late events are still accounted for.
          if (!result.closeConfirmed) throw new ProviderStopUnconfirmedError(DRIVER_KIND, result);
          listeners.clear();
        },
      };
    },
  };
}
