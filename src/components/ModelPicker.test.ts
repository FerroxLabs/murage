// Opening the model picker reads two sources: the provider connections (the
// catalog its rows are built from) and the engine fleet (the store's
// refreshInstances, which rejects when GET /api/instances fails — FOLLOW4).
// One Promise.all in one try/catch used to drop a catalog that had already
// answered and replace the menu with the probe's raw error, although the
// connections were there to list. Each source now fails on its own: the
// catalog draws whenever it answered, a catalog failure is the alert, and a
// fleet failure is a secondary line, never the catalog's replacement (FOLLOW6,
// FOLLOW4 verifier). The renderer suite has no DOM, so the outcome function is
// driven directly and the notices are rendered to static markup.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { PublicProviderConnection } from "../../shared/provider-connections";
import { ModelPickerBusyNotice, ModelPickerNotices, isThreadModelMutationLocked, modelPickerViewportOffset, refreshModelPickerCatalog } from "./ModelPicker";

const connection = (id: string, catalog: Partial<PublicProviderConnection["catalog"]> = {}): PublicProviderConnection => ({
  id, label: id, enabled: true, catalog: { models: [], ...catalog },
} as unknown as PublicProviderConnection);
// The line points at the focus re-probe (the store re-probes the fleet on
// window focus), not at Refresh models: that button also re-POSTs every
// enabled provider's catalog refresh, which is far more than a fleet probe
// (FOLLOW7; the wording claudeAccounts.fleetRefreshError already uses).
const fleetLine = "The engine list could not refresh; the engines shown are the last known ones. Switch to another window and back to probe the engines again.";
const partialLine = "Some model lists could not refresh. Their last saved models are preserved; check Models settings for details.";
const pickerSource = readFileSync(fileURLToPath(new URL("./ModelPicker.tsx", import.meta.url)), "utf8");

describe("model picker viewport placement", () => {
  it.each([
    { viewport:390, width:366, anchor:150, left:12 },
    { viewport:820, width:390, anchor:590, left:200 },
    { viewport:1440, width:390, anchor:1440, left:1038 },
    { viewport:390, width:366, anchor:390, left:12 },
  ])("keeps the entire menu inside both gutters at $viewport", ({viewport,width,anchor,left}) => {
    const placed=anchor-width+modelPickerViewportOffset(anchor,width,viewport);
    expect(placed).toBe(left);
    expect(placed).toBeGreaterThanOrEqual(12);
    expect(placed+width).toBeLessThanOrEqual(viewport-12);
  });

  it("recalculates for a resized viewport and relocated header anchor", () => {
    expect(modelPickerViewportOffset(900,390,1440)).toBe(0);
    expect(modelPickerViewportOffset(150,366,390)).toBe(228);
  });
});

