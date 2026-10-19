import { createHash } from "node:crypto";
import { memoryRequestPrefix } from "../../shared/memory.ts";
import { buildFluxMemoryEnvelope, fluxEnvelopeApplies, recordFluxMemoryReport } from "../flux-memory-envelope.ts";
import { fluxMemoryContextForTurn, fluxMemoryDecision } from "../flux-memory-headers.ts";
import type { ProviderAdapter, ProviderInstance, SendTurnInput } from "../contracts.ts";

/** One delivery contract for every registered adapter. This is a user-message
 * reference prefix; it never changes the system prompt or grants authority. */
export function decorateMemoryInstance(live: ProviderInstance): ProviderInstance {
  const original = live.adapter;
  const sessions = new Map<string, { sessionId: string; fingerprint?: string }>();
  const pending = new Map<string, string>();
  const unsubscribe = original.onEvent(event => {
    if (event.type === "turn.completed") pending.delete(event.threadId);
    if (event.type === "session.exited") {
      sessions.delete(event.threadId); pending.delete(event.threadId);
    } else if (event.type === "session.started") {
      if (!event.sessionId) { sessions.delete(event.threadId); pending.delete(event.threadId); return; }
      const previous = sessions.get(event.threadId);
      sessions.set(event.threadId, {
        sessionId: event.sessionId,
        fingerprint: pending.get(event.threadId) ?? (previous?.sessionId === event.sessionId ? previous.fingerprint : undefined),
      });
      pending.delete(event.threadId);
    }
  });
  const sendTurn = async (input: SendTurnInput) => {
    const { memoryContext: bundled, ...turn } = input;
    // An engine command reaches the engine as the command alone, so it
    // carries no reference, and counts as an unbundled turn below: the next
    // ordinary turn delivers the bundle again.
    // Flux memory envelope (lane 2.2): on a Flux turn with the switch on, Murage sends its recall as the
    // fallback and injects nothing locally, so exactly one memory block reaches the model. The turn must also be one the
    // 1.0.2 Flux memory headers inject on (the owner's own turn, no kill switch, no breaker, flux-memory-headers.ts): a
    // non-owner audience, a background or prewarm turn keeps local injection, as its headers already say inject off.
    const envelope = original.capabilities.fluxEnvelope === true && fluxEnvelopeApplies(input, { driverCarries: true })
      && fluxMemoryDecision(fluxMemoryContextForTurn(input)).inject === "on"
      ? buildFluxMemoryEnvelope(bundled?.text ?? "") : undefined;
    if (envelope) {
      turn.fluxMemory = envelope;
      const bundleId = bundled?.bundleId;
      turn.onFluxMemory = report => {
        recordFluxMemoryReport(input.threadId, report, bundleId);
        input.onFluxMemory?.(report);
      };
    }
    const memoryContext = input.engineCommand || envelope ? undefined : bundled;
    if (input.integrations?.memory) {
      const { memory, ...integrations } = input.integrations;
      if (Object.hasOwn(integrations.custom ?? {}, "murage-memory")) throw new Error("MEMORY_MCP_NAME_COLLISION");
      if (original.capabilities.memoryMcp === true) {
        turn.integrations = { ...integrations, memory };
      } else turn.integrations = integrations;
    }
    let fingerprint: string | undefined;
    if (memoryContext) {
      fingerprint = createHash("sha256").update(JSON.stringify([
        memoryContext.text, memoryContext.policyRevision, memoryContext.deletionEpoch,
        memoryContext.recordVersions, memoryContext.sourceVersions, input.model ?? null,
      ])).digest("hex");
      const confirmed = sessions.get(input.threadId);
      const sameSession = input.resumeCursor === undefined || input.resumeCursor === confirmed?.sessionId;
      const alreadyDelivered = original.hasSession(input.threadId) && sameSession && confirmed?.fingerprint === fingerprint;
      if (!alreadyDelivered) {
        turn.text = memoryRequestPrefix(memoryContext.text) + input.text;
      }
      pending.set(input.threadId, fingerprint);
    } else {
      // A later bundle must be delivered again after an unbundled turn.
      sessions.delete(input.threadId); pending.delete(input.threadId);
    }
    try {
      const result = await original.sendTurn(turn);
      if (fingerprint && sessions.has(input.threadId)) sessions.get(input.threadId)!.fingerprint = fingerprint;
      return result;
    } catch (error) {
      sessions.delete(input.threadId); pending.delete(input.threadId);
      throw error;
    }
  };
  const adapter = new Proxy(original, {
    get(target, property) {
      if (property === "sendTurn") return sendTurn;
      if (property === "capabilities") return {
        ...target.capabilities, memoryDelivery: "prefixed-reference", memoryMcp: target.capabilities.memoryMcp === true,
      };
      if (property === "stopAll") return async () => {
        sessions.clear(); pending.clear(); await target.stopAll();
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ProviderAdapter;
  let disposed = false;
  return new Proxy(live, {
    get(target, property) {
      if (property === "adapter") return adapter;
      if (property === "dispose") return async () => {
        if (!disposed) { disposed = true; unsubscribe(); sessions.clear(); pending.clear(); }
        await target.dispose();
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
