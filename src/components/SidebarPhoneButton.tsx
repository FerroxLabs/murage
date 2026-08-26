import { useEffect, useState } from "react";
import { Plus, Smartphone } from "lucide-react";

import { cn } from "@/lib/cn";
import type { Action } from "@/state/store";
import type { SidebarDensity } from "@/lib/sidebar-preferences";
import { companionBridge, type CompanionState } from "./PhoneSetupFlow";

export const SIDEBAR_PHONE_RECENT_MS = 2 * 60_000;
const SIDEBAR_PHONE_POLL_MS = 15_000;

type SidebarPhoneSnapshot = Pick<CompanionState, "enabled" | "devices" | "error">;

export type SidebarPhoneStatusKind =
  | "checking"
  | "unavailable"
  | "unpaired"
  | "stale"
  | "recent";

export interface SidebarPhoneStatus {
  kind: SidebarPhoneStatusKind;
  label: string;
  pairedCount: number;
  recentCount: number;
}

/** The sidecar coalesces last-seen writes for up to one minute. A two-minute
 * window leaves room for that write interval and this button's 15-second
 * poll without calling an idle phone "connected". Green therefore means the
 * phone successfully reached this computer recently, not that a socket is
 * guaranteed to still be open. */
export function deriveSidebarPhoneStatus(
  snapshot: SidebarPhoneSnapshot | null | undefined,
  now: number,
): SidebarPhoneStatus {
  if (snapshot === undefined) {
    return { kind: "checking", label: "Checking phone status", pairedCount: 0, recentCount: 0 };
  }
  if (snapshot === null) {
    return { kind: "unavailable", label: "Phone status unavailable", pairedCount: 0, recentCount: 0 };
  }

  const pairedCount = snapshot.devices.length;
  if (!pairedCount) {
    return { kind: "unpaired", label: "Pair a phone", pairedCount: 0, recentCount: 0 };
  }

  const recentCount = snapshot.enabled && !snapshot.error
    ? snapshot.devices.filter((device) => {
        const age = now - device.lastSeenAt;
        return Number.isFinite(device.lastSeenAt) && age >= 0 && age <= SIDEBAR_PHONE_RECENT_MS;
      }).length
    : 0;
  if (recentCount) {
    const label = pairedCount === 1
      ? "Phone active recently"
      : recentCount === pairedCount
        ? `${pairedCount} phones active recently`
        : `${recentCount} of ${pairedCount} phones active recently`;
    return { kind: "recent", label, pairedCount, recentCount };
  }

  return {
    kind: "stale",
    label: pairedCount === 1
      ? "Phone paired — not recently active"
      : `${pairedCount} phones paired — none recently active`,
    pairedCount,
    recentCount: 0,
  };
}

type ToggleAppSettingsAction = Extract<Action, { type: "toggleAppSettings" }>;

export const phoneSettingsAction = (): ToggleAppSettingsAction => ({
  type: "toggleAppSettings",
  open: true,
  section: "companion",
});

function useSidebarPhoneStatus(): SidebarPhoneStatus {
  const [snapshot, setSnapshot] = useState<SidebarPhoneSnapshot | null>();

  useEffect(() => {
    const companion = companionBridge();
    if (!companion) {
      setSnapshot(null);
      return;
    }

    let disposed = false;
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const next = await companion.state();
        if (!disposed) setSnapshot(next);
      } catch {
        if (!disposed) setSnapshot((current) => current ?? null);
      } finally {
        refreshing = false;
      }
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), SIDEBAR_PHONE_POLL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  return deriveSidebarPhoneStatus(snapshot, Date.now());
}

export function SidebarPhoneStatusButton({
  density,
  status,
  onOpen,
}: {
  density: SidebarDensity;
  status: SidebarPhoneStatus;
  onOpen: () => void;
}) {
  const recent = status.kind === "recent";
  return (
    <button
      type="button"
      onClick={onOpen}
      title={status.label}
      aria-label={status.label}
      data-phone-status={status.kind}
      data-sidebar-density={density}
      className={cn(
        "relative flex size-10 shrink-0 items-center justify-center rounded-md hover:bg-raised",
        density === "icons" && "mx-auto",
        recent ? "text-success" : "text-ink-secondary hover:text-ink",
      )}
    >
      <Smartphone size={18} strokeWidth={1.8} />
      {status.kind === "unpaired" && (
        <span
          aria-hidden="true"
          data-phone-plus
          className="absolute bottom-1 right-1 flex size-3.5 items-center justify-center rounded-full border border-panel bg-panel"
        >
          <Plus size={10} strokeWidth={2.8} />
        </span>
      )}
      {recent && (
        <span
          aria-hidden="true"
          data-phone-recent
          className="absolute bottom-1.5 right-1.5 size-1.5 rounded-full border border-panel bg-success"
        />
      )}
    </button>
  );
}

export function SidebarPhoneButton({
  density,
  onOpen,
}: {
  density: SidebarDensity;
  onOpen: () => void;
}) {
  const status = useSidebarPhoneStatus();
  return <SidebarPhoneStatusButton density={density} status={status} onOpen={onOpen} />;
}
