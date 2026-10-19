// SPDX-License-Identifier: AGPL-3.0-or-later
import { HTTPError } from "./http";

/** The old cloud.murage.ai portal's WebAuthn step-up (/v1/account/2fa*) is retired. Second factors are enrolled and
 *  proved in the murage.ai members area (Supabase MFA) and the access token carries the proof (customer-identity.ts).
 *  It ran on a Better Auth session, which may never act on a Cloud route, so there is no way to turn it back on. */
export function accountTwoFactorRoute(request: Request): Response | null {
  if (!new URL(request.url).pathname.startsWith("/v1/account/2fa")) return null;
  throw new HTTPError(410, "step_up_moved");
}
