// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > Devices (1.0.3 L4): phone pairing, and the computer and browser your bots can borrow, first; script
// access and the remote computer connection (VPS) under the page's one Advanced.
import type { ReactNode } from "react";
import { t } from "@/lib/i18n";
import { ApiKeyRow, VpsConnection } from "./ApiKeys";
import { BrowserExternalClients } from "./BrowserExternalClients";
import { CompanionSection } from "./CompanionSection";
import { LocalComputerSection } from "./LocalComputerSection";
import { ScriptAccessSettings } from "./ScriptAccessSettings";
import { Anchor } from "./SettingsAnchor";
import { AdvancedSection, Card } from "./SettingsPrimitives";
import type { PageAdvanced } from "./BotsSettings";

/** Every computer a bot can borrow, and the browser it can use. The remote computer connection is in Advanced. */
export function ComputerAndBrowserSettings({ browserProfiles }: { browserProfiles: ReactNode }) {
  return (
    <>
      <LocalComputerSection />
      {browserProfiles}
      <BrowserExternalClients />
    </>
  );
}

export function DevicesSettings({ advanced, profileEmail, bots, browserProfiles }: {
  advanced: PageAdvanced;
  profileEmail?: string;
  bots: ReadonlyArray<{ id: string; name: string; hidden?: boolean }>;
  browserProfiles: ReactNode;
}) {
  return (
    <>
      <Anchor id="companion-heading"><CompanionSection profileEmail={profileEmail} /></Anchor>
      <Anchor id="computer-settings-heading"><ComputerAndBrowserSettings browserProfiles={browserProfiles} /></Anchor>
      <AdvancedSection {...advanced} summary={t("settings.l4.advanced.companion")}>
        <ScriptAccessSettings bots={bots} />
        <Anchor id="vps-heading">
          <Card title={t("settings.computer.remoteTitle")} subtitle={t("settings.computer.remoteNote")}>
            <div className="flex flex-col gap-4">
              <ApiKeyRow section="box" />
              <VpsConnection />
            </div>
          </Card>
        </Anchor>
      </AdvancedSection>
    </>
  );
}
