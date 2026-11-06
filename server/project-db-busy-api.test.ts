// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
//
// DBBUSY-1018 on a real server. Owner writes claim the writer lock up front (write-tx.ts beginWrite), so:
//  - project reads (project, board, activity, usage, brief versions) keep a read-only frame and still answer while another
//    connection holds the writer lock (a search-index merge slice, a long owner write);
//  - a project create or close that cannot get the lock in time answers the 503 busy reply (code DATABASE_BUSY, Retry-After),
//    never the 400 "check the fields" or the 500 "could not finish". What these tests prove is the FIRST lock grab: a create
//    or close refused there has written nothing yet. They do not make the whole request atomic: create commits its row
//    before materialization, close stops running work before its final write, and an optional Start still reports a busy
//    lock as its start reason (project-new.ts). A busy error after those points leaves recoverable, already committed steps.
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-murage.ts";

let fixture: VerificationServer, headers: Record<string, string>, leadId: string;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, retryAfter: response.headers.get("retry-after"), body: await response.json().catch(() => null) as any };
};
const projectBody = (clientId: string) => ({ clientId, purpose: "Keep answering", mode: "goal", members: [leadId], leadBotId: leadId, goal: { title: "Keep answering" } });
/** Another connection takes the writer lock on the fixture's messages.db, as a merge slice or a long write would. */
function holdWriter(): () => void {
  const db = new DatabaseSync(join(fixture.info.dataDir, "messages.db"));
  db.exec("PRAGMA busy_timeout=10000");
  db.exec("BEGIN IMMEDIATE");
  return () => { try { if (db.isTransaction) db.exec("ROLLBACK"); } finally { db.close(); } };
}

beforeAll(async () => {
  fixture = await launchVerificationServer(process.env);
  const proof = await (await fetch(`${fixture.info.url}/api/desktop-secret`)).json() as { secret: string };
  headers = { "x-murage-surface": "desktop", "x-murage-surface-secret": proof.secret };
  const model = (await api("GET", "/api/instances")).body.instances.find((i: any) => i.instanceId === "verification").models.options[0].id;
  const made = await api("POST", "/api/bots", { name: "Busy lead", modelSelection: { instanceId: "verification", model } });
  expect(made.status).toBe(201); leadId = made.body.bot.id;
  await api("PATCH", `/api/bots/${leadId}`, { computer: "off", browser: false, composio: false });
}, 30000);
afterAll(async () => { await fixture?.close(); });

it("project GETs still answer while another connection holds the writer lock", async () => {
  const made = await api("POST", "/api/projects", projectBody("held-read"));
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const release = holdWriter();
  try {
    for (const path of ["/api/groups/held-read/project", "/api/groups/held-read/board", "/api/groups/held-read/activity",
      "/api/groups/held-read/usage", "/api/groups/held-read/project/brief/versions"]) {
      const answer = await api("GET", path);
      expect(answer.status, `${path} ${JSON.stringify(answer.body)}`).toBe(200);
    }
  } finally { release(); }
}, 60000);

it("a project create that cannot get the writer lock answers 503 busy, and a retry after it creates the project", async () => {
  const release = holdWriter();
  let held;
  try { held = await api("POST", "/api/projects", projectBody("held-create")); } finally { release(); }
  expect(held.status, JSON.stringify(held.body)).toBe(503);
  expect(held.body.code).toBe("DATABASE_BUSY");
  expect(held.retryAfter).not.toBeNull();
  const again = await api("POST", "/api/projects", projectBody("held-create"));
  expect(again.status, JSON.stringify(again.body)).toBe(200);
  expect((await api("GET", "/api/groups/held-create/project")).status).toBe(200);
}, 60000);

it("a project close that cannot get the writer lock answers 503 busy and leaves the project open", async () => {
  expect((await api("POST", "/api/projects", projectBody("held-close"))).status).toBe(200);
  const release = holdWriter();
  let held;
  try { held = await api("POST", "/api/groups/held-close/project/close", {}); } finally { release(); }
  expect(held.status, JSON.stringify(held.body)).toBe(503);
  expect(held.body.code).toBe("DATABASE_BUSY");
  const project = await api("GET", "/api/groups/held-close/project");
  expect(project.status).toBe(200);
  expect(project.body.closing).toBe(false);
  expect(project.body.lifecycle).toBe("open");
}, 60000);
