import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { browserBindHost, rebindBrowserDoor } from "../src/browser.ts";
import { inspectBrowserServe, refreshBrowserServe } from "../src/listener.ts";
const { readServeStatus } = createRequire(import.meta.url)("../../electron/companion-remote-access.mjs") as {
  readServeStatus(raw: string, options: {proxyTarget: string}): {owner: "none" | "ours" | "other" | "unknown"};
};

const OURS = {Web:{"box.tail1234.ts.net:443":{Handlers:{"/":{Proxy:"http://127.0.0.1:8813"}}}}};

describe("read-only Serve reconciliation", () => {
  it.each([
    ["ours",OURS],
    ["none",{}],
    ["unknown",null],
    ["unknown",[]],
    ["unknown",{Web:"bad"}],
    ["other",{TCP:{443:{HTTPS:true}}}],
    ["other",{...OURS,AllowFunnel:{"box.tail1234.ts.net:443":true}}],
    ["other",{Web:{...OURS.Web,"other.tail1234.ts.net:443":{Handlers:{"/":{Proxy:"http://127.0.0.1:3000"}}}}}],
    ["other",{Web:{"box.tail1234.ts.net:443":{Handlers:{"/":{Proxy:"http://127.0.0.1:8813/other"}}}}}],
  ])("agrees with the desktop ownership parser for %s", (owner,config) => {
    const raw = JSON.stringify(config);
    expect(inspectBrowserServe(raw,8813).owner).toBe(owner);
    expect(readServeStatus(raw,{proxyTarget:"http://127.0.0.1:8813"}).owner).toBe(owner);
  });

  it("reads only Serve status and identifies the existing HTTPS front", async () => {
    const calls: string[][] = [];
    const run = ((_cli: string,args: string[],_opts: unknown,done: Function)=>{
      calls.push(args); done(null,JSON.stringify(OURS));
    }) as unknown as typeof import("node:child_process").execFile;
    expect(await refreshBrowserServe(8813,{run,candidates:["fake-tailscale"]})).toEqual({
      owner:"ours",origin:"https://box.tail1234.ts.net",problem:null,
    });
    expect(calls).toEqual([["serve","status","--json"]]);
  });

  it("does not infer an empty config after a failed read or an expired budget", async () => {
    let calls = 0;
    const run = ((_cli: string,_args: string[],_opts: unknown,done: Function)=>{
      calls++; done(new Error("daemon unavailable"),"");
    }) as unknown as typeof import("node:child_process").execFile;
    expect((await refreshBrowserServe(8813,{run,candidates:["fake-tailscale"]})).owner).toBe("unknown");
    expect(calls).toBe(1);
    expect((await refreshBrowserServe(8813,{run,deadline:0})).owner).toBe("unknown");
    expect(calls).toBe(1);
  });
});

describe("the sidecar's actual bind decision", () => {
  it("converges a tailnet listener to loopback when an owned HTTPS front is observed", async () => {
    const source = readFileSync(new URL("../src/index.ts",import.meta.url),"utf8");
    const start = source.indexOf("const desiredBrowserBindHost =");
    const end = source.indexOf("/** A sentence naming",start);
    expect(start).toBeGreaterThan(0);
    const declaration = source.slice(start,end).replace("(): string =>","() =>");
    const desired = new Function("browserBindHost","BROWSER_BIND","BROWSER_FRONT","tailscaleAddress","tailnetSelfAddress","console",
      `${declaration}; return desiredBrowserBindHost;`)(browserBindHost,"auto",{scheme:"https",host:"box.tail1234.ts.net",port:443},
      ()=>"100.79.121.109",()=>"100.79.121.109",{log:()=>{}});
    const listened: string[] = [];
    const fakeServer = {closeAllConnections:()=>{},close:(done:()=>void)=>done()};
    const result = await rebindBrowserDoor({
      server:fakeServer as import("node:http").Server,port:8813,boundHost:"100.79.121.109",desiredHost:desired,
      listen:async (_server,_port,host)=>{listened.push(host);},
    });
    expect(result.host).toBe("127.0.0.1");
    expect(listened).toEqual(["127.0.0.1"]);
  });
});
