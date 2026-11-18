/** Request destination is the only authority for Flux refusal policy. Keep the
 * original URL for the transport; no provider name, model or credential is read. */
export function fluxRouteFor<T extends string | URL | Request | null | undefined>(requestUrl: T): { requestUrl: T; routed: boolean } {
  let routed = false;
  try {
    const url = new URL(typeof requestUrl === "object" && requestUrl !== null && "url" in requestUrl ? requestUrl.url : String(requestUrl));
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    routed = (url.protocol === "https:" || url.protocol === "http:")
      && (host === "fluxrouter.ai" || host.endsWith(".fluxrouter.ai"));
  } catch { /* No concrete URL means no Flux policy. */ }
  return { requestUrl, routed };
}

/** Identity marker for AST discovery. The kind distinguishes a raw decode from
 * an adapter boundary; the inventory checks the surrounding executable call. */
export function registerBusyloopPayloadSite<T>(kind: "read" | "classify", payload: T): T {
  void kind;
  return payload;
}

/** CLI/RPC transports construct a model prompt separately from their configured
 * URL. Keep that URL decision beside the prompt for structural verification. */
export function registerBusyloopRequestSite<T>(route: ReturnType<typeof fluxRouteFor>, payload: T): T {
  void route;
  return payload;
}

/** An engine with no provider URL surface must cite the enforced restriction,
 * rather than pretending that a provider label is a request URL. */
export interface NoFluxTraffic { citation: string; reason: string }
export function noFluxTraffic(proof: NoFluxTraffic): undefined {
  void proof;
  return undefined;
}
