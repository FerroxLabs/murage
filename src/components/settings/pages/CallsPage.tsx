// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > Calls (1.0.19 page 2 of 14): calls to you (off for today, history) first, then the calls your bots place for
// you (the voice account, numbers, your words), which moved here from Connected apps with its id kept
// (connections.phone-calls, anchor phone-calls-heading, so every old link still lands).
import { Suspense } from "react";
import type { SettingsPageCard, SettingsPageProps } from "@/lib/settings-page-contract";
import { CallsSettings } from "../../CallsSettings";
import { LazyBoundary, retryableLazy } from "../../LazyBoundary";
import { PageCards } from "../PageCards";
import { deviceGate } from "./page-kit";

// Its screen and its 8-language words load the first time the page shows (BOT-CALLS-1020).
const PhoneCallsSection = retryableLazy(() => import("../../PhoneCallsSettings"));

export function callsCards({ desktop }: Pick<SettingsPageProps, "desktop">): SettingsPageCard[] {
  return [
    { id: "calls.calls", anchor: "calls-settings-title", simple: false, render: () => deviceGate(desktop, "calls-settings-title", () => <CallsSettings />) },
    {
      id: "connections.phone-calls", anchor: "phone-calls-heading", simple: false,
      render: () => deviceGate(desktop, "phone-calls-heading", () => (
        <LazyBoundary inline onRetry={PhoneCallsSection.retry}><Suspense fallback={null}><PhoneCallsSection.Component /></Suspense></LazyBoundary>
      )),
    },
  ];
}

export default function CallsPage({ mode, desktop }: SettingsPageProps) {
  return <PageCards cards={callsCards({ desktop })} mode={mode} />;
}
