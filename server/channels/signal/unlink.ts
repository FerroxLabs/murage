// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
// @ts-expect-error Shared ESM contract is also consumed by release scripts.
import { artifactBinding, isVerifiedSignalEvidence, SIGNAL_CLI_COMMIT, unlinkProofSchema } from "./evidence.mjs";
import type { RuntimePin } from "./types.ts";
// @ts-expect-error Shared ESM contract is also consumed by release scripts.
export { unlinkContract, unlinkProofSchema } from "./evidence.mjs";
export interface AuthorizedUnlink { readonly method: "unregister"; readonly params: Readonly<Record<string, never>> }
const authorized = new WeakMap<AuthorizedUnlink, true>();
/** Authorization consumes the verifier's exact object, never another read/parse. */
export function authorizeUnlink(pin: RuntimePin, verified: { manifest: any; manifestBytes: Buffer }): AuthorizedUnlink | undefined {
  if (!isVerifiedSignalEvidence(verified)) return;
  const { manifest, manifestBytes } = verified;
  const parsed = unlinkProofSchema.safeParse(manifest.unlinkProof);
  if (!parsed.success || !manifest.results["S7-UNLINK"] || !pin.g0 || pin.g0.signalCliCommit !== SIGNAL_CLI_COMMIT
      || pin.g0.signalCliVersion !== pin.signalCliVersion || pin.g0.artifactSha256 !== artifactBinding(pin)
      || manifest.artifactSha256 !== pin.g0.artifactSha256
      || pin.g0.manifestSha256 !== createHash("sha256").update(manifestBytes).digest("hex")) return;
  const request: AuthorizedUnlink = Object.freeze({ method: "unregister", params: Object.freeze({}) });
  authorized.set(request, true); return request;
}
export function isAuthorizedUnlink(request: AuthorizedUnlink | undefined, liveDeviceId: number): request is AuthorizedUnlink {
  return !!request && authorized.has(request) && Number.isSafeInteger(liveDeviceId) && liveDeviceId >= 2;
}
