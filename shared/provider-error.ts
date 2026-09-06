/** Safe structured facts about a provider rejection. No request/response text. */
export interface ProviderErrorInfo {
  kind: "credits" | "authentication" | "permission" | "rate-limit" | "unavailable";
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
    : status === 401 ? "authentication" : status === 403 ? "permission"
      : status === 429 ? "rate-limit" : status === 503 ? "unavailable" : undefined;
  if (!kind || typeof status !== "number") return undefined;
  return { kind, httpStatus: status, ...(fluxRouterSource(message) ? { provider: "flux-router" as const } : {}) };
}

/** The renderer consumes fixed copy, never provider-supplied details or URLs. */
export function providerErrorPresentation(info: ProviderErrorInfo): { title: string; summary: string; resolution: string; billingUrl?: string } {
  const provider = info?.provider === "flux-router" ? "Flux Router" : "Your model provider";
  switch (info?.kind) {
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
