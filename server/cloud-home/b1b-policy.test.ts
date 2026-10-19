// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer, get } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { HOME_PAGE_CSP, homePagePolicy, homeRememberedGrantWrite, mermaidFrameCsp, secureHomeHtml } from "./b1b-policy.ts";
describe("home policy helpers",()=>{
  it.each([["PATCH","/api/bots/b",{alwaysAllow:[]}],["POST","/api/bots/b/always-allow",{allowKey:"Bash(*)"}],["POST","/api/routines/r/always-allow",{allowKey:"Bash(*)"}],["POST","/api/bots/b/respond",{behavior:"always"}],["POST","/api/teams/import",{team:{members:[{alwaysAllow:["Bash(*)"]}]}}],["POST","/api/packages/import",{agents:[{alwaysAllow:[]}] }]] as const)("refuses remembered grant writer %s %s",(method,path,body)=>{expect(homeRememberedGrantWrite(method,path,body)).toBe(true);});
  it("keeps reads, removals and allow-once available",()=>{expect(homeRememberedGrantWrite("GET","/api/bots/b",{alwaysAllow:[]})).toBe(false);expect(homeRememberedGrantWrite("POST","/api/bots/b/always-allow/remove",{allowKey:"Bash(*)"})).toBe(false);expect(homeRememberedGrantWrite("POST","/api/bots/b/respond",{behavior:"allow"})).toBe(false);});
  it("sets strict headers for implicit and explicit HTML, overriding a route policy",async()=>{
    const server=createServer((req,res)=>{secureHomeHtml(res);if(req.url === "/explicit")res.writeHead(200,{"Content-Type":"text/html","Content-Security-Policy":"unsafe"});else res.setHeader("content-type","text/html; charset=utf-8");res.end("<!doctype html>");});server.listen(0,"127.0.0.1");await once(server,"listening");
    try {for(const path of ["/implicit","/explicit"]) {const headers=await new Promise<import("node:http").IncomingHttpHeaders>((resolve,reject)=>{get({host:"127.0.0.1",port:(server.address() as AddressInfo).port,path},res=>{res.resume();res.once("end",()=>resolve(res.headers));}).on("error",reject);});expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");expect(headers["content-security-policy"]).toContain("require-trusted-types-for 'script'");expect(headers["content-security-policy"]).toContain("script-src 'self'");}}
    finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
});
describe("the home page policy",()=>{
  const hash="sha256-"+"A".repeat(43)+"=";
  it("requires Trusted Types with only the app's policy and the sanitizer's own, never a default or duplicates",()=>{
    expect(HOME_PAGE_CSP).toContain("require-trusted-types-for 'script'; trusted-types murage dompurify");
    expect(HOME_PAGE_CSP).not.toMatch(/'allow-duplicates'|trusted-types[^;]*\bdefault\b|'unsafe-eval'|script-src[^;]*'unsafe-inline'/);
    expect(homePagePolicy("")).toBe(HOME_PAGE_CSP);
    expect(homePagePolicy("default-src 'none'; sandbox")).toBe(`${HOME_PAGE_CSP}; sandbox`);
  });
  it("gives the diagram frame only its own hashed script, no network, and framing by the app alone",()=>{
    const frame=homePagePolicy(`sandbox allow-scripts; script-src '${hash}'`);
    expect(frame).toContain(`script-src '${hash}';`);
    expect(frame).toMatch(/^default-src 'none';/);
    for (const part of ["connect-src 'none'","object-src 'none'","base-uri 'none'","form-action 'none'","frame-ancestors 'self'"]) expect(frame).toContain(part);
    expect(frame).toMatch(/; sandbox allow-scripts$/);
    expect(frame).not.toMatch(/script-src[^;]*'unsafe-inline'|allow-same-origin|require-trusted-types-for/);
  });
  it("keeps the app policy for anything else that asks for scripts",()=>{
    for (const prior of ["sandbox allow-scripts", `sandbox allow-scripts allow-same-origin; script-src '${hash}'`, `sandbox allow-scripts; script-src '${hash}' 'unsafe-inline'`, `sandbox allow-scripts; script-src 'self'`])
      expect(homePagePolicy(prior).startsWith(HOME_PAGE_CSP),prior).toBe(true);
  });
  it("reads the frame page's script hash from its own meta policy",()=>{
    expect(mermaidFrameCsp(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src '${hash}'; style-src 'unsafe-inline'">`)).toBe(`sandbox allow-scripts; script-src '${hash}'`);
    expect(mermaidFrameCsp("<!doctype html><title>Diagram frame</title>")).toBe("sandbox allow-scripts");
  });
});

