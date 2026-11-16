// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > How every bot behaves (1.0.19 page 3 of 14): the rules and working defaults shared by every bot. New-bot
// effort moved to Models & engines (its id botDefaults.new-bot-effort is kept).
import type { SettingsPageCard, SettingsPageProps } from "@/lib/settings-page-contract";
import type { ReactNode } from "react";
import { HouseRulesSettings } from "../../HouseRulesSettings";
import { ProjectAutonomySetting } from "../../ProjectAutonomySetting";
import { ROOM_ROUTING_COPY, RoomRoutingSettings } from "../../RoomRoutingSettings";
import { RoomTurnTimeoutSettings } from "../../RoomTurnTimeoutSettings";
import { StarterProfiles } from "../../StarterProfiles";
import { Card } from "../../SettingsPrimitives";
import { PageCards } from "../PageCards";
import { ToolCallsRow } from "../rows/BotRows";
import { deviceGate } from "./page-kit";

export function botDefaultsCards({ desktop }: Pick<SettingsPageProps, "desktop">): SettingsPageCard[] {
  const card = (name: string, anchor: string, render: () => ReactNode): SettingsPageCard => ({
    id: `botDefaults.${name}`, anchor, simple: false, render: () => deviceGate(desktop, anchor, render),
  });
  return [
    card("house-rules", "house-rules-heading", () => <HouseRulesSettings />),
    card("starter-profiles", "starter-profiles-heading", () => <StarterProfiles />),
    card("tool-calls", "tool-calls-heading", () => <ToolCallsRow />),
    card("project-autonomy", "project-autonomy-heading", () => <ProjectAutonomySetting />),
    card("channel-turns", "room-turn-timeout", () => (
      <Card title="Channel turns" subtitle="Stop a bot that goes quiet in a channel. Use Stop to end a reply yourself."><RoomTurnTimeoutSettings /></Card>
    )),
    card("room-routing", "room-routing-label", () => <Card title={ROOM_ROUTING_COPY.title} subtitle={ROOM_ROUTING_COPY.subtitle}><RoomRoutingSettings /></Card>),
  ];
}

export default function BotDefaultsPage({ mode, desktop }: SettingsPageProps) {
  return <PageCards cards={botDefaultsCards({ desktop })} mode={mode} />;
}
