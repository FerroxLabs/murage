import { expect, test, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePortBlock } from "../../server/testing/ports";

// Renderer-only fixture: real StoreProvider/Composer, synthetic paste events,
// and in-memory upload responses. No system clipboard, harness, or provider.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64");
const bot = {
  id: "clipboard-bot", name: "Clipboard fixture", color: "blue", threadId: "thread-a",
  modelSelection: { instanceId: "fixture", model: "fixture" },
  tasks: [], messages: [], description: "", title: "",
};
let server: ViteDevServer;
let origin: string;
let cache: string;
let supportsImages = true;
let holdUploads = false;
const uploads: Array<{ mime: string; bytes: number; path: string }> = [];
const pendingUploads: Array<() => void> = [];

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-clipboard-vite-"));
  server = await createServer({
    configFile: false, root, envFile: false, cacheDir: cache,
    resolve: { alias: { "@": `${root}/src` } },
    server: { host: "127.0.0.1", strictPort: true, watch: null, hmr: false },
    plugins: [{
      name: "clipboard-fixture",
      resolveId(id) { if (id === "/__clipboard.js") return "\0clipboard-fixture"; },
      load(id) {
        if (id !== "\0clipboard-fixture") return;
        return `
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { StoreProvider, useStore } from '/src/state/store.tsx';
          import { Composer } from '/src/components/Composer.tsx';
          function Probe() {
            const { state } = useStore();
            const [task, setTask] = React.useState('a');
            if (!state.bots[0] || !state.instances.length) return React.createElement('output', {}, 'loading');
            const bot = {...state.bots[0], threadId: 'thread-' + task};
            return React.createElement(React.Fragment, {},
              React.createElement('output', {}, 'ready'),
              React.createElement('button', {onClick:()=>setTask('a')}, 'Task A'),
              React.createElement('button', {onClick:()=>setTask('b')}, 'Task B'),
              state.error && React.createElement('div', {role:'alert'}, state.error),
              React.createElement(Composer, {key: task, bot}));
          }
          createRoot(document.getElementById('root')).render(React.createElement(StoreProvider, {}, React.createElement(Probe)));
        `;
      },
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          const path = new URL(req.url ?? "/", "http://fixture").pathname;
          const json = (body: unknown, status = 200) => {
            res.statusCode = status;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(body));
          };
          if (path === "/__clipboard") {
            res.setHeader("content-type", "text/html");
            res.end('<div id="root"></div><script type="module" src="/__clipboard.js"></script>');
          } else if (path === "/api/desktop-secret") json({ error: "Not found" }, 404);
          else if (path === "/api/events") { res.statusCode = 204; res.end(); }
          else if (path === "/api/bots") json({ bots: [bot], groups: [] });
          else if (path === "/api/config") json({ surface: "remote", features: {}, rooms: { turnTimeoutMinutes: 5 } });
          else if (path === "/api/instances") json({ instances: [{
            instanceId: "fixture", driverKind: "fixture", displayName: "Fixture",
            snapshot: { state: "available", authenticated: true },
            models: { default: "fixture", options: [{ id: "fixture", label: "Fixture" }] },
            capabilities: { images: supportsImages },
          }] });
          else if (path === "/api/routines") json({ routines: [], runs: [] });
          else if (path === "/api/webhooks") json({ webhooks: [], attempts: [] });
          else if (path === "/api/attachments" && req.method === "POST") {
            let bytes = 0;
            req.on("data", (chunk: Buffer) => { bytes += chunk.length; });
            req.on("end", () => {
              const upload = {
                path: `/fixture/attachments/clipboard-${uploads.length + 1}.png`,
                mime: req.headers["content-type"] ?? "application/octet-stream", bytes,
              };
              uploads.push(upload);
              const finish = () => json(upload);
              if (holdUploads) pendingUploads.push(finish);
              else finish();
            });
          } else if (/^\/api\/attachments\/clipboard-\d+\.png$/.test(path)) {
            res.setHeader("content-type", "image/png");
            res.end(PNG);
          } else if (path.startsWith("/api/")) json({ error: "Unexpected fixture route" }, 404);
          else next();
        });
      },
    }],
  });
  await server.listen(await freePortBlock([0]));
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("fixture has no TCP address");
  origin = `http://127.0.0.1:${address.port}`;
});

