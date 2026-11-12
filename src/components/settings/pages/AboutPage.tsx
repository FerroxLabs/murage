// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// About & help (SETTINGS-LOCKED-1019.md 3.17, seven cards): what you run, what is new, and help. Simple shows Version and
// updates and What's new; Advanced adds the rest. One list of cards, filtered by the shell (PageCards), no second copy.
// Version and updates holds the old Updates and Previous version rows, and News from us holds the old Announcements, each under
// its old anchor so an old link still lands on the row it named.
import { cloudCardHidden } from "@/lib/cloud-settings";
import { sw as t } from "@/lib/settings-words";
import type { SettingsPageCard, SettingsPageProps } from "@/lib/settings-page-contract";
import { AnnouncementsSettings } from "../../AnnouncementsSettings";
import { NewsSignupSettings } from "../../NewsSignupSettings";
import { PreviousVersionRow } from "../../PreviousVersionRow";
import { Anchor } from "../../SettingsAnchor";
import { ComputerOnlyStub } from "../../SettingsStub";
import { SetupAgainRow } from "../../SettingsModal";
import { Card } from "../../SettingsPrimitives";
import { PageCards } from "../PageCards";
import { AboutVersionCard, DiagnosticsRow, SettingsHealthRow, ShortcutsRow, SourceCodeRow, UpdatesCard, WhatsNewRow } from "./about-rows";

const stub = (anchor: string) => <ComputerOnlyStub anchor={anchor} />;
const canGoBack = () => typeof window !== "undefined" && typeof window.muragebox?.updater?.preparePreviousVersion === "function";

/** The cards of About & help, in page order. `desktop` and `cloud` decide a live card or its stub, never nothing. */
export function aboutCards({ desktop, cloud }: Pick<SettingsPageProps, "desktop" | "cloud">): SettingsPageCard[] {
  return [
    {
      id: "about.version", anchor: "about-version-heading", simple: true, render: () => (
        <Card title={t("settings.about.versionUpdatesTitle")}>
          <div className="space-y-4 divide-y divide-hairline/50 [&>div]:pt-4">
            <AboutVersionCard />
            <Anchor id="updates-heading"><UpdatesCard /></Anchor>
            <Anchor id="previous-version-heading">{canGoBack() ? <PreviousVersionRow inline /> : <ComputerOnlyStub anchor="previous-version-heading" inline label={t("settings.l1.card.about.previous-version")} />}</Anchor>
          </div>
        </Card>
      ),
    },
    { id: "about.whats-new", anchor: "whats-new-heading", simple: true, render: () => <WhatsNewRow /> },
    {
      id: "about.news", anchor: "news-heading", simple: false, render: () => (desktop === true
        ? <><NewsSignupSettings /><Anchor id="announcements-heading"><AnnouncementsSettings /></Anchor></>
        : <>{stub("news-heading")}<Anchor id="announcements-heading">{stub("announcements-heading")}</Anchor></>),
    },
    { id: "about.health", anchor: "health-heading", simple: false, render: () => <SettingsHealthRow /> },
    { id: "about.diagnostics", anchor: "diagnostics-heading", simple: false, render: () => (cloudCardHidden("diagnostics-heading", cloud) ? <ComputerOnlyStub anchor="diagnostics-heading" /> : <DiagnosticsRow />) },
    { id: "about.setup", anchor: "setup-heading", simple: false, render: () => (desktop !== true ? stub("setup-heading") : cloudCardHidden("setup-heading", cloud) ? <ComputerOnlyStub anchor="setup-heading" /> : <SetupAgainRow />) },
    { id: "about.shortcuts", anchor: "shortcuts-heading", simple: false, render: () => <><ShortcutsRow /><Card title={t("settings.about.sourceTitle")} subtitle={t("settings.about.sourceNote")}><SourceCodeRow /></Card></> },
  ];
}

export default function AboutPage({ mode, desktop, cloud }: SettingsPageProps) {
  return <PageCards cards={aboutCards({ desktop, cloud })} mode={mode} />;
}
