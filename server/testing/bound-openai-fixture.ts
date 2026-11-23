// control: legacy provider fixtures use real, isolated generation accounting.
// Keep the caller's submission callback and all transport clocks unchanged.
import { randomUUID } from "node:crypto";
import type { ProviderInstance } from "../contracts.ts";
import { createOpenAIChatRuntime as createRuntime } from "../drivers/openai-chat.ts";
import { WritetimeFixture } from "../memory/testing/writetime-fixture.ts";
import { closeTurnLineage, openTurnLineage } from "../memory/lineage-write.ts";
import { bindFixtureTurn } from "./consuming-fixture.ts";
import { InternalCapabilities } from "../internal-capabilities.ts";
import { createProxyReleaseAuthority } from "../consuming-turn-ingress.ts";
import { createMcpMountAdmission } from "../drivers/mcp-mounts.ts";

/** ownerTurn: bind each turn as the owner's own turn (the production owner path; default is a non-owner turn). */
export function bindOpenAIFixture(instance: ProviderInstance, { ownerTurn = false }: { ownerTurn?: boolean } = {}): ProviderInstance {
  const cleanups: Array<() => void> = [];
  const send = instance.adapter.sendTurn.bind(instance.adapter);
  const dispose = instance.dispose.bind(instance);
  instance.adapter.sendTurn = input => {
    if (input.releaseBinding) return send(input);
    const f = new WritetimeFixture();
    const turn = openTurnLineage(f.db, { threadId: input.threadId, turnId: randomUUID() });
    const bound = bindFixtureTurn(f.db, turn, input.warmIdentity?.botId ?? "fixture", undefined, undefined, ownerTurn);
    const caps = new InternalCapabilities();
    caps.begin(bound.binding.identity.botId, input.threadId, turn.turnId);
    // Fixture MCP executables are custom children accepted in this process;
    // they never consume a hosted verdict endpoint or the user's app.
    const authority = createProxyReleaseAuthority(caps);
    const admission = createMcpMountAdmission(bound.binding, authority, "http://127.0.0.1:1");
    cleanups.push(() => { admission.dispose(); closeTurnLineage(turn); f.close(); });
    return send({ ...input, releaseBinding: bound.binding, mountAdmission: admission });
  };
  instance.dispose = async () => {
    // An unconfirmed stop must retain its fixture, just as it retains the child.
    await dispose();
    for (const close of cleanups.splice(0)) close();
  };
  return instance;
}

export const createOpenAIChatRuntime: typeof createRuntime = options => bindOpenAIFixture(createRuntime(options));
