import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { launchVerificationServer, type VerificationServer } from "../../scripts/control-murage.ts";

// A brand-new workspace holds one seeded bot, untouched. The welcome screen
// treats that as empty, so the first-run starter import it offers must be
// accepted by the real server, not only by a stubbed one.
let fixture: VerificationServer, headers: Record<string, string> = {};
async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(fixture.info.url + path, { method, headers: { ...headers, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
test.beforeAll(async () => {
  fixture = await launchVerificationServer(process.env);
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": (await call("GET", "/api/desktop-secret")).body.secret };
});
test.afterAll(async () => { await fixture?.close(); if (fixture) expect(existsSync(fixture.info.dataDir)).toBe(false); });

test("a fresh workspace's first-run starter import is accepted, and a second first-run import is refused", async ({}, info) => {
  test.skip(info.project.name !== "desktop", "one server-side journey");
  const roster = (await call("GET", "/api/bots")).body.bots;
  expect(roster).toHaveLength(1);
  const catalog = await call("POST", "/api/starter-profiles", { action: "catalog" });
  expect(catalog.status).toBe(200);
  const profile = catalog.body.profiles.find((entry: { id: string }) => entry.id === "starter-personal-home");
  const selection = { agents: profile.agents.map((agent: { key: string }) => agent.key), skills: [], routines: profile.routines.map((routine: { key: string }) => routine.key), instructions: [] };
  const preview = await call("POST", "/api/starter-profiles", { action: "preview", profileId: profile.id, selection });
  expect(preview.status).toBe(200);
  const reviewed = { action: "import", profileId: profile.id, selection, archiveSha256: preview.body.archiveSha256, reviewHash: preview.body.reviewHash, acknowledgeWarnings: true, firstRun: true };
  const imported = await call("POST", "/api/starter-profiles", reviewed);
  expect(imported.status, JSON.stringify(imported.body)).toBe(201);
  expect(imported.body.bots).toHaveLength(profile.members);
  const after = (await call("GET", "/api/bots")).body.bots;
  expect(after).toHaveLength(1 + profile.members);
  // The workspace is no longer new: another first-run import is refused with
  // the server's own reason.
  const again = await call("POST", "/api/starter-profiles", reviewed);
  expect(again.status).toBe(409);
  expect(again.body.error).toMatch(/already has bots|already imported/);
});
