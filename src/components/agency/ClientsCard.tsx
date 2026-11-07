// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// L6C fallback (1.0.18, designs/UX-L6C-SWITCH-1018.md section 7): the Your clients card as copy only.
// It teaches the three manual levers and shows only when this desktop has at least one paired Cloud
// home, read from the local `cloud-home:state` (no control-plane call). It names, lists and contacts
// no home: no switch, no spend, no network. Switch and spend ride 1.0.19.
import { useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { cloudHomeBridge, loadCloudWorkspace, type CloudHomeBridge } from "@/lib/cloud-workspace";
import { TodayCard } from "@/components/today/TodayCards";
import type { ClientsCardProps, TodayTag } from "@/components/shell/shell-contract";

/** True once the local state shows at least one paired home. Any failure, or no desktop bridge, is false. */
export async function hasPairedHome(bridge: CloudHomeBridge | undefined = cloudHomeBridge()): Promise<boolean> {
  const workspace = await loadCloudWorkspace(bridge);
  return workspace.enabled && workspace.paired.length > 0;
}

function useHasPairedHome(): boolean {
  const [paired, setPaired] = useState(false);
  useEffect(() => {
    const bridge = cloudHomeBridge();
    if (!bridge) return;
    let live = true;
    let latest = 0;
    // Only the newest read may publish, so an older "paired" answer never overwrites a newer "none".
    const read = () => {
      const seq = ++latest;
      void hasPairedHome(bridge).then((value) => { if (live && seq === latest) setPaired(value); });
    };
    read();
    let off: (() => void) | undefined;
    try { off = bridge.onLive?.(() => read()); } catch { off = undefined; }
    // Pairing or disconnecting happens in another panel or the browser: read again when the window comes back.
    window.addEventListener("focus", read);
    return () => { live = false; off?.(); window.removeEventListener("focus", read); };
  }, []);
  return paired;
}

/** The card itself: a title and the levers line. It takes no home, so it can name none. */
export function ClientsCardView() {
  return (
    <TodayCard id="today-clients" title={t("ux.l6c.title")}>
      <p className="mt-2 text-[14px] text-ink">{t("ux.l6c.levers")}</p>
    </TodayCard>
  );
}

export function ClientsCard(_props: ClientsCardProps) {
  return useHasPairedHome() ? <ClientsCardView /> : null;
}

/** The copy-only card carries no tag: it has no count or status to show. */
export function useClientsTag(): TodayTag | null { return null; }
