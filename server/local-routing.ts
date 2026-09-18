export function shouldMountLocalComputer({
  requested,
  hostPlatform = process.platform,
  providerSupportsLocal,
}: {
  requested: "cloud" | "local" | "off" | undefined;
  hostPlatform?: NodeJS.Platform;
  providerSupportsLocal: boolean;
}): boolean {
  if (!providerSupportsLocal) return false;
  if (requested === "local") return hostPlatform === "darwin" || hostPlatform === "linux";
  // Preserve the established macOS Auto behavior. Linux local control is a
  // beta and can only be selected explicitly per bot.
  return requested === undefined && hostPlatform === "darwin";
}

/** Whether a bot carrying this `computer` setting drives THE PERSON'S OWN
 *  MACHINE — the screen and keyboard in front of them — rather than a cloud
 *  box, a local VM, a plain browser, or nothing at all.
 *
 *  This is the one question several places have to answer the same way, and
 *  they had drifted: the host RPC gate folded `undefined` in and the
 *  "stop touching my computer" sweep did not, so the sweep missed every bot
 *  that never chose a computer — which is every bot the owner creates.
 *  Any new site that needs "is this bot on my desktop?" calls this, and
 *  nothing re-spells the boolean.
 *
 *  "vm" and "browser" are their own destinations and never the person's
 *  desktop; "cloud" and "off" never are; an explicit "local" mounts it on
 *  macOS and Linux; and a bot that never chose a computer (`undefined`, the
 *  "Auto" destination) mounts it on macOS — the established macOS Auto
 *  behaviour. The platform matters: fold `undefined` in without it and a
 *  Windows or Linux owner's every default bot answers "yes". */
export function botUsesHostComputer(
  computer: "cloud" | "vm" | "local" | "browser" | "off" | undefined,
  hostPlatform: NodeJS.Platform = process.platform,
): boolean {
  return shouldMountLocalComputer({
    requested: computer === "vm" || computer === "browser" ? "off" : computer,
    hostPlatform,
    providerSupportsLocal: true,
  });
}

/** Whether Auto on a bot with this `computer` setting hands it THIS
 *  computer, and so needs the local-computer acknowledgement
 *  (`acknowledgeLocalAuto`) before it is granted.
 *
 *  A different question with the same answer, deliberately sharing one
 *  implementation: consent is owed exactly when the destination is the
 *  person's own machine. One rule for every route that can switch Auto on —
 *  the profile PATCH, the thread PATCH — so the acknowledgement cannot be
 *  sidestepped by the path taken. Without folding `undefined` in, Auto could
 *  be switched on at profile level for a fresh Mac bot with no warning at
 *  all, while the very same bot's thread route asked for one. */
export const autoMountsLocalComputer = botUsesHostComputer;
