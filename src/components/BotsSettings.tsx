// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > Bots (1.0.3 L4): the starter profiles and the house rules first; the defaults a new bot starts with, how
// tool calls show, project autonomy, channel turns and room routing under the page's one Advanced.
import type { ReactNode } from "react";
import { t } from "@/lib/i18n";
import type { AdvancedSectionProps } from "@/lib/settings-cards";
import { Anchor } from "./SettingsAnchor";
import { AdvancedSection, Card } from "./SettingsPrimitives";
import { StarterProfiles } from "./StarterProfiles";
import { HouseRulesSettings } from "./HouseRulesSettings";
import { ProjectAutonomySetting } from "./ProjectAutonomySetting";
import { RoomTurnTimeoutSettings } from "./RoomTurnTimeoutSettings";
import { ROOM_ROUTING_COPY, RoomRoutingSettings } from "./RoomRoutingSettings";

export type PageAdvanced = Pick<AdvancedSectionProps, "section" | "open" | "onOpenChange">;

export function BotsSettings({ advanced, effortRow, toolCallsRow }: { advanced: PageAdvanced; effortRow: ReactNode; toolCallsRow: ReactNode }) {
  return (
    <>
      <Anchor id="starter-profiles-heading"><StarterProfiles /></Anchor>
      <HouseRulesSettings />
      <AdvancedSection {...advanced} summary={t("settings.l4.advanced.botDefaults")}>
        <Anchor id="new-bot-effort-heading">{effortRow}</Anchor>
        <Anchor id="tool-calls-heading">{toolCallsRow}</Anchor>
        <Anchor id="project-autonomy-heading"><ProjectAutonomySetting /></Anchor>
        <Card title="Channel turns" subtitle="Stop a bot that goes quiet in a channel. Use Stop to end a reply yourself.">
          <RoomTurnTimeoutSettings />
        </Card>
        <Card title={ROOM_ROUTING_COPY.title} subtitle={ROOM_ROUTING_COPY.subtitle}>
          <RoomRoutingSettings />
        </Card>
      </AdvancedSection>
    </>
  );
}
