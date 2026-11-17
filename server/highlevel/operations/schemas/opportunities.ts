import { z } from "zod";
import { strictOperationArgs } from "./common.ts";
const PAGE_MAX = 50;
const PAGE_NUMBER_MAX = 1000;
const ID = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.~%-]+$/u)
  .refine(v => v !== "." && !v.includes("..") && !/%(?![0-9a-f]{2})|%(?:2e|2f|5c|25)/iu.test(v), "Record ID contains characters that are not allowed");
const text = (max: number) => z.string().min(1).max(max).refine(v => !/(?:[a-z][a-z0-9+.-]*:\/\/|^\s*(?:(?:data|file|javascript):|\/\/))/iu.test(v), "URLs are not accepted");
const status = z.enum(["open", "won", "lost", "abandoned"]);
// PROVISIONAL INTERFACE: retain optional legacy locationId until S0 supplies
// r3 argsSchema. Authority always comes from ctx; a conflicting legacy value
// refuses before a preflight. New callers omit it.
const location = { locationId: ID.optional() };
const opportunity = { ...location, opportunityId: ID };
const mutable = {
  pipelineId: ID.optional(), pipelineStageId: ID.optional(), name: text(500).optional(), status: status.optional(),
  monetaryValue: z.number().finite().nonnegative().optional(), assignedTo: ID.optional(),
};
const stage = z.object({ id: ID.optional(), name: text(200), position: z.number().int().nonnegative(), showInFunnel: z.boolean().optional(),
  showInPieChart: z.boolean().optional(), stageWinProbability: z.number().min(0).max(100).optional() }).strict();
const stages = z.array(stage).min(1).max(100).refine(v => new Set(v.map(s => s.name.toLowerCase())).size === v.length &&
  new Set(v.flatMap(s => s.id ? [s.id] : [])).size === v.filter(s => s.id).length, "Duplicate stages");
const pipelineFields = { name: text(200).optional(), stages: stages.optional(), showInFunnel: z.boolean().optional(),
  showInPieChart: z.boolean().optional(), useOpportunityProbability: z.boolean().optional(), colorRenderMode: z.enum(["dot", "bg-tint", "none"]).optional() };
const inputs = {
  "pipelines.list": z.object(location).strict(),
  search: z.object({ ...location, query: text(500).optional(), pipelineId: ID.optional(), pipelineStageId: ID.optional(),
    contactId: ID.optional(), status: z.enum(["open", "won", "lost", "abandoned", "all"]).optional(),
    page: z.number().int().min(1).max(PAGE_NUMBER_MAX).optional(), limit: z.number().int().min(1).max(PAGE_MAX).optional(),
  }).strict().refine(a => !a.pipelineStageId || !!a.pipelineId, "A stage needs its pipeline"),
  "pipelines.create": z.object({ ...location, ...pipelineFields, name: text(200), stages }).strict().refine(a => a.stages.every(s => s.id === undefined), "New stages cannot name existing ids"),
  "pipelines.update": z.object({ ...location, ...pipelineFields, pipelineId: ID }).strict().refine(a => Object.keys(pipelineFields).some(k => a[k as keyof typeof a] !== undefined), "Give at least one field to change"),
  "pipelines.delete": z.object({ ...location, pipelineId: ID }).strict(),
  get: z.object(opportunity).strict(),
  create: z.object({ ...location, ...mutable, pipelineId: ID, contactId: ID, name: text(500), status: status.default("open") }).strict(),
  update: z.object({ ...opportunity, ...mutable }).strict().refine(a => Object.keys(mutable).some(k => a[k as keyof typeof a] !== undefined), "Give at least one field to change"),
  status: z.object({ ...opportunity, status }).strict(),
  upsert: z.object({ ...location, ...mutable, id: ID.optional(), pipelineId: ID, name: text(500), status: status.default("open"),
    followers: z.array(ID).max(10).default([]), isRemoveAllFollowers: z.literal(false).default(false), followersActionType: z.enum(["add", "remove"]).default("add"),
  }).strict(),
  delete: z.object(opportunity).strict(),
  "followers.add": z.object({ ...opportunity, followers: z.array(ID).min(1).max(10).refine(v => new Set(v).size === v.length, "Duplicate followers") }).strict(),
  "followers.remove": z.object({ ...opportunity, followers: z.array(ID).min(1).max(10).refine(v => new Set(v).size === v.length, "Duplicate followers") }).strict(),
};

