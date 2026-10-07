// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What the connected-apps panel says about the catalog, as pure functions:
// the live count ("1,500+ apps"), why it is showing featured apps only, and
// a card for every connection whether or not the loaded list carries it.
// server/app-catalog.ts holds the catalog itself.

export type SignIn = "managed" | "own" | "none";

export interface AppCard {
  slug: string;
  label: string;
  blurb: string;
  logo: string | null;
  noAuth?: boolean;
  domain: string | null;
  signIn?: SignIn;
}

export type CatalogFallbackReason =
  | "no-backend" | "timeout" | "network" | "http" | "auth" | "rate-limited"
  | "bad-response" | "incomplete" | "identity" | "cancelled" | "loading";

/** The whole catalog's size as people read it, rounded down so it stays
 * true for a while: 1,634 is "1,600+ apps". Null until the service said. */
export function appCountLabel(total: number | null | undefined): string | null {
  if (typeof total !== "number" || !Number.isFinite(total) || total < 1) return null;
  if (total < 100) return `${Math.floor(total)} apps`;
  return `${(Math.floor(total / 100) * 100).toLocaleString("en-US")}+ apps`;
}

/** The panel's one-line claim: the live count once the catalog has said it,
 * the standing claim before then. */
export function appsClaimFor(total: number | null | undefined, standing: string): string {
  const count = appCountLabel(total);
  return count ? `${count}, including Gmail, Slack, Notion and GitHub` : standing;
}

const REASON_TEXT: Record<Exclude<CatalogFallbackReason, "loading">, string> = {
  "no-backend": "No connected-apps service is set up yet, so the full list is not available.",
  timeout: "The full list took too long to load.",
  cancelled: "The full list stopped loading before it finished.",
  network: "The full list could not be reached. Check your internet connection.",
  http: "The connected-apps service had a problem sending the full list.",
  auth: "The connected-apps service did not accept this computer's sign-in.",
  "rate-limited": "The connected-apps service is busy right now.",
  "bad-response": "The full list came back in a form Murage could not read.",
  incomplete: "The full list stopped loading part way.",
  identity: "Your connection changed while the list was loading.",
};

export interface CatalogNotice {
  tone: "warning" | "muted";
  text: string;
  /** every fallback offers Retry; only "still loading" does not need one */
  retry: boolean;
}

/**
 * Why the panel is not showing the whole catalog, in every connection mode.
 * Before 0.1.61 only an own-key install ever heard it; the managed broker
 * path, which nearly everyone uses, fell back to 24 apps in silence.
 */
export function catalogNotice(input: {
  source: "api" | "cache" | "curated" | undefined;
  reason?: CatalogFallbackReason;
  detail?: { loaded: number; total: number | null };
  savedAt?: number | null;
}): CatalogNotice | null {
  const { source, reason } = input;
  if (source === "api" || source === undefined) return null;
  if (reason === "loading") return { tone: "muted", text: "Loading the full list of apps.", retry: false };
  if (source === "cache" && !reason) return null;
  let because = reason ? REASON_TEXT[reason] : "";
  if (reason === "incomplete" && input.detail && input.detail.loaded > 0) {
    const loaded = input.detail.loaded.toLocaleString("en-US");
    because = input.detail.total
      ? `The full list stopped loading after ${loaded} of ${input.detail.total.toLocaleString("en-US")} apps.`
      : `The full list stopped loading after ${loaded} apps.`;
  }
  const lead = source === "cache" ? "Showing the app list saved earlier." : "Showing featured apps only.";
  return { tone: "warning", text: because ? `${lead} ${because}` : lead, retry: true };
}

/** A card for a slug nobody described: the panel's monogram fallback. */
export function monogramCard(slug: string): AppCard {
  const label = slug.replace(/[-_.]+/g, " ").trim().replace(/\b\w/g, (letter) => letter.toUpperCase()) || slug;
  return { slug, label, blurb: "", logo: null, domain: null };
}

interface InventoryState {
  connected: boolean;
  accounts?: ReadonlyArray<unknown>;
}

// The connection service's own plumbing, never an app of the person's.
const SERVICE_SLUG = /composio/i;

/** Whether an inventory entry is a connection the person should see. */
export function isConnection(slug: string, state: InventoryState | undefined): boolean {
  return !SERVICE_SLUG.test(slug) && Boolean(state && (state.connected || state.accounts?.length));
}

/**
 * Every connection, as cards: the Connected tab is built from the inventory,
 * never from whichever cards happen to be loaded. An app the loaded list
 * does not carry still gets its row, from the server's card for it or a
 * monogram (0.1.61: six of the owner's thirteen connections were hidden).
 */
export function connectedCards(
  status: Record<string, InventoryState>,
  known: ReadonlyArray<Record<string, AppCard> | ReadonlyArray<AppCard> | null | undefined>,
): AppCard[] {
  const index = new Map<string, AppCard>();
  for (const source of known) {
    if (!source) continue;
    const cards = Array.isArray(source) ? source : Object.values(source);
    for (const card of cards as AppCard[]) if (!index.has(card.slug)) index.set(card.slug, card);
  }
  return Object.entries(status)
    .filter(([slug, state]) => isConnection(slug, state))
    .map(([slug]) => index.get(slug) ?? monogramCard(slug))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Cards that match what is typed, for lists already on screen. */
export function matchesSearch(card: AppCard, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || `${card.label} ${card.slug} ${card.blurb}`.toLowerCase().includes(q);
}

/** The long tail's line in the panel. */
export const NEEDS_OWN_SIGN_IN_SHORT = "Needs your own sign-in details";
