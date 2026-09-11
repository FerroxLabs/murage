// F4-T6 browser proof: code-block Save (adapted from OpenMausBot #979).
//
// A Vite fixture renders the real ChatMarkdown and CodeBlock. Nothing here
// touches a real app, data directory or network.
//
// Proves: clicking Save (mouse, Enter, Space) downloads a file whose bytes are
// exactly the text Copy puts on the clipboard, CRLF/blank lines/Unicode kept;
// the suggested name comes from the fence language and a hostile hint falls
// back to snippet.txt; the Blob URL is revoked afterwards; the save makes no
// network request; nothing claims "Saved"; controls stay inside the block and
// reachable at phone and desktop widths in both skins.
import { test, expect, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

const PYTHON = "# naïve café ✓ 日本語 👩‍💻\n\n\tprint(\"hi\")\n\n";
const CRLF = "line1\r\nline2\r\n\r\nünïcode ✓\r\n";
const MARKDOWN = [
  "```python", PYTHON, "```", "",
  "```../../etc/passwd", "root:x:0:0", "```", "",
  "```dockerfile", "FROM node:24", "```",
].join("\n");
// What each block holds once the renderer drops the fence's closing newline.
const BLOCKS: [section: string, name: string, bytes: string][] = [
  ["markdown", "snippet.py", PYTHON],
  ["markdown", "snippet.txt", "root:x:0:0"],
  ["markdown", "Dockerfile", "FROM node:24"],
  ["crlf", "snippet.ts", CRLF],
];

let server: ViteDevServer, origin: string, cache: string;

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-code-block-save-"));
  server = await createServer({ configFile: false, root, cacheDir: cache, envFile: false,
    resolve: { alias: { "@": `${root}/src` } }, server: { host: "127.0.0.1", hmr: false, watch: null },
    plugins: [react(), tailwindcss(), { name: "code-block-save-fixture",
      resolveId(id) { if (id === "/__code.js") return "\0code-block-save"; },
      load(id) {
        if (id !== "\0code-block-save") return;
        return `import React from 'react';import {createRoot} from 'react-dom/client';
import {ChatMarkdown, CodeBlock} from '/src/components/ChatMarkdown.tsx';
import '/src/styles.css';
const h=React.createElement;
createRoot(document.getElementById('root')).render(h(React.StrictMode,{},h('main',{style:{background:'var(--color-app)',color:'var(--color-ink)',padding:16,height:'100dvh',overflowY:'auto'}},
  h('section',{'data-testid':'markdown',className:'max-w-[min(42rem,100%)]'},h(ChatMarkdown,{text:${JSON.stringify(MARKDOWN)}})),
  // .chat-md as ChatMarkdown provides it: Shiki's light-dark() follows the skin only inside it
  h('section',{'data-testid':'crlf',className:'chat-md max-w-[min(42rem,100%)]'},h(CodeBlock,{code:${JSON.stringify(CRLF)},lang:'ts',streaming:false})))));`;
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (new URL(req.url ?? "/", "http://fixture").pathname === "/__code") {
          res.setHeader("content-type", "text/html");
          res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/__code.js"></script>');
          return;
        }
        next();
      }); },
    }] });
  await server.listen(Number(process.env.MURAGE_E2E_UI_PORT) || 0);
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); safeWipeSync(cache); });

async function open(page: Page, skin = "dark") {
  // record every object URL the page makes and revokes
  await page.addInitScript(() => {
    const w = window as unknown as { __created: string[]; __revoked: string[] };
    w.__created = []; w.__revoked = [];
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob: Blob) => { const url = create(blob); w.__created.push(url); return url; };
    URL.revokeObjectURL = (url: string) => { w.__revoked.push(url); revoke(url); };
  });
  await page.goto(origin + "/__code");
  await page.evaluate((value) => { document.documentElement.dataset.skin = value; }, skin);
  await expect(page.getByTestId("crlf").getByRole("button", { name: "Save code as snippet.ts" })).toBeVisible();
}

const saveButton = (page: Page, section: string, name: string) => page.getByTestId(section).getByRole("button", { name: `Save code as ${name}` });

