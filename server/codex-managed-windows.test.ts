import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const resolver=vi.hoisted(()=>vi.fn());
vi.mock("./env-path.ts",()=>({resolveCliSpawn:resolver}));
import { ManagedNpmUnavailable, verifiedWindowsCodexPath, windowsNpmCommand } from "./codex-managed-windows.ts";
const roots:string[]=[];
afterEach(async()=>{vi.clearAllMocks();await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),"murage-managed-windows-"));roots.push(root);
 const key="node_modules/@openai/codex-win32-x64",pkg=join(root,key),dir=join(pkg,"vendor/x86_64-pc-windows-msvc/bin");await mkdir(dir,{recursive:true});
 const entry={version:"0.153.4-win32-x64",resolved:"https://registry.npmjs.org/@openai/codex/-/codex-0.153.4-win32-x64.tgz",integrity:"sha512-"+Buffer.alloc(64).toString("base64")};
 const lock={packages:{[key]:entry}};
 await writeFile(join(root,"package-lock.json"),JSON.stringify(lock));
 await writeFile(join(pkg,"package.json"),JSON.stringify({name:"@openai/codex",version:entry.version,os:["win32"],cpu:["x64"]}));
 const cli=join(dir,"codex.exe"),bytes=Buffer.alloc(128);bytes.write("MZ");bytes.writeUInt32LE(64,60);bytes.write("PE\0\0",64);bytes.writeUInt16LE(0x8664,68);await writeFile(cli,bytes);
 return {root,cli,lock,entry,bytes};
}
it("binds the pinned npm native package and PE x64 executable",async()=>{const f=await fixture();await expect(verifiedWindowsCodexPath(f.root,"0.153.4")).resolves.toBe(f.cli);});
it.each(["host","version","integrity"])("refuses changed native package %s",async change=>{
 const f=await fixture();if(change==="host")f.entry.resolved="https://other.invalid/codex.tgz";if(change==="version")f.entry.version="0.0.1-win32-x64";if(change==="integrity")f.entry.integrity="";
 await writeFile(join(f.root,"package-lock.json"),JSON.stringify(f.lock));await expect(verifiedWindowsCodexPath(f.root,"0.153.4")).rejects.toThrow("integrity unavailable");
});
it("rejects an ARM64 PE before executing it",async()=>{const f=await fixture();f.bytes.writeUInt16LE(0xaa64,68);await writeFile(f.cli,f.bytes);await expect(verifiedWindowsCodexPath(f.root,"0.153.4")).rejects.toThrow("not Windows x64");});
it("resolves npm through installed Node without a shell, including spaces in its path",async()=>{
 const f=await fixture(),nodeDir=join(f.root,"Program Files","nodejs");await mkdir(join(nodeDir,"node_modules/npm/bin"),{recursive:true});await writeFile(join(nodeDir,"node_modules/npm/bin/npm-cli.js"),"// fixture");resolver.mockReturnValue({command:join(nodeDir,"node.exe"),args:[]});
 await expect(windowsNpmCommand(["install","--prefix",join(f.root,"owned prefix")])).resolves.toEqual({command:join(nodeDir,"node.exe"),args:[join(nodeDir,"node_modules/npm/bin/npm-cli.js"),"install","--prefix",join(f.root,"owned prefix")]});
});
it("explains the missing npm prerequisite without a shell fallback",async()=>{resolver.mockReturnValue({command:"node.exe",args:[]});await expect(windowsNpmCommand(["install"])).rejects.toThrow(ManagedNpmUnavailable);await expect(windowsNpmCommand(["install"])).rejects.toThrow("Install Node.js (including npm)");});
