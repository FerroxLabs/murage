import { classifyFluxRefusal } from "./flux-refusal.ts";
import { FLUX_BILLING_PAGE } from "./flux-links.ts";
/** The approved Cloud line for a Flux turn refused with a 402, 401 or 403. Word for word; the server and the chat card share it. */
export const FLUX_NOT_READY_COPY = "Your Flux credit is still getting ready. Try again in a minute; if it keeps happening, we've been told and are on it.";

/** The held-service line a Cloud home shows when Flux refuses a turn because the service itself is on hold. Shared by the server and the chat card. */
export const FLUX_SERVICE_HOLD_COPY = "This one is on our side, not something you did. Please try again soon.";

/** The Cloud home's own plain lines for a Flux refusal (the server words them; the chat shows them as a copy-only card):
 *  the not-ready line, the held-service line and the used-up-month line (with or without its reset date and carry-on sentence). */
const CREDITS_USED_LINE = /^You've used this month's credits\. (?:They come back on [A-Z][a-z]+ \d{1,2}\.|They come back when your month resets\.)(?: To carry on now, switch to Claude Code or Codex and sign in to your own account\.)?$/;
export function isCloudFluxLine(message: string): boolean {
  return message === FLUX_NOT_READY_COPY || message === FLUX_SERVICE_HOLD_COPY || CREDITS_USED_LINE.test(message);
}

/** A Cloud home, a customer's own Claude, ChatGPT or Grok sign-in refused a turn (401 or 403): one plain line naming the engine. No key advice. */
export function cloudEngineSignInCopy(engineName?: string): string {
  return `Your ${engineName?.trim() || "engine"} sign-in needs a refresh. Sign in again to carry on.`;
}
/** The same for a 402 from the customer's own engine account. */
export function cloudEngineAccountCopy(engineName?: string): string {
  const name = engineName?.trim() || "engine";
  return `Your ${name} plan needs attention before it can answer. Check it with ${name}, then try again.`;
}

/** Structured facts about a provider rejection. The only provider text is `providerSaid`, cleaned on the server. */
export interface ProviderErrorInfo {
  kind: "credits" | "spend-cap" | "payment" | "authentication" | "permission" | "rate-limit" | "unavailable";
  provider?: "flux-router";
  httpStatus: number;
  fluxBudget?: true;
  fluxDecision?: import("./flux-busyloop.ts").Decision;
  fluxResetsAt?: number;
  /** The driver kind of the engine that ran the turn, stamped by the server (ERRORS-NAME-THE-SERVICE). */
  engine?: string;
  /** The saved AI service the turn went through, stamped by the server: its preset, and whether it is a plan sign-in. */
  connection?: { preset: string; signIn?: boolean };
  /** What the provider itself said (ERRORS-NAME-THE-SERVICE scope B): one line, at most PROVIDER_SAID_MAX characters, with
   * keys, bearer strings, emails and link paths removed on the server (server/provider-said.ts). Shown as data, never as a
   * link or markup, under "What <service> said". */
  providerSaid?: string;
  /** The team id the provider named for the key (xAI), when it named one. */
  providerTeam?: string;
}

/** The longest provider sentence kept on a provider error. */
export const PROVIDER_SAID_MAX = 300;

/** Provider sentences Murage has a plain line for. Each is keyed to the service that writes it, so another provider's text
 * that happens to read the same never picks it. */
export type ProviderSaidNote = "xai-spend-limit";
const XAI_SPEND_LIMIT = /used all available credits or reached its monthly spending limit/i;
// The xAI API key routes only. Grok Build (grokAgent) and the Grok plan sign-in run on the grok.com plan, never the key
// (server/drivers/acp/grok.ts strips every API key from its env), so xAI's team wording does not describe them.
const XAI_SERVICE = new Set(["grok", "xai"]);

/** The plain line for what the provider said, when Murage knows it. xAI answers 402 with "Your team ... has either used all
 * available credits or reached its monthly spending limit": a team that still has credit has hit its spending limit, which
 * the owner raises in xAI billing. It stays a payment kind (not spend-cap): xAI's limit is the owner's own setting and
 * billing is where it is raised. */
