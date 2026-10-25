// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CloudDevice, CloudScope } from "./cloud-sessions.ts";
import { isP256 } from "./cloud-home/b1b-webauthn.ts";
export type CloudRequestIdentity = CloudDevice & {settingsRead?: boolean; accessHash?: string};
type OwnerBrowserShape = Pick<CloudDevice, "scope" | "assertionKey" | "publicKey" | "revoked" | "factor">;
/** The READ gate: the owner's passkey browser OR a remembered owner browser. Scope `browser`, two P-256 keys AND a live
 * factor row (`device.factor`, from cloud_browser_factors). Two P-256 keys alone are not enough: every browser the door
 * enrolls has them, and a bare door browser carries no factor and stays chat-level. CloudSessions.device() only returns
 * devices of the owner account and selects the LIVE factor kind, so a resolved device that passes this is the owner's. */
export const isOwnerBrowser = (device: OwnerBrowserShape | undefined): boolean =>
  device?.scope === "browser" && !device.revoked && (device.factor === "passkey" || device.factor === "remembered-owner")
  && isP256(device.publicKey) && isP256(device.assertionKey);
/** The owner's PASSKEY browser only: the full-surface web owner. */
export const isPasskeyOwnerBrowser = (device: OwnerBrowserShape | undefined): boolean =>
  isOwnerBrowser(device) && device!.factor === "passkey";
/** The ACTING gate: the passkey browser, full stop. No per-request state can widen it (H1). */
export const ownerBrowserActs = isPasskeyOwnerBrowser;
/** The route scope a browser device carries: the passkey browser is `owner-browser`, a remembered owner is
 * `remembered-owner`, and anything else keeps its own scope. */
export const ownerBrowserScope = (device: OwnerBrowserShape | undefined): "owner-browser" | "remembered-owner" | CloudScope | undefined =>
  isPasskeyOwnerBrowser(device) ? "owner-browser" : isOwnerBrowser(device) ? "remembered-owner" : device?.scope;
const identities = new WeakMap<object, CloudRequestIdentity>();
export const cloudIdentity = (headers: object): CloudRequestIdentity | undefined => identities.get(headers);
export const setCloudIdentity = (headers: object, device: CloudRequestIdentity): void => { identities.set(headers,device); };
