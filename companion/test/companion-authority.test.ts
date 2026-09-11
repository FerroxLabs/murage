import { createServer, type Server, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createProxyHandler } from "../src/proxy.ts";
import { cookieName, createBrowserHandler, type BrowserDeviceStore } from "../src/browser.ts";
import { createCompanionAuthority } from "../../server/companion-authority.ts";

const PRIVATE_TOKEN = "c".repeat(64);
const listen = async (server: Server) => {
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  return (server.address() as AddressInfo).port;
};
const close = async (server: Server) => {
  server.closeAllConnections();
  await new Promise<void>(resolve=>server.close(()=>resolve()));
};

describe.each(["device","browser"] as const)("%s private join forwarding", surface => {
  it("requires pairing/session, capability, and the private launch proof; never forwards a client's proof", async () => {
    let capability = true;
    let seen: IncomingHttpHeaders | null = null;
    let joins = 0;
    const authorize = createCompanionAuthority(PRIVATE_TOKEN);
    const harness = createServer((req,res) => {
      seen = req.headers;
      const join = req.url?.endsWith("/computer/join");
      if (join && !authorize(req.headers)) { res.writeHead(404); res.end(); return; }
      if (join) joins++;
      if (req.url === "/api/events") {
        res.writeHead(200,{"content-type":"text/event-stream"});
        res.end('data: {"kind":"runtime"}\n\n'); return;
      }
      res.writeHead(200,{"content-type":"application/json"});
      res.end(JSON.stringify(join ? {joinUrl:"https://fixture.invalid/authorized-box"} : {ok:true}));
    });
    const harnessPort = await listen(harness);
    const devices: BrowserDeviceStore = {
      redeem:()=>({error:"unused"}), openSession:()=>null, closeSession:()=>false, renewSession:()=>null,
      resolveSession:value=>value === "paired-session" ? {
        device:{id:"paired",name:"Fixture",cloudDesktopAccess:capability},session:{expiresAt:Date.now()+60_000},
        sessionId:"paired-session-record",
      } : null,
      sessionDeadline:id=>id === "paired-session-record" ? Date.now()+60_000 : null,
    };
    const options = {harnessPort,companionToken:PRIVATE_TOKEN};
    const door = createServer(surface === "device" ? createProxyHandler({
      ...options,authenticate:value=>value === "paired-bearer" ? {id:"paired",cloudDesktopAccess:capability} : null,
      redeem:()=>({error:"unused"}),serverName:()=>"Fixture",
    }) : createBrowserHandler({
      ...options,identity:()=>({scheme:"http",hosts:new Set(["127.0.0.1"])}),devices,
    }));
    const port = await listen(door);
    const headers = (paired = true): Record<string,string> => ({
      "content-type":"application/json",
      ...(surface === "device"
        ? paired ? {authorization:"Bearer paired-bearer"} : {}
        : {origin:`http://127.0.0.1:${port}`,...(paired ? {cookie:`${cookieName("http")}=paired-session`} : {})}),
      "x-murage-companion-token":"attacker-supplied-proof",
    });
    const ask = (path: string, paired = true) => fetch(`http://127.0.0.1:${port}${path}`,{
      method:"POST",headers:headers(paired),body:"{}",
    });
    try {
      expect((await ask("/api/bots/bot_test/computer/join",false)).status).toBe(401);
      expect(joins).toBe(0);
      capability = false;
      expect((await ask("/api/bots/bot_test/computer/join")).status).toBe(403);
      expect(seen).toBeNull();
      capability = true;
      const joined = await ask("/api/bots/bot_test/computer/join");
      expect(joined.status).toBe(200);
      expect(joins).toBe(1);
      expect(seen!["x-murage-companion-token"]).toBe(PRIVATE_TOKEN);
      expect(seen!["x-murage-companion"]).toBe("1");
      expect(await joined.text()).not.toContain(PRIVATE_TOKEN);
      const normal = await fetch(`http://127.0.0.1:${port}/api/bots`,{headers:headers()});
      expect(normal.status).toBe(200);
      expect(seen!["x-murage-companion-token"]).toBeUndefined();
      expect(await normal.text()).not.toContain(PRIVATE_TOKEN);
      const events = await fetch(`http://127.0.0.1:${port}/api/events`,{headers:headers()});
      expect(events.status).toBe(200);
      expect(seen!["x-murage-companion-token"]).toBeUndefined();
      expect(await events.text()).not.toContain(PRIVATE_TOKEN);
    } finally { await close(door); await close(harness); }
  });

  it("fails join helpfully when independently launched without private proof", async () => {
    const devices: BrowserDeviceStore = {
      redeem:()=>({error:"unused"}),openSession:()=>null,closeSession:()=>false,renewSession:()=>null,
      resolveSession:()=>({device:{id:"paired",name:"Fixture",cloudDesktopAccess:true},session:{expiresAt:Date.now()+60_000},sessionId:"paired-session-record"}),
      sessionDeadline:()=>Date.now()+60_000,
    };
    const door = createServer(surface === "device" ? createProxyHandler({
      harnessPort:1,authenticate:()=>({cloudDesktopAccess:true}),redeem:()=>({error:"unused"}),serverName:()=>"Fixture",
    }) : createBrowserHandler({harnessPort:1,identity:()=>({scheme:"http",hosts:new Set(["127.0.0.1"])}),devices}));
    const port = await listen(door);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/bots/bot_test/computer/join`,{
        method:"POST",body:"{}",headers:{"content-type":"application/json",...(surface === "browser" ? {origin:`http://127.0.0.1:${port}`} : {})},
      });
      expect(response.status).toBe(503);
      expect(await response.text()).toContain("started together");
    } finally { await close(door); }
  });
});
