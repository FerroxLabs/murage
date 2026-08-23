import { describe, expect, it } from "vitest";

import { describeRun, groupActivityRuns } from "./activity-runs";
import type { Message } from "@/state/store";

let seq = 0;
const tool = (name: string, ok = true): Message =>
  ({ id: `t${++seq}`, at: seq, kind: "activity", tool: { name, ok } }) as Message;
/** a step with no verdict yet — `ok` absent, not `ok: undefined`, which a
 * default parameter would quietly turn back into a finished step */
const running = (name: string): Message =>
  ({ id: `t${++seq}`, at: seq, kind: "activity", tool: { name } }) as Message;
const text = (body: string): Message => ({ id: `m${++seq}`, at: seq, kind: "text", text: body }) as Message;

describe("groupActivityRuns", () => {
  it("folds consecutive tool steps into one run", () => {
    const items = groupActivityRuns([tool("Edit"), tool("Bash"), tool("Edit")]);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("run");
    expect(items[0].kind === "run" && items[0].messages).toHaveLength(3);
  });

  it("keeps text between runs, so a run never swallows what the bot said", () => {
    const items = groupActivityRuns([tool("Edit"), tool("Edit"), text("Now the sitemap:"), tool("Write"), tool("Write")]);
    expect(items.map((i) => i.kind)).toEqual(["run", "message", "run"]);
  });

  it("leaves a lone tool step as an ordinary message", () => {
    const items = groupActivityRuns([text("hi"), tool("Edit"), text("done")]);
    expect(items.map((i) => i.kind)).toEqual(["message", "message", "message"]);
  });

  it("keeps a step that is still running out of the run, so live progress stays visible", () => {
    const items = groupActivityRuns([tool("Edit"), tool("Edit"), running("Bash")]);
    expect(items.map((i) => i.kind)).toEqual(["run", "message"]);
    expect(items[1].kind === "message" && items[1].message.tool?.name).toBe("Bash");
  });

  it("never folds a failed turn, which renders as an error not a tool run", () => {
    const items = groupActivityRuns([tool("Edit"), tool("error: the CLI exited")]);
    expect(items.map((i) => i.kind)).toEqual(["message", "message"]);
  });

  it("gives a run a stable id taken from its first step", () => {
    const steps = [tool("Edit"), tool("Edit")];
    const items = groupActivityRuns(steps);
    expect(items[0].kind === "run" && items[0].id).toBe(`run:${steps[0].id}`);
  });
});

describe("describeRun", () => {
  it("counts repeats and names the tools in order of first use", () => {
    expect(describeRun([tool("Edit"), tool("Bash"), tool("Edit"), tool("Edit")])).toBe("4 steps · Edit ×3, Bash");
  });

  it("names a single repeat without a multiplier", () => {
    expect(describeRun([tool("Edit"), tool("Bash")])).toBe("2 steps · Edit, Bash");
  });

  it("trims a long tail of tool names rather than running off the row", () => {
    expect(describeRun([tool("Edit"), tool("Bash"), tool("Write"), tool("Grep"), tool("Read")])).toBe(
      "5 steps · Edit, Bash, Write +2 more",
    );
  });

  it("says how many steps failed, because that is the reason to open it", () => {
    expect(describeRun([tool("Edit"), tool("Bash", false)])).toBe("2 steps · Edit, Bash · 1 failed");
  });
});
