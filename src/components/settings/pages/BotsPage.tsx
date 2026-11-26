// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 Bots page: every bot in one list with the bulk bar (level, Archive) and the Move all review (lane roster).
import { lazy, Suspense } from "react";

import type { SettingsPageProps } from "@/lib/settings-page-contract";

// The container reads window capabilities when it is imported, so it loads with the page, not with the registry.
const BotsRosterLive = lazy(() => import("@/components/BotsRosterLive"));

export default function BotsPage(_props: SettingsPageProps) {
  return (
    <Suspense fallback={null}>
      <BotsRosterLive />
    </Suspense>
  );
}
