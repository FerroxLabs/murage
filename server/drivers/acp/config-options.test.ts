import { removeTempDirSync } from "../../testing/cleanup.ts";
// Adapted from upstream 923be2380 for Murage ACP contracts.
import { describe, expect, it } from "vitest";
import { acpModelOption, acpVariantOption, offeredModels } from "./config-options.ts";

describe("ACP model and reasoning options", () => {
  it("preserves grouped model labels and providers and ignores duplicate or malformed IDs", () => {
    const result = { configOptions: [{ type: "select", id: "route", category: "model", currentValue: "zai/flash", options: [
      { name: "Z.ai", options: [{ value: "zai/flash", name: "GLM Flash" }, { value: "zai/max", name: "GLM" }] },
      { value: "zai/flash", name: "Duplicate" }, { value: "" }, null,
    ] }] };
    expect(acpModelOption(result)).toEqual({ configId: "route", currentValue: "zai/flash", options: [
      { id: "zai/flash", label: "GLM Flash", provider: "Z.ai" }, { id: "zai/max", label: "GLM", provider: "Z.ai" },
    ] });
    expect(offeredModels(result, "route")).toEqual(["zai/flash", "zai/max"]);
  });

  it("supports legacy model metadata without claiming a config setter", () => {
    expect(acpModelOption({ models: { currentModelId: "fast", availableModels: [
      { modelId: "fast", name: "Fast", provider: "local" }, { modelId: "deep" }, { modelId: "fast" }, {},
    ] } })).toEqual({ currentValue: "fast", options: [
      { id: "fast", label: "Fast", provider: "local" }, { id: "deep", label: "deep" },
    ] });
    expect(acpModelOption({})).toBeUndefined();
  });

  it.each(["effort", "reasoning_effort", "thought_level"])("preserves %s native values", (id) => {
    expect(acpVariantOption({ configOptions: [{ type: "select", id, currentValue: "enabled", options: [
      { value: "enabled", name: "Model default" }, { name: "Thinking", options: [{ value: "max", name: "Maximum" }] },
      { value: "disabled", name: "Off" },
    ] }] })).toEqual({ configId: id, currentValue: "enabled", options: [
      { id: "enabled", label: "Model default" }, { id: "max", label: "Maximum" }, { id: "disabled", label: "Off" },
    ] });
  });

  it("does not invent reasoning options for a model without them", () => {
    expect(acpVariantOption({ configOptions: [{ type: "select", id: "model", options: [{ value: "fast" }] }] })).toBeUndefined();
    expect(acpVariantOption({ configOptions: [{ type: "boolean", id: "effort", currentValue: true }] })).toBeUndefined();
  });
});

it('bounds native IDs, labels, counts and current values before publication', () => {
  const option = (options: unknown[], currentValue?: string) => acpVariantOption({ configOptions: [{ id: 'effort', type: 'select', options, currentValue }] });
  expect(option([{ value: 'x'.repeat(200), name: 'y'.repeat(256) }])?.options).toHaveLength(1);
  expect(option([{ value: 'x'.repeat(201) }, { value: 'ok', name: 'y'.repeat(257) }])?.options).toEqual([]);
  const choices = Array.from({ length: 128 }, (_, i) => ({ value: String(i) }));
  expect(option(choices)?.options).toHaveLength(128);
  expect(option([...choices, { value: 'overflow' }], 'overflow')).toMatchObject({ options: expect.any(Array) });
  expect(option([...choices, { value: 'overflow' }], 'overflow')?.options).toHaveLength(128);
  expect(option(choices, 'missing')?.currentValue).toBeUndefined();
});

it('removes an invalid startup catalog and accepts boundary choices', async () => {
  const { mkdtempSync, writeFileSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { readStartupModelCatalog } = await import('../../startup-model-catalog.ts');
  const dir = mkdtempSync(join(tmpdir(), 'catalog-bounds-'));
  const path = join(dir, 'catalog.json');
  try {
    const catalog = { default: 'model', options: [{ id: 'model', label: 'Model', variants: [{ id: 'x'.repeat(200), label: 'y'.repeat(256) }] }] };
    writeFileSync(path, JSON.stringify(catalog));
    expect(readStartupModelCatalog(path)?.options[0].variants).toEqual(catalog.options[0].variants);
    const full = { default: '0', options: Array.from({ length: 129 }, (_, i) => ({ id: String(i), label: String(i) })) };
    writeFileSync(path, JSON.stringify(full));
    expect(readStartupModelCatalog(path)?.options).toHaveLength(129);
    for (const bad of [
      { ...full, options: [...full.options, { id: 'overflow', label: 'Overflow' }] },
      { ...catalog, default: 'missing' },
      { ...catalog, options: [{ id: 'model', label: 'Model', variants: [{ id: 'x'.repeat(201), label: 'Long' }] }] },
      { ...catalog, options: [{ id: 'model', label: 'Model', variants: [{ id: 'ok', label: 'x'.repeat(257) }] }] },
      { ...catalog, options: [{ id: 'model', label: 'Model', variants: Array.from({ length: 129 }, (_, i) => ({ id: String(i), label: String(i) })) }] },
    ]) {
      writeFileSync(path, JSON.stringify(bad));
      expect(readStartupModelCatalog(path)).toBeUndefined();
      expect(existsSync(path)).toBe(false);
    }
  } finally { removeTempDirSync(dir); }
});
