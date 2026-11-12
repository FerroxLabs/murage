// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > Search, images and dictation (1.0.19 page 7 of 14, page id `webSearch`; PAGES-A-astra.md): Web search, Images,
// Dictation, in that order. Each card keeps its registry id and anchor. The AssemblyAI key is one field on the Skills page
// (voice.voice-key), so the voice card here says where it is and mounts no key. A Cloud window reaches this page only for
// Images (this computer's search and voice keys stay on this computer), so the others are the computer-only stub there.
import type { ReactNode } from "react";
import { t } from "@/lib/i18n";
import type { SettingsPageCard, SettingsPageProps } from "@/lib/settings-page-contract";
import { SearchSettings } from "../../SearchSettings";
import { Card, PartSlot, PartsHost } from "../../SettingsPrimitives";
import { ImagesSettings } from "../../ToolsSettings";
import { TranscriptionSettings } from "../../TranscriptionSettings";
import { PageCards } from "../PageCards";
import { deviceGate, stub } from "./page-kit";

export function webSearchCards({ desktop, cloud }: Pick<SettingsPageProps, "desktop" | "cloud">): SettingsPageCard[] {
  const card = (name: string, anchor: string, render: () => ReactNode, thisComputer = false): SettingsPageCard => ({
    id: `webSearch.${name}`, anchor, simple: false,
    render: () => deviceGate(desktop, anchor, () => (thisComputer && cloud ? stub(anchor) : render())),
  });
  return [
    card("search", "search-settings-heading", () => <SearchSettings />, true),
    card("provider-keys", "search-keys-heading", () => <PartSlot id="webSearch.provider-keys" />, true),
    card("images", "image-settings-heading", () => <ImagesSettings />),
    card("daily-check", "image-daily-check-heading", () => <PartSlot id="webSearch.daily-check" />),
    card("voice", "voice-settings-heading", () => (
      <Card title={t("settings.voice.title")} subtitle={t("settings.voice.note")}><TranscriptionSettings /></Card>
    ), true),
  ];
}

export default function SearchImagesDictationPage({ mode, desktop, cloud }: SettingsPageProps) {
  return (
    <PartsHost>
      <PageCards cards={webSearchCards({ desktop, cloud })} mode={mode} />
    </PartsHost>
  );
}
