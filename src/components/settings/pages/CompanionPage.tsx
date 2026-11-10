// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Phone and other devices (SETTINGS-LOCKED-1019.md 3.14): open Murage from your phone, a tablet or a browser. One card, the
// pairing card: phone access, the sign-in code and QR, remote access, paired devices, keep awake and the phone previews.
import type { SettingsPageCard, SettingsPageProps } from "@/lib/settings-page-contract";
import { useStore } from "@/state/store";
import { CompanionSection } from "../../CompanionSection";
import { PageCards } from "../PageCards";

/** The cards of Phone and other devices. */
export function companionCards(profileEmail: string | undefined): SettingsPageCard[] {
  return [
    { id: "companion.pairing", anchor: "companion-heading", simple: true, render: () => <CompanionSection profileEmail={profileEmail} /> },
  ];
}

export default function CompanionPage({ mode }: SettingsPageProps) {
  const { state } = useStore();
  return <PageCards cards={companionCards(state.config?.profile?.email)} mode={mode} />;
}
