// SPDX-License-Identifier: AGPL-3.0-or-later
// Positive logger fixtures supply the host admission that a real dispatch owns.
// The production collector, policy, log projection and execution events remain
// unchanged. A standalone completed item models one complete fixture turn;
// explicit turn ids keep streamed items in the same admitted turn.
import { EventBus } from "../harness/bus.ts";
import type { ProviderInstance, RuntimeEvent, SourceContext } from "../contracts.ts";

export class AdmittedEventBus extends EventBus {
  private readonly fixtureInstances = new Map<string, string>();
  private readonly fixtureTurns = new Map<string, { source: SourceContext; turnId?: string }>();

  override publish(event: RuntimeEvent, source?: SourceContext): void {
    if (source) { super.publish(event, source); return; }
    const instanceKey = JSON.stringify([event.provider, event.providerInstanceId]);
    let instanceId = this.fixtureInstances.get(instanceKey);
    if (!instanceId) {
      instanceId = `fixture-${this.fixtureInstances.size + 1}`;
      this.attach([{
        instanceId, driverKind: event.provider ?? "fixture",
        adapter: { onEvent: () => () => {} },
      } as unknown as ProviderInstance]);
      this.fixtureInstances.set(instanceKey, instanceId);
    }
    let turn = this.fixtureTurns.get(event.threadId);
    if (!turn || event.type === "turn.started" || event.turnId && event.turnId !== turn.turnId) {
      turn = { source: this.admitNewTurn(instanceId, event.threadId), turnId: event.turnId };
      this.fixtureTurns.set(event.threadId, turn);
    }
    super.publish(event, turn.source);
    if (event.type === "turn.completed" || event.type === "session.exited" || event.type === "item.completed" && !event.turnId) {
      this.cancelTurn(event.threadId);
      this.fixtureTurns.delete(event.threadId);
    }
  }
}