test.beforeEach(() => {
  supportsImages = true;
  holdUploads = false;
  uploads.length = 0;
  pendingUploads.length = 0;
});
test.afterEach(() => { for (const finish of pendingUploads.splice(0)) finish(); });
test.afterAll(async () => { await server?.close(); if (cache) rmSync(cache, { recursive: true, force: true }); });

async function openComposer(page: Page) {
  await page.goto(`${origin}/__clipboard`);
  await expect(page.locator("output")).toHaveText("ready");
  await expect(page.getByRole("textbox")).toBeEditable();
}

async function pasteImage(
  page: Page,
  options: { source?: "items" | "both" | "files" | "unreadable-item" | "unreadable-file"; mime?: string; name?: string } = {},
) {
  return page.getByRole("textbox").evaluate((element, input) => {
    const file = new File([new Uint8Array(input.bytes)], input.name, { type: input.mime });
    if (input.source === "unreadable-file") {
      Object.defineProperty(file, "arrayBuffer", { value: () => Promise.reject(new Error("Fixture clipboard image could not be read")) });
    }
    const data = new DataTransfer();
    data.items.add(file);
    if (input.source === "items") Object.defineProperty(data, "files", { value: [] });
    if (input.source === "files") Object.defineProperty(data, "items", { value: [] });
    if (input.source === "unreadable-file") {
      Object.defineProperty(data, "files", { value: [file] });
      Object.defineProperty(data, "items", { value: [{ kind: "file", type: input.mime, getAsFile: () => file }] });
    }
    if (input.source === "unreadable-item") {
      Object.defineProperty(data, "files", { value: [] });
      Object.defineProperty(data, "items", { value: [{ kind: "file", type: input.mime, getAsFile: () => null }] });
    }
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }, { bytes: [...PNG], source: options.source ?? "both", mime: options.mime ?? "image/png", name: options.name ?? "clipboard.png" });
}

for (const source of ["items", "both", "files"] as const) {
  test(`image paste from ${source} uploads once and shows one attachment`, async ({ page }, testInfo) => {
    await openComposer(page);
    expect(await pasteImage(page, { source })).toBe(true);
    await expect(page.getByRole("button", { name: "Preview clipboard.png", exact: true })).toHaveCount(1);
    expect(uploads).toEqual([{ path: "/fixture/attachments/clipboard-1.png", mime: "image/png", bytes: PNG.length }]);
    await expect(page.getByRole("img", { name: "clipboard.png", exact: true })).toBeVisible();
    await expect(page.getByRole("textbox")).toHaveValue("");
    await page.screenshot({ path: testInfo.outputPath(`clipboard-${source}.png`), fullPage: true });
  });
}

for (const failure of ["unsupported-responder", "unsupported-mime", "unreadable-item", "unreadable-file"] as const) {
  test(`${failure} displays a clipboard image error without uploading`, async ({ page }, testInfo) => {
    supportsImages = failure !== "unsupported-responder";
    await openComposer(page);
    await page.getByRole("textbox").fill("Keep this draft");
    expect(await pasteImage(page, {
      source: failure === "unreadable-item" || failure === "unreadable-file" ? failure : "both",
      mime: failure === "unsupported-mime" ? "image/svg+xml" : "image/png",
    })).toBe(true);
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("alert")).toContainText(/image|clipboard/i);
    expect(uploads).toHaveLength(0);
    await expect(page.getByRole("button", { name: /^Preview / })).toHaveCount(0);
    await expect(page.getByRole("textbox")).toHaveValue("Keep this draft");
    await page.screenshot({ path: testInfo.outputPath(`clipboard-${failure}.png`), fullPage: true });
  });
}

async function pasteText(page: Page, text: string) {
  return page.getByRole("textbox").evaluate((element, value) => {
    const data = new DataTransfer();
    data.setData("text/plain", value);
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }, text);
}

