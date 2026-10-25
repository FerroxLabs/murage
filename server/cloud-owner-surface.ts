// SPDX-License-Identifier: AGPL-3.0-or-later
import type { IncomingHttpHeaders } from "node:http";
import { cloudIdentity } from "./cloud-request-identity.ts";
import { FRESH_AUTH_COPY } from "./approval-fresh-auth.ts";
import { requestSurface } from "./sse-visibility.ts";

/** The desktop app itself. On a Cloud home the paired phone also reads as the "desktop" surface (so it can approve),
 * but handlers reserved for the desktop app must not treat it as one. */
export const isDesktopApp = (headers: IncomingHttpHeaders, query?: URLSearchParams | null): boolean =>
  requestSurface(headers, query) === "desktop" && !(process.env.MURAGE_CLOUD_ROLE === "home" && cloudIdentity(headers)?.scope === "owner-phone");

/** True when the fresh-auth gate is skipped for this approval: the desktop app only. */
export const skipsFreshAuth = (headers: IncomingHttpHeaders, query?: URLSearchParams | null): boolean =>
  isDesktopApp(headers, query);

/** Where an owner action came from, for the browser extension's owner actions: the desktop app, or otherwise the phone. */
export const ownerSurface = (headers: IncomingHttpHeaders, query?: URLSearchParams | null): "desktop" | "phone" =>
  isDesktopApp(headers, query) ? "desktop" : "phone";

/** A high-risk Allow from the paired phone on a Cloud home. The fresh-auth proof is a P-256 signature, but a cloud phone
 * enrolls only an ed25519 key, so there is no enrolled key to verify a supplied approval key against: the key the same
 * bearer supplies would be self-attested. Until the phone enrolls an approval key, it approves high-risk cards on the computer. */
export const cloudPhoneHighRiskRefusal = (headers: IncomingHttpHeaders): { status: 403; body: Record<string, unknown> } | null =>
  process.env.MURAGE_CLOUD_ROLE === "home" && cloudIdentity(headers)?.scope === "owner-phone"
    ? { status: 403, body: { error: FRESH_AUTH_COPY.computerOnly, code: "approve_on_computer" } }
    : null;
