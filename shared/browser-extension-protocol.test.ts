// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { parseBrowserExtensionMessage as parse, encodeBrowserExtensionMessage as encode, MAX_MESSAGE_BYTES } from "./browser-extension-protocol.ts";
const command = { version: 1 as const, type: "command" as const, id: "request_1", bindingId: "binding_1", generation: 1, operation: "read" as const, params: { tabId: 3 } };
describe("browser extension protocol", () => {
  it("round trips valid envelopes without retaining caller objects", () => { const parsed = parse(encode(command)); expect(parsed).toEqual(command); expect(parsed).not.toBe(command); });
  it.each([0, 2, "1", null])("rejects protocol version %s", version => expect(() => parse({ ...command, version })).toThrow());
  it.each([{ operation: "evaluate" }, { generation: 0 }, { generation: 1.5 }, { id: "../token" }, { params: [] }, { extra: true }])("rejects malformed envelope %j", patch => expect(() => parse({ ...command, ...patch })).toThrow());
  it("rejects oversized Unicode byte payloads", () => expect(() => parse({ ...command, params: { text: "é".repeat(MAX_MESSAGE_BYTES / 2) } })).toThrow());
  it("rejects JSON prototype keys", () => expect(() => parse(JSON.stringify(command).replace('"tabId":3', '"__proto__":{}'))).toThrow());
  it("rejects non JSON values and excessive nesting", () => { expect(() => parse({ ...command, params: { n: NaN } })).toThrow(); let nested: unknown = {}; for(let i=0;i<70;i++) nested = { nested }; expect(() => parse({ ...command, params: nested })).toThrow(); let deep: unknown = {}; for(let i=0;i<40;i++) deep = { deep }; expect(() => parse({ ...command, params: deep })).not.toThrow(); });
  it("requires exactly one response result or error", () => { const response = {version:1,type:"response",id:"r",bindingId:"b",generation:1}; expect(parse({...response,result:null})).toBeTruthy(); expect(parse({...response,error:{code:"denied",message:"Denied"}})).toBeTruthy(); expect(() => parse({...response,result:null,error:{code:"denied",message:"Denied"}})).toThrow(); expect(() => parse(response)).toThrow(); });
  it("validates hello capabilities and browser identity", () => { const hello={version:1,type:"hello",profileId:"p",browser:"chrome",extensionVersion:"1.0.0",capabilities:["cdp"]}; expect(parse(hello)).toEqual(hello); expect(()=>parse({...hello,capabilities:["cdp","cdp"]})).toThrow(); expect(()=>parse({...hello,browser:"unknown"})).toThrow(); });
  it("validates event identity and closed event names", () => { const event={version:1,type:"event",bindingId:"b",generation:1,event:"navigation",data:{tabId:1}}; expect(parse(event)).toEqual(event); expect(()=>parse({...event,event:"execute"})).toThrow(); });
});

import { BROWSER_EXTENSION_PLANNED_CAPABILITIES, BROWSER_EXTENSION_LIFECYCLE_CAPABILITY, BROWSER_MIN_APP_PROTOCOL } from "./browser-extension-protocol";
// @ts-expect-error plain extension module
import { createBrowserExtensionRuntime } from "../extensions/murage-browser/runtime.mjs";
describe("T44 capability handshake", () => {
  it("names the planned capabilities and a minimum app protocol", () => {
    expect([...BROWSER_EXTENSION_PLANNED_CAPABILITIES]).toEqual(["levels_v1", "presence_v1", "handoff_v1", "upload_token_v1"]);
    expect(BROWSER_MIN_APP_PROTOCOL).toBe(1);
  });
  it("the hello declares lifecycle_v1 and only planned capabilities whose code exists", async () => {
    const api = { storage: { local: { get: async () => ({}), set: async () => {} } }, runtime: { getManifest: () => ({ version: "0.1.0" }) }, debugger: { detach: async () => {} }, action: { setBadgeText: async () => {} }, tabs: {}, tabGroups: {} };
    const runtime = createBrowserExtensionRuntime(api, { uuid: () => "p1" });
    await runtime.initialize();
    const hello = await runtime.connection(true);
    expect(hello.capabilities).toContain(BROWSER_EXTENSION_LIFECYCLE_CAPABILITY);
    expect(parse(hello).type).toBe("hello");
    // No planned capability is declared until its code ships in the extension.
    for (const name of BROWSER_EXTENSION_PLANNED_CAPABILITIES) expect(hello.capabilities).not.toContain(name);
  });
});
