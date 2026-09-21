// A FLUX ROUTER KEY, SAVED FROM THE CHAT.
//
// Two jobs, and the second is the one that matters.
//
// 1. The key card has a paste field, and what it pastes must travel the
//    SAME road the Settings card uses: `window.muragebox.mutateFluxConnection`,
//    the bridge that puts the secret in the operating system's keychain from
//    the main process (see src/components/ModelsSettings.tsx). A second
//    saving path would be a second thing to get wrong about a credential.
//
// 2. A person told to paste a key into a card will sometimes paste it into
//    the chat box instead, because the chat box is the thing they have been
//    typing into all morning. A key that reaches the composer's send is a
//    key in a transcript, on disk, and in the next prompt a model reads.
//    So the composer asks `detectFluxKeyInComposer` first, and a hit is
//    routed into secure storage instead of being sent.
//
// The detector is deliberately narrow. A false positive eats a sentence out
// of somebody's conversation; a false negative costs one paste into the card
// that is on screen anyway. It matches the key SHAPE only, never the word.

import type { FluxConnectionMutation, FluxConnectionStatus } from "../../shared/flux-connection";

/**
 * The shape of a Flux Router key.
 *
 * `sk-flux-…` is the spelling shared/key-extract.ts recognizes and the one
 * server/opencode-config.ts writes, and the tail is the same character class
 * with the same minimum length. Anchored, because a key is a whole token: a
 * word that merely contains one is prose about a key.
 */
const FLUX_KEY = /^sk-flux-[A-Za-z0-9_-]{16,}$/;

/** True for a string that is exactly a Flux Router key. */
export function looksLikeFluxKey(value: string): boolean {
  return FLUX_KEY.test(value.trim());
}

/**
 * Is there a Flux Router key in what they typed into the chat box?
 *
 * Returns the key and the text with it taken out, so a person who pasted a
 * key in the middle of a sentence keeps their sentence and loses only the
 * secret. Null when there is nothing key shaped in there, which is the
 * overwhelmingly common case and costs one split.
 *
 * Trailing punctuation is trimmed off a candidate before it is tested,
 * because "here: sk-flux-abc…xyz." is how a human pastes.
 */
