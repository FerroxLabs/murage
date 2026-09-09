import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const CODE = 'const greeting = "Hello";\r\n\tconsole.log(greeting);\n// ' + "long-token-".repeat(35) + "\n\n";
let server: ViteDevServer, origin: string, cache: string;
test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url)); cache = mkdtempSync(join(tmpdir(), "murage-chat-polish-"));
  server = await createServer({ configFile: false, root, envFile: false, cacheDir: cache,
    resolve: { alias: { "@": root + "/src" } }, server: { host: "127.0.0.1", watch: null, hmr: false }, plugins: [tailwindcss(), {
      name: "chat-polish-fixture", resolveId(id) { if (id === "/__polish.js") return "\0chat-polish"; },
      load(id) { if (id !== "\0chat-polish") return; return `
        import React from 'react';import {createRoot} from 'react-dom/client';import {CodeBlock} from '/src/components/ChatMarkdown.tsx';import {KeyboardShortcutsDialog} from '/src/components/KeyboardShortcutsDialog.tsx';import '/src/styles.css';
        const params=new URLSearchParams(location.search);document.documentElement.dataset.skin=params.get('skin')||'dark';window.muragebox={platform:params.get('platform')||'darwin'};
        window.copyCalls=[];window.clipboardMode='ok';Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copyCalls.push(text);if(window.clipboardMode==='reject')throw new Error('Denied');if(window.clipboardMode==='hold')await new Promise(resolve=>window.finishCopy=resolve)}}});
        function Fixture(){const[open,setOpen]=React.useState(false);const[code,setCode]=React.useState(${JSON.stringify(CODE)});const opener=React.useRef(null);return React.createElement(React.Fragment,null,
          React.createElement('button',{ref:opener,onClick:()=>setOpen(true)},'Keyboard shortcuts'),React.createElement('button',{onClick:()=>setCode('new stream line\\n')},'Replace code'),
          React.createElement(CodeBlock,{code,lang:code.startsWith('new')?'unknown-language':'ts',streaming:code.startsWith('new')}),React.createElement(KeyboardShortcutsDialog,{open,onClose:()=>setOpen(false),returnFocusRef:opener}));}
        createRoot(document.getElementById('root')).render(React.createElement(Fixture));`; },
      configureServer(vite) { vite.middlewares.use((req, res, next) => { if (req.url !== "/__polish" && !req.url?.startsWith("/__polish?")) return next(); res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:var(--color-app);color:var(--color-ink)"><main id="root" style="max-width:760px;margin:24px auto;padding:16px"></main><script type="module" src="/__polish.js"></script>'); }); },
    }] });
  await server.listen(0); const address = server.httpServer!.address(); if (!address || typeof address === "string") throw new Error("No fixture port"); origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); rmSync(cache, { recursive: true, force: true }); });
test("copy confirms only after success and reports a rejected clipboard", async ({ page }) => {
  await page.goto(origin + "/__polish"); await page.evaluate(() => { (window as any).clipboardMode = "hold"; });
  await page.getByRole("button", { name: "Copy code", exact: true }).click(); await expect(page.getByText("Copied", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).copyCalls)).toEqual([CODE]); await page.evaluate(() => (window as any).finishCopy());
  await expect(page.getByText("Copied", { exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).clipboardMode = "reject"; }); await page.getByRole("button", { name: "Copy code", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not copy"); await expect(page.getByText("Copied", { exact: true })).toHaveCount(0);
});
test("stream replacement cannot display stale highlighted code or copied confirmation", async ({ page }) => {
  await page.goto(origin + "/__polish"); await expect(page.locator(".shiki")).toBeVisible();
  await page.evaluate(() => { (window as any).clipboardMode = "hold"; }); await page.getByRole("button", { name: "Copy code", exact: true }).click();
  await page.getByRole("button", { name: "Replace code", exact: true }).click(); await page.evaluate(() => (window as any).finishCopy());
  await expect(page.locator("pre")).toHaveText("new stream line\n"); await expect(page.getByText("Copied", { exact: true })).toHaveCount(0);
});
for (const skin of ["light", "dark"]) test("code wrapping preserves bytes and contrast on narrow " + skin, async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(origin + "/__polish?skin=" + skin);
  await expect(page.locator(".shiki")).toBeVisible(); await expect(page.getByText("TypeScript", { exact: true })).toBeVisible(); await expect(page.getByText("5 lines", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Wrap long lines", exact: true }).click(); await expect(page.getByRole("button", { name: "Disable line wrapping" })).toHaveAttribute("aria-pressed", "true");
  expect(await page.locator("pre").evaluate(pre => pre.scrollWidth <= pre.clientWidth + 1)).toBe(true);
  await page.getByRole("button", { name: "Copy code", exact: true }).click(); expect(await page.evaluate(() => (window as any).copyCalls.at(-1))).toBe(CODE);
  await page.screenshot({ path: info.outputPath("code-" + skin + "-mobile.png"), fullPage: true });
});
for (const platform of ["darwin", "win32"]) test("shortcut reference searches platform keys, traps focus and returns to opener on " + platform, async ({ page }, info) => {
  if (platform === "win32") await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin + "/__polish?platform=" + platform + "&skin=" + (platform === "win32" ? "light" : "dark"));
  const opener = page.getByRole("button", { name: "Keyboard shortcuts", exact: true }); await opener.click();
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true }); await expect(dialog).toBeVisible(); await expect(page.getByRole("textbox", { name: "Search shortcuts" })).toBeFocused();
  await page.screenshot({ path: info.outputPath("shortcuts-" + platform + ".png"), fullPage: true });
  await page.getByRole("textbox", { name: "Search shortcuts" }).fill(platform === "darwin" ? "command" : "ctrl k");
  const paletteTerm = dialog.getByRole("term").filter({ hasText: "Search and switch conversations" });
  await expect(paletteTerm).toHaveText("Search and switch conversationsCommand palette"); await expect(paletteTerm).toBeVisible();
  const paletteKeys = paletteTerm.locator("..").locator("kbd");
  await expect(paletteKeys).toHaveText([platform === "darwin" ? "⌘" : "Ctrl", "K"]);
  await page.getByRole("textbox", { name: "Search shortcuts" }).fill("no-such-action"); await expect(dialog.getByRole("status")).toContainText("No shortcuts match");
  for (let i = 0; i < 5; i++) { await page.keyboard.press("Tab"); expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true); }
  await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(opener).toBeFocused();
  await page.keyboard.press("?"); await expect(dialog).toHaveCount(0);
});
