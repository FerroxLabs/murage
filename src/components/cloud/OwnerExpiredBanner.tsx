// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A Cloud home's owner browser whose owner factor ran out: it can still chat, and the home says so in /api/config (owner:false).
// One calm line with the way back. Nothing renders off a Cloud home page, or while the owner factor is good.
import { uxCloud } from "@/lib/cloud-ux-copy";
import { onCloudHomePage } from "@/lib/owner-code";
import { useStore } from "@/state/store";

/** Pure: show the line only for a Cloud home page whose config answered owner:false. */
export const ownerExpired = (config: { owner?: boolean } | null | undefined, homePage: boolean): boolean => homePage && config?.owner === false;

export function OwnerExpiredBannerView() {
  return <div role="status" aria-live="polite" className="bg-control px-4 py-2 text-center text-[13px] font-medium text-ink">{uxCloud("ux.cloud.ownerBanner.expired")}</div>;
}

export function OwnerExpiredBanner() {
  const { state } = useStore();
  return ownerExpired(state.config, onCloudHomePage()) ? <OwnerExpiredBannerView /> : null;
}