test("ordinary text preserves native selection replacement and long text replaces the selection with a pasted attachment", async ({ page }) => {
  await openComposer(page);
  const input = page.getByRole("textbox");
  await input.fill("before SELECT after");
  await input.evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(7, 13));
  expect(await pasteText(page, "short")).toBe(false);
  // Synthetic paste does not perform the browser's default edit. Let Chromium
  // insert text at its current selection after proving Composer allowed it.
  await page.keyboard.insertText("short");
  await expect(input).toHaveValue("before short after");
  await expect(page.getByRole("button", { name: "Display pasted text in chat box" })).toHaveCount(0);

  await input.fill("before SELECT after");
  await input.evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(7, 13));
  const longText = "Long clipboard content\n".repeat(60);
  expect(await pasteText(page, longText)).toBe(true);
  await expect(input).toHaveValue("before  after");
  await expect(page.getByRole("button", { name: "Display pasted text in chat box" })).toHaveCount(1);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("murage-draft-attachments") ?? "{}"));
  expect(saved["bot:clipboard-bot:thread-a"]).toEqual([expect.objectContaining({ kind: "paste", text: longText })]);
  expect(uploads).toHaveLength(0);
});

test("two delayed uploads remain in their original task draft after navigation", async ({ page }, testInfo) => {
  holdUploads = true;
  await openComposer(page);
  await page.getByRole("textbox").fill("Task A draft");
  expect(await pasteImage(page, { source: "items", name: "first.png" })).toBe(true);
  expect(await pasteImage(page, { source: "items", name: "second.png" })).toBe(true);
  await expect.poll(() => pendingUploads.length).toBe(2);
  await page.getByRole("button", { name: "Task B", exact: true }).click();
  await expect(page.getByRole("textbox")).toHaveValue("");
  await page.getByRole("textbox").fill("Task B draft");

  const savedForA = () => page.evaluate(() =>
    JSON.parse(localStorage.getItem("murage-draft-attachments") ?? "{}")["bot:clipboard-bot:thread-a"] ?? [],
  );
  pendingUploads.shift()!();
  await expect.poll(async () => (await savedForA()).length).toBe(1);
  pendingUploads.shift()!();
  await expect.poll(async () => (await savedForA()).length).toBe(2);
  expect((await savedForA()).map((attachment: { name: string }) => attachment.name).sort()).toEqual(["first.png", "second.png"]);
  await expect(page.getByRole("textbox")).toHaveValue("Task B draft");
  await expect(page.getByRole("button", { name: /^Preview / })).toHaveCount(0);

  await page.getByRole("button", { name: "Task A", exact: true }).click();
  await expect(page.getByRole("textbox")).toHaveValue("Task A draft");
  await expect(page.getByRole("button", { name: "Preview first.png", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview second.png", exact: true })).toBeVisible();
  expect(uploads).toHaveLength(2);
  await page.screenshot({ path: testInfo.outputPath("clipboard-original-task.png"), fullPage: true });
});

test("denied attachment storage retains successive uploads and removal in the mounted draft", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const key = "murage-draft-attachments";
    localStorage.setItem(key, JSON.stringify({
      "bot:clipboard-bot:thread-a": [{
        kind: "image", id: "saved-baseline", path: "/fixture/attachments/clipboard-99.png",
        name: "prior.png", size: 1, mime: "image/png",
      }],
    }));
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name: string, value: string) {
      if (name === key) throw new DOMException("Fixture attachment storage denied", "QuotaExceededError");
      return original.call(this, name, value);
    };
  });
  await openComposer(page);
  await expect(page.getByRole("button", { name: "Preview prior.png", exact: true })).toBeVisible();
  expect(await pasteImage(page, { source: "items", name: "first.png" })).toBe(true);
  await expect(page.getByRole("button", { name: "Preview first.png", exact: true })).toBeVisible();
  expect(await pasteImage(page, { source: "items", name: "second.png" })).toBe(true);
  await expect(page.getByRole("button", { name: /^Preview / })).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Preview second.png", exact: true })).toBeVisible();

  await page.locator('[title="first.png"]').getByRole("button", { name: "Remove file", exact: true }).click();
  await expect(page.getByRole("button", { name: "Preview first.png", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Preview second.png", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview prior.png", exact: true })).toBeVisible();
  expect(uploads).toHaveLength(2);
  const savedNames = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("murage-draft-attachments") ?? "{}")["bot:clipboard-bot:thread-a"]
      .map((attachment: { name: string }) => attachment.name),
  );
  expect(savedNames).toEqual(["prior.png"]);
  await page.screenshot({ path: testInfo.outputPath("clipboard-storage-denied.png"), fullPage: true });
});
