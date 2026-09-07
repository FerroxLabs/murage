import { normalizeAccountAlias } from "./composio.ts";

export interface ConnectorRequest {
  slug: string;
  alias?: string;
}

export function connectorRequestKey(request: ConnectorRequest): string {
  return JSON.stringify([request.slug.trim().toLowerCase(), request.alias?.trim().toLowerCase() ?? ""]);
}

/** Structured requests take precedence; legacy callers can still send slugs. */
export function parseConnectorRequests(body: { items?: unknown; slugs?: unknown }): ConnectorRequest[] {
  const rawItems = Array.isArray(body.items) ? body.items : Array.isArray(body.slugs) ? body.slugs : [];
  const items: ConnectorRequest[] = [];
  const seen = new Set<string>();
  for (const raw of rawItems) {
    const row = typeof raw === "string" ? { slug: raw } : raw;
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const value = row as { slug?: unknown; toolkit?: unknown; alias?: unknown; account?: unknown };
    const rawSlug = value.slug ?? value.toolkit;
    if (typeof rawSlug !== "string") continue;
    const slug = rawSlug.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,80}$/.test(slug)) continue;
    const alias = normalizeAccountAlias((value.alias ?? value.account) as string | null | undefined);
    const item = { slug, ...(alias ? { alias } : {}) };
    const key = connectorRequestKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  return items;
}

/** Toolkit readiness never proves readiness of a specifically requested account. */
export function connectorRequestStatus(
  service: { connected?: boolean; pending?: boolean; status?: string; accounts?: { alias?: string; status: string }[] } | undefined,
  alias?: string,
): { connected: boolean; pending: boolean; status: string } {
  if (!alias) return { connected: service?.connected === true, pending: service?.pending === true, status: service?.status ?? "not_connected" };
  const account = service?.accounts?.find((item) => item.alias?.trim().toLowerCase() === alias.trim().toLowerCase());
  const status = account?.status ?? "not_connected";
  return { connected: /^active$/i.test(status), pending: /^(initiated|initializing|pending)$/i.test(status), status };
}
