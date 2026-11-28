// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 Overview page (A1): stores nothing. It draws the finder's rows with their level and the slots other lanes
// fill; <OverviewSection id="overview.changed"/> stays here and loads ChangedRecently.tsx (J1) by its own file.
import type { SettingsPageProps } from "@/lib/settings-page-contract";
import { OverviewSection } from "../overview-sections";

export default function OverviewPage(_props: SettingsPageProps) {
  return <OverviewSection id="overview.changed" />;
}
