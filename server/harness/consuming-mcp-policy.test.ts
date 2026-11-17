import { expect, it } from "vitest";
import { ProviderRegistry } from "./registry.ts";
import { makeFakeDriver } from "../testing/fake-driver.ts";
it("registry withholds unqualified consuming mounts while preserving native chat and explicit mount refusal", async () => {
  const fake = makeFakeDriver();
  const create = fake.driver.create;
  let received: unknown;
  fake.driver.create = async input => {
    const instance = await create(input);
    Object.assign(instance.adapter.capabilities, { consumingMcp: false, agentsMcp: true, memoryMcp: true,
      computerMcp: true, composioMcp: true, phoneMcp: true, browserMcp: true, customMcp: true, localComputerMcp: true, images: true });
    instance.adapter.sendTurn = async turn => { received = turn; if (turn.integrations) throw new Error("explicit mount refused"); return { turnId: "native-chat" }; };
    return instance;
  };
  const registry = new ProviderRegistry([fake.driver]);
  try {
    await registry.load({ fixture: { driver: "fake" } });
    const adapter = registry.get("fixture")!.adapter;
    expect(adapter.capabilities).toMatchObject({ agentsMcp: false, memoryMcp: false, computerMcp: false,
      composioMcp: false, phoneMcp: false, browserMcp: false, customMcp: false, localComputerMcp: false, images: true });
    await expect(adapter.sendTurn({ threadId: "T", text: "hello" })).resolves.toEqual({ turnId: "native-chat" });
    const mounted = { threadId: "T", text: "hello", integrations: { agents: { command: "fixture", args: [], env: {} } } };
    await expect(adapter.sendTurn(mounted)).rejects.toThrow("explicit mount refused");
    expect((received as typeof mounted).integrations).toBe(mounted.integrations);
    expect(fake.created.get("fixture")!.instance.adapter.capabilities.agentsMcp).toBe(true);
  } finally { await registry.disposeAll(); }
});
