// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings > Models and engines (1.0.3 L4): the Flux Router card, your sign-ins and keys with Add a key, and the
// engines (install, update, repair) first; model catalogs, local model servers, several Claude accounts and engine
// command lines under the page's one Advanced. Each card that holds an Advanced part sends it to the slot with
// <InAdvanced>, so every key field and every repair row stays on the first screen.
import { useEffect, useRef } from "react";
import { t } from "@/lib/i18n";
import { OPEN_LOCAL_MODELS_EVENT } from "@/lib/local-models-view";
import { EnginesSettings } from "./EnginesSettings";
import { requestLocalModelsFocus } from "./LocalModelsSettings";
import { ModelsSettings } from "./ModelsSettings";
import { PasteKeys } from "./PasteKeys";
import { Anchor } from "./SettingsAnchor";
import { AdvancedHost, AdvancedSection, AdvancedSlotTarget, Card } from "./SettingsPrimitives";
import type { PageAdvanced } from "./BotsSettings";

export function AiSettings({ advanced }: { advanced: PageAdvanced }) {
  // The Engines rows and the model picker send people to the local servers by event. That section lives under
  // Advanced, so the page opens it first and the section takes the focus as it mounts.
  const open = useRef(advanced);
  open.current = advanced;
  useEffect(() => {
    const onOpen = () => {
      if (open.current.open) return;
      requestLocalModelsFocus();
      open.current.onOpenChange(true);
    };
    window.addEventListener(OPEN_LOCAL_MODELS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_LOCAL_MODELS_EVENT, onOpen);
  }, []);
  return (
    <AdvancedHost>
      <ModelsSettings />
      <div id="paste-any-keys" tabIndex={-1} className="outline-none">
        <Card title={t("settings.l4.addKey.title")} subtitle={t("settings.l4.addKey.note")}>
          <PasteKeys />
        </Card>
      </div>
      <Anchor id="engines-heading">
        <Card title={t("settings.l4.engines.title")} subtitle={t("settings.l4.engines.note")}>
          <EnginesSettings />
        </Card>
      </Anchor>
      <AdvancedSection {...advanced} summary={t("settings.l4.advanced.models")}><AdvancedSlotTarget /></AdvancedSection>
    </AdvancedHost>
  );
}
