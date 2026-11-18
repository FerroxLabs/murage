import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { chromium, type Browser } from "@playwright/test";
import { compile } from "tailwindcss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ModelPickerDialog, type ModelPickerDialogProps } from "./ModelPickerDialog";

const { store } = vi.hoisted(() => ({ store: { state: { bots: [], instances: [], engineNote: "", localOnlyEngines: [] }, dispatch: vi.fn() } }));
vi.mock("@/state/store", () => ({ useStore: () => store }));
const boundaryLabel = "W".repeat(256);
const selection = { instanceId: "custom", model: "deep", variant: "max" };
const props = {
  bot: { id: "bot", modelSelection: selection }, contained: true, root: { current: null },
  active: { instanceId: "custom", models: { options: [{ id: "deep", label: "Deep", variants: [{ id: "max", label: boundaryLabel }] }] } },
  rows: [], query: "", limit: 30, connections: [], error: "", fleetError: "", refreshing: false,
  prefs: { favorites: [], recent: [] }, selectedKey: "deep", selectedLabel: "Deep", threadModelMutationLocked: false,
  setQuery: vi.fn(), setLimit: vi.fn(), setEngineId: vi.fn(), refresh: vi.fn(), save: vi.fn(), pick: vi.fn(), manage: vi.fn(), manageLocal: vi.fn(), openOwnAccount: vi.fn(),
} as unknown as ModelPickerDialogProps;
let browser: Browser;
let css: string;
let markup: string;
// CI provisions Chromium for the Linux Vitest runtime.
describe.skipIf(process.platform !== "linux")("native thinking control at phone widths", () => {
  beforeAll(async () => {
    markup = renderToStaticMarkup(createElement(ModelPickerDialog, props));
    const require = createRequire(import.meta.url);
    const compiler = await compile(readFileSync(resolve("src/styles.css"), "utf8"), {
      base: resolve("src"),
      loadStylesheet: async (id, base) => {
        const path = id.startsWith(".") ? resolve(base, id) : require.resolve(id === "tailwindcss" ? "tailwindcss/index.css" : id);
        return { path, base: dirname(path), content: readFileSync(path, "utf8") };
      },
    });
    css = compiler.build([...markup.matchAll(/class="([^"]+)"/g)].flatMap(match => match[1].split(/\s+/)));
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  }, 60_000);
  afterAll(async () => { await browser?.close(); });

  it.each([320, 390])("keeps a 256-character option and its control inside a %s px picker", async width => {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    try {
      await page.setContent(`<style>${css}</style><main style="width:calc(100vw - 24px);margin:12px">${markup}</main>`);
      const select = page.getByRole("combobox", { name: "Thinking", exact: true });
      expect(await select.inputValue()).toBe("max");
      expect(await select.locator('option[value="max"]').textContent()).toBe(boundaryLabel);
      const box = await select.boundingBox();
      const panel = await page.getByRole("dialog").boundingBox();
      expect(box).not.toBeNull(); expect(panel).not.toBeNull();
      expect(box!.width).toBeGreaterThan(40);
      expect(box!.x).toBeGreaterThanOrEqual(panel!.x);
      expect(box!.x + box!.width).toBeLessThanOrEqual(panel!.x + panel!.width);
      await select.selectOption("");
      expect(await select.inputValue()).toBe("");
      await select.selectOption("max");
      expect(await select.inputValue()).toBe("max");
    } finally { await page.close(); }
  });
});
