// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// Lane 5.5: the labels a hand-off shows follow the copy rules whatever the bot put in its tool call.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { delegationAction, delegationLiveLine, delegationRequest } from "./delegation-tool";

const call = (fields: Record<string, unknown>) => JSON.stringify(fields);
const lineFor = (fields: Record<string, unknown>) => delegationAction("message_agent", call(fields)) ?? "";

describe("hand-off labels follow the copy rules", () => {
  it.each([
    ["a long bot id", { bot_id: "bot_8f3a91c2d4", message: "Draft the intro" }],
    ["a uuid", { bot_id: "3f2b8c1e-9a4d-4c7e-8b1a-5d6e7f8a9b0c", message: "Draft the intro" }],
    ["the vendor name", { bot_name: "Composio helper", message: "Draft the intro" }],
  ])("never shows %s as the teammate", (_label, fields) => {
    const request = delegationRequest("message_agent", call(fields));
    expect(request?.who).toBeNull();
    expect(lineFor(fields)).toContain("a teammate");
  });

  it("keeps names and tasks the person wrote, including safe, unsafe, short numbered names and dashes", () => {
    for (const name of ["Safe Harbor", "Unsafe Ops", "Jean-Luc"]) {
      expect(delegationRequest("message_agent", call({ bot_name: name, message: "Hi" }))?.who).toBe(name);
    }
    // a name shaped like an id is shown once the roster says it is a bot's name
    const roster = [{ id: "b1", name: "Agent-007" }, { id: "b2", name: "Bot-3PO" }];
    for (const name of ["Agent-007", "Bot-3PO"]) {
      expect(delegationRequest("message_agent", call({ bot_name: name, message: "Hi" }), { roster })?.who).toBe(name);
    }
    expect(delegationRequest("message_agent", call({ bot_name: "Jean\u2013Luc", message: "Hi" }))?.who).toBe("Jean-Luc");
    expect(delegationRequest("message_agent", call({ bot_name: "Draft \u2014 Partner", message: "Hi" }))?.who).toBe("Draft, Partner");
    expect(delegationRequest("delegate_task", call({ bot_name: "Draft Partner", task: "Check the safe deposit box" }))?.task).toBe("check the safe deposit box");
  });

  it("keeps a real name", () => {
    expect(lineFor({ bot_name: "Draft Partner", message: "Draft the intro." })).toBe("send Draft Partner a message");
    expect(delegationRequest("delegate_task", call({ bot_name: "Robot", task: "Draft the intro." }))?.who).toBe("Robot");
  });

  it.each([
    ["a uuid", "Look at 3f2b8c1e-9a4d-4c7e-8b1a-5d6e7f8a9b0c and reply"],
    ["the vendor name", "Send it through Composio"],
  ])("leaves %s out of the task phrase", (_label, task) => {
    const request = delegationRequest("delegate_task", call({ bot_name: "Draft Partner", task }));
    expect(request?.task).toBeNull();
    expect(delegationAction("delegate_task", call({ bot_name: "Draft Partner", task }))).toBe("hand work to Draft Partner");
  });

  it("turns an em dash in the task into a comma", () => {
    const request = delegationRequest("delegate_task", call({ bot_name: "Draft Partner", task: "Draft the intro \u2014 keep it short" }));
    expect(request?.task).toBe("draft the intro, keep it short");
    expect(request?.task).not.toMatch(/[\u2014\u2013]/);
    expect(delegationLiveLine("delegate_task", { bot_name: "Draft Partner", task: "x" })).toBe("handing work to Draft Partner");
  });

  it.each([
    [{ bot_id: "bot_123" }, null],
    [{ agent_id: "agent-7" }, null],
    [{ bot_id: "Draft Partner" }, "Draft Partner"],
    [{ botId: "Nova" }, "Nova"],
    [{ agentId: "3f2b8c1e-9a4d-4c7e-8b1a-5d6e7f8a9b0c" }, null],
    [{ bot: "bot_123" }, null],
    [{ agent: "agent-7" }, null],
    [{ bot: "8f3a91c2d4e5b6a7" }, null],
    [{ bot: "Draft Partner" }, "Draft Partner"],
    [{ bot_name: "Agent-007" }, null],
    [{ bot_name: "Jean\u2013Luc" }, "Jean-Luc"],
    [{ bot_name: "Draft \u2014 Partner" }, "Draft, Partner"],
    [{ bot_id: "bot_123", bot: "Draft Partner" }, "Draft Partner"],
  ])("a selector reads as a name only when it cannot be an id: %j", (fields, who) => {
    expect(delegationRequest("message_agent", call({ ...fields, message: "Hi" }))?.who).toBe(who);
    if (who === null) expect(lineFor({ ...fields, message: "Hi" })).toBe("send a teammate a message");
  });

  it("every field the bridge takes a teammate in is judged as a selector (source pin)", () => {
    const source = readFileSync(new URL("./delegation-tool.ts", import.meta.url), "utf8");
    const bridge = readFileSync(new URL("../server/drivers/agents-proxy.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/WHO_FIELDS|NAME_FIELDS/);
    const fields = JSON.parse(source.match(/const SELECTOR_FIELDS = (\[[^\]]*\])/)![1]!) as string[];
    const bridgeKeys = JSON.parse(bridge.match(/const TEAMMATE_KEYS = (\[[^\]]*\])/)![1]!) as string[];
    for (const key of bridgeKeys.filter((key) => key !== "name")) expect(fields).toContain(key);
    expect(source).toMatch(/readableName\(row\[field\], "selector"\)/);
    expect(source).not.toMatch(/readableName\(row\[field\], "name"\)/);
  });

  describe("every selector alias the bridge accepts (server/drivers/agents-proxy.ts TEAMMATE_KEYS)", () => {
    const roster = [{ id: "bot_123", name: "Draft Partner" }, { id: "ember", name: "Ember" }];
    const aliases = ["bot_id", "bot_name", "member", "recipient", "bot", "to", "botId", "botName", "agent_id", "agentId", "agent_name", "agentName", "agent", "target"];
    it.each(aliases)("%s holding an id never shows the id, and shows the bot's name when the roster is known", (alias) => {
      expect(delegationLiveLine("ask_bot", { [alias]: "bot_123", message: "Hi" })).toBe("asking a teammate");
      expect(delegationLiveLine("ask_bot", { [alias]: "@agent-7", message: "Hi" })).toBe("asking a teammate");
      expect(delegationLiveLine("ask_bot", { [alias]: "bot_123", message: "Hi" }, roster)).toBe("asking Draft Partner");
      // an id the roster knows, whatever its shape, is never shown as written
      expect(delegationLiveLine("ask_bot", { [alias]: "ember", message: "Hi" }, roster)).toBe("asking Ember");
      expect(delegationLiveLine("ask_bot", { [alias]: "ember", message: "Hi" }, [{ id: "ember", name: "{bad}" }])).toBe("asking a teammate");
      expect(delegationAction("ask_bot", call({ [alias]: "bot_123", message: "Hi" }), { roster })).toBe("ask Draft Partner a question");
    });
    it("the selector the bridge reads first names the teammate", () => {
      expect(delegationLiveLine("ask_bot", { bot_id: "ember", bot_name: "Draft Partner", message: "Hi" }, roster)).toBe("asking Ember");
      expect(delegationLiveLine("ask_bot", { recipient: "bot_123", message: "Hi" })).toBe("asking a teammate");
    });
  });
});
