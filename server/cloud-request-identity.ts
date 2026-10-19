// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CloudDevice } from "./cloud-sessions.ts";
import { isP256 } from "./cloud-home/b1b-webauthn.ts";
export type CloudRequestIdentity = CloudDevice & {settingsRead?: boolean; accessHash?: string};
/** A browser device of the home's owner with a passkey factor: scope `browser`, two P-256 keys AND a saved factor row
 * (`device.factor`, from cloud_browser_factors). Two P-256 keys alone are not enough: every browser the door enrolls has
 * them and no factor row, and stays chat-level. CloudSessions.device() only returns devices of the owner account and
 * selects `factor`, so a resolved device that passes this test is the owner's passkey browser. */
export const isOwnerBrowser = (device: Pick<CloudDevice, "scope" | "assertionKey" | "publicKey" | "revoked" | "factor"> | undefined): boolean =>
  device?.scope === "browser" && !device.revoked && device.factor === true && isP256(device.publicKey) && isP256(device.assertionKey);
const identities = new WeakMap<object, CloudRequestIdentity>();
export const cloudIdentity = (headers: object): CloudRequestIdentity | undefined => identities.get(headers);
export const setCloudIdentity = (headers: object, device: CloudRequestIdentity): void => { identities.set(headers,device); };
