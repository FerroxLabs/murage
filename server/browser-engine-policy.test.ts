import { describe, expect, it } from "vitest";
import { listHeadlessBrowserTools, validateHeadlessBrowserCall } from "./browser-engine-policy.ts";

describe("headless browser tool policy", () => {
  it("rejects forged scope, launch configuration and file destinations before dispatch", () => {
    for (const key of ["session", "namespace", "extraArgs", "restore", "restoreSave", "allowedDomains", "caCert", "headed", "webmcp", "path", "screenshotDir", "all"]) {
      expect(() => validateHeadlessBrowserCall("agent_browser_open", { [key]: "forged" })).toThrow("not permitted");
    }
    for (const name of ["eval", "tools_profiles", "profiles", "state_load", "upload", "download", "get_cdp_url", "wait_for_function"]) {
      expect(() => validateHeadlessBrowserCall(`agent_browser_${name}`, {})).toThrow("not permitted");
    }
    expect(() => validateHeadlessBrowserCall("agent_browser_screenshot", { path: "/tmp/overwrite" })).toThrow("not permitted");
    expect(() => validateHeadlessBrowserCall("agent_browser_close", { all: true })).toThrow("not permitted");
    expect(() => validateHeadlessBrowserCall("agent_browser_fill", { selector: "--session", text: "other" })).toThrow("invalid value");
  });
  it("validates pinned core argument shapes and preserves private HTTP needs", () => {
    const examples: [string, Record<string, unknown>][] = [
      ["open", { url: "http://127.0.0.1:8123/private" }], ["read", { url: "https://example.com", outline: true, llms: "index" }],
      ["snapshot", { interactive: true, depth: 3 }], ["click", { selector: "@e1", newTab: true }],
      ["fill", { selector: "#query", text: "hello" }], ["type", { selector: "@e2", text: "hello", delayMs: 5 }],
      ["press", { key: "Control+a" }], ["check", { selector: "#accept" }], ["select", { selector: "#choice", values: ["one"] }],
      ["scroll", { direction: "down", amount: 300 }], ["wait_for_url", { url: "**/done", waitTimeoutMs: 1000 }],
      ["wait_for_load", { state: "domcontentloaded" }], ["get_attr", { selector: "a", name: "href" }],
      ["tab_switch", { tab: "t1" }], ["screenshot", { format: "png", fullPage: true }], ["close", {}],
    ];
    for (const [name, args] of examples) expect(validateHeadlessBrowserCall(`agent_browser_${name}`, args)).toEqual({ name: `agent_browser_${name}`, arguments: args });
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hello", "example.com"]) {
      expect(() => validateHeadlessBrowserCall("agent_browser_open", { url })).toThrow("HTTP");
    }
    expect(() => validateHeadlessBrowserCall("agent_browser_select", { selector: "a", values: [] })).toThrow("invalid value");
    expect(() => validateHeadlessBrowserCall("agent_browser_click", {})).toThrow("missing");
    expect(() => validateHeadlessBrowserCall("agent_browser_snapshot", { depth: -1 })).toThrow("invalid value");
  });
  it("replaces upstream schema escape hatches with the exact allowlist", () => {
    const tools = listHeadlessBrowserTools([
      { name: "agent_browser_open", inputSchema: { properties: { session: {}, extraArgs: {}, url: {} } } },
      { name: "agent_browser_eval" }, { name: "agent_browser_close" }, { name: "agent_browser_open" },
    ]);
    expect(tools.map((tool) => tool.name)).toEqual(["agent_browser_open", "agent_browser_close"]);
    expect(tools[0].inputSchema).toEqual({ type: "object", properties: { url: { type: "string" } }, required: [], additionalProperties: false });
    expect((tools[1].inputSchema as { properties: unknown }).properties).toEqual({});
    expect(listHeadlessBrowserTools(null)).toEqual([]);
  });
});
