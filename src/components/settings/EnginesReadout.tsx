// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Models & engines away from the desktop (a paired phone, a Cloud window; LOCKED 2.4 "read-only"): which engines this
// Murage has and whether each one works, from the same /api/instances list and route state the desktop rows read.
// No key, no command line and no button: changing any of it is the computer's job.
import { creditFromHealth } from "@/lib/flux-credit";
import { routeState } from "@/lib/route-state";
import { useEngineHealthAnswer } from "@/components/today/use-engine-health";
import { useStore } from "@/state/store";

export function EnginesReadout() {
  const { state } = useStore();
  const credit = creditFromHealth(useEngineHealthAnswer());
  return (
    <div data-engines-readout className="flex flex-col gap-2">
      <p className="text-[12px] text-ink-secondary">Read-only here. Add keys and change engines on your computer.</p>
      {state.instances.length === 0 ? <p className="text-[13px] text-ink-secondary">No engines are set up yet.</p> : (
        <ul className="divide-y divide-hairline/30">
          {state.instances.map((instance) => (
            <li key={instance.instanceId} data-engine-readout={instance.instanceId} className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-[13px]">
              <span className="text-ink">{instance.displayName}</span>
              <span className="text-ink-secondary">{routeState(null, instance, null, credit).line}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
