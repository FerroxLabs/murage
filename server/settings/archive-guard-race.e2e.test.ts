// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Settings v10 C6 through the real server: Archive names the app-choices revision the owner reviewed, and the route re-checks it
// after its last await (the phone-call stop). A choice saved while the stop is in flight answers 409 with the bot not archived
// and the newer choices untouched.
import { mkdirSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";

const SERVER = fileURLToPath(new URL("..", import.meta.url));
const posixOnly = describe.skipIf(process.platform === "win32");

// In the server: the phone stop's legacy-call step waits, while a flag file exists, until a gate file is written.
const instrumentation = `
  const fs=await import('node:fs');const path=await import('node:path');const {pathToFileURL}=await import('node:url');
  const dir=process.env.MURAGE_DATA_DIR;const server=${JSON.stringify(SERVER)};
  const {PhoneCallService}=await import(pathToFileURL(path.join(server,'phone-calls','service.ts')).href);
  const hold=PhoneCallService.prototype.holdLegacyCalls;
  PhoneCallService.prototype.holdLegacyCalls=async function(...args){
    if(fs.existsSync(path.join(dir,'stop-hold'))){
      fs.rmSync(path.join(dir,'stop-hold'));fs.writeFileSync(path.join(dir,'stop-held'),'1');
      while(!fs.existsSync(path.join(dir,'stop-gate')))await new Promise(r=>setTimeout(r,10));
      fs.rmSync(path.join(dir,'stop-gate'));
    }
    return hold.apply(this,args);
  };
`;

posixOnly("archive revision re-check after the phone stop", () => {
  let fixture: VerificationServer;
  let desktop: Record<string, string> = {};
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { ...desktop, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  };
  const until = async (check: () => boolean, ms = 20_000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 20)); } };
  const configure = (id: string, revision: number, allowWrites: boolean) => call("PUT", `/api/bots/${id}/access`, { action: "configure", revision, mode: "restricted", allowWrites, grants: [] });

  beforeAll(async () => {
    fixture = await launchVerificationServer({}, undefined, { instrumentationSource: instrumentation });
    desktop = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await call("GET", "/api/desktop-secret")).body.secret };
    // an existing call history is what sends Archive through the phone stop
    mkdirSync(fixture.info.dataDir, { recursive: true });
    writeFileSync(join(fixture.info.dataDir, "phone-calls.db"), "", { flag: "a" });
  }, 120_000);
  afterAll(async () => { await fixture?.close(); });

  it("a choice saved during the phone stop refuses the archive: bot stays, newer choices stay", async () => {
    const made = await call("POST", "/api/bots", { name: "Raced" });
    const id = made.body.bot.id as string;
    const first = await configure(id, 0, false);
    expect(first.status).toBe(200);
    const reviewed = first.body.policy.revision as number;
    writeFileSync(join(fixture.info.dataDir, "stop-hold"), "1");
    const archive = call("PATCH", `/api/bots/${id}`, { hidden: true, accessRevision: reviewed });
    await until(() => existsSync(join(fixture.info.dataDir, "stop-held")));
    const changed = await configure(id, reviewed, true);
    expect(changed.status).toBe(200);
    writeFileSync(join(fixture.info.dataDir, "stop-gate"), "1");
    const answer = await archive;
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ code: "ACCESS_CHANGED", botId: id });
    const after = await call("GET", `/api/bots/${id}/access`);
    expect(after.body.policy).toMatchObject({ mode: "restricted", allowWrites: true, revision: changed.body.policy.revision });
    const listed = (await call("GET", "/api/bots?messages=0")).body.bots.find((bot: any) => bot.id === id);
    expect(listed.hidden).not.toBe(true);
    rmSync(join(fixture.info.dataDir, "stop-held"), { force: true });
  });
});
