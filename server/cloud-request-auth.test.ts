// SPDX-License-Identifier: AGPL-3.0-or-later
// C3.1 regression coverage derived from the independent Opus gap probes.
import { createHmac, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudSessions, type CloudScope } from "./cloud-sessions.ts";
import { cloudBodies, createCloudRequestAuth, stepPurpose, type CloudAuthOptions } from "./cloud-request-auth.ts";
import { listenCloudProxy } from "./cloud-home/proxy-socket.ts";

import { removeTempDirSync } from "./testing/cleanup.ts";
const origin = "https://home.example";
let root: string, sessions: CloudSessions, upstream: Server, proxy: Server | null = null;
const seenBodies: boolean[] = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "opus-probe-")); vi.stubEnv("MURAGE_CLOUD_ROLE", "home"); seenBodies.length = 0; });
afterEach(async () => {
  for (const s of [upstream, proxy]) if (s?.listening) { const closed = once(s, "close"); s.close(); s.closeAllConnections(); await closed; }
  proxy = null; if (sessions?.db.isOpen) sessions.db.close(); removeTempDirSync(root); vi.unstubAllEnvs();
});
function pair(scope: CloudScope) {
  const key = generateKeyPairSync("ed25519"), factor = generateKeyPairSync("ed25519");
  if (scope === "browser") {
    // mint() no longer enrolls browsers (the door does, with no factor row): the row is written as the door writes it.
    const id = randomUUID();
    sessions.db.prepare("INSERT OR IGNORE INTO cloud_meta VALUES ('account','owner')").run();
    sessions.db.prepare("INSERT INTO cloud_devices (id,account,scope,publicKey,assertionKey,revoked,addedAt,lastSeenAt) VALUES (?,?,?,?,?,0,0,0)").run(id, "owner", "browser", key.publicKey.export({ type: "spki", format: "pem" }).toString(), factor.publicKey.export({ type: "spki", format: "pem" }).toString());
    return { ...sessions.issue(id), factor };
  }
  const code = sessions.mint({ account: "owner", scope, publicKey: key.publicKey.export({ type: "spki", format: "pem" }).toString(), assertionKey: factor.publicKey.export({ type: "spki", format: "pem" }).toString() });
  const msg = Buffer.from(`murage-pair:${sessions.environmentId}:${code}:owner`);
  return { ...sessions.redeem(code, "owner", sign(null, msg, key.privateKey).toString("base64url"), sign(null, msg, factor.privateKey).toString("base64url")), factor };
}
async function start(trustedProxy?: string, extra: Partial<CloudAuthOptions> = {}) {
  sessions = new CloudSessions(new DatabaseSync(join(root, "s.db")));
  const auth = createCloudRequestAuth({ sessions, publicOrigin: origin, trustedProxy, bootstrapSecret: () => "fixture-bootstrap-key-32-characters", ...extra });
  upstream = createServer(async (req, res) => {
    const handled = await auth(req, res, new URL(req.url!, origin));
    seenBodies.push(cloudBodies.has(req));
    if (handled) return;
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ reachedHandler: true }));
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  return (upstream.address() as AddressInfo).port;
}
function call(port: number, method: string, path: string, token?: string, body?: unknown, socketPath?: string, extra: Record<string, string> = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const req = request({ ...(socketPath ? { socketPath } : { host: "127.0.0.1", port }), method, path, agent: false, headers: {
      host: socketPath ? "local.invalid" : "home.example", ...(socketPath ? { "x-forwarded-host": "home.example", "x-forwarded-for": "198.51.100.7" } : {}),
      origin, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data ? { "content-length": String(data.length) } : {}), ...extra } }, res => {
      const chunks: Buffer[] = []; res.on("data", c => chunks.push(c)); res.on("end", () => { const t = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode!, body: t ? JSON.parse(t) : null }); });
    }); req.on("error", reject); req.end(data);
  });
}

