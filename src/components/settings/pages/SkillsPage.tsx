// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > Skills (1.0.19 page 4 of 14): teach a skill, the library and import, and the scan rules. The scan rules are
// their own card now (they used to ride the page's Advanced slot).
import type { ReactNode } from "react";
import { cloudCardHidden } from "@/lib/cloud-settings";
import type { SettingsPageCard, SettingsPageProps } from "@/lib/settings-page-contract";
import { SkillScanRules } from "../../skills/SkillsSettings";
import { SkillsLibraryV10 } from "../../skills/SkillsLibraryV10";
import { WorkspaceFeatureRow } from "../../SettingsModal";
import { PageCards } from "../PageCards";
import { deviceGate, stub } from "./page-kit";

export function skillsCards({ desktop, cloud, mode }: Pick<SettingsPageProps, "desktop" | "cloud"> & Partial<Pick<SettingsPageProps, "mode">>): SettingsPageCard[] {
  const card = (name: string, anchor: string, render: () => ReactNode): SettingsPageCard => ({
    id: `skills.${name}`, anchor, simple: false, render: () => deviceGate(desktop, anchor, render),
  });
  return [
    card("recorder", "skill-recorder-heading", () => (cloudCardHidden("skill-recorder-heading", cloud) ? stub("skill-recorder-heading") : <WorkspaceFeatureRow feature="skillRecorder" />)),
    card("library", "skills-settings-title", () => <SkillsLibraryV10 advanced={mode === "advanced"} />),
    card("scan-rules", "skill-scan-rules-heading", () => <SkillScanRules />),
  ];
}

export default function SkillsPage({ mode, desktop, cloud }: SettingsPageProps) {
  return <PageCards cards={skillsCards({ desktop, cloud, mode })} mode={mode} />;
}