describe("refreshModelPickerCatalog", () => {
  it("draws the catalog and no notice when both sources answer", async () => {
    const list = [connection("flux"), connection("openai")];
    const outcome = await refreshModelPickerCatalog({ connections: async () => ({ connections: list }), fleet: async () => {}, force: false });
    expect(outcome).toEqual({ connections: list, error: "", fleetError: "" });
  });

  it("keeps the catalog that answered and reports the fleet probe on its own line when only GET /api/instances failed", async () => {
    const list = [connection("flux")];
    const fleet = vi.fn(async () => { throw new Error("Failed to fetch"); });
    const outcome = await refreshModelPickerCatalog({ connections: async () => ({ connections: list }), fleet, force: false });
    expect(fleet).toHaveBeenCalledTimes(1);
    expect(outcome.connections).toBe(list);
    expect(outcome.error).toBe("");
    expect(outcome.fleetError).toBe(fleetLine);
  });

  it("keeps the drawn list and reports the catalog's own failure as the alert when the connections did not answer", async () => {
    const outcome = await refreshModelPickerCatalog({ connections: async () => { throw new Error("HTTP 502"); }, fleet: async () => {}, force: false });
    expect(outcome.connections).toBeUndefined();
    expect(outcome.error).toBe("HTTP 502");
    expect(outcome.fleetError).toBe("");
    const bare = await refreshModelPickerCatalog({ connections: async () => { throw "offline"; }, fleet: async () => {}, force: false });
    expect(bare.error).toBe("Model catalog unavailable");
  });

  it("reports both when both failed, each under its own name", async () => {
    const outcome = await refreshModelPickerCatalog({ connections: async () => { throw new Error("HTTP 502"); }, fleet: async () => { throw new Error("Failed to fetch"); }, force: true });
    expect(outcome).toEqual({ error: "HTTP 502", fleetError: fleetLine });
  });

  it("names a forced refresh that left some provider catalogs stale, alongside a fleet failure", async () => {
    const list = [connection("flux", { error: { code: "rate-limited", message: "HTTP 429" } }), connection("openai")];
    const partial = await refreshModelPickerCatalog({ connections: async () => ({ connections: list }), fleet: async () => { throw new Error("Failed to fetch"); }, force: true });
    expect(partial).toEqual({ connections: list, error: partialLine, fleetError: fleetLine });
    // A disabled connection's stale catalog is not the user's problem, and an
    // un-forced open never reports staleness: the last saved models are what
    // it shows by design.
    const disabled = [{ ...connection("flux", { error: { code: "rate-limited", message: "HTTP 429" } }), enabled: false }];
    expect((await refreshModelPickerCatalog({ connections: async () => ({ connections: disabled }), fleet: async () => {}, force: true })).error).toBe("");
    expect((await refreshModelPickerCatalog({ connections: async () => ({ connections: list }), fleet: async () => {}, force: false })).error).toBe("");
  });

  it("treats a body without a connections list as an empty catalog, not a failure", async () => {
    const outcome = await refreshModelPickerCatalog({ connections: async () => ({}), fleet: async () => {}, force: true });
    expect(outcome).toEqual({ connections: [], error: "", fleetError: "" });
  });
});

describe("ModelPickerNotices", () => {
  it("renders nothing when there is nothing to say", () => {
    expect(renderToStaticMarkup(createElement(ModelPickerNotices, { error: "", fleetError: "" }))).toBe("");
  });

  it("renders the fleet failure as a status line, not as the catalog's alert", () => {
    const markup = renderToStaticMarkup(createElement(ModelPickerNotices, { error: "", fleetError: fleetLine }));
    expect(markup).not.toContain('role="alert"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain("data-model-picker-fleet-error");
    expect(markup).toContain(fleetLine);
  });

  it("renders both lines apart, the catalog's alert first", () => {
    const markup = renderToStaticMarkup(createElement(ModelPickerNotices, { error: "HTTP 502", fleetError: fleetLine }));
    const alert = markup.indexOf('role="alert"'), status = markup.indexOf('role="status"');
    expect(alert).toBeGreaterThanOrEqual(0);
    expect(status).toBeGreaterThan(alert);
    expect(markup).toContain("HTTP 502");
    expect(markup).toContain(fleetLine);
  });
});

describe("B14 busy-thread inspection", () => {
  it("allows inspection but fences every thread model mutation while the turn is busy", () => {
    expect(isThreadModelMutationLocked("thread-1", true)).toBe(true);
    expect(isThreadModelMutationLocked("thread-1", false)).toBe(false);
    expect(isThreadModelMutationLocked(undefined, true)).toBe(false);
  });

  it("renders the wait-or-stop explanation only while the mutation fence is active", () => {
    expect(renderToStaticMarkup(createElement(ModelPickerBusyNotice, { locked: false }))).toBe("");
    const markup = renderToStaticMarkup(createElement(ModelPickerBusyNotice, { locked: true }));
    expect(markup).toContain('role="status"');
    expect(markup).toContain("inspect models");
    expect(markup).toContain("wait for it to finish or stop this turn");
  });

  it("keeps opening available while guarding both model and effort callbacks", () => {
    expect(pickerSource).not.toContain("if(threadId&&bot.busy)return;const show=");
    expect(pickerSource).toMatch(/const pick=.*if\(threadModelMutationLocked\)return/);
    expect(pickerSource).toMatch(/data-model-choice disabled=\{threadModelMutationLocked\}/);
    expect(pickerSource).toMatch(/Thread effort<select[\s\S]{0,500}disabled=\{threadModelMutationLocked\}[\s\S]{0,500}if\(threadModelMutationLocked\)return/);
  });
});
