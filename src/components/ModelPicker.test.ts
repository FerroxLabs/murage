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
import { EngineOptionRows, PickerPriceNote, PickerRowMeta, pickerRowTitle, ModelPickerBusyNotice, ModelPickerNotices, isThreadModelMutationLocked, modelPickerMaxHeight, modelPickerViewportOffset, refreshModelPickerCatalog } from "./ModelPicker";
import { ENGINE_DISABLED_SUFFIX, PRICE_UNKNOWN, engineMenuFamilies, priceBandNote, type PickerEngine, type PickerModel } from "@/lib/provider-model-picker";

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

// ── The Engine control's rows ─────────────────────────────────────────────
// Two defects in one native <select> (Sean's screenshot, 2026-09-18): every
// family was an <optgroup label={primary.displayName}> wrapping options that
// carried that same displayName, so the normal one-connection-per-driver case
// printed each engine's name twice; and an <option> cannot draw an icon, so
// the ProviderMark the picker's own trigger already showed was missing from
// the list it opened. The rows render without a DOM, so the markup is the
// assertion.
const fleet = (instanceId: string, driverKind: string, displayName: string, enabled = true): PickerEngine =>
  ({ instanceId, driverKind, displayName, enabled, snapshot: { state: "available", authenticated: true }, models: { default: "m", options: [] } });
const rowsMarkup = (instances: PickerEngine[], selectedId?: string) =>
  renderToStaticMarkup(createElement(EngineOptionRows, { id: "engine-bot-list", labelId: "engine-bot-label", families: engineMenuFamilies(instances), selectedId, activeIndex: 0, onPick: () => {} }));

