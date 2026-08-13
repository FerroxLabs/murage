import { describe, expect, it } from "vitest";
import { instanceSupportsLocalComputer, linuxAutoDescription } from "./local-computer";

describe("local computer UI eligibility", () => {
  it("requires the selected instance to advertise approval-capable local MCP", () => {
    const bot = { modelSelection: { instanceId: "claude", model: "test" } };
    const instances = [
      {
        instanceId: "claude",
        capabilities: { localComputerMcp: true },
      },
    ] as any;
    expect(instanceSupportsLocalComputer(instances, bot as any)).toBe(true);
    expect(instanceSupportsLocalComputer([{ ...instances[0], capabilities: {} }] as any, bot as any)).toBe(
      false,
    );
  });

  it("states that Linux Auto never selects this computer", () => {
    expect(linuxAutoDescription()).toContain("otherwise computer use stays off");
  });
});
