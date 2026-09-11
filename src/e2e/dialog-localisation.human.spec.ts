import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { safeWipe } from "../../server/testing/safe-wipe.mjs";
const de = JSON.parse(readFileSync(new URL("../locales/de.json", import.meta.url), "utf8")) as Record<string, string>;

// Real dialog components; synthetic store/API and child buttons drive only their
// local error branches. No server/native operation, account or owner data used.
let vite: ViteDevServer, origin: string, temporary: string;
test.beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), "murage-dialog-locale-"));
  const root = fileURLToPath(new URL("../../", import.meta.url));
  vite = await createServer({ configFile: false, envFile: false, root, cacheDir: join(temporary, "vite"),
    resolve: { alias: { "@": join(root, "src") } }, server: { host: "127.0.0.1", port: 0, watch: null, hmr: false },
    plugins: [{ name: "dialog-locale-fixture", enforce: "pre", resolveId(id, importer) {
      if (id === "/__dialog.js") return "\0dialog-entry";
      if (importer?.endsWith("Dialog.tsx") && (id.endsWith("/state/store") || id.endsWith("/state/store.tsx"))) return "\0dialog-store";
      if (importer?.endsWith("Dialog.tsx") && (id === "./Files" || id === "./Inbox")) return `\0dialog-${id.slice(2)}`;
    }, load(id) {
      if (id === "\0dialog-store") return `export const useStore=()=>({state:{bots:[{id:'bot',threadId:'thread',tasks:[]}],groups:[],routineRuns:[]},dispatch:()=>{}});export const api=async()=>{if(new URLSearchParams(location.search).get('mode')==='fallback')throw null;return {}};`;
      if (id === "\0dialog-Inbox") return `import React from 'react';export function Inbox(p){return React.createElement('button',{onClick:()=>p.onOpen({threadId:new URLSearchParams(location.search).get('mode')==='missing'?'absent':'thread',messageId:'message'})},'Trigger source');}`;
      if (id === "\0dialog-Files") return `import React from 'react';export const openFiles=()=>{};export const artifactNativeAction=()=>async()=>{throw null};export function Files(p){const mode=new URLSearchParams(location.search).get('mode');return React.createElement('button',{onClick:()=>mode==='folder'?p.onRevealFolder({botId:'bot',threadId:'thread'}):mode==='native'?p.onNativeAction({},'open'):p.onSource({botId:'bot',threadId:'thread',sourceConversationAvailable:mode!=='missing'})},'Trigger source');}`;
      if (id === "\0dialog-entry") return `import React from 'react';import {createRoot} from 'react-dom/client';import {setLocale} from '/src/lib/i18n.ts';import {InboxDialog} from '/src/components/InboxDialog.tsx';import {FilesDialog} from '/src/components/FilesDialog.tsx';import '/src/styles.css';setLocale('de');window.muragebox={revealWorkspace:async()=>{throw null}};const kind=new URLSearchParams(location.search).get('kind');createRoot(document.getElementById('root')).render(React.createElement(kind==='files'?FilesDialog:InboxDialog,{botId:'bot',onClose:()=>{document.getElementById('root').textContent='Closed'}}));`;
    }, configureServer(server) { server.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith("/__dialog?")) return next();
      res.setHeader("content-type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/__dialog.js"></script>');
    }); } }, react(), tailwindcss()] });
  await vite.listen(); const address = vite.httpServer!.address();
  if (!address || typeof address === "string") throw Error("Missing fixture port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await vite?.close(); if (temporary) await safeWipe(temporary); });

for (const width of [390, 820, 1440]) test(`German dialog error states and keyboard at ${width}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const cases = [
    ["inbox", "missing", "inbox.conversationUnavailable"], ["inbox", "mismatch", "source.openError"],
    ["inbox", "fallback", "inbox.openResultError"], ["files", "mismatch", "source.openError"],
    ["files", "fallback", "source.openError"], ["files", "folder", "files.workingFolderError"],
    ["files", "native", "files.nativeActionError"], ["files", "missing", "files.sourceUnavailableRetained"],
  ] as const;
  for (const [kind, mode, key] of cases) {
    await page.goto(`${origin}/__dialog?kind=${kind}&mode=${mode}`);
    const dialog = page.getByRole("dialog", { name: de[kind === "files" ? "files.title" : "inbox.title"], exact: true });
    await expect(dialog).toBeVisible();
    const button = dialog.getByRole("button", { name: "Trigger source" });
    await button.focus(); await page.keyboard.press("Enter");
    await expect(dialog.getByRole("alert")).toHaveText(de[key]);
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    if (mode === "missing") await page.screenshot({ path: info.outputPath(`${kind}-${width}.png`) });
    await page.keyboard.press("Escape"); await expect(page.getByText("Closed", { exact: true })).toBeVisible();
  }
  expect(errors).toEqual([]);
});
