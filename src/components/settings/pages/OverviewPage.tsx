// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 Overview page: a slot seated by the shell (SHELL-SEAT). The find lane (A1) replaces this body and keeps
// <OverviewSection id="overview.changed"/> in it; the loader line in page-registry.tsx already points here.
import type { SettingsPageProps } from "@/lib/settings-page-contract";
import { OverviewSection } from "../overview-sections";

export default function OverviewPage(_props: SettingsPageProps) {
  return <OverviewSection id="overview.changed" />;
}