type Device = ReturnType<typeof pair>;
function factor(device: Device, method: string, path: string, body: unknown) {
  const purpose = stepPurpose(method, path, body), challenge = sessions.challenge(device.deviceId, purpose), at = Date.now();
  const signature = sign(null, Buffer.from(`murage:${sessions.environmentId}:${device.deviceId}:${purpose}:${challenge}:${at}`), device.factor.privateKey).toString("base64url");
  return { "x-murage-step-up": Buffer.from(JSON.stringify({challenge, at, signature})).toString("base64url") };
}
const sensitiveRoutes: [string, string, unknown][] = [
  ["POST", "/api/skills/import", {link:"https://github.com/example/skill"}],
  ["POST", "/api/skills/import", {zip:"UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA=="}],
  ["POST", "/api/skills/import", {kind:"file", files:[{path:"SKILL.md",content:"# Fixture"}]}],
  ["POST", "/api/bots/b1/skills", {source:"example/skill"}],
  ["POST", "/api/bots/b1/skills/library", {ids:["fixture"]}],
  ["POST", "/api/bots/b1/assistant-profile", {slug:"fixture"}],
  ["PATCH", "/api/instances/i1", {binaryPath:"/bin/fixture"}],
  ["POST", "/api/instances/i1/claude-update", {}],
  ["POST", "/api/engine-management/fuigoAgent", {action:"install"}],
  ["POST", "/api/hermes/profiles/import", {profiles:["fixture"]}],
  ["DELETE", "/api/folder-trust?folder=%2Ftmp%2Ffixture", {}],
  ["POST", "/api/cli-test", {cli:"/bin/fixture"}],
  ["PUT", "/api/bots/b1/access", {action:"configure",revision:0,mode:"unrestricted",allowWrites:true,grants:[]}],
  ["PATCH", "/api/bots/b1/message-allow", {mode:"list",botIds:["b2"]}],
  ["PATCH", "/api/bots/b1/sharing", {mode:"all"}],
  ["POST", "/api/browser-extension/clients", {action:"pair",label:"fixture",profileId:"fixture"}],
  ["POST", "/api/team-library/github", {url:"https://github.com/example/team"}],
  ["POST", "/api/teams/import", {format:"murage.team",version:1,team:{name:"Fixture",members:[{key:"fixture",name:"Fixture",appearance:{color:"green"}}],room:{name:"Fixture",defaultResponder:{kind:"everyone"}}}}],
  ["POST", "/api/packages/import", {action:"preview",archivePath:"/tmp/fixture.zip",selection:{agents:[],skills:[],routines:[]}}],
  ["POST", "/api/starter-profiles", {action:"preview",profileId:"starter-personal-home",selection:{agents:[],skills:[],routines:[]}}],
  ["PATCH", "/api/config", {browser:"managed"}],
  ["POST", "/api/webhooks", {botId:"b1",name:"fixture"}],
  ["POST", "/api/mcp/servers", {name:"fixture",command:"fixture"}],
  ["DELETE", "/api/bots/b1", {}],
];
describe("real cloud auth with a signed device factor", () => {
  it.each([["PATCH","/api/bots/b1",{alwaysAllow:[]}],["POST","/api/bots/b1/always-allow",{allowKey:"Bash(*)"}],["POST","/api/routines/r1/always-allow",{allowKey:"Bash(*)"}],["POST","/api/teams/import",{team:{members:[{alwaysAllow:["Bash(*)"]}]}}],["POST","/api/packages/import",{agents:[{alwaysAllow:[]}]}]] as const)("home refuses %s %s even with a factor",async(method,path,body)=>{
    const port=await start(),device=pair("owner-desktop");
    expect((await call(port,method,path,device.accessToken,body,undefined,factor(device,method,path,body))).status).toBe(403);
  });

  it.each(sensitiveRoutes)("binds %s %s to its actual method/path/body", async (method,path,body) => {
    const port=await start(), device=pair("owner-desktop");
    expect((await call(port,method,path,device.accessToken,body)).status).toBe(403);
    const signed=factor(device,method,path,body);
    expect((await call(port,method,path,device.accessToken,body,undefined,signed)).status).toBe(200);
    expect((await call(port,method,path,device.accessToken,body,undefined,signed)).status).toBe(403);
  });
  it.each(["auto","full","unlimited"])("phone cannot raise routine permissionMode to %s even with its own factor", async permissionMode => {
    const port=await start(), phone=pair("owner-phone"), owner=pair("owner-desktop");
    for (const [method,path,body] of [["POST","/api/routines",{botId:"b1",name:"Fixture",permissionMode,schedule:{type:"interval",minutes:5}}],["PATCH","/api/routines/r1",{permissionMode}]] as const) {
      expect((await call(port,method,path,phone.accessToken,body,undefined,factor(phone,method,path,body))).status).toBe(403);
      expect((await call(port,method,path,owner.accessToken,body)).status).toBe(403);
      expect((await call(port,method,path,owner.accessToken,body,undefined,factor(owner,method,path,body))).status).toBe(200);
    }
  });
  it.each([{computer:"local"},{hostComputerConsent:"allowed"},{acknowledgeLocalAuto:true},{alwaysAllow:[]},{autoApprove:true},{fullAccess:true},{noLimits:true}])("phone cannot elevate through %j", async body => {
    const port=await start(), device=pair("owner-phone"), path="/api/bots/b1";
    expect((await call(port,"PATCH",path,device.accessToken,body,undefined,factor(device,"PATCH",path,body))).status).toBe(403);
  });
  it("keeps the real dispatcher's accepted computer modes under authority review", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const modes = /!\[("cloud"[^\]]*)\]\.includes\(body\.computer\)/.exec(source);
    expect(modes, "accepted computer modes changed; review which modes grant host authority").not.toBeNull();
    expect(JSON.parse(`[${modes![1]}]`)).toEqual(["cloud", "vm", "local", "browser", "off"]);
  });
  it("phone sensitive operations require its own factor; credentials remain refused", async () => {
    const port=await start(), phone=pair("owner-phone"), owner=pair("owner-desktop"), path="/api/instances/i1", body={binaryPath:"/bin/fixture"};
    expect((await call(port,"PATCH",path,phone.accessToken,body)).status).toBe(403);
    expect((await call(port,"PATCH",path,phone.accessToken,body,undefined,factor(owner,"PATCH",path,body))).status).toBe(403);
    expect((await call(port,"PATCH",path,phone.accessToken,body,undefined,factor(phone,"PATCH",path,body))).status).toBe(200);
    expect((await call(port,"PATCH","/api/config",phone.accessToken,{},undefined,factor(phone,"PATCH","/api/config",{}))).status).toBe(403);
  });
  it("refuses changed bodies, paths, methods and another device's assertion", async () => {
    const port=await start(), device=pair("owner-desktop"), other=pair("owner-desktop"), path="/api/skills/import", body={link:"https://github.com/example/skill"};
    for (const [method,target,payload] of [["POST",path,{...body,replace:true}],["POST","/api/starter-profiles",body],["PUT",path,body]] as const)
      expect((await call(port,method,target,device.accessToken,payload,undefined,factor(device,"POST",path,body))).status).toBe(403);
    expect((await call(port,"POST",path,other.accessToken,body,undefined,factor(device,"POST",path,body))).status).toBe(403);
  });
  it.each(["/api/routines/r1/run","/api/bots/b1/computer/join"])("browser %s without a factor row is refused, retaining chat", async path => {
    const port=await start(), browser=pair("browser"), owner=pair("owner-desktop"), body={deviceId:"fixture"};
    const cookie={cookie:`__Host-murage=${browser.accessToken}`};
    expect((await call(port,"POST","/api/bots/b1/messages",undefined,{text:"Hello"},undefined,cookie)).status).toBe(200);
    expect((await call(port,"POST",path,undefined,body,undefined,cookie)).status).toBe(403);
    expect((await call(port,"POST",path,undefined,body,undefined,{...cookie,...factor(owner,"POST",path,body)})).status).toBe(403);
    expect((await call(port,"POST",path,undefined,{deviceId:"other"},undefined,{...cookie,...factor(browser,"POST",path,body)})).status).toBe(403);
    // A door-enrolled browser has no factor row, so even its own correctly signed assertion is refused.
    const signed={...cookie,...factor(browser,"POST",path,body)};
    expect((await call(port,"POST",path,undefined,body,undefined,signed)).status).toBe(403);
  });
});
describe("transport authority and early refusal", () => {
  // the home's trusted proxy is a Unix socket at a file path (the Linux Cloud home); Windows cannot listen on one there
  it.skipIf(process.platform === "win32")("Unix anonymous cannot enter internal/gateway/extension; loopback TCP capabilities remain routable", async () => {
    const socketPath=join(root,"p.sock"), port=await start(`unix:${socketPath}`);
    proxy=listenCloudProxy(upstream,socketPath)!; await once(proxy,"listening");
    for(const path of ["/api/internal/agents","/api/model-gateway/v1/models","/api/browser-extension/mcp"]) {
      for(const token of [undefined,"invalid"])
        expect((await call(port,"POST",path,token,{},socketPath,{"x-murage-surface":"desktop","x-murage-surface-secret":"forged"})).status).toBe(403);
      expect((await call(port,"POST",path,undefined,{})).status).toBe(200);
    }
    for(const path of ["/api/health","/api/media/bytes/fixture"])
      expect((await call(port,"GET",path,undefined,undefined,socketPath)).status).toBe(200);
    expect((await call(port,"POST","/api/media/bytes/fixture",undefined,{},socketPath)).status).toBe(403);
    expect((await call(port,"GET","/api/decisions",pair("owner-desktop").accessToken,undefined,socketPath)).status).toBe(200);
  });
  it("refuses before reading an unfinished large protected request", async () => {
    const port=await start();
    const result=await new Promise<number>((resolve,reject)=>{
      const req=request({host:"127.0.0.1",port,method:"PATCH",path:"/api/config",headers:{host:"home.example",origin,"content-length":String(12*1024*1024)}},res=>{
        res.resume(); res.on("end",()=>{resolve(res.statusCode!);req.destroy();});
      });
      req.on("error",reject); req.setTimeout(2000,()=>{req.destroy();reject(new Error("gate waited for the body"));});
      req.flushHeaders(); // No bytes, no end: buffering would wait forever.
    });
    expect(result).toBe(403); expect(seenBodies).toEqual([false]);
  });
});

