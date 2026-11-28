import { describe, expect, it } from "vitest";
import { autoVerdict, type AutoApprover } from "./auto-approve.ts";

// Windows CU review (F28): the owner's real desktop is never looked at on a turn nobody is watching.
// The entry is the classifier every engine's host-computer ask goes through (autoVerdict), shaped like a
// Claude ask for Murage's own computer mount.
const mounts = [{ engineName: "computer", mountId: "own:computer", provenance: "own" as const }];
const ask = (name: string) => {
  const toolCall = { name: `mcp__computer__${name}`, input: {} };
  return { tool: toolCall.name, summary: name, call: { toolCall, mcpMounts: mounts, engine: "claude" as const } };
};
const verdict = (bot: AutoApprover, name: string, context: object) => {
  const opened = ask(name);
  return autoVerdict(bot, opened.tool, opened.summary, { call: opened.call, scope: "local-computer", ...context } as never);
};
const READS = ["screenshot", "get_window_state", "get_desktop_state", "list_windows", "zoom"];

describe("an unattended host turn never looks at the owner's real screen unasked", () => {
  for (const [label, bot] of [["Ask", { autoApprove: false }], ["Auto", { autoApprove: true }]] as const) {
    for (const name of READS) {
      it(`${label}: ${name} on an unattended turn is held`, () => {
        const result = verdict(bot, name, { unattended: true });
        expect(result.approve).toBeNull();
        expect(["no-grant", "unattended-block"]).toContain(result.source);
      });
    }
  }

  it("an attended owner turn keeps its one-card behaviour: reads run unasked, a click asks at Ask", () => {
    for (const name of READS) expect(verdict({ autoApprove: false }, name, {}).approve, name).toEqual(expect.any(String));
    expect(verdict({ autoApprove: false }, "click", {}).approve).toBeNull();
  });

  it("a read of Murage's computer that is not host-scoped (a VM or cloud box) is untouched on an unattended turn", () => {
    const opened = ask("screenshot");
    const result = autoVerdict({ autoApprove: false }, opened.tool, opened.summary, { call: opened.call, unattended: true } as never);
    expect(result).toMatchObject({ source: "own-unasked", approve: expect.any(String) });
  });
});

describe("what Local control says about asking is what the classifier does at Ask on an owner turn", () => {
  it("looking at the screen never asks; every action that changes something asks", () => {
    for (const name of READS) expect(verdict({ autoApprove: false }, name, {}).approve, name).toEqual(expect.any(String));
    for (const name of ["click", "type_text", "press_key", "hotkey", "drag", "scroll", "launch_app", "computer_exec", "open_url"]) {
      expect(verdict({ autoApprove: false }, name, {}).approve, name).toBeNull();
    }
  });
});
