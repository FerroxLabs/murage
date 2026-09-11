import type { Bot, InstanceInfo } from "@/state/store";

export function instanceSupportsLocalComputer(
  instances: InstanceInfo[],
  bot: Pick<Bot, "modelSelection">,
): boolean {
  const capabilities = instances.find(
    (instance) => instance.instanceId === bot.modelSelection.instanceId,
  )?.capabilities;
  return capabilities?.localComputerMcp === true || capabilities?.computerMcp === true;
}

/** Whether the Runs-on “This computer” control should be clickable.
 *  macOS keeps the destination available even before CUA has a grant, so
 *  the user can pick it and then approve Accessibility / Screen Recording
 *  instead of finding a grayed-out button. */
export function localComputerSelectable({
  capabilities,
  providerSupportsLocal,
}: {
  capabilities: DesktopCapabilities;
  providerSupportsLocal: boolean;
}): boolean {
  if (!providerSupportsLocal) return false;
  if (capabilities.localComputer.available) return true;
  return capabilities.host.platform === "darwin";
}

export function localComputerDisabledReason({
  capabilities,
  providerSupportsLocal,
}: {
  capabilities: DesktopCapabilities;
  providerSupportsLocal: boolean;
}): string | null {
  if (!providerSupportsLocal) {
    return "The selected provider cannot request approvals for local computer actions.";
  }
  if (capabilities.localComputer.available) return null;
  if (capabilities.host.platform === "linux") {
    if (capabilities.localComputer.reasonCode === "linux-wayland-seat-safety-blocked") {
      return "Local computer control is not available on Wayland yet. Sign out and choose Ubuntu on Xorg to use This computer.";
    }
    if (capabilities.localComputer.reasonCode === "wayland-compositor-unsupported") {
      return "Wayland local control is currently limited to GNOME. Xorg remains available on supported desktops.";
    }
    if (!capabilities.localComputer.enabled) {
      return "Enable the local control beta and complete the Cua Driver checks first.";
    }
    return capabilities.localComputer.message ?? "Cua Driver is not ready for local control.";
  }
  if (capabilities.host.label === "Browser") {
    return "Local computer control requires the desktop app.";
  }
  return "CUA Driver is not ready for local computer control.";
}

export function linuxAutoDescription(): string {
  return "Auto uses a cloud box when one is configured; otherwise computer use stays off.";
}

export function autoSelectsLocalComputer({
  platform,
  computer,
  capabilitiesReady,
  localSelectable,
}: {
  platform: DesktopCapabilities["host"]["platform"];
  computer: Bot["computer"];
  capabilitiesReady: boolean;
  localSelectable: boolean;
}): boolean {
  return platform !== "linux" && computer !== "cloud" && capabilitiesReady && localSelectable;
}

/** Whether switching a bot to Auto hands it THIS computer, and so must show
 *  the local-computer warning and send `acknowledgeLocalAuto`.
 *
 *  Mirrors the server's own rule for the thread route
 *  (`shouldMountLocalComputer` in server/local-routing.ts, used by
 *  `PATCH /api/bots/:id/tasks/:threadId`): an explicit "local" mounts the
 *  computer on macOS and Linux, and a bot that never chose a computer mounts
 *  it on macOS — the established macOS Auto behaviour. "vm" and "browser"
 *  are not local; "cloud" and "off" never are. Without this the composer's
 *  mode chip asked the server for Auto with no acknowledgement on every
 *  fresh Mac bot, was refused, and the person saw a red banner instead of
 *  the warning. */
export function autoNeedsLocalComputerWarning({
  platform,
  computer,
  autoApprove,
}: {
  platform: DesktopCapabilities["host"]["platform"];
  computer: Bot["computer"];
  autoApprove: Bot["autoApprove"];
}): boolean {
  if (autoApprove) return false;
  if (computer === "local") return platform === "darwin" || platform === "linux";
  return computer === undefined && platform === "darwin";
}
