import { test, expect } from "./page-error-guard";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

// UX L7 part 1: the phone's four tabs and a Needs you card as a sheet, at
// 390x844, the way a person checks them on a phone. Same shape as
// phone-computer-empty.human.spec.ts: a throwaway Vite dev server renders the
// real components, no harness server and nothing on disk but this process's
// scratch cache dir (wiped in afterAll).
let server: ViteDevServer;
let origin: string;
let cache: string;
test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-phone-tabs-"));
  server = await createServer({ configFile: false, root, cacheDir: cache, envFile: false,
    resolve: { alias: { "@": `${root}/src` } }, server: { host: "127.0.0.1", watch: null, hmr: false },
    plugins: [react(), tailwindcss(), { name: "phone-tabs-fixture", enforce: "pre",
      resolveId(id) { if (id === "/__phone-tabs.js") return "\0fixture-phone-tabs"; },
      load(id) {
        if (id !== "\0fixture-phone-tabs") return;
        return `import React from 'react';import {createRoot} from 'react-dom/client';
          import {PhoneTabs} from '/src/components/phone/PhoneTabs.tsx';import {NeedsRow} from '/src/components/needs/NeedsRow.tsx';
          import '/src/styles.css';
          const h=React.createElement;
          function Fixture(){
            const [tab,setTab]=React.useState('today');const [open,setOpen]=React.useState(false);
            const card=h('div',{className:'flex gap-2 pt-3'},h('button',{type:'button'},'Allow once'),h('button',{type:'button'},'Deny'));
            const page=tab==='needs-you'
              ? h('ul',{className:'space-y-2 p-4'},h(NeedsRow,{id:'r1',line:'Send the Dana email?',meta:'Max · waiting since 07:12',open:open,onToggle:function(){setOpen(function(o){return !o;});}},card))
              : h('h1',{className:'p-4 text-[22px]'},'Page '+tab);
            return h('div',{className:'flex h-full flex-col bg-app text-ink'},h('main',{className:'min-h-0 flex-1 overflow-hidden'},page),
              h(PhoneTabs,{active:tab,needsCount:3,onSelect:setTab}));
          }
          createRoot(document.getElementById('root')).render(h(Fixture));`;
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (req.url !== "/__phone-tabs") return next();
        res.setHeader("content-type", "text/html");
        res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%}</style><div id="root" style="height:100%"></div><script type="module" src="/__phone-tabs.js"></script>');
      }); },
    }],
  });
  await server.listen(0);
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); safeWipeSync(cache); });

test("phone: four 56 px tabs under the thumb, the Needs you count, and a Needs you card as a sheet", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/__phone-tabs`);
  const tabs = page.getByRole("navigation", { name: "Main" });
  await expect(tabs.getByRole("button")).toHaveCount(4);
  const names = ["Today", "Chats", "Needs you, 3 waiting", "Routines"];
  for (const name of names) {
    const box = await tabs.getByRole("button", { name, exact: true }).boundingBox();
    expect(box, name).not.toBeNull();
    expect(Math.round(box!.height)).toBe(56);
    expect(box!.width).toBeGreaterThan(90);
    expect(Math.round(box!.y + box!.height)).toBe(844);
  }
  expect(await tabs.locator("[data-phone-tab] > span:last-child").evaluateAll((els) => els.map((el) => getComputedStyle(el).fontSize))).toEqual(["12px", "12px", "12px", "12px"]);
  await expect(tabs.getByRole("button", { name: "Today" })).toHaveAttribute("aria-current", "page");
  await expect(tabs.locator("[data-phone-needs-count]")).toHaveText("3");

  await tabs.getByRole("button", { name: "Needs you, 3 waiting" }).click();
  await expect(tabs.getByRole("button", { name: "Needs you, 3 waiting" })).toHaveAttribute("aria-current", "page");
  await expect(tabs.locator("[aria-current=page]")).toHaveCount(1);

  // The card opens as a sheet from the bottom, named by its question, holding the keyboard.
  const open = page.getByRole("button", { name: "Open" });
  await open.click();
  const sheet = page.getByRole("dialog", { name: "Send the Dana email?" });
  await expect(sheet).toBeVisible();
  const box = await sheet.boundingBox();
  expect(Math.round(box!.y + box!.height)).toBe(844);
  await expect(sheet.getByRole("button", { name: "Allow once" })).toBeVisible();
  expect(await sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("Tab");
    expect(await sheet.evaluate((el) => el.contains(document.activeElement)), `Tab ${i + 1} stays in the sheet`).toBe(true);
  }
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("Shift+Tab");
    expect(await sheet.evaluate((el) => el.contains(document.activeElement)), `Shift+Tab ${i + 1} stays in the sheet`).toBe(true);
  }
  await page.screenshot({ path: testInfo.outputPath("phone-tabs-sheet.png") });
  // Close from the keyboard too.
  await sheet.getByRole("button", { name: "Close" }).focus();
  await page.keyboard.press("Enter");
  await expect(sheet).toHaveCount(0);
  await expect(open).toBeFocused();
  await open.click();
  await expect(sheet).toBeVisible();

  // Escape closes it and focus goes back to Open.
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(open).toBeFocused();

  // So do Close and a tap on the dimmed page above it.
  await open.click();
  await sheet.getByRole("button", { name: "Close" }).click();
  await expect(sheet).toHaveCount(0);
  await open.click();
  await expect(sheet).toBeVisible();
  await page.mouse.click(195, 20);
  await expect(sheet).toHaveCount(0);

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("phone-tabs.png") });
});

// The fixture draws the tabs at every width (App.tsx hides them above md); this checks the card only.
test("computer: the same Needs you card opens in place, not as a sheet", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${origin}/__phone-tabs`);
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Needs you, 3 waiting" }).click();
  await page.getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("button", { name: "Allow once" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
