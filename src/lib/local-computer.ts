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

/** What the harness says about itself on `GET /api/config` (`harness` in
 *  `ConfigStatus`, src/state/store.tsx): the platform the server's own
 *  consent rule runs on. `platform` is the harness's `process.platform`. */
export type HarnessAnnouncement = { platform?: string };

/** The host platform the local-Auto warning decides on.
 *
 *  The server decides local-Auto consent from ITS `process.platform`
 *  (`autoMountsLocalComputer` in server/local-routing.ts), so the renderer's
 *  copy of the rule must run on the same platform, and the harness announces
 *  it on `/api/config` (`harness.platform`, the route the renderer already
 *  reads at startup). That answer wins whenever it is present — over the
 *  browser UA and over the desktop shell's own answer alike, since the
 *  harness is the thing that refuses the PATCH.
 *
 *  Only while the harness has not answered (config not loaded yet, or an
 *  older harness that does not announce itself) does the renderer fall back:
 *  the desktop shell's platform in Electron, else the UA in a plain browser
 *  (the dev rig, the browser door), where the host is not announced as a
 *  desktop. The UA is the BROWSER's machine, not necessarily the harness's
 *  — a Linux or Windows tab through the browser door on a Mac harness used
 *  to get a bare 400 with no dialog, and a Mac tab on a Linux harness a
 *  dialog the server never required — which is why the announcement exists
 *  (FOLLOW5). */
export function localAutoHostPlatform(
  capabilities: Pick<DesktopCapabilities, "host">,
  {
    harness,
    userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
  }: { harness?: HarnessAnnouncement | null; userAgent?: string } = {},
): DesktopCapabilities["host"]["platform"] {
  const announced = harnessPlatform(harness);
  if (announced) return announced;
  return capabilities.host.platform === "other" && /Mac/.test(userAgent) ? "darwin" : capabilities.host.platform;
}

/** The harness's announced platform folded into the renderer's platform
 *  names, or `undefined` when the harness has not answered. A platform the
 *  renderer has no name for (a BSD, say) is "other" — the server mounts
 *  nothing there, and it must never fall through to a UA guess. */
function harnessPlatform(harness: HarnessAnnouncement | null | undefined): DesktopCapabilities["host"]["platform"] | undefined {
  const platform = harness?.platform;
  if (typeof platform !== "string" || platform === "") return undefined;
  return platform === "darwin" || platform === "linux" || platform === "win32" ? platform : "other";
}

/** Whether switching a bot to Auto hands it THIS computer, and so must show
 *  the local-computer warning and send `acknowledgeLocalAuto`. Applies to
 *  every Auto switch in the renderer — the composer chip (thread level) and
 *  the settings panel switch (profile level) alike — because the server
 *  refuses either without the acknowledgement (`autoMountsLocalComputer`
 *  in server/local-routing.ts).
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
  return autoMountsThisComputer({ platform, computer });
}

/** Whether Auto on a bot with this `computer` setting hands it THIS
 *  computer — the renderer's copy of the server's `autoMountsLocalComputer`
 *  (server/local-routing.ts). Provider support is deliberately not part of
 *  the rule, because the server's is not (`providerSupportsLocal` is
 *  hard-coded there): a Mac bot on a provider with no local-computer
 *  capability is still refused Auto without the acknowledgement, so the
 *  renderer must still show the warning for it rather than fire a PATCH
 *  that comes back as a bare 400. */
export function autoMountsThisComputer({
  platform,
  computer,
}: {
  platform: DesktopCapabilities["host"]["platform"];
  computer: Bot["computer"];
}): boolean {
  if (computer === "local") return platform === "darwin" || platform === "linux";
  return computer === undefined && platform === "darwin";
}

/** Whether moving an Auto-on bot's computer destination (the "Runs on"
 *  grid in ComputerPanel) must show the local-computer warning and send
 *  `acknowledgeLocalAuto`. Mirrors the server's profile PATCH exactly: the
 *  acknowledgement is due when the new destination mounts this computer
 *  and the current one did not; Auto already granted on this desktop
 *  (moving `undefined` ↔ "local") is the same desktop and needs none, and
 *  a bot in Ask never needs one for a destination change. */
export function computerSwitchNeedsLocalAutoWarning({
  platform,
  from,
  to,
  autoApprove,
}: {
  platform: DesktopCapabilities["host"]["platform"];
  from: Bot["computer"];
  to: Bot["computer"];
  autoApprove: Bot["autoApprove"];
}): boolean {
  if (!autoApprove) return false;
  return autoMountsThisComputer({ platform, computer: to }) && !autoMountsThisComputer({ platform, computer: from });
}
