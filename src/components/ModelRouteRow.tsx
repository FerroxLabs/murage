// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SETTINGS-LOCKED-1019.md 4.1 and 4.3: the line a bot's Model card and the model picker show for the engine they are on,
// when that route needs something (off, not installed, needs a repair, needs a sign-in, credit used up). One EngineRow,
// one fix, the same words as Settings > Models & engines. Nothing is drawn while the route is ready, or while there is
// only a reading in progress (no fix to offer), so a working bot's card stays as quiet as it was.
import { api, useStore, type InstanceInfo } from "@/state/store";
import { routeState, type RouteFixAction } from "@/lib/route-state";
import { creditFromHealth } from "@/lib/flux-credit";
import { useEngineHealthAnswer } from "@/components/today/use-engine-health";
import { EngineRow } from "./EngineRow";

/** `manage` opens Settings > Models & engines, where install, repair, sign-in and renew steps live. */
export function ModelRouteRow({ engine, manage, className }: { engine: InstanceInfo | undefined; manage: () => void; className?: string }) {
  const { refreshInstances } = useStore();
  const health = useEngineHealthAnswer();
  if (!engine) return null;
  const route = routeState(null, engine, null, creditFromHealth(health));
  if (!route.fix) return null;
  const onFix = (action: RouteFixAction) => {
    if (action === "turnOn") {
      void api(`/api/instances/${encodeURIComponent(engine.instanceId)}`, { method: "PATCH", body: JSON.stringify({ enabled: true }) })
        .then(() => refreshInstances(), () => manage());
      return;
    }
    if (action === "addCredit") { window.open("https://flux.ferroxlabs.com", "_blank", "noopener,noreferrer"); return; }
    manage();
  };
  return <EngineRow name={engine.displayName} state={route} onFix={onFix} className={className} />;
}
