// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The rich Markdown editor in a real browser: "/" opens the block menu,
// Heading and Task list come from it, the bubble menu bolds a selection, a
// link goes in through the inline field (no browser prompt), and Save hands
// over the Markdown the editor wrote. Dark and light screenshots.
import { test, expect, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

let server: ViteDevServer, origin: string, cache: string;

// A page with the editor and a Save button that shows the saved Markdown.
const ENTRY = [
  "import React from 'react';import {createRoot} from 'react-dom/client';",
  "import {RichMarkdownEditor} from '/src/components/editor/RichMarkdownEditor.tsx';import '/src/styles.css';",
  "const q=new URLSearchParams(location.search);document.documentElement.dataset.skin=q.get('skin')||'dark';",
  "function Page(){const [md,setMd]=React.useState(q.get('start')||'');const [saved,setSaved]=React.useState(null);",
  "return React.createElement('div',null,",
  "React.createElement(RichMarkdownEditor,{value:md,onChange:setMd,ariaLabel:'Notes',className:'max-h-[520px]'}),",
  "React.createElement('button',{type:'button',onClick:()=>setSaved(md),style:{marginTop:12,padding:'6px 12px',borderRadius:8,background:'var(--color-accent)',color:'white'}},'Save'),",
  "saved===null?null:React.createElement('pre',{'data-testid':'saved',style:{color:'var(--color-ink)',whiteSpace:'pre-wrap'}},saved));}",
  "createRoot(document.getElementById('root')).render(React.createElement(Page));",
].join("");

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-rich-editor-ui-"));
  server = await createServer({
    configFile: false, root, cacheDir: cache, envFile: false,
    resolve: { alias: [{ find: "@", replacement: root + "/src" }] },
    server: { host: "127.0.0.1", watch: null, hmr: false },
    plugins: [tailwindcss(), {
      name: "rich-editor-fixture",
      resolveId(id) { if (id === "/__rich.js") return "\0rich-editor"; },
      load(id) { if (id === "\0rich-editor") return ENTRY; },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (!(req.url === "/__rich" || req.url?.startsWith("/__rich?"))) return next();
        res.setHeader("content-type", "text/html");
        res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:var(--color-app)"><main id="root" style="padding:16px;max-width:720px;margin:16px auto"></main><script type="module" src="/__rich.js"></script>');
      }); },
    }],
  });
  await server.listen(0);
  const address = server.httpServer!.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  origin = "http://127.0.0.1:" + address.port;
});
test.afterAll(async () => { await server?.close(); safeWipeSync(cache); });
test.beforeEach(({ page }) => {
  page.on("pageerror", (error) => console.log("page error:", error.message));
  page.on("console", (message) => { if (message.type() === "error") console.log("console error:", message.text()); });
  page.on("dialog", (dialog) => { throw new Error(`a native ${dialog.type()} dialog opened`); });
});

async function slash(page: Page, query: string, pick: string) {
  await page.keyboard.type("/");
  const menu = page.getByRole("listbox", { name: "Insert a block" });
  await expect(menu).toBeVisible();
  await page.keyboard.type(query);
  await menu.getByRole("option", { name: new RegExp("^" + pick) }).first().click();
  await expect(menu).toHaveCount(0);
}

for (const skin of ["dark", "light"] as const) {
  test(`slash menu, task list, bubble bold and link save as Markdown (${skin})`, async ({ page }, info) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto(origin + "/__rich?skin=" + skin);
    const box = page.getByRole("textbox", { name: "Notes" });
    await expect(box).toBeVisible();
    await expect(page.getByRole("toolbar", { name: "Formatting" })).toBeVisible();
    await box.click();
    await expect(page.locator(".rme .is-empty[data-placeholder]")).toHaveAttribute("data-placeholder", /Press '\/' for commands/);

    // "/" with no query lists all 13 blocks.
    await page.keyboard.type("/");
    await expect(page.getByRole("listbox", { name: "Insert a block" }).getByRole("option")).toHaveCount(13);
    await info.attach("slash-menu", { body: await page.screenshot(), contentType: "image/png" });
    await page.screenshot({ path: info.outputPath(`slash-menu-${skin}.png`) });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Backspace");

    await slash(page, "head", "Heading 2");
    await page.keyboard.type("Errands");
    await page.keyboard.press("Enter");
    await slash(page, "task", "Task list");
    await page.keyboard.type("Pay the rent");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Call the bank");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Remember the receipt today.");

    // Select "receipt" and bold it from the bubble menu.
    await page.keyboard.press("End");
    for (let i = 0; i < " today.".length; i += 1) await page.keyboard.press("ArrowLeft");
    for (let i = 0; i < "receipt".length; i += 1) await page.keyboard.press("Shift+ArrowLeft");
    const bubble = page.getByRole("toolbar", { name: "Selection formatting" });
    await expect(bubble).toBeVisible();
    await page.screenshot({ path: info.outputPath(`bubble-${skin}.png`) });
    await bubble.getByRole("button", { name: "Bold (⌘B)" }).click();

    // Link the selection with the inline field.
    await bubble.getByRole("button", { name: "Link" }).click();
    const address = bubble.getByLabel("Link address");
    await expect(address).toBeFocused();
    await address.fill("https://example.com/receipts");
    await page.screenshot({ path: info.outputPath(`link-${skin}.png`) });
    await address.press("Enter");

    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByTestId("saved")).toHaveText([
      "## Errands",
      "",
      "- [ ] Pay the rent",
      "- [ ] Call the bank",
      "",
      "Remember the [**receipt**](https://example.com/receipts) today.",
    ].join("\n"));
    await page.mouse.move(40, 40);
    await page.screenshot({ path: info.outputPath(`editor-${skin}.png`), fullPage: true });
  });
}

test("the drag handle's + adds a block below, and a checked task saves as [x]", async ({ page }) => {
  await page.goto(origin + "/__rich?skin=dark&start=" + encodeURIComponent("# Plan\n\n- [ ] One"));
  const box = page.getByRole("textbox", { name: "Notes" });
  await expect(box).toBeVisible();
  await box.locator("h1").hover();
  const add = page.getByRole("button", { name: "Add a block below" });
  await expect(add).toBeVisible();
  await add.click();
  await page.keyboard.type("Between");
  await box.locator('li[data-checked] input[type="checkbox"]').check();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("saved")).toHaveText("# Plan\n\nBetween\n\n- [x] One");
});
