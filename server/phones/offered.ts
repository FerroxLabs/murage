// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The facts that decide whether this host offers phone tools at all. */
export interface OfferFacts {
  features: Record<string, unknown> | undefined;
  cloudRole: string | undefined;
  launchProof: boolean;
  sharedWorkspace: boolean;
}

/** On only with the flag set to exactly true, on a desktop host (not a Cloud home), with the desktop's launch proof, in an unshared workspace. */
export function phonesOffered(f: OfferFacts): boolean {
  return f.features?.phoneTools === true && f.cloudRole !== "home" && f.launchProof && !f.sharedWorkspace;
}

/** On only with its own flag set to exactly true (independent of `phoneTools`), on a desktop host, with the launch proof, in an unshared workspace. */
export function shareAskOffered(f: OfferFacts): boolean {
  return f.features?.phoneShareAsk === true && f.cloudRole !== "home" && f.launchProof && !f.sharedWorkspace;
}

export type PhoneFamily = "jobs" | "ask" | "bootstrap" | "admin";

/**
 * Which feature family a /api/phones path belongs to. Ask: the three share and ask routes (exact method and path) and the
 * ask revoke. Bootstrap: the challenge and token routes (either flag), plus the companion's minted report. Admin: the
 * list and the revoke. Jobs: every other /api/phones/self* path. Anything else is null.
 */
export function phoneFamily(method: string, path: string): PhoneFamily | null {
  if ((method === "GET" && path === "/api/phones/self/targets")
    || (method === "POST" && (path === "/api/phones/self/share" || path === "/api/phones/self/ask" || path === "/api/phones/ask-revoke"))) return "ask";
  if ((method === "GET" && path === "/api/phones/self/challenge") || (method === "POST" && (path === "/api/phones/self/token" || path === "/api/phones/minted"))) return "bootstrap";
  if (path === "/api/phones" || path === "/api/phones/revoke") return "admin";
  if (path === "/api/phones/self" || path.startsWith("/api/phones/self/")) return "jobs";
  return null;
}

/** Ask answers to share and ask; jobs and admin to phone tools; bootstrap to either. */
export function familyOffered(family: PhoneFamily, f: OfferFacts): boolean {
  if (family === "ask") return shareAskOffered(f);
  if (family === "bootstrap") return phonesOffered(f) || shareAskOffered(f);
  return phonesOffered(f);
}
