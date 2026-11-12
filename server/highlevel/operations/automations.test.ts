// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { f5BoundProjection, automationsOperations } from "./automations.ts";

describe("F5 automations", () => {
  it("auto.addToWorkflowNamesWorkflowId", () => {
    const spec = automationsOperations.find((entry) => entry.id === "automations.workflow.addContact");
    expect(typeof spec?.recordRefs).toBe("function");
    expect(spec!.recordRefs({ contactId: "contact_1", workflowId: "workflow_1", eventStartTime: "2026-11-10T12:00:00Z" })).toEqual(["contact_1", "workflow_1"]);
    expect(spec!.fields({ contactId: "contact_1", workflowId: "workflow_1", eventStartTime: "2026-11-10T12:00:00Z" })).toEqual(["workflowId", "eventStartTime"]);
  });

  it("auto.removeAllIsD", () => {
    const spec = automationsOperations.find((entry) => entry.id === "automations.campaign.removeAll");
    expect(spec?.risk).toBe("D");
    expect(spec!.endpoint.retry).toBe("write");
  });
});

// These exercise the frozen OperationSpec boundary through an isolated fixture.
// Production host/grant/receipt tests also run in f5-contract.test.ts.
import { automationRoutes, exerciseF5, fakeF5Provider } from "../fake/automations.ts";
import { HighLevelError } from "../errors.ts";

const cases = [
  ["workflows.list", "R", { locationId: "location_1" }, "GET", "/workflows/", "workflows.readonly"],
  ["campaigns.list", "R", { locationId: "location_1", status: "published" }, "GET", "/campaigns/", "campaigns.readonly"],
  ["workflow.addContact", "C", { contactId: "contact_1", workflowId: "workflow_1", eventStartTime: "2026-11-10T12:00:00Z" }, "POST", "/contacts/contact_1/workflow/workflow_1", "contacts.write"],
  ["workflow.removeContact", "C", { contactId: "contact_1", workflowId: "workflow_1" }, "DELETE", "/contacts/contact_1/workflow/workflow_1", "contacts.write"],
  ["campaign.addContact", "C", { contactId: "contact_1", campaignId: "campaign_1" }, "POST", "/contacts/contact_1/campaigns/campaign_1", "contacts.write"],
  ["campaign.removeContact", "C", { contactId: "contact_1", campaignId: "campaign_1" }, "DELETE", "/contacts/contact_1/campaigns/campaign_1", "contacts.write"],
  ["campaign.removeAll", "D", { contactId: "contact_1" }, "DELETE", "/contacts/contact_1/campaigns/remove-all", "contacts.write"],
] as const;

for (const [verb, risk, args, method, path, scope] of cases) {
  describe(`automations.${verb}`, () => {
    const get = () => {
      const spec = automationsOperations.find((s) => s.id === `automations.${verb}`);
      expect(typeof (spec?.risk === "R" ? spec.prepareRead : spec?.prepare)).toBe("function");
      return spec!;
    };
    it("strict schema rejects extra keys, URLs, unsafe ids and wrong types", () => {
      const spec = get();
      expect(spec.args.safeParse(args).success).toBe(true);
      for (const key of ["extra", "url", "header", "path", "token"]) expect(spec.args.safeParse({ ...args, [key]: "SENTINEL" }).success).toBe(false);
      for (const key of Object.keys(args)) {
        for (const value of ["https://evil.test", "//evil.test", {}, ["contact_1"]]) expect(spec.args.safeParse({ ...args, [key]: value }).success).toBe(false);
        if (key.endsWith("Id")) for (const value of ["..", ".", "%2f", "%252f", "a/b", "a?b", "a#b", ""]) expect(spec.args.safeParse({ ...args, [key]: value }).success).toBe(false);
      }
    });
    it("endpoint, risk and retry match the qualified manifest", async () => {
      const spec = get();
      expect(spec.endpoint).toMatchObject({ method, scope, version: "2021-07-28", retry: risk === "R" ? "read" : "write" });
      expect(spec.endpoint.path.test(path)).toBe(true);
      expect(spec.endpoint.path.test(`${path}/extra`)).toBe(false);
      expect(spec.risk).toBe(risk);
      const { crm, calls } = fakeF5Provider();
      await exerciseF5(spec, crm, args, "full");
      expect(calls.at(-1)?.slice(0, 3)).toEqual([spec.id, method, path]);
    });
    it("receipt metadata contains only record ids and field names", () => {
      const spec = get();
      const input = { ...args, eventStartTime: "SENTINEL", status: "SENTINEL", extra: "SENTINEL" };
      expect(JSON.stringify([spec.fields(input), spec.recordRefs(input)])).not.toContain("SENTINEL");
      expect(spec.targets(args)).toBe(1);
    });
    it("R runs on read; changes require change; D requires full", async () => {
      const spec = get();
      for (const level of ["off", "read", "change", "full"] as const) {
        const { crm, calls } = fakeF5Provider();
        if (level === "off" || (risk !== "R" && level === "read") || (risk === "D" && level !== "full")) {
          await expect(exerciseF5(spec, crm, args, level)).rejects.toThrow("not_granted");
          expect(calls).toHaveLength(0);
        } else {
          const result = await exerciseF5(spec, crm, args, level);
          expect(result.result?.structuredContent?.outsideContent).toBe("highlevel-crm");
        }
      }
    });
    it("ownership refuses a foreign location before any nested mutation", async () => {
      const spec = get();
      const { crm, calls } = fakeF5Provider();
      await expect(exerciseF5(spec, crm, args, "full", "foreign_location")).rejects.toThrow(/HighLevel business connected here\./);
      expect(calls.filter((call) => call[1] !== "GET")).toHaveLength(0);
    });
    it("provider error text never appears in a receipt", async () => {
      const spec = get();
      const { crm } = fakeF5Provider();
      const result = await exerciseF5(spec, { request: async (...call) => {
        if (call[0] === spec.id) throw new HighLevelError("SENTINEL", { status: 422, providerDetail: "SENTINEL" });
        return crm.request(...call);
      } }, args, "full");
      expect(JSON.stringify(result.receipt ?? {})).not.toContain("SENTINEL");
      if (risk === "R") expect(result.receipt).toBeUndefined();
      else expect(result.receipt?.status).toBe(422);
    });
  });
}

