// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { createPrivateWindowsDirectory, readPrivateWindowsJson, writePrivateWindowsJson } from "../electron/browser-extension-windows.mjs";
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export type BrowserExtensionClientIdentity = { clientId: string; workspaceId: string; botId: string; threadId: string; profileId: string; label: string };
type StoredClient = BrowserExtensionClientIdentity & { tokenHash: string };
type Registry = { version: 1; workspaceId: string; enabled: boolean; clients: StoredClient[] };
function refused(): never { throw new Error("Browser client registry unavailable or unauthorized"); }
/** Platform-specific private-directory verification; Windows requires the native ACL helper. */
export function assertPrivateBrowserClientPath(file: string): void {
  if (process.platform === "win32") { createPrivateWindowsDirectory(dirname(file)); return; }
  if (!isAbsolute(file)) refused();
  const parent = dirname(file), stat = lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(parent) !== resolve(parent) || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) refused();
}
export function readPrivateBrowserClientJson(file: string): unknown {
  assertPrivateBrowserClientPath(file);
  if (process.platform === "win32") return readPrivateWindowsJson(file);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 1024 * 1024) refused();
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
}
/** Owner-only config writer for pairing routes; never puts credentials in argv. */
export function writePrivateBrowserClientJson(file: string, value: unknown): void {
  if (process.platform === "win32") { createPrivateWindowsDirectory(dirname(file)); writePrivateWindowsJson(file, value); }
  else { assertPrivateBrowserClientPath(file); writeFileAtomic(file, JSON.stringify(value), { mode: 0o600 }); }
}
function hash(token: string) { return createHash("sha256").update(token).digest("hex"); }
export class BrowserExtensionClients {
  private data: Registry;
  private epoch = 0;
  private readonly file: string;
  constructor(file: string, options: { workspaceId: string }) {
    if (!ID.test(options.workspaceId) || !isAbsolute(file)) refused();
    this.file = file;
    if (process.platform === "win32") createPrivateWindowsDirectory(dirname(file));
    else mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    assertPrivateBrowserClientPath(file);
    let data: unknown;
    try { data = readPrivateBrowserClientJson(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (data === undefined) { this.data = { version: 1, workspaceId: options.workspaceId, enabled: false, clients: [] }; return; }
    const value = data as Registry;
    if (!value || value.version !== 1 || value.workspaceId !== options.workspaceId || typeof value.enabled !== "boolean" || !Array.isArray(value.clients) || value.clients.length > 128 || Object.keys(value).sort().join(",") !== "clients,enabled,version,workspaceId") refused();
    const clients = new Set<string>(), bots = new Set<string>(), threads = new Set<string>();
    for (const client of value.clients) {
      if (!client || Object.keys(client).sort().join(",") !== "botId,clientId,label,profileId,threadId,tokenHash,workspaceId" || [client.clientId,client.botId,client.threadId,client.profileId].some(id=>typeof id!=="string"||!ID.test(id)) || client.workspaceId !== options.workspaceId || typeof client.label !== "string" || !client.label.trim() || client.label.length > 100 || typeof client.tokenHash !== "string" || !/^[a-f0-9]{64}$/.test(client.tokenHash) || clients.has(client.clientId) || bots.has(client.botId) || threads.has(client.threadId)) refused();
      clients.add(client.clientId); bots.add(client.botId); threads.add(client.threadId);
    }
    this.data = value;
  }
  get enabled() { return this.data.enabled; }
  private save(data: Registry) { assertPrivateBrowserClientPath(this.file); if (process.platform === "win32") writePrivateWindowsJson(this.file, data); else writeFileAtomic(this.file, JSON.stringify(data), { mode: 0o600 }); this.data = data; this.epoch++; }
  /** Owner settings route only. Disabled revokes every already-issued authorizer. */
  setEnabled(enabled: boolean): void { if (typeof enabled !== "boolean") refused(); if (enabled !== this.data.enabled) this.save({ ...this.data, enabled }); }
  /** Owner pairing route supplies a newly created dedicated bot/thread, never client claims. */
  pair(input: { label: string; profileId: string; botId: string; threadId: string }): { clientId: string; token: string } {
    if (!this.enabled || this.data.clients.length >= 128 || typeof input.label !== "string" || !input.label.trim() || input.label.length > 100 || [input.profileId,input.botId,input.threadId].some(id=>typeof id!=="string"||!ID.test(id)) || this.data.clients.some(client=>client.botId===input.botId||client.threadId===input.threadId)) refused();
    const clientId = randomUUID(), token = randomBytes(32).toString("base64url");
    const client: StoredClient = { clientId, workspaceId:this.data.workspaceId, botId:input.botId, threadId:input.threadId, profileId:input.profileId, label:input.label, tokenHash:hash(token) };
    this.save({ ...this.data, clients:[...this.data.clients,client] }); return {clientId,token};
  }
  list(): BrowserExtensionClientIdentity[] { return this.data.clients.map(({tokenHash:_,...identity})=>({...identity})); }
  revoke(clientId: string): boolean { if (!this.data.clients.some(client=>client.clientId===clientId)) return false; this.save({...this.data,clients:this.data.clients.filter(client=>client.clientId!==clientId)}); return true; }
  authorize(clientId: string, token: string): BrowserExtensionClientIdentity & { stillAuthorized: () => boolean } {
    if (!this.enabled || typeof token!=="string" || !TOKEN.test(token)) refused();
    const client=this.data.clients.find(client=>client.clientId===clientId);
    if (!client || !timingSafeEqual(Buffer.from(client.tokenHash,"hex"),Buffer.from(hash(token),"hex"))) refused();
    const epoch=this.epoch; const {tokenHash:_,...identity}=client;
    return {...identity,stillAuthorized:()=>this.enabled&&this.epoch===epoch&&this.data.clients.includes(client)};
  }
}
