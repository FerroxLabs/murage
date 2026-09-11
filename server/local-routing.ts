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

/** Whether Auto on a bot with this `computer` setting hands it THIS
 *  computer, and so needs the local-computer acknowledgement
 *  (`acknowledgeLocalAuto`) before it is granted.
 *
 *  One rule for every route that can switch Auto on — the profile PATCH,
 *  the thread PATCH — so the acknowledgement cannot be sidestepped by the
 *  path taken. "vm" and "browser" are their own destinations and never the
 *  person's desktop; "cloud" and "off" never are; an explicit "local"
 *  mounts it on macOS and Linux; and a bot that never chose a computer
 *  (`undefined`, the "Auto" destination) mounts it on macOS — the
 *  established macOS Auto behaviour. Without folding `undefined` in, Auto
 *  could be switched on at profile level for a fresh Mac bot with no
 *  warning at all, while the very same bot's thread route asked for one. */
export function autoMountsLocalComputer(
  computer: "cloud" | "vm" | "local" | "browser" | "off" | undefined,
  hostPlatform: NodeJS.Platform = process.platform,
): boolean {
  return shouldMountLocalComputer({
    requested: computer === "vm" || computer === "browser" ? "off" : computer,
    hostPlatform,
    providerSupportsLocal: true,
  });
}
