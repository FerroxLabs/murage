// A cold session whose picker lists only Flux tiers (BUNDLE-HEADROOM-1018
// follow-up Low, RESIDUALS-1018-B). Its own file on purpose: vitest gives each
// test file a fresh module instance, so the price snapshot has NOT been
// fetched here. ModelPicker.test.ts preloads it in beforeAll, which hid the
// case where a Flux-only list never looks a model up, never starts the import,
// and the dated price note never arrives.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { modelMetadataReady, preloadModelMetadata, subscribeModelMetadata } from "@/lib/model-metadata";
import { priceBandNote } from "@/lib/provider-model-picker";
import { PickerPriceNote } from "./ModelPickerDialog";

const pickerSource = readFileSync(fileURLToPath(new URL("./ModelPicker.tsx", import.meta.url)), "utf8");
// The chip keeps the state (1.0.19 slice P); the lazy dialog draws the note, so links 3 and 4 read the dialog.
const dialogSource = readFileSync(fileURLToPath(new URL("./ModelPickerDialog.tsx", import.meta.url)), "utf8");

describe("cold Flux-only picker: the price note", () => {
  it("starts cold: the note waits instead of showing an undated line", () => {
    expect(modelMetadataReady()).toBe(false);
    expect(renderToStaticMarkup(createElement(PickerPriceNote, { shown: true }))).toBe("");
  });

  it("opening the picker asks for the snapshot itself, so a list that never looks a model up still gets it", () => {
    // The open effect, not a row lookup, is what starts the import.
    expect(pickerSource).toMatch(/useEffect\(\(\)=>\{if\(open\)\{void refresh\(\);void preloadModelMetadata\(\);\}\},\[open\]\)/);
  });

  it("the open menu updates when the snapshot lands, with no other interaction (Astra r1 Low)", () => {
    // This repo's component tests run in node with no DOM (no jsdom), so the mounted picker cannot be opened here; the
    // chain that carries the landing to the open menu is checked link by link instead, and each link's behaviour below.
    // 1. the picker subscribes to the snapshot: a landing re-renders it
    expect(pickerSource).toMatch(/const metadataReady=useSyncExternalStore\(subscribeModelMetadata,modelMetadataReady,modelMetadataReady\);/);
    // 2. the rows are rebuilt on that render (their memo keys on metadataReady), so `ordered` is the fresh list
    expect(pickerSource).toMatch(/const rows=useMemo\(\(\)=>engine\?pickerModels\(engine,connections\):\[\],\[engine,connections,metadataReady\]\);/);
    // 3. the open menu renders the note from that render, shown whenever it lists any row (a Flux-only list included)
    expect(dialogSource).toMatch(/<PickerPriceNote shown=\{!!ordered\.length\}\/>/);
    // 4. the note reads readiness at render time, never a value captured before the landing
    expect(dialogSource).toMatch(/export function PickerPriceNote\(\{shown\}:\{shown:boolean\}\)\{[\s\S]{0,120}if\(!shown\|\|!modelMetadataReady\(\)\)return null;/);
  });

  it("a failed chunk load leaves the note pending and the next open tries again", async () => {
    let calls = 0;
    await preloadModelMetadata(() => { calls += 1; return Promise.reject(new Error("chunk load failed")); });
    expect(calls).toBe(1);
    expect(modelMetadataReady()).toBe(false);
    expect(renderToStaticMarkup(createElement(PickerPriceNote, { shown: true }))).toBe("");
    await preloadModelMetadata(() => { calls += 1; return Promise.reject(new Error("still offline")); });
    expect(calls).toBe(2);
  });

  it("once the open-time preload lands, subscribers hear it once and the dated note renders", async () => {
    let heard = 0;
    const stop = subscribeModelMetadata(() => { heard += 1; });
    await preloadModelMetadata();
    stop();
    expect(heard).toBe(1);
    expect(modelMetadataReady()).toBe(true);
    const html = renderToStaticMarkup(createElement(PickerPriceNote, { shown: true }));
    expect(html).toContain("data-price-band-note");
    expect(html).toContain(priceBandNote().replace(/&/g, "&amp;").replace(/'/g, "&#x27;"));
    // A closed menu still says nothing.
    expect(renderToStaticMarkup(createElement(PickerPriceNote, { shown: false }))).toBe("");
  });
});
