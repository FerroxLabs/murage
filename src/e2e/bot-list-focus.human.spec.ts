// Where focus goes when the phone's bot-list drawer closes.
//
// The "Open bot list" button lives in each main view's header, so a pick in
// the drawer that changes the KIND of view (bot chat to room, a workspace back
// to a chat) unmounts the button that was on screen at the click and mounts a
// new one. A synchronous .focus() in the close handler landed on the old one,
// and focus fell to <body>. This mounts the real useBotListDrawer,
// BotListDrawerProvider and OpenBotListButton in a small shell shaped like
// App.tsx's: the same "pick then close in one handler" drawer, and the same
// effect that drops a workspace a commit AFTER the selection changes. Then it
// reads document.activeElement back out of Chromium.
//
// Nothing here touches a real app, data directory, engine or network.
import { test, expect, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

let server: ViteDevServer, origin: string, cache: string;

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-bot-list-focus-"));
  server = await createServer({
    configFile: false,
    root,
    cacheDir: cache,
    envFile: false,
    resolve: { alias: { "@": `${root}/src` } },
    server: { host: "127.0.0.1", hmr: false, watch: null },
    plugins: [
      react(),
      {
        name: "bot-list-focus-fixture",
        enforce: "pre",
        resolveId(id) {
          if (id === "/__focus.js") return "\0focus-entry";
        },
        load(id) {
          if (id !== "\0focus-entry") return;
          return `import React,{useEffect,useState} from 'react';import {createRoot} from 'react-dom/client';
import {BotListDrawerProvider,OpenBotListButton,useBotListDrawer} from '/src/components/OpenBotListButton.tsx';
const h=React.createElement;
// Three different element types, as in App.tsx's main-view switch.
function BotView({id}){return h('main',{'data-view':'bot'},h('header',null,h(OpenBotListButton),h('span',null,'Bot '+id)));}
function RoomView(){return h('main',{'data-view':'room'},h('header',null,h('div',null,h(OpenBotListButton),h('span',null,'Room'))));}
function Workspace(){return h('main',{'data-view':'workspace'},h('header',null,h(OpenBotListButton),h('span',null,'Browser workspace')));}
function Drawer({pick,close}){
  useEffect(()=>{const onKey=e=>e.key==='Escape'&&close();document.addEventListener('keydown',onKey);return()=>document.removeEventListener('keydown',onKey);},[close]);
  const row=(label,next)=>h('button',{type:'button',onClick:()=>{pick(next);close();}},label);
  return h('nav',{'aria-label':'Bot list'},row('Bot a',{kind:'bot',id:'a'}),row('Bot b',{kind:'bot',id:'b'}),row('Room',{kind:'room',id:'r'}));
}
function Shell(){
  const [selected,setSelected]=useState({kind:'bot',id:'a'});
  const [workspace,setWorkspace]=useState(null);
  const {drawerOpen,closeDrawer,control}=useBotListDrawer(true);
  // App.tsx drops a workspace in an effect, a commit after the pick.
  useEffect(()=>{if(workspace&&(selected.kind!=='bot'||selected.id!==workspace))setWorkspace(null);},[workspace,selected]);
  const view=workspace&&selected.kind==='bot'&&selected.id===workspace?h(Workspace):selected.kind==='room'?h(RoomView):h(BotView,{id:selected.id});
  return h(BotListDrawerProvider,{value:control},view,
    drawerOpen&&h(Drawer,{pick:setSelected,close:closeDrawer}),
    h('button',{type:'button',onClick:()=>setWorkspace(selected.id)},'Open workspace'));
}
createRoot(document.getElementById('mount')).render(h(Shell));`;
        },
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (request.url !== "/__focus") return next();
            response.setHeader("content-type", "text/html");
            response.end(
              '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
                '<body><div id="mount"></div><script type="module" src="/__focus.js"></script></body></html>',
            );
          });
        },
      },
    ],
  });
  await server.listen(0);
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await server?.close();
  safeWipeSync(cache);
});

const pageErrors: string[] = [];
test.afterEach(() => {
  expect(pageErrors, `the fixture page reported ${pageErrors.length} error(s)`).toEqual([]);
  pageErrors.length = 0;
});

async function open(page: Page) {
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/__focus`);
  await expect(page.locator("[data-view=bot]")).toBeVisible();
}

/** Which view's bot-list button holds focus, or what holds it instead. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement;
    if (active?.getAttribute("aria-label") === "Open bot list") return `button in ${active.closest("[data-view]")?.getAttribute("data-view")}`;
    return active?.tagName.toLowerCase() ?? "none";
  });

async function pick(page: Page, row: string) {
  await page.getByRole("button", { name: "Open bot list", exact: true }).click();
  await page.getByRole("navigation", { name: "Bot list" }).getByRole("button", { name: row, exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Bot list" })).toBeHidden();
}

test("a pick that swaps a bot chat for a room focuses the room's button", async ({ page }) => {
  await open(page);
  await pick(page, "Room");
  await expect(page.locator("[data-view=room]")).toBeVisible();
  await expect.poll(() => focused(page)).toBe("button in room");
});

test("a pick that swaps a room for a bot chat focuses the chat's button", async ({ page }) => {
  await open(page);
  await pick(page, "Room");
  await pick(page, "Bot b");
  await expect(page.locator("[data-view=bot]")).toBeVisible();
  await expect.poll(() => focused(page)).toBe("button in bot");
});

test("leaving a workspace for a chat, a commit later, focuses the chat's button", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(page.locator("[data-view=workspace]")).toBeVisible();
  await pick(page, "Bot b");
  await expect(page.locator("[data-view=bot]")).toBeVisible();
  await expect.poll(() => focused(page)).toBe("button in bot");
});

test("bot to bot, where nothing remounts, still focuses the button", async ({ page }) => {
  await open(page);
  await pick(page, "Bot b");
  await expect(page.getByText("Bot b", { exact: true })).toBeVisible();
  await expect.poll(() => focused(page)).toBe("button in bot");
});

test("Escape closes the drawer back onto the button", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Open bot list", exact: true }).click();
  await page.getByRole("navigation", { name: "Bot list" }).getByRole("button", { name: "Room" }).focus();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("navigation", { name: "Bot list" })).toBeHidden();
  await expect.poll(() => focused(page)).toBe("button in bot");
});

test("opening the drawer does not pull focus back to the button", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Open bot list", exact: true }).click();
  const row = page.getByRole("navigation", { name: "Bot list" }).getByRole("button", { name: "Bot b" });
  await row.focus();
  await page.waitForTimeout(100);
  await expect(row).toBeFocused();
});
