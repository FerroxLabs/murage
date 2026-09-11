import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const CODE = 'const greeting = "Hello";\r\n\tconsole.log(greeting);\n// ' + "long-token-".repeat(35) + "\n\n";
// #1023 (adapted): long inline tokens inside a real bot bubble. The identifier
// has no line-break opportunity at all; the path is the upstream example.
const LONG_PATH = "dist/{download,privacy,terms,license,support,presskit,changelogs,docs,about,feedback}";
const LONG_IDENTIFIER = "murage_" + "InlineCodeContainment_".repeat(8) + "end";
const LOCAL_FILE = `/Users/murage/${LONG_IDENTIFIER}.md`;
const FENCED = "// " + "fenced_line_stays_scrollable_".repeat(8);
const INLINE_CODES = [LONG_PATH, LONG_IDENTIFIER, LONG_IDENTIFIER, LOCAL_FILE, LONG_IDENTIFIER, LONG_IDENTIFIER, LONG_IDENTIFIER];
const INLINE_MESSAGE = [
  `Open \`${LONG_PATH}\` and rename \`${LONG_IDENTIFIER}\` before shipping.`,
  `مرحبا بالعالم \`${LONG_IDENTIFIER}\` مرحبا بالعالم`,
  `Saved [\`${LOCAL_FILE}\`](${LOCAL_FILE}) and documented [\`${LONG_IDENTIFIER}\`](https://example.com/docs). Plain label: [${LOCAL_FILE}](${LOCAL_FILE}).`,
  `| File | Docs |\n| --- | --- |\n| \`${LONG_IDENTIFIER}\` | [\`${LONG_IDENTIFIER}\`](https://example.com/docs) |`,
  "```ts\n" + FENCED + "\n```",
].join("\n\n");
// The transcript scroller, message row, flex row and bubble classes are ChatView's
// bot message (ChatView.tsx transcript "h-full overflow-x-hidden overflow-y-auto …" >
// "group flex w-full flex-col" > "flex w-full items-center" > data-testid="msg-bubble").
// #root is overflow:clip in styles.css, so the scroller is what lets a tall narrow
// message scroll, exactly as in the app.
const INLINE_FIXTURE = `
  import React from 'react';import {createRoot} from 'react-dom/client';import {ChatMarkdown} from '/src/components/ChatMarkdown.tsx';import '/src/styles.css';
  const params=new URLSearchParams(location.search);document.documentElement.dataset.skin=params.get('skin')||'dark';
  window.copyCalls=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copyCalls.push(text)}}});const h=React.createElement;
  createRoot(document.getElementById('root')).render(h('div',{'data-testid':'transcript',className:'h-full overflow-x-hidden overflow-y-auto overscroll-y-contain px-5 max-md:px-3 [overflow-anchor:none] py-4'},
    h('div',{className:'group flex w-full flex-col items-start'},h('div',{className:'flex w-full items-center gap-1.5 justify-start'},
      h('div',{'data-testid':'msg-bubble',className:'w-fit max-w-[min(42rem,78%)] max-md:max-w-full rounded-2xl text-[15px] leading-relaxed bg-card px-4 py-2.5 text-ink'},h(ChatMarkdown,{text:${JSON.stringify(INLINE_MESSAGE)}}))))));`;
