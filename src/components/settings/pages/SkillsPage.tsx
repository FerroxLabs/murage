// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > Skills (1.0.19 page 4 of 14): teach a skill, the library and import, and the scan rules. The scan rules are
// their own card now (they used to ride the page's Advanced slot).
import type { ReactNode } from "react";
import { cloudCardHidden } from "@/lib/cloud-settings";
import type { SettingsPageCard, SettingsPageProps } from "@/lib/settings-page-contract";
import { SkillScanRules, SkillsSettings } from "../../skills/SkillsSettings";
import { TranscriptionKey } from "../../TranscriptionSettings";
import { WorkspaceFeatureRow } from "../../SettingsModal";
import { PageCards } from "../PageCards";
import { deviceGate, stub } from "./page-kit";

export function skillsCards({ desktop, cloud }: Pick<SettingsPageProps, "desktop" | "cloud">): SettingsPageCard[] {
  const card = (name: string, anchor: string, render: () => ReactNode, idSection = "skills"): SettingsPageCard => ({
    id: `${idSection}.${name}`, anchor, simple: false, render: () => deviceGate(desktop, anchor, render),
  });
  return [
    card("recorder", "skill-recorder-heading", () => (cloudCardHidden("skill-recorder-heading", cloud) ? stub("skill-recorder-heading") : <WorkspaceFeatureRow feature="skillRecorder" />)),
    // The AssemblyAI key, next to Teach a skill (its id stays webSearch.voice-key). The voice card on Search, images and dictation points here.
    card("voice-key", "voice-key-heading", () => (cloudCardHidden("voice-key-heading", cloud) ? stub("voice-key-heading") : <TranscriptionKey />), "webSearch"),
    card("library", "skills-settings-title", () => <SkillsSettings />),
    card("scan-rules", "skill-scan-rules-heading", () => <SkillScanRules />),
  ];
}

export default function SkillsPage({ mode, desktop, cloud }: SettingsPageProps) {
  return <PageCards cards={skillsCards({ desktop, cloud })} mode={mode} />;
}
