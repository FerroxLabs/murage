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
import { useSettingsMode } from "@/lib/settings-mode";
import { EnginesSettings } from "../../EnginesSettings";
import { ModelsSettings } from "../../ModelsSettings";
import { PasteKeys } from "../../PasteKeys";
import { Card, PartSlot, PartsHost } from "../../SettingsPrimitives";
import { PageCards } from "../PageCards";
import { NewBotEffortRow } from "../rows/BotRows";
import { EnginesReadout } from "../EnginesReadout";
import { deviceGate } from "./page-kit";

/** Where the page's controls are live: the confirmed desktop, and not a Cloud window (its bridge refuses credential:set
 *  and model-signin:*). Elsewhere the page is read-only (LOCKED 2.4): the engine list as a readout, every card that takes
 *  a key or a command line as the onComputer stub. undefined while the surface has not answered. */
export function modelsLive({ desktop, cloud = false }: { desktop: boolean | undefined; cloud?: boolean }): boolean | undefined {
  if (desktop === undefined) return undefined;
  return desktop === true && !cloud;
}

export function modelsCards({ desktop, cloud = false }: Pick<SettingsPageProps, "desktop"> & { cloud?: boolean }): SettingsPageCard[] {
  const live = modelsLive({ desktop, cloud });
  const card = (name: string, anchor: string, render: () => ReactNode, idSection = "models"): SettingsPageCard => ({
    id: `${idSection}.${name}`, anchor, simple: isSimpleCard(`${idSection}.${name}`), render: () => deviceGate(live, anchor, render),
  });
  const slot = (name: string) => () => <PartSlot id={`models.${name}`} />;
  return [
    {
      ...card("engines", "engines-heading", () => (
        <>
          <Card title={t("settings.l4.engines.title")} subtitle={t("settings.l4.engines.note")}><EnginesSettings /></Card>
          <PartSlot id="models.engines-more" />
        </>
      )),
      // Away from the desktop the engine list stays readable: which engines there are and whether each works.
      ...(live === false ? { render: () => <Card title={t("settings.l4.engines.title")}><EnginesReadout /></Card> } : {}),
    },
    card("local-servers", "local-models-heading", slot("local-servers")),
    card("providers", "models-heading", slot("providers")),
    card("paste-keys", "paste-any-keys", () => (
      <AddKeyCard />
    )),
    card("claude-accounts", "claude-accounts-heading", slot("claude-accounts")),
    card("existing-keys", "existing-keys-heading", slot("existing-keys")),
    card("catalogs", "model-catalogs-heading", slot("catalogs")),
    card("new-bot-effort", "new-bot-effort-heading", () => <NewBotEffortRow />, "botDefaults"),
    card("command-lines", "engine-command-lines-heading", slot("command-lines")),
  ];
}

/** "Add a key" carries one helper line in Simple (G9 Fable H2): PasteKeys' own short line, which also says nothing is
 *  saved until the owner chooses. The card's subtitle says the same thing again, so it shows in Advanced only. */
export function AddKeyFrame({ simple, children }: { simple: boolean; children: ReactNode }) {
  return <Card title={t("settings.l4.addKey.title")} subtitle={simple ? undefined : t("settings.l4.addKey.note")}>{children}</Card>;
}

function AddKeyCard() {
  return <AddKeyFrame simple={useSettingsMode() === "simple"}><PasteKeys /></AddKeyFrame>;
}

/** Simple puts the one weekly job first: "Add a key" leads, the rest keep their order. Advanced is the full list as built. */
export function modelsCardsFor(mode: SettingsPageProps["mode"], input: Pick<SettingsPageProps, "desktop"> & { cloud?: boolean }): SettingsPageCard[] {
  const cards = modelsCards(input);
  if (mode !== "simple") return cards;
  return [...cards.filter((card) => card.id === "models.paste-keys"), ...cards.filter((card) => card.id !== "models.paste-keys")];
}

export default function ModelsPage({ mode, desktop, cloud }: SettingsPageProps) {
  return (
    <PartsHost>
      {modelsLive({ desktop, cloud }) === true && <ModelsSettings />}
      <PageCards cards={modelsCardsFor(mode, { desktop, cloud })} mode={mode} />
    </PartsHost>
  );
}