let server: ViteDevServer, origin: string, cache: string;
test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url)); cache = mkdtempSync(join(tmpdir(), "murage-chat-polish-"));
  server = await createServer({ configFile: false, root, envFile: false, cacheDir: cache,
    resolve: { alias: { "@": root + "/src" } }, server: { host: "127.0.0.1", watch: null, hmr: false }, plugins: [tailwindcss(), {
      name: "chat-polish-fixture", resolveId(id) { if (id === "/__polish.js") return "\0chat-polish"; if (id === "/__inline.js") return "\0chat-inline"; },
      load(id) { if (id === "\0chat-inline") return INLINE_FIXTURE; if (id !== "\0chat-polish") return; return `
        import React from 'react';import {createRoot} from 'react-dom/client';import {CodeBlock} from '/src/components/ChatMarkdown.tsx';import {KeyboardShortcutsDialog} from '/src/components/KeyboardShortcutsDialog.tsx';import '/src/styles.css';
        const params=new URLSearchParams(location.search);document.documentElement.dataset.skin=params.get('skin')||'dark';window.muragebox={platform:params.get('platform')||'darwin'};
        window.copyCalls=[];window.clipboardMode='ok';Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copyCalls.push(text);if(window.clipboardMode==='reject')throw new Error('Denied');if(window.clipboardMode==='hold')await new Promise(resolve=>window.finishCopy=resolve)}}});
        function Fixture(){const[open,setOpen]=React.useState(false);const[code,setCode]=React.useState(${JSON.stringify(CODE)});const opener=React.useRef(null);return React.createElement(React.Fragment,null,
          React.createElement('button',{ref:opener,onClick:()=>setOpen(true)},'Keyboard shortcuts'),React.createElement('button',{onClick:()=>setCode('new stream line\\n')},'Replace code'),
          React.createElement('div',{className:'chat-md'},React.createElement(CodeBlock,{code,lang:code.startsWith('new')?'unknown-language':'ts',streaming:code.startsWith('new')})),React.createElement(KeyboardShortcutsDialog,{open,onClose:()=>setOpen(false),returnFocusRef:opener}));}
        createRoot(document.getElementById('root')).render(React.createElement(Fixture));`; },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        const inline = req.url === "/__inline" || req.url?.startsWith("/__inline?"); if (!inline && req.url !== "/__polish" && !req.url?.startsWith("/__polish?")) return next(); res.setHeader("content-type", "text/html");
        if (inline) return res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:var(--color-app);color:var(--color-ink)"><main id="root"></main><script type="module" src="/__inline.js"></script>');
        res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:var(--color-app);color:var(--color-ink)"><main id="root" style="max-width:760px;margin:24px auto;padding:16px"></main><script type="module" src="/__polish.js"></script>'); }); },
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
  await expect(page.locator(".shiki")).toHaveCSS("color-scheme", skin);
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
  await dialog.getByRole("button", { name: "Close keyboard shortcuts", exact: true }).focus();
  await page.keyboard.press("Shift+Tab"); await expect(dialog.getByRole("button", { name: "Done", exact: true })).toBeFocused();
  await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(opener).toBeFocused();
  await page.keyboard.press("?"); await expect(dialog).toHaveCount(0);
});
for (const [width, skin] of [[320, "light"], [390, "dark"], [820, "light"], [1280, "dark"]] as const) test(`inline code stays inside the bot bubble at ${width}px ${skin} while fenced code still scrolls`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 }); await page.goto(origin + "/__inline?skin=" + skin);
  const bubble = page.getByTestId("msg-bubble"); await expect(bubble.locator(".shiki")).toBeVisible();
  // exact inline bytes: wrapping changes layout only, never the token
  await expect(bubble.locator(":not(pre) > code")).toHaveText(INLINE_CODES);
  const geometry = await bubble.evaluate((element) => {
    const box = element.getBoundingClientRect(), style = getComputedStyle(element), transcript = element.closest("[data-testid=transcript]")!;
    return { right: box.right, contentLeft: box.left + parseFloat(style.paddingLeft), contentRight: box.right - parseFloat(style.paddingRight), viewport: innerWidth, pageWidth: document.documentElement.scrollWidth,
      // the real transcript is overflow-x-hidden, which would silently cut a leak; its scroll width still reports one
      transcriptOverflow: transcript.scrollWidth - transcript.clientWidth,
      tableOverflow: [...element.querySelectorAll("table")].map((table) => table.parentElement!.scrollWidth - table.parentElement!.clientWidth),
      boxes: [...element.querySelectorAll("code, button")].filter((node) => !node.closest("pre")).map((node) => ({ tag: node.tagName, text: node.textContent ?? "", rects: [...node.getClientRects()].map((rect) => ({ left: rect.left, right: rect.right })) })) };
  });
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 0.5); expect(geometry.pageWidth).toBeLessThanOrEqual(geometry.viewport);
  expect(geometry.transcriptOverflow, "transcript horizontal overflow").toBeLessThanOrEqual(1);
  // a long identifier in a cell must wrap in the cell, not push the table into a horizontal scroll
  expect(geometry.tableOverflow).toHaveLength(1); expect(geometry.tableOverflow[0], "table wrapper scroll overflow").toBeLessThanOrEqual(1);
  for (const node of geometry.boxes) {
    const label = `${node.tag} ${node.text.slice(0, 32)}`;
    // the identifier has no break opportunity and is wider than the bubble at every width, so it must wrap to stay inside
    if (node.tag === "CODE" && node.text.includes(LONG_IDENTIFIER)) expect(node.rects.length, `${label} wraps at ${width}px`).toBeGreaterThan(1);
    for (const rect of node.rects) { expect(rect.left, `${label} left edge`).toBeGreaterThanOrEqual(geometry.contentLeft - 0.5); expect(rect.right, `${label} right edge`).toBeLessThanOrEqual(geometry.contentRight + 0.5); }
  }
  const fenced = bubble.locator(".shiki").locator("..");
  expect(await fenced.evaluate((element) => [getComputedStyle(element).overflowX, element.scrollWidth > element.clientWidth])).toEqual(["auto", true]);
  await bubble.getByRole("button", { name: "Copy code", exact: true }).click(); expect(await page.evaluate(() => (window as any).copyCalls.at(-1))).toBe(FENCED);
  // human check: grow the viewport to the whole transcript (after every assertion) so a narrow capture shows the full message
  await page.setViewportSize({ width, height: Math.max(900, await page.getByTestId("transcript").evaluate((element) => element.scrollHeight)) });
  await page.screenshot({ path: info.outputPath(`inline-code-${width}-${skin}.png`) });
});
