// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > Models & engines (1.0.19 page 6 of 14; PAGES-A-astra.md). Engines first (each row is S1's EngineRow, read from
// routeState), then local servers, Flux and the model connections, pasted keys, Claude accounts, the existing keys, the
// catalogs, the new-bot effort (moved here from How every bot behaves; its id botDefaults.new-bot-effort is kept) and the
// engine command lines. ModelsSettings is hosted once; each card is a slot it sends its piece to (PartsHost).
import type { ReactNode } from "react";
import { t } from "@/lib/i18n";
import type { SettingsPageCard, SettingsPageProps } from "@/lib/settings-page-contract";
import { isSimpleCard } from "@/lib/settings-simple-cards";
import { EnginesSettings } from "../../EnginesSettings";
import { ModelsSettings } from "../../ModelsSettings";
import { PasteKeys } from "../../PasteKeys";
import { Card, PartSlot, PartsHost } from "../../SettingsPrimitives";
import { PageCards } from "../PageCards";
import { NewBotEffortRow } from "../rows/BotRows";
import { deviceGate } from "./page-kit";

export function modelsCards({ desktop }: Pick<SettingsPageProps, "desktop">): SettingsPageCard[] {
  const card = (name: string, anchor: string, render: () => ReactNode, idSection = "models"): SettingsPageCard => ({
    id: `${idSection}.${name}`, anchor, simple: isSimpleCard(`${idSection}.${name}`), render: () => deviceGate(desktop, anchor, render),
  });
  const slot = (name: string) => () => <PartSlot id={`models.${name}`} />;
  return [
    card("engines", "engines-heading", () => (
      <>
        <Card title={t("settings.l4.engines.title")} subtitle={t("settings.l4.engines.note")}><EnginesSettings /></Card>
        <PartSlot id="models.engines-more" />
      </>
    )),
    card("local-servers", "local-models-heading", slot("local-servers")),
    card("providers", "models-heading", slot("providers")),
    card("paste-keys", "paste-any-keys", () => (
      <Card title={t("settings.l4.addKey.title")} subtitle={t("settings.l4.addKey.note")}><PasteKeys /></Card>
    )),
    card("claude-accounts", "claude-accounts-heading", slot("claude-accounts")),
    card("existing-keys", "existing-keys-heading", slot("existing-keys")),
    card("catalogs", "model-catalogs-heading", slot("catalogs")),
    card("new-bot-effort", "new-bot-effort-heading", () => <NewBotEffortRow />, "botDefaults"),
    card("command-lines", "engine-command-lines-heading", slot("command-lines")),
  ];
}

export default function ModelsPage({ mode, desktop }: SettingsPageProps) {
  return (
    <PartsHost>
      {desktop === true && <ModelsSettings />}
      <PageCards cards={modelsCards({ desktop })} mode={mode} />
    </PartsHost>
  );
}
