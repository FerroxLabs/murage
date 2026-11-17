// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup as render } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PublicProviderConnection } from "../../shared/provider-connections.ts";
import { orderModels } from "../../shared/model-order.ts";
import { preloadModelMetadata } from "../lib/model-metadata.ts";
import { pickerKey, pickerModels, type PickerEngine } from "../lib/provider-model-picker.ts";
import { orderedPickerModels } from "../lib/provider-model-picker-dialog.ts";
import { ModelPickerDialog, type ModelPickerDialogProps } from "./ModelPickerDialog";
import { ModelCatalogRows } from "./ModelsSettings";
import { ServerCard } from "./LocalModelsSettings";
import { ImageSettingsView, type ImageModel } from "./ImageSettings";
import { EngineSetup } from "./EngineSetup";
import { LimitBackupRow } from "./ThreadFollowControls";
import type { Bot, InstanceInfo } from "../state/store";

const fixture = vi.hoisted(() => ({ state: { bots: [], instances: [] as unknown[], engineNote: "", localOnlyEngines: [] }, dispatch: vi.fn() }));
vi.mock("@/state/store", () => ({ useStore: () => fixture, api: vi.fn(async () => ({ engines: [], connections: [] })) }));
beforeAll(async () => {
  Object.defineProperty(window, "muragebox", { configurable: true, value: { platform: "linux" } });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  await preloadModelMetadata();
});
afterAll(() => { Reflect.deleteProperty(window, "muragebox"); vi.unstubAllGlobals(); });
const options = [
  { id: "claude-opus-5", label: "Claude Opus 5", pricing: { outputPerMillion: 25, source: "fixture", updatedAt: 1 } },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 (latest)", pricing: { outputPerMillion: 5, source: "fixture", updatedAt: 1 } },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", pricing: { outputPerMillion: 25, source: "fixture", updatedAt: 1 } },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", pricing: { outputPerMillion: 0.5, source: "fixture", updatedAt: 1 } },
];
const doc = (markup: string) => { const container = document.createElement("div"); container.innerHTML = markup; return container; };
const engine = { instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", snapshot: { state: "available", authenticated: true }, models: { default: "claude-opus-5", options } } as PickerEngine;

function pickerProps(contained: boolean): ModelPickerDialogProps {
  const rows = pickerModels(engine, []);
  return { bot: { id: "fixture", modelSelection: { instanceId: "claude", model: "claude-opus-5" } }, engine, active: engine,
      root: { current: null }, contained, rows, query: "", limit: 100, connections: [], error: "", fleetError: "", refreshing: false,
      prefs: { favorites: [], recent: [] }, selectedKey: pickerKey({ instanceId: "claude", model: "claude-opus-5" }), selectedLabel: "Claude Opus 5",
      setQuery: vi.fn(), setLimit: vi.fn(), setEngineId: vi.fn(), refresh: vi.fn(), save: vi.fn(), pick: vi.fn(), manage: vi.fn(), manageLocal: vi.fn(), openOwnAccount: vi.fn(),
    } as unknown as ModelPickerDialogProps;

}

describe("real model surfaces use the shared order", () => {
  it("keeps every ordering label in one English inventory", () => {
    const inventory = readFileSync("docs/verification/model-order.md", "utf8");
    expect(inventory).toContain("| Older versions | ModelPickerDialog, ModelsSettings, OrderedModelOptions |");
    expect(inventory).toContain("| Current model: {model} | ThreadFollowControls |");
    expect(inventory).toContain("| base · {model} |");
    expect(inventory).toContain("| direct · {model} |");
  });
  it.each([false, true])("desktop/web and phone picker (contained=%s), including the older divider and selected row", contained => {
    const props = pickerProps(contained);
    const expected = orderModels(props.rows.map(row => ({ ...row, id: row.selection.model })));
    const document = doc(render(h(ModelPickerDialog, props)));
    expect([...document.querySelectorAll("[data-model-choice] span.truncate")].map(node => node.textContent)).toEqual(expected.map(row => row.label));
    expect(document.querySelector("[data-model-older-divider]")?.textContent).toBe("Older versions");
    expect(document.querySelector('[data-model-choice][aria-pressed="true"]')?.textContent).toContain("Claude Opus 5");
  });
  it("renders the complete Claude screenshot with exactly one quiet older divider", () => {
    const screenshot = [
      ["claude-fable-5", "Claude Fable 5", 50], ["claude-fable-5-1", "Claude Fable 5.1", 50], ["claude-fable-5-2", "Claude Fable 5.2", 50],
      ["claude-opus-5", "Claude Opus 5", 25], ["claude-opus-5-5", "Claude Opus 5.5", 25],
      ["claude-sonnet-5", "Claude Sonnet 5", 15], ["claude-sonnet-5-5", "Claude Sonnet 5.5", 15],
      ["claude-haiku-4-5", "Claude Haiku 4.5 (latest)", 5], ["claude-haiku-5-5", "Claude Haiku 5.5", 0.5],
    ].map(([id, label, price]) => ({ id: String(id), label: String(label), pricing: { outputPerMillion: Number(price), source: "fixture", updatedAt: 1 } }));
    const props = pickerProps(true);
    props.rows = pickerModels({ ...engine, models: { ...engine.models, options: screenshot } }, []);
    const expected = orderModels(props.rows.map(row => ({ ...row, id: row.selection.model })));
    const document = doc(render(h(ModelPickerDialog, props)));
    expect([...document.querySelectorAll("[data-model-choice] span.truncate")].map(node => node.textContent)).toEqual(expected.map(row => row.label));
    expect(document.querySelectorAll("[data-model-older-divider]")).toHaveLength(1);
    expect(document.querySelector("[data-model-older-divider]")!.nextElementSibling!.textContent).toContain("Claude Fable 5.1");
    expect(document.textContent).not.toContain("(latest)");
  });
  it.each([false, true])("arrow keys follow all visible choices at contained=%s", async contained => {
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container), props = pickerProps(contained);
    try {
      await act(async () => { root.render(h(ModelPickerDialog, props)); });
      const buttons = [...container.querySelectorAll<HTMLButtonElement>("[data-model-choice]")];
      expect(buttons.length).toBeGreaterThan(3);
      buttons[0]!.focus();
      for (const button of buttons.slice(1)) {
        await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
        expect(document.activeElement).toBe(button);
      }
      await act(async () => { buttons.at(-1)!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
      expect(document.activeElement).toBe(buttons[0]);
      expect(container.querySelector("[data-model-older-divider]")?.closest("button")).toBeNull();
    } finally { await act(async () => { root.unmount(); }); container.remove(); }
  });
  it("native engine price metadata reaches the real picker without being replaced by a snapshot", () => {
    const rows = pickerModels(engine, []);
    expect(rows.find(row => row.selection.model === options[0]!.id)!.pricing).toEqual(options[0]!.pricing);
  });
  it("Flux's bare and pinned ids retain distinct labels, while repeated ids keep the selected route", () => {
    const pinned = "flux-pinned-claude-fable-5-1", bare = "claude-fable-5-1";
    const rows = [pinned, bare, pinned].map((model, index) => ({ key: `route-${index}`, selection: { instanceId: "e", connectionId: "flux-account", model }, label: "Claude Fable 5.1", group: "Flux Router", provider: "flux" }));
    const ordered = orderedPickerModels(rows, "", [], [], "route-2");
    expect(ordered.map(row => row.selection.model)).toEqual([pinned, bare]);
    // MAIN RULING 1114-MODEL-ORDER: put concise route distinctions before the model name.
    expect(ordered.map(row => row.label)).toEqual(["flux pinned · Claude Fable 5.1", "direct · Claude Fable 5.1"]);
    expect(ordered[0]!.key).toBe("route-2");
  });
  it("the actual metadata pipeline reproduces and resolves the duplicate Flux Fable label", () => {
    const bare = "claude-fable-5-1", pinned = `flux-pinned-${bare}`;
    const connection: PublicProviderConnection = { id: "flux-fixture", preset: "flux", label: "Flux Router", baseUrl: "", protocol: "openai", enabled: true, configured: true, revision: "fixture", state: "catalog-ready",
      catalog: { connectionId: "flux-fixture", stale: false, assurance: "catalog-only", models: [bare, pinned].map(id => ({ id, label: id, connectionId: "flux-fixture", preset: "flux", enabled: true, chatEligible: true, capabilities: { chat: true }, outputModalities: ["text"] })) } };
    const rows = pickerModels({ ...engine, models: { default: pinned, options: [{ id: pinned, label: pinned }] } }, [connection]);
    // Native pinned id, provider bare id and provider pinned id all resolve to
    // the same upstream metadata name. Connection-qualified keys hid this cause.
    expect(rows.map(row => row.label)).toEqual(["Claude Fable 5.1", "Claude Fable 5.1", "Claude Fable 5.1"]);
    const selectedKey = pickerKey({ instanceId: "claude", connectionId: "flux-fixture", model: pinned });
    const ordered = orderedPickerModels(rows, "", [], [], selectedKey);
    const expected = orderModels(rows.map(row => ({ id: row.selection.model, label: row.label, pricing: row.pricing, selected: row.key === selectedKey })));
    expect(ordered.map(row => row.label)).toEqual(expected.map(row => row.label));
    expect(ordered).toHaveLength(2);
    expect(ordered.find(row => row.selection.model === pinned)!.key).toBe(selectedKey);
  });
  it.each([false, true])("both billing accounts remain selectable in the rendered picker (favorites=%s)", async starred => {
    const props = pickerProps(true), container = document.createElement("div");
    props.rows = ["personal", "work"].map(account => {
      const selection = { instanceId: "claude", connectionId: account, model: "flux-pinned-claude-fable-5-1" };
      return { key: pickerKey(selection), selection, label: "Claude Fable 5.1", group: account, provider: "flux" };
    });
    props.selectedKey = props.rows[0]!.key;
    props.prefs.favorites = starred ? props.rows.map(row => row.key) : [];
    const root = createRoot(container);
    try {
      await act(async () => { root.render(h(ModelPickerDialog, props)); });
      const buttons = [...container.querySelectorAll<HTMLButtonElement>("[data-model-choice][aria-pressed]")];
      expect(buttons).toHaveLength(2);
      expect(buttons.map(button => button.querySelector("span.truncate")!.textContent)).toEqual(["personal · Claude Fable 5.1", "work · Claude Fable 5.1"]);
      for (const [index, button] of buttons.entries()) {
        await act(async () => { button.click(); });
        expect(props.pick).toHaveBeenLastCalledWith(props.rows[index]!.selection);
      }
    } finally { await act(async () => { root.unmount(); }); }
  });
  it("EngineSetup keeps the default recommendation with the shared list's corrected freshness label", () => {
    const instance = { ...engine, snapshot: { state: "unavailable" }, models: { default: "claude-haiku-4-5", options }, install: { native: true, platform: "linux" } } as InstanceInfo;
    const markup = render(h(EngineSetup, { instance }));
    const recommended = orderModels(options).find(row => row.id === instance.models.default)!;
    expect(markup).toContain(`Recommended for new choices: ${recommended.label}`);
    expect(markup).not.toContain("(latest)");
  });
  it("corrects Flux pinned duplicates at the actual picker boundary", () => {
    const rows = ["flux-pinned-claude-fable-5-1", "flux-pinned-claude-fable-5-1-thinking", "flux-pinned-claude-fable-5-1"].map(model => ({ key: pickerKey({ instanceId: "e", model }), selection: { instanceId: "e", model }, label: "Claude Fable 5.1", group: "Engine models", provider: "Flux" }));
    const ordered = orderedPickerModels(rows, "", [], []);
    expect(ordered).toHaveLength(2);
    expect(new Set(ordered.map(row => row.label)).size).toBe(2);
  });
  it("Settings provider and Flux catalog rows render the shared order", () => {
    const document = doc(render(h(ModelCatalogRows, { models: options })));
    expect([...document.querySelectorAll("[data-model-id]")].map(node => node.getAttribute("data-model-id"))).toEqual(orderModels(options).map(row => row.id));
    expect(document.querySelector("[data-model-older-divider]")?.textContent).toBe("Older versions");
  });
  it("the backup model select renders the shared order without changing its saved model", () => {
    fixture.state.instances = [engine];
    const bot = { id: "fixture", modelSelection: { instanceId: "other", model: "other" }, limitBackup: { selection: { instanceId: "claude", model: "claude-opus-5" }, routines: true, at: 1 } } as Bot;
    const document = doc(render(h(LimitBackupRow, { bot })));
    const select = document.querySelector('select[aria-label="Model for Claude"]')!;
    expect([...select.querySelectorAll("option")].map(node => node.value)).toEqual(orderModels(options).map(row => row.id));
    expect(select.querySelector("option[selected]")?.getAttribute("value")).toBe("claude-opus-5");
  });
  it("local Settings model cards keep vendor order and remove duplicate ids", () => {
    const models = ["local::custom-z", "local::custom-a", "local::custom-z"].map(id => ({ id, model: id.split("::")[1]!, loaded: true, engines: [] }));
    const server = { id: "local", name: "Local", label: "Local models", kind: "llamacpp", address: "http://127.0.0.1:9999/v1", source: "added", editable: true, hasKey: false, status: "running", checkedAt: 1, models } as Parameters<typeof ServerCard>[0]["server"];
    const document = doc(render(h(ServerCard, { server, now: 1, onChanged: vi.fn(), onTested: vi.fn() })));
    expect([...document.querySelectorAll("[data-local-model-id]")].map(node => node.getAttribute("data-local-model-id"))).toEqual(orderModels(models.map(model => ({ ...model, label: model.model }))).map(row => row.id));
  });
  it("image Settings model options use the same list-only rule", () => {
    const models = ["image-2", "image-1", "image-2"].map(id => ({ id, label: id, generate: true, edit: false, qualities: [], sizes: [], availability: "catalog-listed" })) as ImageModel[];
    const document = doc(render(h(ImageSettingsView, { snapshot: { enabled: true, connections: [{ id: "c", label: "Images", provider: "openai" }], selected: { connectionId: "c", model: "image-1" }, catalog: { connectionId: "c", provider: "openai", defaultModel: "image-2", models } }, busy: null, error: "", notice: "", onChange: vi.fn(), onRefresh: vi.fn(), showLibrary: false })));
    const values = [...document.querySelectorAll('select[aria-label="Image model"] option')].map(node => node.getAttribute("value")).filter(Boolean);
    expect(values).toEqual(orderModels(models).map(row => row.id));
  });
});