async function downloadBytes(page: Page, trigger: () => Promise<void>) {
  const pending = page.waitForEvent("download");
  await trigger();
  const download = await pending;
  return { name: download.suggestedFilename(), url: download.url(), bytes: readFileSync((await download.path())!) };
}

test("Save downloads exactly what Copy copies, named from the fence language, with no request and no saved claim", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await open(page);
  // let Shiki's lazily loaded highlighter finish (three known languages; the
  // hostile hint stays a plain <pre>) so fixture module loads are not counted
  await expect(page.locator("pre.shiki")).toHaveCount(3);
  await page.waitForLoadState("networkidle");
  let requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  for (const [section, name, text] of BLOCKS) {
    requests = [];
    const saved = await downloadBytes(page, () => saveButton(page, section, name).click());
    // the save itself asks the network for nothing; only the blob is read
    expect(requests.filter((url) => !url.startsWith("blob:"))).toEqual([]);
    expect(saved.name).toBe(name);
    expect(saved.url).toMatch(/^blob:/);
    expect(saved.bytes.equals(Buffer.from(text, "utf8"))).toBe(true);
    // the same block's Copy puts the very same text on the clipboard
    const block = saveButton(page, section, name).locator("xpath=ancestor::div[contains(@class,'rounded-lg')][1]");
    await block.getByRole("button", { name: "Copy code" }).click();
    await expect(block.getByRole("button", { name: "Copy code" })).toContainText("Copied");
    expect(Buffer.from(await page.evaluate(() => navigator.clipboard.readText()), "utf8").equals(saved.bytes)).toBe(true);
    await expect(block).not.toContainText("Saved");
    await expect(block.getByRole("alert")).toHaveCount(0);
    // the object URL is released once the browser has taken the bytes
    await expect.poll(() => page.evaluate((url) => (window as unknown as { __revoked: string[] }).__revoked.includes(url), saved.url)).toBe(true);
  }
  expect(requests.filter((url) => !url.startsWith("blob:"))).toEqual([]);
  const created = await page.evaluate(() => (window as unknown as { __created: string[] }).__created.length);
  expect(created).toBe(BLOCKS.length);
});

test("Save works from the keyboard with Enter and Space", async ({ page }) => {
  await open(page);
  const button = saveButton(page, "markdown", "snippet.py");
  for (const key of ["Enter", "Space"]) {
    await button.focus();
    await expect(button).toBeFocused();
    const saved = await downloadBytes(page, () => page.keyboard.press(key));
    expect(saved.name).toBe("snippet.py");
    expect(saved.bytes.equals(Buffer.from(PYTHON, "utf8"))).toBe(true);
    await expect(button).toBeFocused();
  }
});

for (const [width, height] of [[390, 844], [1280, 800]] as const) {
  for (const skin of ["dark", "light"]) {
    test(`the controls fit and stay reachable at ${width}px in the ${skin} skin`, async ({ page }, info) => {
      await page.setViewportSize({ width, height });
      await open(page, skin);
      for (const [section, name] of BLOCKS) {
        const button = saveButton(page, section, name);
        const block = button.locator("xpath=ancestor::div[contains(@class,'rounded-lg')][1]");
        const outer = (await block.boundingBox())!;
        for (const control of [block.getByRole("button", { name: /^(Wrap long lines|Disable line wrapping)$/ }), button, block.getByRole("button", { name: "Copy code" })]) {
          const box = (await control.boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(outer.x); expect(box.x + box.width).toBeLessThanOrEqual(outer.x + outer.width + 0.5);
          expect(box.height).toBeGreaterThanOrEqual(32);
        }
        await expect(button).toHaveAttribute("title", `Save code as ${name}`);
        // the word hides on a phone like Wrap's does; the accessible name stays
        if (width < 640) await expect(button.getByText("Save", { exact: true })).toBeHidden();
        else await expect(button.getByText("Save", { exact: true })).toBeVisible();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`code-block-save-${width}-${skin}.png`), fullPage: true });
    });
  }
}
