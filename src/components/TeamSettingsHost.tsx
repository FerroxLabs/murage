// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Mounted once (in the sidebar): opens team settings when anything asks
// through openTeamSettings(). The dialog itself loads on first use, so the
// first paint carries only this listener.
import { Suspense, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { OPEN_TEAM_SETTINGS_EVENT, type OpenTeamSettingsDetail } from "@/lib/team-manage";
import { LazyBoundary, retryableLazy } from "./LazyBoundary";

const TeamSettingsDialog = retryableLazy(() => import("./TeamSettingsDialog").then((module) => ({ default: module.TeamSettingsDialog })));

export function TeamSettingsHost({ onRenamed }: { onRenamed?: (from: string, to: string) => void }) {
  const [open, setOpen] = useState<OpenTeamSettingsDetail | null>(null);
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<OpenTeamSettingsDetail>).detail;
      if (!detail || typeof detail.section !== "string" || !detail.section.trim() || detail.section.length > 200) return;
      setOpen({ section: detail.section, focus: detail.focus === "rename" || detail.focus === "delete" ? detail.focus : "members" });
    };
    window.addEventListener(OPEN_TEAM_SETTINGS_EVENT, listener);
    return () => window.removeEventListener(OPEN_TEAM_SETTINGS_EVENT, listener);
  }, []);
  if (!open) return null;
  // Portalled to the page: on a phone the sidebar is a transformed drawer,
  // and a fixed overlay inside it would cover only the drawer.
  return createPortal(
    <LazyBoundary onRetry={TeamSettingsDialog.retry} onDismiss={() => setOpen(null)}>
      <Suspense fallback={null}>
        <TeamSettingsDialog.Component
          key={`${open.section}:${open.focus}`}
          section={open.section}
          focus={open.focus}
          onClose={() => setOpen(null)}
          onRenamed={onRenamed}
        />
      </Suspense>
    </LazyBoundary>,
    document.body,
  );
}