export function providerSaidNote(info: Pick<ProviderErrorInfo, "kind" | "providerSaid" | "engine" | "connection"> | undefined): ProviderSaidNote | undefined {
  if (!info || typeof info.providerSaid !== "string") return undefined;
  if (info.kind !== "payment" && info.kind !== "credits" && info.kind !== "spend-cap") return undefined;
  const xai = (typeof info.connection?.preset === "string" && XAI_SERVICE.has(info.connection.preset))
    || (info.connection === undefined && typeof info.engine === "string" && XAI_SERVICE.has(info.engine));
  return xai && XAI_SPEND_LIMIT.test(info.providerSaid) ? "xai-spend-limit" : undefined;
}

/** xAI's billing page, where a team's credit and spending limit are set. */
export const XAI_BILLING_PAGE = "https://console.x.ai/";

/** A support address at the provider's own domain, which a capped account's
 * rejection carries where a billing URL would otherwise be. Anchored at both
 * ends of the host so `fluxrouter.ai.evil.invalid` and `notfluxrouter.ai`
 * are not the provider, exactly as the URL form refuses those hosts. */
const FLUX_ROUTER_CONTACT = /[\w.+-]+@fluxrouter\.ai(?![\w.-])/;

function fluxRouterSource(message: string): boolean {
  for (const match of message.matchAll(/(?:^|[\s("'<>])(https:\/\/[^\s"'<>]+)/g)) {
    try {
      const url = new URL(match[1]);
      if (url.hostname === "fluxrouter.ai" && !url.username && !url.password && (!url.port || url.port === "443")) return true;
    } catch { /* malformed provider URL is not identity evidence */ }
  }
  return FLUX_ROUTER_CONTACT.test(message);
}

/** A ceiling the ACCOUNT has reached, as opposed to a balance it has spent.
 *
 * These are not the same failure and they do not have the same answer. An
 * exhausted balance is fixed by adding credit; a monthly ceiling is not —
 * Flux Router's own words are "the ceiling rises automatically as your
 * account builds payment history — adding credit will not lift it". Sending
 * someone to buy credit here costs them money and changes nothing, so the
 * two are classified apart and answered apart.
 *
 * Matched on the machine code where the provider sends one and on the
 * ceiling sentence where it sends only prose; the OpenAI-compatible route
 * puts the bare code in `message`, the Anthropic-compatible route puts the
 * sentence there, and the ACP route wraps the sentence in its own. */
const SPEND_CAP = /account_monthly_budget_exhausted|monthly spend ceiling/i;

/** Only actual structured HTTP status establishes the error category. */
export function classifyProviderError(error: unknown, flux = false): ProviderErrorInfo | undefined {
  if (!error || typeof error !== "object") return undefined;
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const { http_status: status, message: detail } = data as { http_status?: unknown; message?: unknown };
  const message = typeof detail === "string" ? detail.slice(0, 4096) : "";
  const kind: ProviderErrorInfo["kind"] | undefined = status === 402 && SPEND_CAP.test(message) ? "spend-cap"
    : status === 402 && /credit balance is exhausted/i.test(message) ? "credits"
      : status === 402 ? "payment" : status === 401 ? "authentication" : status === 403 ? "permission"
      : status === 429 ? "rate-limit" : status === 503 ? "unavailable" : undefined;
  if (!kind || typeof status !== "number") return undefined;
  const envelope = data as { body?: unknown; code?: unknown; error?: unknown };
  const refusal = envelope.body ?? (envelope.code || envelope.error ? data : detail);
  if (flux && classifyFluxRefusal(status, refusal) === "budget") {
    return { kind, httpStatus: status, provider: "flux-router", fluxBudget: true };
  }
  return { kind, httpStatus: status, ...(kind !== "payment" && fluxRouterSource(message) ? { provider: "flux-router" as const } : {}) };
}

/** True when a rejection's own text names the Flux Router as its source, whatever its kind. `classifyProviderError` leaves `provider` off a
 *  plain 402 on purpose (its card must not claim the router), so a caller that only needs to know "did this come from Flux" asks here. */
export function isFluxRouterRejection(error: unknown): boolean {
  const data = error && typeof error === "object" ? (error as { data?: unknown }).data : undefined;
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const detail = (data as { message?: unknown }).message;
  return typeof detail === "string" && fluxRouterSource(detail.slice(0, 4096));
}

/** Which local lease another thread holds. Contention between this device's own
 * threads is not a provider rejection and never needs account or model setup. */
export type LocalResource = "working-folder" | "computer" | "browser" | "shared";
export interface LocalResourceConflict { kind: "resource-busy"; resource: LocalResource }

/** The exact copy the server uses when a thread cannot claim a resource another
 * thread holds (the `resource_busy` admission conflict in
 * `server/independent-thread-runs.ts`). Direct-turn setup now waits instead of
 * refusing; the setup copies stay so messages saved by earlier builds keep
 * their card. Matched verbatim, never by pattern. */
export const LOCAL_RESOURCE_BUSY_MESSAGES: ReadonlyMap<string, LocalResource> = new Map([
  ["Another thread is using this working folder. Wait for it to finish.", "working-folder"],
  ["Another thread is using this computer. Wait for it to finish.", "computer"],
  ["Another thread is using this browser profile. Wait for it to finish.", "browser"],
  ["Another thread is using this browser, computer or working folder.", "shared"],
]);

/** A local lease refusal is recorded with no diagnostic details. Engine and
 * provider failures always carry details, so provider text that merely repeats
 * this copy keeps the ordinary runtime or provider card. */
export function classifyLocalResourceConflict(message: unknown, details?: unknown): LocalResourceConflict | undefined {
  if (typeof message !== "string" || details) return undefined;
  const resource = LOCAL_RESOURCE_BUSY_MESSAGES.get(message.trim());
  return resource ? { kind: "resource-busy", resource } : undefined;
}

/** Part of THIS device that a turn needed and Murage could not set up: the
 * built-in browser, the bot's computer (Local VM, this Mac's CUA Driver, a
 * VPS or cloud box), or its working folder. None is a model-provider problem,
 * so none may be answered with "choose another configured model in Provider
 * settings". The server tags the failure where it knows the source
 * (`Message.tool.localFailure`); the tag is read from that structured field
 * only, never inferred from engine or provider text. */
export const LOCAL_SETUP_FAILURES = [
  "browser", "computer", "working-folder",
  // A bot's own engine folder (server/drivers/scoped-cli-home.ts ScopeUnavailableError.code): busy, could not be built, or the
  // engine is too old / unreadable to be given one. The card words these in the owner's language from the code (and the engine name).
  "engine-folder-busy", "engine-folder-unavailable", "engine-update-required",
  // The bot's engine folder shares the owner's sign-in through a link: not allowed here (no symlink rights), or no longer one file.
  "engine-symlink-required", "engine-login-link-lost",
  // The owner's engine settings file that a bot's copy is made from cannot be read: the copy is removed and the turn does not start.
  "engine-config-invalid", "engine-hook-repair-failed",
  // Windows: Murage's native helper (murage-browser-host.exe) that makes Claude's owner-only folders is missing or could not run
  // (antivirus quarantine is the usual cause). Fail-closed: the turn does not start. Worded from the code (runtimeError.local.windows-helper.*).
  "windows-helper",
  // S5-DATADIR-PATHS r4.1 section 6: a stored folder from an earlier data-folder location that could not be matched (data-dir-moved),
  // and a linked workspaces or Claude accounts folder that now points somewhere else (data-root-changed). Worded from the code.
  "data-dir-moved", "data-root-changed", "data-root-changed-providers",
  "skill-link-foreign", "skill-link-staging", "pinned-procedures",
] as const;
export type LocalSetupFailure = (typeof LOCAL_SETUP_FAILURES)[number];
/** The fixed fallback for a safety-file repair refusal; the card localizes this code. */
export const engineHookRepairFailureLine = (engine: string): string => `Murage couldn't put its tool check for ${engine} back in place, so this turn didn't start. Restart Murage, then send again.`;
/** The failures worded from their code in the owner's language with the engine named (runtimeError.local.<code>.*). */
export const ENGINE_FOLDER_FAILURES = [
  "engine-folder-busy", "engine-folder-unavailable", "engine-update-required", "engine-symlink-required", "engine-login-link-lost", "engine-config-invalid", "engine-hook-repair-failed",
] as const satisfies readonly LocalSetupFailure[];
export type EngineFolderFailure = (typeof ENGINE_FOLDER_FAILURES)[number];
export const isEngineFolderFailure = (value: unknown): value is EngineFolderFailure => (ENGINE_FOLDER_FAILURES as readonly unknown[]).includes(value);
/** The failures whose card body is worded from the code (runtimeError.local.<code>.message), not the recorded English line. */
export const DATA_FOLDER_FAILURES = ["data-dir-moved", "data-root-changed", "data-root-changed-providers"] as const satisfies readonly LocalSetupFailure[];
export const SKILL_LINK_FAILURES = ["skill-link-foreign", "skill-link-staging", "pinned-procedures"] as const satisfies readonly LocalSetupFailure[];
export const isWordedLocalFailure = (value: unknown): value is (typeof SKILL_LINK_FAILURES)[number] | EngineFolderFailure | "windows-helper" | (typeof DATA_FOLDER_FAILURES)[number] => (SKILL_LINK_FAILURES as readonly unknown[]).includes(value) || isEngineFolderFailure(value) || value === "windows-helper" || (DATA_FOLDER_FAILURES as readonly unknown[]).includes(value);

/** The browser engine's own failure copy (server/browser-engine.ts), as
 * earlier builds recorded it when a browser check failed the whole turn.
 * Those turns carry no tag, so this keeps their saved card honest. Matched
 * verbatim, and like a lease refusal only when there are no engine details:
 * a Murage setup failure is recorded without them. */
const LEGACY_BROWSER_SETUP_FAILURE = /^(?:agent-browser command timed out|agent-browser command failed \((?:-?\d+|null)\)|agent-browser \d+\.\d+\.\d+ is required|MURAGE_AGENT_BROWSER_PATH is not a readable executable file|No verified pinned agent-browser or executable on PATH; install the optional browser engine)$/;

export function classifyLocalSetupFailure(message: unknown, details?: unknown, tagged?: unknown): LocalSetupFailure | undefined {
  if (typeof tagged === "string" && (LOCAL_SETUP_FAILURES as readonly string[]).includes(tagged)) return tagged as LocalSetupFailure;
  if (typeof message !== "string" || details) return undefined;
  return LEGACY_BROWSER_SETUP_FAILURE.test(message.trim()) ? "browser" : undefined;
}

/** The renderer consumes fixed copy, never provider-supplied details or URLs. */
export function providerErrorPresentation(info: ProviderErrorInfo): { title: string; summary: string; resolution: string; billingUrl?: string } {
  const provider = info?.provider === "flux-router" ? "Flux Router" : "Your AI service";
  switch (info?.kind) {
    case "payment": return {
      title: "Payment or account access needed",
      summary: "Your AI service said payment or account access is needed. That does not always mean you are out of credit.",
      resolution: "Check billing and access with your AI service, including your own key if you use one, and that your account can use the model you picked. Then try again.",
    };
    // No billing link: the whole point of this case is that buying something
    // does not clear it.
    case "spend-cap": return {
      title: `${provider} has reached its monthly spending limit`,
      summary: "The account reached the spending limit set for it this month, so no more requests will run until that limit resets or is raised.",
      resolution: "The limit rises on its own as the account builds up payment history, so adding credit will not lift it. Ask your AI service to raise it sooner, or pick another AI in Models & engines.",
    };
    case "credits": return {
      title: `${provider} needs credits`,
      summary: "Your AI service says the account has run out of credit, so this reply could not finish.",
      resolution: "If you have already added credits, try again once the new balance shows. You can also pick another AI in Models & engines.",
      ...(info.provider === "flux-router" ? { billingUrl: FLUX_BILLING_PAGE } : {}),
    };
    case "authentication": return { title: `${provider} did not accept the sign-in`, summary: "Your AI service did not accept the sign-in or key used for this request.", resolution: "Check this AI's sign-in or key in Models & engines, then try again." };
    case "permission": return { title: `${provider} denied access`, summary: "Your AI service refused this request. You may still be signed in.", resolution: "Check that your account can use the model you picked, or pick another AI in Models & engines." };
    case "rate-limit": return { title: `${provider} request limit reached`, summary: "Your AI service is limiting requests right now. This can be a short pause or a limit on the account.", resolution: "Check your AI service's limit and when it resets, then try again, or pick another AI in Models & engines." };
    case "unavailable": return { title: `${provider} is temporarily unavailable`, summary: "Your AI service is busy right now.", resolution: "Wait a moment, then try again, or pick another AI in Models & engines." };
    default: return { title: "Your AI service could not finish this", summary: "There are no more details saved for this error.", resolution: "Try again. If it happens again, check the AI you picked in Models & engines." };
  }
}

/** A failed turn is stored in the transcript as `error: <message>` with the
 * message cut at this many characters (server/index.ts), and the card shows
 * exactly that. Anything a driver writes longer than this is cut there
 * mid-word with no ellipsis, so engine text is ended cleanly inside the same
 * budget instead. */
export const ERROR_MESSAGE_MAX = 160;

/** Technical-details line the ACP driver writes for a typed engine failure:
 * Fuigo's `error.data.error_kind` (server/drivers/acp/core.ts). */
export const ENGINE_ERROR_KIND_PREFIX = "Engine error kind: ";

/** Engine failure kinds Murage has reviewed copy for, one catalog string each
 * (`runtimeError.engineKind.<kind>`). Fuigo 1.0.18 is the source of the
 * spellings; the older ones stay as aliases below so an engine mid upgrade
 * still gets its copy. A kind that is not one of these gets no explanation. */
export const ENGINE_ERROR_CATEGORIES = [
  // Model-request kinds (fuigo-sampler `SamplingErrorKind::as_str`).
  "empty_response", "idle_timeout", "cancelled", "rate_limited",
  "auth", "http", "api", "max_tokens_truncation", "doom_loop_detected", "serialization",
  // Agent-side kinds (fuigo-shell `AcpErrorKind::as_str`). `internal` is the
  // one a request with no more specific kind is stamped with, so it is the
  // kind Murage sees most often.
  "session_unavailable", "internal", "invalid_request", "not_found", "session_storage",
  "compaction", "execution_incomplete",
] as const;
export type EngineErrorCategory = (typeof ENGINE_ERROR_CATEGORIES)[number];

/** Older or alternate spellings that resolve to a canonical kind. The
 * canonical side is always the token Fuigo puts on the wire
 * (`fuigo-sampler/src/events.rs` `SamplingErrorKind::as_str`). */
const ENGINE_ERROR_ALIASES: ReadonlyMap<string, EngineErrorCategory> = new Map([
  ["rate_limit", "rate_limited"],
  ["doom_loop", "doom_loop_detected"],
]);

/** The kind the ACP driver read out of `error.data.error_kind` and carried as
 * its own event field (`runtime.error.errorKind`).
 *
 * It is deliberately NOT parsed back out of the error text: the transcript's
 * technical details begin with the engine's own message, so an engine whose
 * one-line message reads "Engine error kind: auth" would otherwise choose the
 * explanation shown to the user. Text an engine wrote describes the engine;
 * it is never evidence about it. */
export function engineErrorCategory(kind: unknown): EngineErrorCategory | undefined {
  if (typeof kind !== "string") return undefined;
  const canonical = ENGINE_ERROR_ALIASES.get(kind) ?? kind;
  return (ENGINE_ERROR_CATEGORIES as readonly string[]).includes(canonical)
    ? canonical as EngineErrorCategory
    : undefined;
}

/** Codes a failed CONNECTION raises, as distinct from a server that answered
 *  badly. undici wraps all of these in `TypeError("fetch failed")`, whose
 *  message is what a user used to be shown, whole. */
const CONNECT_FAILURE_CODES = new Set([
  "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "EHOSTUNREACH",
  "ENETUNREACH", "EPIPE", "ETIMEDOUT", "ERR_SOCKET_CONNECTION_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
]);

/** True when this error means "the address never answered", not "the server
 *  answered with something I did not like". Walks `cause`, because that is
 *  where undici puts the real errno.
 *
 *  CONNECT FAILURES ONLY. Several of these codes — ECONNRESET, EPIPE,
 *  UND_ERR_SOCKET, ETIMEDOUT — are raised just as readily by a connection that
 *  died halfway through a reply, and nothing in the error distinguishes the
 *  two. Call this only where the caller knows nothing has been received yet
 *  (see `reached` in server/drivers/openai-chat.ts); asked about a failure
 *  after bytes have arrived it answers true and the answer is wrong. */
export function isEndpointUnreachable(error: unknown): boolean {
  for (let step: unknown = error, depth = 0; step instanceof Error && depth < 5; depth++) {
    const code = (step as NodeJS.ErrnoException).code;
    if (typeof code === "string" && CONNECT_FAILURE_CODES.has(code)) return true;
    if (step.name === "TypeError" && step.message === "fetch failed" && !(step.cause instanceof Error)) return true;
    step = (step as { cause?: unknown }).cause;
  }
  return false;
}

/** The codes a request never leaves the client on: the name did not resolve, the address refused or never answered the connection,
 *  or the TLS handshake failed. The rest of CONNECT_FAILURE_CODES (a reset, a broken pipe, a dead socket, a timeout) is raised just
 *  as readily once the request is on the wire and the server may have read it. */
const NEVER_CONNECTED_CODES = new Set([
  "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ERR_SOCKET_CONNECTION_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT",
  "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "ERR_TLS_CERT_ALTNAME_INVALID",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_INVALID_URL",
]);

/** True when this failure proves the request was never delivered: no connection to the address was ever made, so nothing of it
 *  was written (turn-attribution.ts I14, Astra r5 order 2). Any other failure may have come after the server read the request
 *  (a connection that broke, a server that went quiet) and proves nothing either way: the caller leaves what it stamped. */
export function neverConnected(error: unknown): boolean {
  for (let step: unknown = error, depth = 0; step instanceof Error && depth < 5; depth++) {
    const code = (step as NodeJS.ErrnoException).code;
    if (typeof code === "string" && NEVER_CONNECTED_CODES.has(code)) return true;
    step = (step as { cause?: unknown }).cause;
  }
  return false;
}

/** `http://192.168.1.50:11434/v1` → `192.168.1.50:11434`. Never the path
 *  and never the query: a base URL can carry a key in either. Falls back to the
 *  raw string only when it will not parse, and never to an empty name. */
export function endpointName(url: string | undefined | null): string {
  if (!url?.trim()) return "the model server";
  try {
    return new URL(url).host || "the model server";
  } catch {
    return url.split("/").filter(Boolean)[1] ?? "the model server";
  }
}

/** What the chat bubble says when the model server never answered.
 *
 *  It used to say `fetch failed`, in full — undici's own words, escaping
 *  before the driver's label was applied. That sentence names no host, no
 *  engine and no next step, and it is the exact message a user gets when their
 *  llama.cpp box is off or the tailnet drops, which is the commonest local
 *  failure there is. Wording follows the Local models screen, which already
 *  had the right sentence for this ("Nothing answered at this address. Start
 *  the server, then check again." — src/components/LocalModelsSettings.tsx).
 *  Stays inside ERROR_MESSAGE_MAX so the transcript does not truncate it. */
export function unreachableEndpointMessage(url: string | undefined | null): string {
  return `Could not reach ${endpointName(url)}: nothing answered there. Check that the server is running and that its address is right.`;
}
