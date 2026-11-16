// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { FakeHighLevelRequest, FakeHighLevelRoute } from "../fake-provider.ts";

export const OPPORTUNITY_FIXTURE = {
  id: "opp_1", locationId: "loc_fixture_01", pipelineId: "pipe_1", pipelineStageId: "stage_1",
  contactId: "contact_1", name: "Fixture deal", status: "open", monetaryValue: 100,
};
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const pipeline = (request: FakeHighLevelRequest) => {
  const body = object(request.body);
  return { id: "pipe_1", locationId: OPPORTUNITY_FIXTURE.locationId, ...body,
    ...(Array.isArray(body.stages) ? { stages: body.stages.map((s, i) => ({ id: `new_stage_${i}`, ...object(s) })) } : {}) };
};
const saved = (request: FakeHighLevelRequest) => ({ ...(request.operation.endsWith(".upsert") ? { new: true } : {}), opportunity: { id: "opp_1", ...object(request.body) } });
const route = (operation: string, method: FakeHighLevelRoute["method"], path: RegExp, handle: FakeHighLevelRoute["handle"]): FakeHighLevelRoute =>
  ({ operation: `opportunities.${operation}`, method, path, handle });
export const opportunitiesRoutes: readonly FakeHighLevelRoute[] = [
  route("pipelines.list", "GET", /^\/opportunities\/pipelines$/u, request => ({ pipelines: request.query?.locationId === OPPORTUNITY_FIXTURE.locationId
    ? [{ id: "pipe_1", name: "Sales", stages: [{ id: "stage_1", name: "New", position: 0 }, { id: "stage_2", name: "Qualified", position: 1 }] }] : [] })),
  route("pipelines.create", "POST", /^\/opportunities\/pipelines$/u, pipeline),
  route("pipelines.update", "PUT", /^\/opportunities\/pipelines\/pipe_1$/u, pipeline),
  route("pipelines.delete", "DELETE", /^\/opportunities\/pipelines\/pipe_1$/u, () => ({ success: true })),
  route("search", "GET", /^\/opportunities\/search$/u, request => ({ opportunities: request.query?.location_id === OPPORTUNITY_FIXTURE.locationId ? [{ ...OPPORTUNITY_FIXTURE }] : [], meta: { total: 1 } })),
  route("get", "GET", /^\/opportunities\/opp_1$/u, () => ({ opportunity: { ...OPPORTUNITY_FIXTURE } })),
  route("create", "POST", /^\/opportunities\/$/u, saved),
  route("update", "PUT", /^\/opportunities\/opp_1$/u, saved),
  route("upsert", "POST", /^\/opportunities\/upsert$/u, saved),
  route("status", "PUT", /^\/opportunities\/opp_1\/status$/u, () => ({ succeeded: true })),
  route("delete", "DELETE", /^\/opportunities\/opp_1$/u, () => ({ succeeded: true })),
  route("followers.add", "POST", /^\/opportunities\/opp_1\/followers$/u, request => ({ followers: object(request.body).followers, followersAdded: [...object(request.body).followers as string[]] })),
  route("followers.remove", "DELETE", /^\/opportunities\/opp_1\/followers$/u, request => ({ followersRemoved: object(request.body).followers })),
];
export default opportunitiesRoutes;
