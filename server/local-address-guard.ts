// Plain http to a local model server by NAME (gpubox, gpubox.tailnet.ts.net,
// nas.local, …). The shared rule only knows the name looks local; this module
// is the server's authority on where it actually points.
//
// Rule: plain http to a `local-name` is allowed only when EVERY address the
// name resolves to is loopback, private (RFC1918, IPv6 ULA), link-local or
// tailnet. A name that resolves to nothing, or to any public address, is
// refused. The check runs when a server is added or edited AND again before
// every request Murage sends to it, so a name that later starts resolving to
// a public address (DNS rebinding, a changed record) gets no request and no
// key over plain http.
//
// IP literals and https need no resolution: the shared rule already decided.
import { lookup as dnsLookup } from "node:dns/promises";

import { classifyIpAddress, classifyLocalHostname } from "../shared/local-models.ts";

export interface ResolvedLocalAddress {
  address: string;
  family: number;
}

export type LocalNameLookup = (hostname: string) => Promise<readonly ResolvedLocalAddress[]>;

export type LocalAddressCheck =
  | { ok: true }
  | { ok: false; code: "https-required" | "unresolved-address" };

const LOOKUP_TIMEOUT_MS = 3_000;

const systemLookup: LocalNameLookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

let activeLookup: LocalNameLookup = systemLookup;

/** Tests swap the resolver; `null` restores the system one. */
export function setLocalNameLookupForTests(lookup: LocalNameLookup | null): void {
  activeLookup = lookup ?? systemLookup;
}

async function resolveWithTimeout(lookup: LocalNameLookup, hostname: string, timeoutMs: number): Promise<readonly ResolvedLocalAddress[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([lookup(hostname).catch(() => null), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * May Murage send a request to this URL? Only plain http to a `local-name`
 * does any work; everything else answers from the shared rule.
 */
export async function checkLocalServerUrl(
  rawUrl: string,
  lookup: LocalNameLookup = activeLookup,
  timeoutMs: number = LOOKUP_TIMEOUT_MS,
): Promise<LocalAddressCheck> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, code: "unresolved-address" };
  }
  if (url.protocol !== "http:") return { ok: true };
  const addressClass = classifyLocalHostname(url.hostname);
  if (addressClass === "public") return { ok: false, code: "https-required" };
  if (addressClass !== "local-name") return { ok: true };
  const hostname = url.hostname.replace(/\.$/, "");
  const addresses = await resolveWithTimeout(lookup, hostname, timeoutMs);
  if (!addresses || addresses.length === 0) return { ok: false, code: "unresolved-address" };
  if (addresses.some((entry) => classifyIpAddress(entry.address) === "public")) return { ok: false, code: "https-required" };
  return { ok: true };
}
