import { afterAll, beforeAll, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer, headers: Record<string, string>;
interface ApiBody { browserProfiles: Array<{ id: string; name: string; partitionId?: string }>; secret: string; bot: { id: string }; error: string }
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as ApiBody };
};
const project = (profiles: Array<{ id: string; name: string }>) => profiles.map(({ id, name }) => ({ id, name }));
beforeAll(async () => {
  fixture = await launchVerificationServer(process.env, undefined, { instrumentationSource: `
    const fs=await import('node:fs');const path=await import('node:path');const file=path.join(process.env.MURAGE_DATA_DIR,'config.json');
    const config=JSON.parse(fs.readFileSync(file,'utf8'));config.features={browser:true};config.browserProfiles=[{id:'work',name:'Work',partitionId:'Work'}];fs.writeFileSync(file,JSON.stringify(config));
  ` });
  const proof = await api("GET", "/api/desktop-secret"); headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.body.secret };
});
afterAll(async () => { await fixture?.close(); });
it("rejects sequential stale rename/delete before config, reference or cleanup effects", async () => {
  const before = (await api("GET", "/api/config")).body;
  const base = project(before.browserProfiles);
  const bot = (await api("POST", "/api/bots", { name: "Profile CAS fixture" })).body.bot;
  expect((await api("PATCH", `/api/bots/${bot.id}`, { browserProfile: "work" })).status).toBe(200);
  const next = [...base, { id: "other", name: "Other" }];
  expect((await api("PATCH", "/api/config", { browserProfiles: next, expectedBrowserProfiles: base })).status).toBe(200);
  const saved = readFileSync(join(fixture.info.dataDir, "config.json"), "utf8");
  const files = ["bots.json", "browser-cleanups.json"].map(name => { const file = join(fixture.info.dataDir, name); return existsSync(file) ? readFileSync(file, "utf8") : null; });
  for (const browserProfiles of [[{ id: "work", name: "Stale rename" }], []]) {
    const conflict = await api("PATCH", "/api/config", { browserProfiles, expectedBrowserProfiles: base, language: "de" });
    expect(conflict.status).toBe(409); expect(conflict.body.error).toContain("changed elsewhere");
    expect(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8")).toBe(saved);
    expect(["bots.json", "browser-cleanups.json"].map(name => { const file = join(fixture.info.dataDir, name); return existsSync(file) ? readFileSync(file, "utf8") : null; })).toEqual(files);
  }
  const after = (await api("GET", "/api/config")).body; expect(project(after.browserProfiles)).toEqual(next);
  const refreshed = next.map(profile => profile.id === "work" ? { ...profile, name: "Reviewed rename" } : profile);
  expect((await api("PATCH", "/api/config", { browserProfiles: refreshed, expectedBrowserProfiles: project(after.browserProfiles) })).status).toBe(200);
  expect((await api("GET", "/api/config")).body.browserProfiles.find((profile: { id: string }) => profile.id === "work")).toMatchObject({ name: "Reviewed rename", partitionId: "Work" });
});
it("requires snapshots for old clients, refuses malformed/partition-bearing snapshots, and preserves unrelated writes", async () => {
  const current = (await api("GET", "/api/config")).body.browserProfiles;
  const next = project(current);
  expect((await api("PATCH", "/api/config", { browserProfiles: next })).status).toBe(409);
  expect((await api("PUT", "/api/config", { browserProfiles: next, expectedBrowserProfiles: null })).status).toBe(400);
  expect((await api("PATCH", "/api/config", { browserProfiles: next, expectedBrowserProfiles: current })).status).toBe(400);
  expect((await api("PATCH", "/api/config", { language: "en" })).status).toBe(200);
});
