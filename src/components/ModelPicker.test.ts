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
import { describe, expect, it, vi } from "vitest";
import type { PublicProviderConnection } from "../../shared/provider-connections";
import { ModelPickerNotices, refreshModelPickerCatalog } from "./ModelPicker";

const connection = (id: string, catalog: Partial<PublicProviderConnection["catalog"]> = {}): PublicProviderConnection => ({
  id, label: id, enabled: true, catalog: { models: [], ...catalog },
} as unknown as PublicProviderConnection);
const fleetLine = "The engine list could not refresh; the engines shown are the last known ones. Use Refresh models to probe them again.";
const partialLine = "Some model lists could not refresh. Their last saved models are preserved; check Models settings for details.";

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
