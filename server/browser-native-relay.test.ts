import { ownedCloseCli } from "./browser-owned-close.ts";
import { it, expect, vi } from "vitest";
import { browserInputEvents, createNativeBrowser } from "./browser-native-relay.ts";
import { acceptBrowserGeneration, expectedStaleBrowserFrame } from "../src/lib/browser-view-state.ts";
it("sends text as ordered native keystrokes without splitting Unicode code points", () => {
  const events = browserInputEvents({type:"input_keyboard",eventType:"char",text:"Hi 🌍"});
  expect(events.map(e=>e.text)).toEqual(["H","i"," ","🌍"]);
  expect(events.every(e=>e.eventType==="keyDown")).toBe(true);
  const press={type:"input_keyboard",eventType:"keyDown",key:"Enter"};expect(browserInputEvents(press)).toEqual([press]);
});
it("closing an unused relay asks the maintenance CLI once and retains its not-running receipt", async () => {
  const native=createNativeBrowser({command:"/nonexistent/engine-must-not-launch",args:[],env:{AGENT_BROWSER_SOCKET_DIR:"/nonexistent/murage-runtime",AGENT_BROWSER_SESSION:"idle"}});
  const run = vi.spyOn(ownedCloseCli, "run").mockResolvedValue({ code: 0, stdout: JSON.stringify({
    launchId: null, closed: true, path: "not_running", groupExhausted: true, treeExhausted: false, outsideSeen: 0, unconfirmed: null,
  }) });
  try {
    await expect(native.close()).resolves.toBeUndefined(); await expect(native.close()).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
  } finally { run.mockRestore(); }
});
it("never rewinds ownership after delayed status responses",()=>{
  expect(acceptBrowserGeneration(8,7)).toBe(false);expect(acceptBrowserGeneration(8,8)).toBe(true);expect(acceptBrowserGeneration(8,9)).toBe(true);expect(acceptBrowserGeneration(undefined,2)).toBe(true);
});
it("suppresses only the expected stale frame conflict, preserving privacy and auth failures",()=>{
  expect(expectedStaleBrowserFrame(Object.assign(new Error("Browser frame generation is stale"),{status:409}))).toBe(true);
  expect(expectedStaleBrowserFrame(Object.assign(new Error("Browser document requires human review"),{status:409}))).toBe(false);
  expect(expectedStaleBrowserFrame(Object.assign(new Error("Browser frame generation is stale"),{status:401}))).toBe(false);
});

it("close-only recovery refuses a missing ownership record", async () => {
  const recovery = createNativeBrowser({command:"/nonexistent/engine-must-not-launch",args:[],env:{AGENT_BROWSER_SOCKET_DIR:"/nonexistent/murage-runtime",AGENT_BROWSER_SESSION:"idle"}}, { closeOnly: true });
  await expect(recovery.close()).rejects.toThrow('ownership is unconfirmed');
});