describe("Engine control rows", () => {
  it("draws one row and no header for a family of one, so no name is printed twice", () => {
    const markup = rowsMarkup([fleet("claude", "claudeAgent", "Claude"), fleet("codex", "codex", "Codex")]);
    expect(markup).not.toContain("data-engine-family-header");
    expect(markup.match(/data-engine-choice/g)).toHaveLength(2);
    // The list as a person reads it: each engine named once, not "Claude /
    // Claude / Codex / Codex" (tags stripped, so the truncation title on each
    // row does not count as something drawn).
    const drawn = markup.replace(/<[^>]*>/g, "|");
    expect(drawn.match(/Claude/g)).toHaveLength(1);
    expect(drawn.match(/Codex/g)).toHaveLength(1);
  });

  it("draws the header for a family of more than one, where it is the only thing that groups them", () => {
    const markup = rowsMarkup([fleet("claude", "claudeAgent", "Claude"), fleet("claude-work", "claudeAgent", "Claude work"), fleet("codex", "codex", "Codex")]);
    expect(markup.match(/data-engine-family-header/g)).toHaveLength(1);
    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-labelledby="engine-bot-list-claudeAgent"');
    expect(markup.match(/data-engine-choice/g)).toHaveLength(3);
  });

  it("gives every row its engine's own icon, the mark the trigger button already shows", () => {
    const instances = [fleet("claude", "claudeAgent", "Claude"), fleet("codex", "codex", "Codex"), fleet("droid", "droidAgent", "Droid")];
    const markup = rowsMarkup(instances);
    expect(markup.match(/data-engine-icon/g)).toHaveLength(instances.length);
    // An icon, not a placeholder gap: each marked span carries a real drawing.
    for (const span of markup.split("data-engine-icon").slice(1)) expect(span.slice(0, 200)).toContain("<svg");
    expect(markup.match(/<svg/g)?.length).toBeGreaterThanOrEqual(instances.length);
  });

  it("keeps the listbox semantics the <select> gave for free, and marks the current choice", () => {
    const markup = rowsMarkup([fleet("claude", "claudeAgent", "Claude"), fleet("codex", "codex", "Codex")], "codex");
    expect(markup).toContain('role="listbox"');
    expect(markup).toContain('aria-labelledby="engine-bot-label"');
    expect(markup.match(/role="option"/g)).toHaveLength(2);
    expect(markup.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(markup).toMatch(/aria-selected="true"[^>]*>(?:(?!<\/button>)[\s\S])*Codex/);
    // Roving tabindex: one row in the tab order, the rest reached by arrows.
    expect(markup.match(/tabindex="0"/g)).toHaveLength(1);
    expect(markup.match(/tabindex="-1"/g)).toHaveLength(1);
    expect(markup).toContain("focus-visible:ring-2 focus-visible:ring-accent");
  });

  it("keeps the disabled suffix visible on the row, not only in a title", () => {
    const markup = rowsMarkup([fleet("codex", "codex", "Codex", false)]);
    expect(markup).toContain(`${ENGINE_DISABLED_SUFFIX.replace(/ /g, " ")}`);
    expect(markup).toContain("Disabled");
    expect(markup.replace(/<[^>]*>/g, "")).toContain("Codex · Disabled");
  });

  it("names the control through its visible label and answers for the empty state in the source", () => {
    // The old control was <select aria-label="Engine"> with a placeholder
    // <option value="">Choose an engine</option>. Both survive: the combobox
    // takes its name from the same visible "Engine" label, and the placeholder
    // is what the combobox reads when nothing is chosen.
    expect(pickerSource).toMatch(/role="combobox" aria-labelledby=\{labelId\}/);
    expect(pickerSource).toMatch(/placeholder=\{CHOOSE_ENGINE_OPTION\}/);
    expect(pickerSource).toMatch(/onPick=\{instanceId=>\{setEngineId\(instanceId\);setLimit\(30\);\}\}/);
    expect(pickerSource).not.toContain("<optgroup");
  });
});

// ── The model row's meta line and hover ───────────────────────────────────
// The row is coarse on purpose — a band, not a figure — so the hover is what
// keeps it honest. Three row shapes, three things the hover has to say.
const priced = (input: number, output: number) => ({ inputPerMillion: input, outputPerMillion: output, source: "https://models.dev/api.json", updatedAt: Date.parse("2026-09-18T00:00:00Z") });
const modelRow = (over: Partial<PickerModel> & { label: string }): PickerModel =>
  ({ key: over.label, selection: { instanceId: "e", model: over.label }, group: "Flux Router", provider: "flux", ...over } as PickerModel);
const meta = (row: PickerModel) => renderToStaticMarkup(createElement(PickerRowMeta, { row }));

describe("pickerRowTitle", () => {
  it("keeps every exact figure a priced row has, and adds the same rate restated", () => {
    const title = pickerRowTitle(modelRow({ label: "Claude Sonnet 5", pricing: priced(2, 10) }));
    expect(title).toContain("Input $2/M");
    expect(title).toContain("Output $10/M");
    expect(title).toContain("$1 ≈ 100K output tokens");
    expect(title).toContain("https://models.dev/api.json");
    expect(title).toContain(new Date(Date.parse("2026-09-18T00:00:00Z")).toLocaleDateString());
  });

  it("says what a route actually is instead of quoting a rate it does not have", () => {
    // The row reads "$–$$$". The old hover would have said "Price unavailable"
    // directly under it — a price range over a claim of no price.
    const title = pickerRowTitle(modelRow({ label: "Flux Auto", selection: { instanceId: "e", model: "flux-auto" } }));
    expect(title).not.toBe(PRICE_UNKNOWN);
    expect(title).not.toContain(PRICE_UNKNOWN);
    expect(title).toContain("$–$$$");
    expect(title).toMatch(/picks a model for each turn/);
    expect(title).toMatch(/depends on which one runs/);
    // No invented figure: the only "$" in it are the band symbols.
    expect(title).not.toMatch(/\$\d/);
    expect(title).not.toMatch(/\/M\b/);
  });

  it("says so plainly when there is no resolvable rate", () => {
    expect(pickerRowTitle(modelRow({ label: "Mystery model", selection: { instanceId: "e", model: "mystery-1" } }))).toBe(PRICE_UNKNOWN);
  });
});

describe("PickerRowMeta", () => {
  it("draws a five-tier band, and marks an unresolved price as the absence it is", () => {
    const band = meta(modelRow({ label: "Opus", pricing: priced(15, 25) }));
    expect(band).toContain("$$$$");
    expect(band).toContain("data-price-cell");
    expect(band).toContain('class="font-medium"');
    expect(band).not.toContain("data-price-unknown");

    const unknown = meta(modelRow({ label: "Mystery", selection: { instanceId: "e", model: "mystery-1" } }));
    expect(unknown).toContain(PRICE_UNKNOWN);
    expect(unknown).toContain("data-price-unknown");
    expect(unknown).toContain('class="italic"');
    // Never a symbol, so it cannot be read as the cheap end of the scale.
    expect(unknown.replace(/<[^>]*>/g, "|")).not.toMatch(/\$/);
  });

  it("draws a route's span rather than one band", () => {
    expect(meta(modelRow({ label: "Flux Auto", selection: { instanceId: "e", model: "flux-auto" } }))).toContain("$–$$$");
  });

  it("marks vision and tools with icons, not words", () => {
    const both = meta(modelRow({ label: "Sonnet", pricing: priced(2, 10), capabilities: { vision: true, tools: true } }));
    expect(both).toContain('data-capability="vision"');
    expect(both).toContain('data-capability="tools"');
    expect(both).toContain('aria-label="Reads images"');
    expect(both).toContain('aria-label="Uses tools"');
    expect(both).toContain('title="Reads images"');
    expect(both.match(/<svg/g)).toHaveLength(2);
    // Icons, so the drawn text gains nothing: the line is already five cells
    // at 11px in a 390px menu.
    expect(both.replace(/<[^>]*>/g, "|")).not.toMatch(/vision|tools|Reads images|Uses tools/);
  });

  it("stays silent about a capability nobody stated — absent is not 'cannot'", () => {
    const quiet = meta(modelRow({ label: "Mystery", selection: { instanceId: "e", model: "mystery-1" } }));
    expect(quiet).not.toContain("data-capability");
    expect(quiet).not.toContain("<svg");
    // Not even an empty slot: the parent is `gap-x-2`, so a childless wrapper
    // would still push 8px of nothing between the price and what follows.
    expect(quiet.match(/<span/g)).toHaveLength(2);
    const toolsOnly = meta(modelRow({ label: "Tools", pricing: priced(1, 2), capabilities: { tools: true } }));
    expect(toolsOnly).toContain('data-capability="tools"');
    expect(toolsOnly).not.toContain('data-capability="vision"');
    expect(toolsOnly.match(/<svg/g)).toHaveLength(1);
    // A stated false is still not a negative icon.
    const stated = meta(modelRow({ label: "NoVision", pricing: priced(1, 2), capabilities: { vision: false, tools: true } }));
    expect(stated).not.toContain('data-capability="vision"');
  });

  it("leaves a local row's own note and the stale marker where they were", () => {
    const local = meta(modelRow({ label: "Local", group: "Local models", localServer: "llama.cpp on seanbeast", stale: true }));
    expect(local).not.toContain("data-price-cell");
    expect(local).toContain("Cached catalog");
  });
});

describe("the price-band note", () => {
  it("is dated from the bundled snapshot, said once, and never per row", () => {
    expect(priceBandNote()).toMatch(/approximate, from published rates, \w+ \d{4}$/);
    expect(meta(modelRow({ label: "Opus", pricing: priced(15, 25) }))).not.toContain("approximate");
  });

  it("renders the dated line when there is a list to annotate, and nothing when there is not", () => {
    const shown = renderToStaticMarkup(createElement(PickerPriceNote, { shown: true }));
    expect(shown).toContain("data-price-band-note");
    expect(shown).toContain(priceBandNote());
    expect(shown).toMatch(/approximate, from published rates, \w+ \d{4}/);
    expect(renderToStaticMarkup(createElement(PickerPriceNote, { shown: false }))).toBe("");
  });

  it("sits outside the scrolling list, so it cannot scroll away", () => {
    // The list is `<div className="min-h-0 flex-1 overflow-y-auto p-2">…</div>`;
    // the note must come after its close and before the Manage footer.
    const list = pickerSource.indexOf('className="min-h-0 flex-1 overflow-y-auto p-2"');
    const note = pickerSource.indexOf("<PickerPriceNote ");
    const manage = pickerSource.indexOf("Manage models and providers");
    expect(list).toBeGreaterThanOrEqual(0);
    expect(note).toBeGreaterThan(list);
    expect(manage).toBeGreaterThan(note);
    expect(pickerSource.slice(list, note)).toContain("More models ·");
    expect(pickerSource).toContain("<PickerPriceNote shown={!!ordered.length}/>");
  });
});

// Customer journey: every Flux tier row read "Engine models" under the "Flux
// Router" heading, the empty "No local server detected" row sat above the
// tiers, and on a phone the menu stopped at 70% of the screen with ~3 rows.
describe("the list reads in the owner's order, with true labels", () => {
  it("never labels a Flux tier or pinned route as the engine's own model", () => {
    const tier = meta(modelRow({ label: "Flux Auto", group: "Engine models", provider: "Claude Code", selection: { instanceId: "e", model: "flux-auto" } }));
    expect(tier).not.toContain("Engine models");
    const pinned = meta(modelRow({ label: "Flux Opus", group: "Engine models", provider: "Claude Code", selection: { instanceId: "e", model: "flux-opus-5" } }));
    expect(pinned).not.toContain("Engine models");
    expect(pinned).toContain("Flux Router");
    // the engine's own model still says where it comes from
    expect(meta(modelRow({ label: "Sonnet", group: "Engine models", provider: "Claude Code", selection: { instanceId: "e", model: "claude-sonnet-5" } }))).toContain("Engine models");
  });

  it("draws the no-local-server hint after every model row, never above the Flux tiers", () => {
    const rows = pickerSource.indexOf("ordered.slice(0,limit).map(");
    const hint = pickerSource.indexOf("data-local-rail-empty");
    expect(rows).toBeGreaterThan(0);
    expect(hint).toBeGreaterThan(rows);
  });

  it("uses the height a phone has below the header instead of 70% of it", () => {
    // 390x844 phone, menu opening 110px down: everything but a 12px margin
    expect(modelPickerMaxHeight(110, 844, 390)).toBe(722);
    // desktop keeps its compact cap
    expect(modelPickerMaxHeight(60, 900, 1440)).toBe(560);
    // a short window still gets a usable list
    expect(modelPickerMaxHeight(400, 520, 390)).toBe(240);
  });
});
