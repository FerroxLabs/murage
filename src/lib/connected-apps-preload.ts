// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { api } from "@/state/store";
import { readCachedInventory, writeCachedInventory } from "./connected-apps-cache";
import type { AppCard as ToolkitCard } from "./app-catalog";

export interface ConnectorStatus {
  connected: boolean;
  pending?: boolean;
  status?: string;
  accounts?: Array<{
    id: string;
    alias?: string;
    status: string;
  }>;
}

// The panel is a modal and unmounts whenever it closes. Keep the last known
// account inventory at module scope so reopening never flashes every service
// as disconnected while a fresh secure status check runs in the background.
export let cachedConnectorStatus: Record<string, ConnectorStatus> | null = null;
export let cachedConnectorStatusAt = 0;
export let cachedConnectorStatusAuthoritative = true;
let connectorStatusRequest: Promise<ConnectorInventory> | null = null;
/** The server's card for every connected slug (logo, name), kept with the
 * inventory so the Connected tab can show apps no loaded list carries. */
export let inventoryApps: Record<string, ToolkitCard> = {};

/** true after the last inventory answer said credentials.bin could not be
 * read this launch. Config then cannot vouch for which keys exist, so the
 * lock stands down and the panel shows what it remembers, as it always did. */
let credentialStoreUnreadable = false;
const CONNECTOR_STATUS_CACHE_MS = 30_000;
export interface ConnectorInventory {
  services: Record<string, ConnectorStatus>;
  /** false when the server could not read the credential store: the list is
   * then "we do not know", and nothing may be cleared on the strength of it */
  authoritative: boolean;
  /** false when the server answered before its connection backend was
   * ready (the first moments after a launch or an update). Its empty list
   * means "not yet", never "nothing is connected". */
  backendReady?: boolean;
  /** a card for each connected slug, from the server's held catalog */
  apps?: Record<string, ToolkitCard>;
  /** the server answered from what it last knew and is refreshing it: usable
   * now, ask again shortly */
  revalidating?: boolean;
}

/** Warm the account inventory once the app server is ready. Concurrent panel
 * opens share the same request, and recent data survives modal unmounts. */
export function preloadConnectedApps(force = false, serverForce = force): Promise<ConnectorInventory> {
  if (!force && cachedConnectorStatus !== null && Date.now() - cachedConnectorStatusAt < CONNECTOR_STATUS_CACHE_MS) {
    return Promise.resolve({
      services: cachedConnectorStatus,
      authoritative: cachedConnectorStatusAuthoritative,
      apps: inventoryApps,
    });
  }
  if (connectorStatusRequest) return connectorStatusRequest;
  connectorStatusRequest = api(serverForce ? "/api/connectors/connected?force=1" : "/api/connectors/connected")
    .then((response) => {
      const services: Record<string, ConnectorStatus> = response.services ?? {};
      // An unreadable credential store tells us nothing about what is
      // connected. Keep the last inventory we were sure about instead.
      if (response.credentialStore === "unavailable") {
        credentialStoreUnreadable = true;
        return { services: readCachedInventory()?.services ?? {}, authoritative: false };
      }
      credentialStoreUnreadable = false;
      // Not ready yet: remembered accounts, if any, stand; nothing is cached
      // on the strength of an answer that does not know.
      if (response.configured === false) {
        return { services: readCachedInventory()?.services ?? {}, authoritative: false, backendReady: false };
      }
      // The server has nothing remembered and its first answer has not come
      // back yet: an empty list here is "not yet", never "nothing connected".
      if (response.known === false) {
        return { services: readCachedInventory()?.services ?? {}, authoritative: false, revalidating: true };
      }
      const revalidating = response.revalidating === true;
      cachedConnectorStatus = services;
      // A list still being refreshed is not held as fresh: the next ask goes out.
      cachedConnectorStatusAt = revalidating ? 0 : Date.now();
      cachedConnectorStatusAuthoritative = true;
      if (response.apps && typeof response.apps === "object") inventoryApps = { ...inventoryApps, ...response.apps };
      writeCachedInventory(services, Date.now());
      return { services, authoritative: true, apps: inventoryApps, ...(revalidating ? { revalidating } : { revalidating: false }) };
    })
    .catch(() => ({ services: readCachedInventory()?.services ?? {}, authoritative: false }))
    .finally(() => {
      connectorStatusRequest = null;
    });
  return connectorStatusRequest;
}

/** The inventory request already in flight, if any — the app warms one on
 * connect. The locked panel awaits THIS rather than starting its own, so it
 * learns whether the credential store was readable without sending a single
 * connector request of its own. */
export function pendingConnectedApps(): Promise<ConnectorInventory> | null {
  return connectorStatusRequest;
}

export function isCredentialStoreUnreadable(): boolean {
  return credentialStoreUnreadable;
}

export function rememberConnectedApps(services: Record<string, ConnectorStatus>, authoritative: boolean) {
  // A list the server said it is still refreshing keeps its "not fresh" stamp:
  // re-stamping it would make a reopen skip the server for 30 seconds.
  const stillRefreshing = cachedConnectorStatus !== null && cachedConnectorStatusAt === 0;
  cachedConnectorStatus = services;
  if (!stillRefreshing) cachedConnectorStatusAt = Date.now();
  cachedConnectorStatusAuthoritative = authoritative;
}
