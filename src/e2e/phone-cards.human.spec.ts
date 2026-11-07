import { test, expect } from "./page-error-guard";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

// UX L7 part 2, at 390x844 the way a person holds a phone: the Routines tab's
// list by day scrolls inside the page (a week of routines is taller than the
// screen), and the New routine and Hire sheets stay above the software
// keyboard. The keyboard is the one trackVisualViewport() (lib/visual-viewport)
// publishes: --vvh shrinks to the visible height and data-keyboard="open".
// Same shape as phone-tabs.human.spec.ts: a throwaway Vite dev server renders
// the real list and the sheets' real class strings, nothing on disk but this
// process's scratch cache dir (wiped in afterAll).
let server: ViteDevServer;
let origin: string;
let cache: string;
const KEYBOARD_VVH = 420;
test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-phone-cards-"));
  server = await createServer({ configFile: false, root, cacheDir: cache, envFile: false,
    resolve: { alias: { "@": `${root}/src` } }, server: { host: "127.0.0.1", watch: null, hmr: false },
    plugins: [react(), tailwindcss(), { name: "phone-cards-fixture", enforce: "pre",
      resolveId(id) { if (id === "/__phone-cards.js") return "\0fixture-phone-cards"; },
      load(id) {
        if (id !== "\0fixture-phone-cards") return;
        return `import React from 'react';import {createRoot} from 'react-dom/client';
          import {PhoneRoutineList} from '/src/components/phone/PhoneRoutineList.tsx';
          import {NEW_ROUTINE_BACKDROP,NEW_ROUTINE_BOX} from '/src/components/routines/NewRoutineSheet.tsx';
          import {HIRE_BACKDROP,HIRE_BOX} from '/src/components/hire/HireBotDialog.tsx';
          import {BOX_FRAME} from '/src/components/ui/BoxShell.tsx';
          import '/src/styles.css';
          const h=React.createElement;const view=new URLSearchParams(location.search).get('view');
          const now=Date.now();
          const routines=Array.from({length:30},function(_,i){return {id:'r'+i,name:'Routine '+i,prompt:'p',target:'bot',botId:'nova',runOn:'local',enabled:true,
            schedule:{type:'once',at:now+(i+1)*60000},durationMinutes:30,nextRunAt:now+(i+1)*60000};});
          function sheet(backdrop,box,name){
            const lines=Array.from({length:14},function(_,i){return h('p',{key:i,className:'py-2'},'Line '+i);});
            return h('div',{className:backdrop,'data-fixture-backdrop':''},h('div',{role:'dialog','aria-label':name,className:BOX_FRAME+' '+box},
              h('div',{className:'px-5 py-4'},name),h('div',{className:'min-h-0 flex-1 overflow-y-auto px-5'},h('textarea',{'aria-label':'Words',rows:3}),lines),
              h('div',{className:'px-5 py-3'},h('button',{type:'button'},'Done'))));
          }
          function Fixture(){
            if(view==='list') return h('main',{className:'flex h-full min-w-0 flex-1 flex-col bg-app'},h('header',{className:'p-4'},'Routines'),
              h(PhoneRoutineList,{routines:routines,botName:function(){return 'Nova';},now:now,onOpen:function(){},onNew:function(){}}));
            if(view==='new') return sheet(NEW_ROUTINE_BACKDROP,NEW_ROUTINE_BOX,'New routine');
            return sheet(HIRE_BACKDROP,HIRE_BOX,'Hire a bot');
          }
          createRoot(document.getElementById('root')).render(h(Fixture));`;
      },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/__phone-cards?")) return next();
        res.setHeader("content-type", "text/html");
        res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%}</style><div id="root" style="height:100%"></div><script type="module" src="/__phone-cards.js"></script>');
      }); },
    }],
  });
  await server.listen(0);
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await server?.close(); safeWipeSync(cache); });

test("phone: the Routines list by day scrolls to its last row and New routine", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/__phone-cards?view=list`);
  const list = page.locator("[data-phone-routine-list]");
  await expect(list.locator("[data-phone-routine-row]")).toHaveCount(30);
  const box = (await list.boundingBox())!;
  expect(box.y + box.height, "the list ends at the bottom of the screen").toBeLessThanOrEqual(844 + 0.5);
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight + 100)).toBe(true);
  expect(await list.evaluate((el) => getComputedStyle(el).overflowY)).toBe("auto");
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  const add = page.locator("[data-phone-routine-new]");
  await add.scrollIntoViewIfNeeded();
  expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  const addBox = (await add.boundingBox())!;
  expect(addBox.y + addBox.height).toBeLessThanOrEqual(844 + 0.5);
  await page.screenshot({ path: testInfo.outputPath("phone-routine-list-scrolled.png") });
});

for (const [view, name] of [["new", "New routine"], ["hire", "Hire a bot"]] as const) {
  test(`phone: the ${name} sheet sits on the bottom and stays above the keyboard`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/__phone-cards?view=${view}`);
    const dialog = page.getByRole("dialog", { name });
    let box = (await dialog.boundingBox())!;
    expect(Math.abs(box.y + box.height - 844), "a bottom sheet with no keyboard").toBeLessThanOrEqual(1);
    expect(box.width).toBeGreaterThanOrEqual(389);
    await page.evaluate((vvh) => {
      document.documentElement.style.setProperty("--vvh", `${vvh}px`);
      document.documentElement.dataset.keyboard = "open";
    }, KEYBOARD_VVH);
    await page.getByRole("textbox", { name: "Words" }).focus();
    box = (await dialog.boundingBox())!;
    expect(box.y, "the head is on screen").toBeGreaterThanOrEqual(0);
    expect(box.y + box.height, "the sheet ends above the keyboard").toBeLessThanOrEqual(KEYBOARD_VVH + 0.5);
    const done = (await dialog.getByRole("button", { name: "Done" }).boundingBox())!;
    expect(done.y + done.height, "its button row is above the keyboard").toBeLessThanOrEqual(KEYBOARD_VVH + 0.5);
    const backdrop = (await page.locator("[data-fixture-backdrop]").boundingBox())!;
    expect(backdrop.y + backdrop.height).toBeLessThanOrEqual(KEYBOARD_VVH + 0.5);
    await page.screenshot({ path: testInfo.outputPath(`phone-${view}-keyboard.png`) });
  });
}
