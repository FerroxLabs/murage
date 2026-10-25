// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// F16 phase 1 through the real server: POST /api/deletions/dismiss saves the dismiss in pending-deletions.json, so the owed list
// stays empty for that deletion on the next GET, and a newer deletion owed by the same engine shows again.
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer, headers: Record<string, string>, data: string;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
};
const entry = (id: string) => {
  const since = Date.now() - 30 * 60_000;
  return { id, createdAt: since, threadIds: [], desks: [], engineHomes: [], attachments: [], artifactBlobs: [], leftovers: [], owed: { since, homes: [{ engine: "claude", code: "engine-open" }] } };
};

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env);
  data = realpathSync.native(fixture.info.dataDir);
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
}, 30000);
afterAll(async () => { await fixture?.close(); });

it("dismiss is saved by the server, and a newer deletion of the same engine shows again", async () => {
  const journal = join(data, "pending-deletions.json");
  writeFileSync(journal, JSON.stringify([entry("11111111-aaaa-4bbb-8ccc-000000000001")]));
  const shown = await api("GET", "/api/deletions/owed");
  expect(shown.body.notices).toHaveLength(1);
  const covers = shown.body.notices[0].covers as string[];
  expect(covers).toEqual(["11111111-aaaa-4bbb-8ccc-000000000001:claude"]);
  const dismissed = await api("POST", "/api/deletions/dismiss", { covers });
  expect(dismissed.status).toBe(200);
  expect(dismissed.body.notices).toEqual([]);
  expect((await api("GET", "/api/deletions/owed")).body.notices).toEqual([]);
  // saved in the journal, so a restart reads it back
  const saved = JSON.parse(readFileSync(journal, "utf8")) as Array<{ owed: { items: Array<{ dismissedAt?: number }> } }>;
  expect(typeof saved[0]!.owed.items[0]!.dismissedAt).toBe("number");
  // a newer deletion owed by the same engine
  writeFileSync(journal, JSON.stringify([...saved, entry("22222222-aaaa-4bbb-8ccc-000000000002")]));
  const again = await api("GET", "/api/deletions/owed");
  expect(again.body.notices).toHaveLength(1);
  expect(again.body.notices[0].covers).toEqual(["22222222-aaaa-4bbb-8ccc-000000000002:claude"]);
  // a body that is not a list of strings is refused
  expect((await api("POST", "/api/deletions/dismiss", { covers: "x" })).status).toBe(400);
  writeFileSync(journal, "[]");
}, 30000);