it("auto.contactAndAutomationOwnershipBothRequired", async () => {
  const spec = automationsOperations.find((s) => s.id === "automations.workflow.addContact");
  expect(typeof spec?.ownership).toBe("function");
  for (const workflows of [[], [{ id: "workflow_1", locationId: "foreign" }], [{ id: "workflow_1" }], [{ id: "workflow_1", locationId: "location_1" }, { id: "workflow_1", locationId: "location_1" }]]) {
    const { crm, calls } = fakeF5Provider(automationRoutes.map((route) => route.operation === "automations.workflows.list" ? { ...route, value: { workflows } } : route));
    await expect(exerciseF5(spec!, crm, { contactId: "contact_1", workflowId: "workflow_1" }, "full")).rejects.toThrow("Choose a workflow or campaign from the HighLevel business connected here.");
    expect(calls.every((call) => call[1] === "GET")).toBe(true);
  }
});

it("auto.workflowBodyAndReservedCampaignPaths", async () => {
  const spec = automationsOperations.find((s) => s.id === "automations.workflow.addContact");
  expect(typeof (spec?.risk === "R" ? spec.prepareRead : spec?.prepare)).toBe("function");
  const { crm, calls } = fakeF5Provider();
  await exerciseF5(spec!, crm, cases[2][2], "change");
  expect(calls.at(-1)?.[3]).toEqual({ eventStartTime: "2026-11-10T12:00:00Z" });
  for (const verb of ["campaign.addContact", "campaign.removeContact"]) {
    const campaign = automationsOperations.find((s) => s.id === `automations.${verb}`)!;
    for (const campaignId of ["removeAll", "remove-all", "%72emoveAll"]) await expect(exerciseF5(campaign, fakeF5Provider().crm, { contactId: "contact_1", campaignId }, "full")).rejects.toThrow();
  }
});

it("auto.failureAndUnknownOutcomesNeverRetryOrClaimApplied", async () => {
  for (const spec of automationsOperations.filter((s) => s.risk !== "R")) {
    const args = cases.find(([verb]) => spec.id === `automations.${verb}`)![2];
    for (const [value, outcome] of [[{ succeeded: false }, "not_applied"], [{}, "outcome_unknown"], [{ succeeded: "true" }, "outcome_unknown"]] as const) {
      const fixture = fakeF5Provider();
      let sends = 0;
      const result = await exerciseF5(spec, { request: async (...call) => {
        if (call[0] === spec.id) { sends++; return value; }
        return fixture.crm.request(...call);
      } }, args, "full");
      expect(sends).toBe(1);
      expect(result.receipt?.outcome).toBe(outcome);
    }
    const result = await exerciseF5(spec, fakeF5Provider(automationRoutes.map(route => ({ ...route, value: route.operation === spec.id ? { succeded: true, message: "SENTINEL" } : route.value }))).crm, args, "full");
    expect(result.receipt?.outcome).toBe("applied");
    expect(() => spec.project({ succeeded: true })).toThrow();
  }
});

import { automationsRoutes } from "../fake/automations.ts";
it("auto.fakeRoutesImplementTheFrozenHandlerInterface", async () => {
  for (const route of automationsRoutes) expect(await route.handle()).toEqual(route.value);
});


describe("F5 complete reads or explicit refusal", () => {
  for (const kind of ["workflows", "campaigns"] as const) {
    const project = (value: unknown) => automationsOperations.find(s => s.id === `automations.${kind}.list`)!.project(value);
    it(`${kind} refuses row 51 instead of hiding it`, () => {
      expect(() => project({ [kind]: Array.from({ length: 51 }, (_, i) => ({ id: `id_${i}` })) })).toThrow(/too large/i);
    });
    it(`${kind} preserves long values and final records`, () => {
      const rows = Array.from({ length: 50 }, (_, i) => ({ id: `id_${i}`, name: i === 49 ? "x".repeat(5000) : "ok" }));
      expect(project({ [kind]: rows })).toEqual({ [kind]: rows });
    });
    it(`${kind} refuses an exhausted scalar budget`, () => {
      expect(() => project({ [kind]: [{ id: "first", name: "x".repeat(40001) }, { id: "last" }] })).toThrow(/too large/i);
    });
  }
});

it("F5 final byte fence refuses the whole result without dropping rows", () => {
  const value = { workflows: [{ name: "x".repeat(65_536) }, { id: "last" }] };
  expect(() => f5BoundProjection(value, "workflows")).toThrow(/too large/i);
  expect(value.workflows).toHaveLength(2);
  const accepted = { workflows: [{ id: "first" }, { id: "last" }] };
  expect(f5BoundProjection(accepted, "workflows")).toEqual(accepted);
});