const wire = {
  "pipelines.list": null, search: null, get: null,
  "pipelines.create": z.strictObject({ ...pipelineFields, name: text(200), stages, locationId: ID }),
  "pipelines.update": z.strictObject(pipelineFields), "pipelines.delete": null,
  create: z.strictObject({ ...mutable, pipelineId: ID, contactId: ID, name: text(500), status, locationId: ID }),
  update: z.strictObject(mutable), status: z.strictObject({ status }),
  upsert: z.strictObject({ ...mutable, id: ID.optional(), pipelineId: ID, name: text(500), status,
    followers: z.array(ID).max(10), isRemoveAllFollowers: z.literal(false), followersActionType: z.enum(["add", "remove"]), locationId: ID }),
  delete: null,
  "followers.add": z.strictObject({ followers: z.array(ID).min(1).max(10) }),
  "followers.remove": z.strictObject({ followers: z.array(ID).min(1).max(10) }),
};
export const schemas = {
  "opportunities.pipelines.list": { argsSchema: strictOperationArgs(inputs["pipelines.list"]), bodySchema: wire["pipelines.list"], projection: ["pipelines"] },
  "opportunities.search": { argsSchema: strictOperationArgs(inputs["search"]), bodySchema: wire["search"], projection: ["opportunities", "meta", "aggregations"] },
  "opportunities.get": { argsSchema: strictOperationArgs(inputs["get"]), bodySchema: wire["get"], projection: ["opportunity"] },
  "opportunities.create": { argsSchema: strictOperationArgs(inputs["create"]), bodySchema: wire["create"], projection: ["opportunity"] },
  "opportunities.update": { argsSchema: strictOperationArgs(inputs["update"]), bodySchema: wire["update"], projection: ["opportunity"] },
  "opportunities.status": { argsSchema: strictOperationArgs(inputs["status"]), bodySchema: wire["status"], projection: ["succeded", "success"] },
  "opportunities.upsert": { argsSchema: strictOperationArgs(inputs["upsert"]), bodySchema: wire["upsert"], projection: ["opportunity", "new"] },
  "opportunities.delete": { argsSchema: strictOperationArgs(inputs["delete"]), bodySchema: wire["delete"], projection: ["succeded", "success"] },
  "opportunities.followers.add": { argsSchema: strictOperationArgs(inputs["followers.add"]), bodySchema: wire["followers.add"], projection: ["followers", "followersAdded"] },
  "opportunities.followers.remove": { argsSchema: strictOperationArgs(inputs["followers.remove"]), bodySchema: wire["followers.remove"], projection: ["followers", "followersRemoved"] },
  "opportunities.pipelines.create": { argsSchema: strictOperationArgs(inputs["pipelines.create"]), bodySchema: wire["pipelines.create"], projection: ["id", "name", "stages", "showInFunnel", "showInPieChart", "locationId", "useOpportunityProbability", "colorRenderMode", "position"] },
  "opportunities.pipelines.update": { argsSchema: strictOperationArgs(inputs["pipelines.update"]), bodySchema: wire["pipelines.update"], projection: ["id", "name", "stages", "showInFunnel", "showInPieChart", "locationId", "useOpportunityProbability", "colorRenderMode", "position"] },
  "opportunities.pipelines.delete": { argsSchema: strictOperationArgs(inputs["pipelines.delete"]), bodySchema: wire["pipelines.delete"], projection: ["success", "message"] },
} as const;
export const argsSchema = Object.fromEntries(Object.entries(schemas).map(([id, row]) => [id, row.argsSchema])) as { [K in keyof typeof schemas]: typeof schemas[K]["argsSchema"] };
export const bodySchema = Object.fromEntries(Object.entries(schemas).map(([id, row]) => [id, row.bodySchema])) as { [K in keyof typeof schemas]: typeof schemas[K]["bodySchema"] };
export const projection = Object.fromEntries(Object.entries(schemas).map(([id, row]) => [id, row.projection])) as { [K in keyof typeof schemas]: typeof schemas[K]["projection"] };
