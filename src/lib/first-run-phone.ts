// WHICH PHONE CARD THE CHIEF IS ALLOWED TO SHOW.
//
// Pairing runs over Tailscale. On a machine without it, a QR code resolves
// to an address the phone cannot reach, so the rule from shared/setup.ts is
// absolute: never a dead QR and never a dead button. The Chief offers to set
// Tailscale up instead, in the chat, one step at a time.
//
// The decision is the RENDERER'S and not the server's, and that is written
// down in shared/setup.ts beside `SetupPhoneReading`: Tailscale is found by
// the Electron main process, and the server runs in a forked utility process
// that cannot see it. So the card arrives with the server's best guess at a
// variant and this module overrules it with what the desktop bridge actually
// reports.
//
// Pure functions over a companion state, so the test is a table and not a
// browser.

import type { CompanionState } from "@/components/PhoneSetupFlow";

/** The two honest phone cards. Named exactly as `SETUP_CARD_VARIANTS` names
 *  them, because this is the value the renderer dispatches on. */
export type FirstRunPhoneVariant = "phone" | "phone-needs-tailscale";

/** Why pairing is not on offer, in the order the walkthrough asks for it.
 *  "unknown" is the honest fourth answer: nobody has looked yet, or the
 *  probe could not say. It is treated exactly like missing, because the one
 *  thing that must never happen is a QR code shown on a hope. */
export type FirstRunTailscaleTrouble = "missing" | "signed-out" | "unknown" | null;

/**
 * Is there a tailnet address this machine can actually hand a phone?
 *
 * A POSITIVE signal only: a MagicDNS name, or an endpoint the sidecar has
 * already classified as a tailnet one. Nothing here infers reachability from
 * the absence of an error, because "no error yet" is the state of a machine
 * that has not been asked.
 */
export function tailnetReachable(state: CompanionState | null | undefined): boolean {
  if (!state) return false;
  if (typeof state.tailscale === "string" && state.tailscale.trim()) return true;
  return Boolean(state.endpoints?.some((endpoint) => endpoint.kind === "tailnet" && Boolean(String(endpoint.url ?? "").trim())));
}

/** The card to render, whatever the card on the wire said. */
export function firstRunPhoneVariant(state: CompanionState | null | undefined): FirstRunPhoneVariant {
  return tailnetReachable(state) ? "phone" : "phone-needs-tailscale";
}

/**
 * What to say is missing, so the walkthrough can start on the right step.
 *
 * `remoteAccess.reason` is the main process's own diagnosis and is trusted
 * over any guess: "missing" is no Tailscale on the machine, "logged-out" is
 * Tailscale installed and nobody signed in. Any other reason concerns
 * certificates for `tailscale serve`, which plain tailnet pairing does not
 * need, so it is not a reason to send someone to the download page.
 */
export function firstRunTailscaleTrouble(state: CompanionState | null | undefined): FirstRunTailscaleTrouble {
  if (tailnetReachable(state)) return null;
  const remote = state?.remoteAccess;
  if (!remote || remote.available === null || remote.available === undefined) return "unknown";
  if (remote.available === false || remote.reason === "missing") return "missing";
  if (remote.reason === "logged-out") return "signed-out";
  return "unknown";
}

/** Which walkthrough step to open on. Installed but signed out starts at the
 *  sign in step: nobody should be told to download what they already have. */
export function firstRunTailscaleStep(state: CompanionState | null | undefined): number {
  return firstRunTailscaleTrouble(state) === "signed-out" ? 1 : 0;
}
