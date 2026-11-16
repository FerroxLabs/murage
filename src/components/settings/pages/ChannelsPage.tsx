// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Messaging apps (SETTINGS-LOCKED-1019.md 3.12): where people can reach your bots. Eight cards in app order. Simple shows the
// four apps (Telegram, Slack, Discord, WhatsApp); Advanced adds the private Slack and Discord app setup, the WhatsApp allowed
// contacts and the WhatsApp groups. Each of those four is its own card: the app component keeps its one account and status
// and sends the part to the card's slot (AdvancedHost), so no second store or routing rule exists. Messaging apps run on this
// computer, so a phone or a paired browser sees a titled stub per card.
import type { SettingsPageCard, SettingsPageProps } from "@/lib/settings-page-contract";
import { sw } from "@/lib/settings-words";
import type { SettingsMode } from "@/lib/settings-mode";
import { DiscordSettings } from "../../DiscordSettings";
import { SlackSettings } from "../../SlackSettings";
import { TelegramSettings } from "../../TelegramSettings";
import { WhatsAppSettings } from "../../WhatsAppSettings";
import { SignalSettings } from "../../SignalSettings";
import { signalSettingsEnabled } from "@/lib/settings-card-registry";
import { AdvancedHost, AdvancedSlotTarget } from "../../SettingsPrimitives";
import { ComputerOnlyStub } from "../../SettingsStub";
import { PageCards } from "../PageCards";

const stub = (anchor: string) => <ComputerOnlyStub anchor={anchor} />;

/** A card whose body is a part of an app component. While the app has nothing to show there (WhatsApp not linked, or not in
 *  contacts mode), the card says so instead of standing empty. */
function SlotCard({ name, empty }: { name: string; empty?: string }) {
  return (
    <>
      <AdvancedSlotTarget name={name} className="peer space-y-4" />
      {empty && <p className="hidden rounded-xl border border-hairline/40 bg-card p-4 text-[12.5px] leading-relaxed text-ink-secondary peer-empty:block">{empty}</p>}
    </>
  );
}

/** The cards of Messaging apps, in page order. */
export function channelsCards({ desktop, mode, anchor }: Pick<SettingsPageProps, "desktop"> & { mode?: SettingsMode; anchor?: string | null }): SettingsPageCard[] {
  const live = desktop === true;
  return [
    { id: "channels.telegram", anchor: "telegram-settings-title", simple: true, render: () => (live ? <TelegramSettings mode={mode} /> : stub("telegram-settings-title")) },
    { id: "channels.slack", anchor: "slack-settings-title", simple: true, render: () => (live ? <SlackSettings mode={mode} arrivalAnchor={anchor} /> : stub("slack-settings-title")) },
    { id: "channels.slack-setup", anchor: "slack-app-setup-heading", simple: false, render: () => (live ? <SlotCard name="slack-setup" /> : stub("slack-app-setup-heading")) },
    { id: "channels.discord", anchor: "discord-settings-title", simple: true, render: () => (live ? <DiscordSettings mode={mode} arrivalAnchor={anchor} /> : stub("discord-settings-title")) },
    { id: "channels.discord-setup", anchor: "discord-app-setup-heading", simple: false, render: () => (live ? <SlotCard name="discord-setup" /> : stub("discord-app-setup-heading")) },
    { id: "channels.whatsapp", anchor: "whatsapp-settings-title", simple: true, render: () => (live ? <WhatsAppSettings mode={mode} arrivalAnchor={anchor} /> : stub("whatsapp-settings-title")) },
    ...(signalSettingsEnabled ? [{ id: "channels.signal", anchor: "signal-settings-title", simple: true, render: () => (live ? <SignalSettings /> : stub("signal-settings-title")) }] : []),
    { id: "channels.allow-lists", anchor: "whatsapp-allow-heading", simple: false, render: () => (live ? <SlotCard name="allow-lists" empty={sw("settings.channels.allowEmpty")} /> : stub("whatsapp-allow-heading")) },
    { id: "channels.whatsapp-groups", anchor: "whatsapp-groups-heading", simple: false, render: () => (live ? <SlotCard name="whatsapp-groups" empty={sw("settings.channels.groupsEmpty")} /> : stub("whatsapp-groups-heading")) },
  ];
}

export function ChannelsPageBody({ mode, desktop, anchor }: Pick<SettingsPageProps, "mode" | "desktop" | "cloud"> & { anchor?: string | null }) {
  return <AdvancedHost><PageCards cards={channelsCards({ desktop, mode, anchor })} mode={mode} /></AdvancedHost>;
}

export default function ChannelsPage(props: SettingsPageProps) {
  return <ChannelsPageBody {...props} />;
}
