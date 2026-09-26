// SPDX-License-Identifier: AGPL-3.0-or-later
// D7 (0.1.60 Windows re-test 3): a restored installation switches every
// engine off until the owner turns one on again. The "Install an AI engine"
// screen then replaced the conversation, so the restored conversations could
// not be seen, and it offered to install an engine that was already there.
// When engines exist but are all switched off, the conversation stays on
// screen with a notice above it; only a machine with no usable engine at
// all still gets the full install screen.
type InstanceLike = { enabled?: boolean; snapshot: { state: string } };
export function enginesOnlySwitchedOff(instances: readonly InstanceLike[]): boolean {
  return instances.length > 0 && instances.some(i => i.enabled === false) &&
    !instances.some(i => i.enabled !== false && i.snapshot.state === "available");
}
