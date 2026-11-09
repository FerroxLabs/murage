// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Computer & browser (SETTINGS-LOCKED-1019.md 3.13): where bots run and sign in. Simple shows Browser access;
// Advanced shows every control the old page had, in the lock's order, with no fold:
// the computer (local VM, browser profiles, browser access for other agents), the built-in browser switch, the remote
// computer and script access.
import { t } from "@/lib/i18n";
import type { SettingsPageCard, SettingsPageProps } from "@/lib/settings-page-contract";
import { useStore } from "@/state/store";
import { ApiKeyRow, VpsConnection } from "../../ApiKeys";
import { BrowserExternalClients } from "../../BrowserExternalClients";
import { DefaultComputerRow } from "../../DefaultComputerRow";
import { LocalComputerSection } from "../../LocalComputerSection";
import { ScriptAccessSettings } from "../../ScriptAccessSettings";
import { Card } from "../../SettingsPrimitives";
import { BrowserProfilesRow, WorkspaceFeatureRow } from "../../SettingsModal";
import { PageCards } from "../PageCards";

type Bots = ReadonlyArray<{ id: string; name: string; hidden?: boolean }>;

/** The cards of Computer & browser, in page order. */
export function computerCards(bots: Bots): SettingsPageCard[] {
  return [
    { id: "companion.computer", anchor: "computer-settings-heading", simple: false, render: () => <><LocalComputerSection /><DefaultComputerRow /><BrowserProfilesRow /><BrowserExternalClients /></> },
    { id: "companion.browser", anchor: "browser-settings-heading", simple: true, render: () => <WorkspaceFeatureRow feature="browser" /> },
    {
      id: "companion.vps", anchor: "vps-heading", simple: false, render: () => (
        <Card title={t("settings.computer.remoteTitle")} subtitle={t("settings.computer.remoteNote")}>
          <div className="flex flex-col gap-4">
            <ApiKeyRow section="box" settingControl="vps-heading" />
            <VpsConnection />
          </div>
        </Card>
      ),
    },
    { id: "companion.script-access", anchor: "script-access-heading", simple: false, render: () => <ScriptAccessSettings bots={bots} /> },
  ];
}

export default function ComputerPage({ mode }: SettingsPageProps) {
  const { state } = useStore();
  return <PageCards cards={computerCards(state.bots)} mode={mode} />;
}
