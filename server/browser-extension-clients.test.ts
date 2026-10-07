// SPDX-License-Identifier: AGPL-3.0-or-later
import { chmodSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe,it,expect } from "vitest";
import { BrowserExtensionClients, readPrivateBrowserClientJson } from "./browser-extension-clients.ts";
// The registry refuses a parent reached through a symlink, and macOS TMPDIR
// sits under /var -> /private/var, so the fixture starts from the real path.
function fixture(){const root=mkdtempSync(join(realpathSync.native(tmpdir()),"browser-clients-"));const file=join(root,"clients.json");return {root,file,clients:new BrowserExtensionClients(file,{workspaceId:"workspace"})};}
const pairing={label:"Test CLI",profileId:"profile",botId:"dedicated_bot",threadId:"dedicated_thread"};
describe.skipIf(process.platform==="win32")("external browser clients",()=>{
  it("starts disabled and cannot pair until owner enables",()=>{const f=fixture();expect(f.clients.enabled).toBe(false);expect(()=>f.clients.pair(pairing)).toThrow();f.clients.setEnabled(true);expect(f.clients.pair(pairing).token).toHaveLength(43);});
  it("persists only token hash and returns server-assigned identity",()=>{const f=fixture();f.clients.setEnabled(true);const credential=f.clients.pair(pairing);const data=readFileSync(f.file,"utf8");expect(data).not.toContain(credential.token);expect(f.clients.list()[0]).not.toHaveProperty("tokenHash");expect(f.clients.authorize(credential.clientId,credential.token)).toMatchObject({...pairing,workspaceId:"workspace",clientId:credential.clientId});});
  it("survives restart without regenerating credentials or identity",()=>{const f=fixture();f.clients.setEnabled(true);const credential=f.clients.pair(pairing);const reloaded=new BrowserExtensionClients(f.file,{workspaceId:"workspace"});expect(reloaded.authorize(credential.clientId,credential.token).threadId).toBe(pairing.threadId);expect(()=>new BrowserExtensionClients(f.file,{workspaceId:"other"})).toThrow();});
  it("revokes both new requests and in-flight authorizer",()=>{const f=fixture();f.clients.setEnabled(true);const c=f.clients.pair(pairing),claim=f.clients.authorize(c.clientId,c.token);expect(claim.stillAuthorized()).toBe(true);expect(f.clients.revoke(c.clientId)).toBe(true);expect(claim.stillAuthorized()).toBe(false);expect(()=>f.clients.authorize(c.clientId,c.token)).toThrow();});
  it("disable then enable never revives prior in-flight authority",()=>{const f=fixture();f.clients.setEnabled(true);const c=f.clients.pair(pairing),claim=f.clients.authorize(c.clientId,c.token);f.clients.setEnabled(false);f.clients.setEnabled(true);expect(claim.stillAuthorized()).toBe(false);expect(f.clients.authorize(c.clientId,c.token).stillAuthorized()).toBe(true);});
  it("rejects cross-client credentials and shared dedicated identities",()=>{const f=fixture();f.clients.setEnabled(true);const a=f.clients.pair(pairing),b=f.clients.pair({...pairing,botId:"bot2",threadId:"thread2"});expect(()=>f.clients.authorize(a.clientId,b.token)).toThrow();expect(()=>f.clients.pair({...pairing,threadId:"thread3"})).toThrow();expect(()=>f.clients.pair({...pairing,botId:"bot3"})).toThrow();});
  it("rejects damaged registry rather than replacing it",()=>{const f=fixture();writeFileSync(f.file,"broken",{mode:0o600});expect(()=>new BrowserExtensionClients(f.file,{workspaceId:"workspace"})).toThrow();expect(readFileSync(f.file,"utf8")).toBe("broken");});
  it("rejects broad file permissions, symlinks and broad parent",()=>{const f=fixture();f.clients.setEnabled(true);chmodSync(f.file,0o644);expect(()=>readPrivateBrowserClientJson(f.file)).toThrow();chmodSync(f.file,0o600);const alias=join(f.root,"alias");symlinkSync(f.file,alias);expect(()=>readPrivateBrowserClientJson(alias)).toThrow();chmodSync(f.root,0o755);expect(()=>readPrivateBrowserClientJson(f.file)).toThrow();});
});
