import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createCompanionAuthority } from "./companion-authority.ts";
import { stripWorkspaceCredentialEnv, WORKSPACE_CREDENTIAL_ENV } from "./config.ts";
import { launchVerificationServer, runControlMurage } from "../scripts/control-murage.ts";

const PRIVATE_TOKEN = "a".repeat(64);

describe("private companion authority", () => {
  it("requires the exact private proof, including type and byte length", () => {
    const accepts = createCompanionAuthority(PRIVATE_TOKEN);
    for (const value of [undefined,"", "b".repeat(64), [PRIVATE_TOKEN], PRIVATE_TOKEN + "\n", PRIVATE_TOKEN + ", " + PRIVATE_TOKEN]) {
      expect(accepts({"x-murage-companion":"1","x-murage-companion-token":value})).toBe(false);
    }
    expect(accepts({"x-murage-companion-token":PRIVATE_TOKEN})).toBe(true);
    expect(createCompanionAuthority(undefined)({"x-murage-companion-token":PRIVATE_TOKEN})).toBe(false);
  });
  it("strips the token from engine/MCP environment copies", () => {
    expect(WORKSPACE_CREDENTIAL_ENV).toContain("MURAGE_COMPANION_TOKEN");
    const env = { PATH:"fixture", MURAGE_COMPANION_TOKEN:PRIVATE_TOKEN };
    stripWorkspaceCredentialEnv(env);
    expect(env).toEqual({PATH:"fixture"});
  });
  it("consumes the boot env so later generic CLI spawns cannot inherit it and reloads do not rotate authority", () => {
    const url = new URL("./companion-authority.ts",import.meta.url).href;
    const config = new URL("./config.ts",import.meta.url).href;
    const script = `
      import {spawnSync} from 'node:child_process';
      const proof = process.env.MURAGE_COMPANION_TOKEN;
      const {companionAuthorized} = await import(${JSON.stringify(url)});
      const consumed = process.env.MURAGE_COMPANION_TOKEN === undefined;
      const child = spawnSync(process.execPath,['-e','process.stdout.write(String(process.env.MURAGE_COMPANION_TOKEN === undefined))'],{encoding:'utf8'});
      const {loadConfig} = await import(${JSON.stringify(config)});
      const configSafe = !JSON.stringify(loadConfig()).includes(proof);
      process.env.MURAGE_COMPANION_TOKEN = 'b'.repeat(64);
      loadConfig();
      process.stdout.write(JSON.stringify({consumed,childSafe:child.stdout === 'true',configSafe,originalWorks:companionAuthorized({'x-murage-companion-token':proof}),replacementDenied:!companionAuthorized({'x-murage-companion-token':'b'.repeat(64)})}));
    `;
    const result = spawnSync(process.execPath,["--experimental-strip-types","--input-type=module","-e",script],{
      encoding:"utf8",env:{...process.env,MURAGE_COMPANION_TOKEN:PRIVATE_TOKEN},timeout:10_000,
    });
    expect(result.status,result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({consumed:true,childSafe:true,configSafe:true,originalWorks:true,replacementDenied:true});
    expect(result.stdout + result.stderr).not.toContain(PRIVATE_TOKEN);
  });
});

describe("cloud desktop join route boundary", () => {
  it("denies direct joins on the real isolated harness and remains healthy", async () => {
    const fixture = await launchVerificationServer();
    try {
      const created = await runControlMurage(["new-bot","--name","Private join boundary"],{
        env:{MURAGE_URL:fixture.info.url},
      }) as {bot:{id:string}};
      for (const extra of [{}, {"x-murage-companion":"1"}, {"x-murage-companion-token":PRIVATE_TOKEN}]) {
        const response = await fetch(`${fixture.info.url}/api/bots/${created.bot.id}/computer/join`,{
          method:"POST",headers:{"content-type":"application/json",...extra},body:"{}",
        });
        expect(response.status).toBe(404);
      }
      expect((await fetch(`${fixture.info.url}/api/health`)).status).toBe(200);
      expect(fixture.child.exitCode).toBeNull();
    } finally { await fixture.close(); }
  },30_000);

  it("rejects direct loopback callers and forgeable companion markers before Box join", async () => {
    // Execute the actual route body behind a real listener, replacing only
    // infrastructure/Box calls. No provider credentials or Box networking.
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const start = source.indexOf('    m = path.match(/^\\/api\\/bots\\/([\\w-]+)\\/computer\\/(provision|join|sleep|exec|screenshot|remove)$/);');
    expect(start).toBeGreaterThan(0);
    const body = source.slice(start, source.indexOf("    // packaged app:", start));
    let joins = 0;
    let backend = "box";
    const handler = new Function("store", "box", "requestSurface", "companionAuthorized", "json", "companionMarked", "vps", `
      return async (req,res) => {
        const url = new URL(req.url,'http://localhost');
        const path = url.pathname; const method = req.method; let m; const cfg = {};
        ${body}
      };
    `)(
      { bot: () => ({ id: "bot_test", cloudBackend: backend }) },
      { joinBox: async () => { joins++; return {joinUrl:"https://fixture.invalid/join"}; } },
      (headers: Record<string,string>) => headers["x-test-desktop"] === "fixture-desktop-proof" ? "desktop" : "companion",
      createCompanionAuthority(PRIVATE_TOKEN),
      (res: import("node:http").ServerResponse, status: number, value: unknown) => {
        res.writeHead(status,{"content-type":"application/json"}); res.end(JSON.stringify(value));
      },
      (headers: Record<string,string>) => headers["x-murage-companion"] !== undefined,
      {vpsComputerJoin:()=>{throw new Error("companion must not open a VPS viewer");}},
    );
    const server = createServer(handler);
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    const port = (server.address() as import("node:net").AddressInfo).port;
    try {
      for (const extra of [{}, {"x-murage-companion":"1"}, {"x-murage-companion-token":"forged"}]) {
        const response = await fetch(`http://127.0.0.1:${port}/api/bots/bot_test/computer/join`,{
          method:"POST", headers:{"content-type":"application/json",...extra}, body:"{}",
        });
        expect(response.status).toBe(404);
        expect(joins).toBe(0);
      }
      for (const extra of [{"x-murage-companion-token":PRIVATE_TOKEN}, {"x-test-desktop":"fixture-desktop-proof"}]) {
        const response = await fetch(`http://127.0.0.1:${port}/api/bots/bot_test/computer/join`,{
          method:"POST",headers:{"content-type":"application/json",...extra},body:"{}",
        });
        expect(response.status).toBe(200);
        expect(await response.text()).not.toContain(PRIVATE_TOKEN);
      }
      expect(joins).toBe(2);
      backend = "vps";
      const vps = await fetch(`http://127.0.0.1:${port}/api/bots/bot_test/computer/join`,{
        method:"POST",headers:{"content-type":"application/json","x-murage-companion-token":PRIVATE_TOKEN},body:"{}",
      });
      expect(vps.status).toBe(409);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve=>server.close(()=>resolve()));
    }
  });
});
