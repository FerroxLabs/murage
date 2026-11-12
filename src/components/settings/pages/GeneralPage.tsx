// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > General (1.0.19 page 1 of 14; PAGES-A-astra.md). One list of cards, in the locked order; Simple shows the
// ones SIMPLE_CARDS names, Advanced shows all. Every control is the shipped component, so no key, type or default moves.
import { t } from "@/lib/i18n";
import { cloudCardHidden } from "@/lib/cloud-settings";
import { homeMeta } from "@/lib/cloud-door";
import { inNativeShell } from "@/lib/native-shell";
import type { SettingsPageCard, SettingsPageProps } from "@/lib/settings-page-contract";
import { isSimpleCard } from "@/lib/settings-simple-cards";
import { useStore } from "@/state/store";
import { AboutMeSettings } from "../../AboutMeSettings";
import { BringYourAi } from "../../BringYourAi";
import { CloudDevicesSettings } from "../../cloud/CloudDevicesSettings";
import { CloudDisconnectComputer, DISCONNECT_COPY, cloudDisconnectBridge } from "../../cloud/CloudDisconnectComputer";
import { NotificationSettings } from "../../NotificationSettings";
import { PhoneNotifications } from "../../PhoneNotifications";
import { PhonePayCard } from "../../phone/PhonePayCard";
import { RemoteSignOut } from "../../RemoteSignOut";
import { ScriptAccessSettings } from "../../ScriptAccessSettings";
import { SkinPicker } from "../../SkinPicker";
import { StartupSettings } from "../../StartupSettings";
import { TimeZoneSettings } from "../../TimeZoneSettings";
import { AdvancedModeCard } from "../AdvancedModeCard";
import { PageCards } from "../PageCards";
import { AnalyticsRow, FontRow, LanguageRow, ProfileFields, SendKeyRow, SidebarDensityRow } from "../rows/GeneralRows";
import { Card } from "../../SettingsPrimitives";
import type { ReactNode } from "react";
import type { Bot } from "@/state/store";
import { deviceGate, stub } from "./page-kit";

/** Related cards share a surface; every registry id, control adapter and landing anchor stays intact. */
export function generalCards({ desktop, cloud }: Pick<SettingsPageProps, "desktop" | "cloud">): SettingsPageCard[] {
  const on = (anchor: string, node: () => ReactNode) => () => deviceGate(desktop, anchor, node);
  const card = (name: string, anchor: string, render: () => ReactNode, group?: string): SettingsPageCard => ({ id: `general.${name}`, anchor, simple: isSimpleCard(`general.${name}`), render, group });
  return [
    card("mode", "advanced-mode-heading", () => <AdvancedModeCard />),
    card("profile", "profile-heading", () => (
      <Card title={t("settings.l4.profile.title")} subtitle={desktop === true ? t("settings.l4.profile.noteDesktop") : t("settings.l4.profile.note")}><ProfileFields /></Card>
    ), "general.about-you"),
    card("about-me", "about-me-heading", on("about-me-heading", () => <AboutMeSettings />), "general.about-you"),
    card("appearance", "appearance-heading", () => (
      <Card title={t("settings.appearance.title")} subtitle={t("settings.appearance.note")}><SkinPicker /><FontRow /></Card>
    ), "general.appearance"),
    card("sidebar-density", "sidebar-density-heading", on("sidebar-density-heading", () => <Card><SidebarDensityRow /></Card>), "general.appearance"),
    card("language", "language-heading", on("language-heading", () => <LanguageRow />), "general.language-time"),
    card("time-zone", "time-zone-heading", on("time-zone-heading", () => <TimeZoneSettings />), "general.language-time"),
    card("send-key", "send-key-heading", () => (inNativeShell() ? stub("send-key-heading") : <SendKeyRow />)),
    // A phone has its own push controls; the computer has the desktop ones.
    card("notifications", "notifications-heading", () => (desktop === false ? <PhoneNotifications /> : deviceGate(desktop, "notifications-heading", () => <NotificationSettings />))),
    card("startup", "startup-heading", on("startup-heading", () => (cloudCardHidden("startup-heading", cloud) ? stub("startup-heading") : <StartupSettings />))),
    card("analytics", "analytics-heading", () => (inNativeShell() ? stub("analytics-heading") : <AnalyticsRow />)),
    card("bring-your-ai", "bring-your-ai-heading", on("bring-your-ai-heading", () => <div tabIndex={-1} data-setting-control="bring-your-ai-heading" className="outline-none"><BringYourAi /></div>)),
  ];
}

export default function GeneralPage({ mode, desktop, cloud }: SettingsPageProps) {
  const { state } = useStore();
  const bots: Bot[] = state.bots;
  return (
    <>
      <PageCards cards={generalCards({ desktop, cloud })} mode={mode} />
      {desktop !== true && <p className="text-[12px] text-ink-secondary">{t("settings.general.remoteNote")}</p>}
      {/* Confirmed remote only: the desktop has no session to sign out of, and `undefined` renders the neutral thing. */}
      {desktop === false && <RemoteSignOut />}
      {desktop === false && <PhonePayCard />}
      {desktop === false && <ScriptAccessSettings bots={bots} />}
      {cloud && cloudDisconnectBridge() && <Card title={DISCONNECT_COPY.title} subtitle={DISCONNECT_COPY.subtitle}><CloudDisconnectComputer /></Card>}
      {desktop !== true && homeMeta(document).homeId && <Card title="Devices" subtitle="Browsers and computers connected to this Cloud home."><CloudDevicesSettings /></Card>}
    </>
  );
}
