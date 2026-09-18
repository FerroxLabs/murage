/** Safe structured facts about a provider rejection. No request/response text. */
export interface ProviderErrorInfo {
  kind: "credits" | "payment" | "authentication" | "permission" | "rate-limit" | "unavailable";
  provider?: "flux-router";
  httpStatus: number;
}

function fluxRouterSource(message: string): boolean {
  for (const match of message.matchAll(/(?:^|[\s("'<>])(https:\/\/[^\s"'<>]+)/g)) {
    try {
      const url = new URL(match[1]);
      if (url.hostname === "fluxrouter.ai" && !url.username && !url.password && (!url.port || url.port === "443")) return true;
    } catch { /* malformed provider URL is not identity evidence */ }
  }
  return false;
}

/** Only actual structured HTTP status establishes the error category. */
export function classifyProviderError(error: unknown): ProviderErrorInfo | undefined {
  if (!error || typeof error !== "object") return undefined;
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const { http_status: status, message: detail } = data as { http_status?: unknown; message?: unknown };
  const message = typeof detail === "string" ? detail.slice(0, 4096) : "";
  const kind: ProviderErrorInfo["kind"] | undefined = status === 402 && /credit balance is exhausted/i.test(message) ? "credits"
    : status === 402 ? "payment" : status === 401 ? "authentication" : status === 403 ? "permission"
      : status === 429 ? "rate-limit" : status === 503 ? "unavailable" : undefined;
  if (!kind || typeof status !== "number") return undefined;
  return { kind, httpStatus: status, ...(kind !== "payment" && fluxRouterSource(message) ? { provider: "flux-router" as const } : {}) };
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
export const LOCAL_SETUP_FAILURES = ["browser", "computer", "working-folder"] as const;
export type LocalSetupFailure = (typeof LOCAL_SETUP_FAILURES)[number];

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
  const provider = info?.provider === "flux-router" ? "Flux Router" : "Your model provider";
  switch (info?.kind) {
    case "payment": return {
      title: "Provider payment or account access required",
      summary: "The provider rejected this request with HTTP 402. This response does not establish that credits are exhausted.",
      resolution: "Check the provider's billing, account and selected-model access, including bring-your-own-key (BYOK) settings, before retrying.",
    };
    case "credits": return {
      title: `${provider} needs credits`,
      summary: "The provider reported that its available credit balance was exhausted. The model could not complete this request.",
      resolution: "If you have already added credits, retry once the updated balance is available. You can also choose another configured engine.",
      ...(info.provider === "flux-router" ? { billingUrl: "https://fluxrouter.ai/home/billing" } : {}),
    };
    case "authentication": return { title: `${provider} could not authenticate`, summary: "The provider rejected the credentials used for this request.", resolution: "Review this engine's sign-in or API-key configuration in Engines & Models, then retry." };
    case "permission": return { title: `${provider} denied access`, summary: "The provider refused permission for this request. This does not necessarily mean you are signed out.", resolution: "Check that the account has access to the selected model and service, or choose another configured engine." };
    case "rate-limit": return { title: `${provider} request limit reached`, summary: "The provider reported a request limit. This may be a short-term rate limit or an account quota.", resolution: "Check the provider's limit and reset time before retrying, or choose another configured engine." };
    case "unavailable": return { title: `${provider} is temporarily unavailable`, summary: "The provider returned a service-unavailable response.", resolution: "Retry later or choose another configured engine." };
    default: return { title: "Provider request failed", summary: "Detailed provider information is unavailable for this saved error.", resolution: "Review the selected engine's configuration before retrying." };
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
  return `Could not reach ${endpointName(url)} — nothing answered there. Check that the server is running and that its address is right.`;
}