export function detectFluxKeyInComposer(text: string): { key: string; rest: string } | null {
  const parts = text.split(/(\s+)/);
  const kept: string[] = [];
  let key = "";
  for (const part of parts) {
    if (!key && part.trim()) {
      const candidate = part.replace(/^["'`([<]+/, "").replace(/["'`)\]>.,;:!?]+$/, "");
      if (looksLikeFluxKey(candidate)) {
        key = candidate;
        continue;
      }
    }
    kept.push(part);
  }
  if (!key) return null;
  return { key, rest: kept.join("").replace(/\s+/g, " ").trim() };
}

export interface FluxKeySaveOptions {
  /** The current connection, for its revision and whether this replaces a
   *  saved key. Read from `GET /api/flux-connection`. */
  status: Pick<FluxConnectionStatus, "configured" | "revision">;
  /** The desktop bridge, when there is one. Passed in rather than read off
   *  `window` so a test can have both halves of this branch. */
  bridge?: ((change: FluxConnectionMutation) => Promise<FluxConnectionStatus>) | null;
  /** The web fallback ModelsSettings keeps, for a browser build with no
   *  Electron behind it. */
  request?: (path: string, init?: RequestInit) => Promise<any>;
  /** True inside the desktop shell. A desktop build whose bridge is missing
   *  must refuse rather than fall back to the unencrypted route. */
  desktop?: boolean;
}

export const FLUX_KEY_STORAGE_UNAVAILABLE = "Secure Flux Router storage is unavailable.";
export const FLUX_KEY_NOT_A_KEY = "That does not look like a Flux Router key. Check it and paste it again.";
/** Flux Router itself refused the key. Said on the card that took the paste,
 *  with the key nowhere in it. */
export const FLUX_KEY_REJECTED = "Flux Router did not accept that key. Check it and paste it again.";

/**
 * THE THREE THINGS THAT CAN BE TRUE OF A KEY, AND WHY THERE ARE THREE.
 *
 * `proved`    Flux Router answered with this key's own model catalogue.
 * `rejected`  Flux Router answered, and said no to this key.
 * `unproved`  Nothing got an answer out of Flux Router. Offline, rate
 *             limited, timed out, a proxy in the way, the service down.
 *
 * The third one exists because collapsing it into the second is the exact
 * cruelty this whole change is against: somebody on a train with a perfectly
 * good key must never be told their key is wrong.
 */
export type FluxKeyProof = "proved" | "rejected" | "unproved";

/** The catalogue error codes that are Flux Router refusing THIS KEY. Every
 *  other code that route can return ("offline", "rate-limited", "unavailable",
 *  "invalid-catalog", "connection-changed") is about the trip, not the key.
 *  Source: ProviderCatalogError, shared/provider-connections.ts. */
const KEY_REFUSED = new Set(["unauthorized", "forbidden"]);

/**
 * Ask Flux Router whether the saved key is real.
 *
 * `POST /api/flux-connection/test` is the check the Settings card has always
 * had, and it is a catalogue read: the server does one GET of
 * `https://api.fluxrouter.ai/v1/models` with the saved key as a bearer token
 * (server/provider-connections.ts, `refreshCatalog`). No model runs, nothing
 * is generated, and the person is billed for nothing. It is capped at fifteen
 * seconds and the result is cached against the key's revision, so the paste
 * screen cannot hang and a retry on the same key does not re-ask.
 *
 * THE KEY IS NOT A PARAMETER AND CANNOT BE. The route reads the saved
 * credential out of the keychain on the server side; nothing here has to hold
 * it, send it or be careful with it, which is the only way to be sure it is
 * never echoed into an error or a log.
 */
export async function proveFluxKey(
  request: (path: string, init?: RequestInit) => Promise<any>,
): Promise<FluxKeyProof> {
  let result: { modelCount?: unknown; code?: unknown };
  try {
    result = await request("/api/flux-connection/test", { method: "POST" });
  } catch {
    // The route refused or never answered: a 409 while the credential store
    // is mid change, a dropped connection, a server restart. None of that is
    // Flux Router's verdict on the key, so none of it may be reported as one.
    return "unproved";
  }
  const code = typeof result?.code === "string" ? result.code : "";
  if (KEY_REFUSED.has(code)) return "rejected";
  // Any other code, or a body that is not the shape this route promises, is
  // an unanswered question rather than a verdict. Proof is the affirmative
  // case only: a catalogue came back, which is Flux Router accepting the key.
  if (code || typeof result?.modelCount !== "number") return "unproved";
  return "proved";
}

/**
 * Save a key the same way the Settings card does.
 *
 * `connect` or `replace` on the same revision the status reported, so two
 * windows cannot quietly overwrite each other, which is the whole reason
 * that revision exists.
 */
export async function saveFluxKey(rawKey: string, options: FluxKeySaveOptions): Promise<FluxConnectionStatus> {
  const key = rawKey.trim();
  if (!looksLikeFluxKey(key)) throw new Error(FLUX_KEY_NOT_A_KEY);
  const change: FluxConnectionMutation = {
    action: options.status.configured ? "replace" : "connect",
    revision: options.status.revision,
    key,
  };
  if (options.desktop || options.bridge) {
    if (!options.bridge) throw new Error(FLUX_KEY_STORAGE_UNAVAILABLE);
    return options.bridge(change);
  }
  if (!options.request) throw new Error(FLUX_KEY_STORAGE_UNAVAILABLE);
  return options.request("/api/flux-connection/mutate", { method: "POST", body: JSON.stringify(change) });
}

/**
 * Save the key, then find out whether it is any good. The first run's road.
 *
 * The saving and the proving are one call because every caller needs both and
 * the defect was a caller that had only the first half. A card that wants to
 * congratulate somebody may do it on `proved` and on nothing else.
 *
 * Saving still happens first, and still happens for a key that turns out to
 * be wrong. That is deliberate: the keychain is where a key belongs the
 * moment it is pasted, the next paste replaces it on the same revision, and
 * a key held back in a React state while a network call decides its fate is
 * a key sitting in the renderer for fifteen seconds.
 */
export async function saveAndProveFluxKey(rawKey: string, options: FluxKeySaveOptions): Promise<FluxKeyProof> {
  await saveFluxKey(rawKey, options);
  // No request function means a desktop bridge save with no web fallback
  // wired in. Nothing can ask, so nothing is claimed.
  if (!options.request) return "unproved";
  return proveFluxKey(options.request);
}

/** The current connection, so a save can carry its revision. */
export async function readFluxStatus(
  request: (path: string, init?: RequestInit) => Promise<any>,
): Promise<Pick<FluxConnectionStatus, "configured" | "revision">> {
  const body = await request("/api/flux-connection");
  return { configured: Boolean(body?.configured), revision: String(body?.revision ?? "") };
}

/** The bridge as the renderer finds it, or null in a browser build. */
export function fluxBridge(): ((change: FluxConnectionMutation) => Promise<FluxConnectionStatus>) | null {
  const box = (globalThis as { muragebox?: { mutateFluxConnection?: (change: FluxConnectionMutation) => Promise<FluxConnectionStatus> } }).muragebox;
  if (!box) return null;
  return box.mutateFluxConnection ? box.mutateFluxConnection.bind(box) : null;
}