describe("the signed pairing generation against this home's own pin (Astra STEPUP-EMAIL-7 #1)", () => {
  const device = () => { const k = generateKeyPairSync("ed25519"), f = generateKeyPairSync("ed25519");
    return { scope: "owner-desktop", publicKey: k.publicKey.export({ type: "spki", format: "pem" }).toString(), assertionKey: f.publicKey.export({ type: "spki", format: "pem" }).toString() }; };
  const signed = (port: number, extra: Record<string, unknown>) => {
    const raw = JSON.stringify({ operation: "/api/cloud/pairing", timestamp: Date.now() / 1000, nonce: randomUUID().replaceAll("-", ""), account: "owner", ...device(), ttl: 120, ...extra });
    return call(port, "POST", "/api/cloud/pairing", undefined, raw, undefined, { "x-murage-signature": createHmac("sha256", "fixture-bootstrap-key-32-characters").update(raw).digest("hex") });
  };
  const devices = () => (sessions.db.prepare("SELECT COUNT(*) AS n FROM cloud_devices").get() as { n: number }).n;
  it("an empty home pinned to generation 2 refuses a generation-1 body and a body with no generation; nothing is minted; it is logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const port = await start(undefined, { homeGeneration: () => 2 });
    for (const extra of [{ generation: 1 }, {}, { generation: "2" }]) {
      const res = await signed(port, extra);
      expect(res.status).toBe(409);
      expect(res.body.code).toBeUndefined();
    }
    expect(devices()).toBe(0);
    expect(warn.mock.calls.filter(c => String(c[0]).includes("pairing refused"))).toHaveLength(3);
    warn.mockRestore();
  });
  it("a home pinned to generation 1 accepts the generation-1 body and mints its one-time code", async () => {
    const port = await start(undefined, { homeGeneration: () => 1 });
    const res = await signed(port, { generation: 1 });
    expect(res.status).toBe(200);
    expect(typeof res.body.code).toBe("string");
  });
  it("a pin that cannot be read refuses (fails closed); an unbound home accepts a legacy body with no generation, logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let port = await start(undefined, { homeGeneration: () => { throw new Error("binding unreadable"); } });
    expect((await signed(port, { generation: 1 })).status).toBe(409);
    upstream.close(); upstream.closeAllConnections(); sessions.db.close();
    root = mkdtempSync(join(tmpdir(), "opus-probe-"));
    port = await start(undefined, {});
    const legacy = await signed(port, {});
    expect(legacy.status).toBe(200);
    expect(warn.mock.calls.some(c => String(c[0]).includes("legacy control plane"))).toBe(true);
    warn.mockRestore();
  });
  describe("an outstanding code is redeemed only under the pin it was minted at (Astra STEPUP-EMAIL-8 #1)", () => {
    const keyed = () => { const k = generateKeyPairSync("ed25519"), f = generateKeyPairSync("ed25519");
      return { k, f, body: { scope: "owner-desktop", publicKey: k.publicKey.export({ type: "spki", format: "pem" }).toString(), assertionKey: f.publicKey.export({ type: "spki", format: "pem" }).toString() } }; };
    const mintFor = async (port: number, extra: Record<string, unknown>) => {
      const d = keyed();
      const raw = JSON.stringify({ operation: "/api/cloud/pairing", timestamp: Date.now() / 1000, nonce: randomUUID().replaceAll("-", ""), account: "owner", ...d.body, ttl: 120, ...extra });
      const res = await call(port, "POST", "/api/cloud/pairing", undefined, raw, undefined, { "x-murage-signature": createHmac("sha256", "fixture-bootstrap-key-32-characters").update(raw).digest("hex") });
      expect(res.status).toBe(200);
      return { code: res.body.code as string, ...d };
    };
    const redeem = (port: number, minted: Awaited<ReturnType<typeof mintFor>>) => {
      const msg = Buffer.from(`murage-pair:${sessions.environmentId}:${minted.code}:owner`);
      return call(port, "POST", "/api/cloud/pair", undefined, { code: minted.code, account: "owner", signature: sign(null, msg, minted.k.privateKey).toString("base64url"), assertionSignature: sign(null, msg, minted.f.privateKey).toString("base64url") });
    };
    const codes = () => (sessions.db.prepare("SELECT COUNT(*) AS n FROM cloud_codes").get() as { n: number }).n;
    it("legacy -> pinned: a code minted with no pin is refused once the pin appears; no device is inserted", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      let pin: number | undefined;
      const port = await start(undefined, { homeGeneration: () => pin });
      const legacy = await mintFor(port, {});
      pin = 1;
      expect((await redeem(port, legacy)).status).toBe(403);
      expect(devices()).toBe(0);
      expect(codes()).toBe(0);
      warn.mockRestore();
    });
    it("generation 1 -> 2: the generation-1 code is refused and dropped; a code minted at the current pin still redeems", async () => {
      let pin = 1;
      const port = await start(undefined, { homeGeneration: () => pin });
      const old = await mintFor(port, { generation: 1 });
      pin = 2;
      expect((await redeem(port, old)).status).toBe(403);
      expect(devices()).toBe(0);
      expect(codes()).toBe(0);
      const fresh = await mintFor(port, { generation: 2 });
      const ok = await redeem(port, fresh);
      expect(ok.status).toBe(200);
      expect(typeof ok.body.deviceId).toBe("string");
      expect(devices()).toBe(1);
    });
    it("an unreadable pin refuses redemption without deleting the code; once readable again the code redeems", async () => {
      let broken = false;
      const port = await start(undefined, { homeGeneration: () => { if (broken) throw new Error("binding unreadable"); return 1; } });
      const minted = await mintFor(port, { generation: 1 });
      broken = true;
      expect((await redeem(port, minted)).status).toBe(403);
      expect(codes()).toBe(1);
      broken = false;
      expect((await redeem(port, minted)).status).toBe(200);
      expect(devices()).toBe(1);
    });
  });
  it("an add-device body still needs its pair-hold proof on a home with ZERO devices", async () => {
    const port = await start(undefined, { homeGeneration: () => 1, recoveryProof: () => { throw new Error("proof refused"); } });
    for (const extra of [{ pairHoldId: "fixture-hold-0000000001" }, { pairHoldId: "fixture-hold-0000000001", pairHoldProof: { payload: "x", signature: "y" } }, { pairHoldProof: {} }]) {
      const res = await signed(port, { generation: 1, ...extra });
      expect(res.status).toBe(403);
      expect(res.body.code).toBeUndefined();
    }
    expect(devices()).toBe(0);
  });
});

