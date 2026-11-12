// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Backups (SETTINGS-LOCKED-1019.md 3.15): keep copies of Murage and recover them. Simple is the set-up, the state, Back up now
// and Restore; Advanced opens the schedule, limits, off-site destination and cleanup in the same card, with no fold, and adds Storage.
import type { SettingsMode } from "@/lib/settings-mode";
import type { SettingsPageCard, SettingsPageProps } from "@/lib/settings-page-contract";
import { BackupSettings } from "../../BackupSettings";
import { DataFolderSettings } from "../../DataFolderSettings";
import { StorageSettings } from "../../StorageSettings";
import { deviceGate } from "./page-kit";
import { PageCards } from "../PageCards";

/** The cards of Backups, in page order. */
export function backupsCards(mode: SettingsMode): SettingsPageCard[] {
  return [
    { id: "backups.backups", anchor: "backups-heading", simple: true, render: () => <div className="space-y-4"><DataFolderSettings /><BackupSettings mode={mode} /></div> },
    { id: "backups.storage", anchor: "storage-heading", simple: false, render: () => <StorageSettings /> },
  ];
}

export default function BackupsPage({ mode, desktop }: SettingsPageProps) {
  return <PageCards cards={backupsCards(mode).map(card => ({ ...card, render: () => deviceGate(desktop, card.anchor, card.render) }))} mode={mode} />;
}
