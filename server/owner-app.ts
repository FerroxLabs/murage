// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IncomingHttpHeaders } from "node:http";
import { approvalDeviceFrom, type ApprovalDevice } from "./approval-fresh-auth.ts";
import { isOwnersComputer } from "./cloud-owner-surface.ts";
import { cloudIdentity } from "./cloud-request-identity.ts";
import { doorAuthorized, ownerActs } from "./companion-authority.ts";
import { companionMarked } from "./sse-visibility.ts";

/** Which of the owner's own apps sent a request. */
export type OwnerApp = { kind: "desktop" } | { kind: "phone"; device: ApprovalDevice & { key: string } };
/** Why a request is not one of the owner's apps: no owner at all, an owner who must answer on the computer
 *  (a paired browser, a keyless app, a Cloud phone) or a phone app with no attested approval key. */
export type OwnerAppRefusal = "needs_owner" | "on_computer" | "unattested";

/**
 * The one owner-app check (APPROVE-ALL-1016 section 7.1; U7 C19 reuses it): the owner's desktop app, or the owner's
 * paired phone APP. Never a browser of any kind, never a bot's shell or a loopback script.
 *
 * Cloud home: the server-set identity decides, nothing the client sends. `owner-desktop` is the desktop app. The
 * passkey browser and the remembered-owner browser read as the "desktop" surface for ordinary owner access
 * (`requestSurface`, `isDesktopApp`), so neither of those is consulted here. `owner-phone` has no enrolled approval
 * key on a home (`cloudPhoneHighRiskRefusal`), so it answers on the computer. Device headers are never read on a home.
 *
 * Off a home: the desktop app is the renderer with its per-launch secret proven (`isOwnersComputer`). The phone is a
 * request the companion door forwarded: the companion marker, the door token AND the launch proof (`ownerActs`), all
 * written by the companion into a fresh header object. Only then are the approval device headers read, and those the
 * companion builds from its device registry, never from the client (`approvalDeviceHeaders`, an allowlist forward).
 * A paired browser forwarded by the same door carries class "browser" and is refused; so is an app with no key.
 */
export function ownerAppSurface(headers: IncomingHttpHeaders, query?: URLSearchParams | null): { ok: true; app: OwnerApp } | { ok: false; refusal: OwnerAppRefusal } {
  if (process.env.MURAGE_CLOUD_ROLE === "home") {
    const identity = cloudIdentity(headers);
    if (!identity || identity.revoked) return { ok: false, refusal: "needs_owner" };
    if (identity.scope === "owner-desktop") return { ok: true, app: { kind: "desktop" } };
    if (identity.scope === "owner-phone") return { ok: false, refusal: "on_computer" };
    return { ok: false, refusal: identity.scope === "browser" ? "on_computer" : "needs_owner" };
  }
  if (isOwnersComputer(headers, query)) return { ok: true, app: { kind: "desktop" } };
  if (!companionMarked(headers) || !doorAuthorized(headers) || !ownerActs(headers)) return { ok: false, refusal: "needs_owner" };
  const device = approvalDeviceFrom(headers);
  if (!device || device.cls !== "app") return { ok: false, refusal: "on_computer" };
  if (!device.key) return { ok: false, refusal: "unattested" };
  return { ok: true, app: { kind: "phone", device: { ...device, key: device.key } } };
}