describe("a device revoked while its request body is still arriving", () => {
  const deleteWithHeldBody = (port: number, token: string, revokeBeforeEnd?: () => void) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({ reason: "fixture" }));
    const req = request({ host: "127.0.0.1", port, method: "DELETE", path: "/api/bots/b1/tasks/t1", agent: false, headers: {
      host: "home.example", origin, "content-type": "application/json", cookie: `__Host-murage=${token}`, "content-length": String(payload.length) } }, res => {
      const chunks: Buffer[] = []; res.on("data", c => chunks.push(c)); res.on("end", () => { const t = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode!, body: t ? JSON.parse(t) : null }); });
    });
    req.on("error", reject);
    req.write(payload.subarray(0, 4));
    setTimeout(() => { revokeBeforeEnd?.(); req.end(payload.subarray(4)); }, 150);
  });
  it("is refused after the body arrives and never reaches the delete handler", async () => {
    const port = await start(), device = pair("browser");
    const reached = await deleteWithHeldBody(port, device.accessToken);
    expect(reached.status).toBe(200);
    const second = pair("browser");
    const result = await deleteWithHeldBody(port, second.accessToken, () => sessions.revoke(second.deviceId));
    expect(result.status).toBe(403);
    expect(result.body?.reachedHandler).toBeUndefined();
  });
});
