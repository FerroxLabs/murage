// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright 2026 Ferrox Labs
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ensureDirs } from "./config.ts";
import { initializeProjectTables } from "./project-tables.ts";
import { handleProjectRoute } from "./project-routes.ts";
let db: DatabaseSync;
beforeEach(() => { ensureDirs(); db = new DatabaseSync(":memory:"); initializeProjectTables(db); db.prepare(`INSERT INTO project_settings (group_id,mode,parts,work_roots,work_profile,run_state,updated_at) VALUES ('g','ongoing','{}','[]','ask','running',0)`).run(); });
afterEach(() => db.close());
const call = (method: string, suffix: string, body: unknown = {}, origin: "desktop" | "companion" | "unproven" = "desktop") => handleProjectRoute(db,{ method,path:`/api/groups/g/${suffix}`,body,origin,group:{id:"g",memberIds:[],threadId:"room"},query:new URLSearchParams(),now:1000 });
it("refuses every budget and work authority write away from desktop", () => {
  for (const origin of ["companion","unproven"] as const) for (const [method,path] of [["POST","budget"],["PATCH","budget"],["PUT","work-roots"],["PATCH","work-profile"]]) expect(call(method!,`project/${path}`,{},origin)?.status).toBe(403);
});
it("creates one period budget, changes by revision and rejects injected unknown fields", () => {
  const result = call("POST","project/budget",{period:"week",tz:"UTC",maxWorkMinutes:120,maxTokens:3000000});
  expect(result?.status).toBe(200); const budget = result?.body.budget as {id:string;revision:number};
  expect(call("POST","project/budget",{period:"day",tz:"UTC",maxWorkMinutes:10})?.status).toBe(409);
  expect(call("PATCH","project/budget",{budgetId:budget.id,expectedRevision:budget.revision,maxWorkMinutes:240})?.status).toBe(200);
  expect(call("PATCH","project/budget",{budgetId:budget.id,expectedRevision:budget.revision,maxWorkMinutes:240})?.body.error).toBe("changed");
  expect(call("PATCH","project/work-profile",{expectedRevision:0,workProfile:"ask",budget:10000})?.status).toBe(400);
  expect(call("GET","usage")?.body).toMatchObject({ totals:{workMs:0,charge:null},notReported:[] });
});
