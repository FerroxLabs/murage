// The chat header, MEASURED (U0-T1).
//
// The shipped header was a class-string problem that only a rendered
// rectangle could see: every control was `shrink-0`, so the identity cluster
// absorbed the whole shortage, the bot's name measured 0px in a 390px column,
// and the role pill wrapped to three lines and overlapped the Find button.
// No source contract can fail on that, so this file renders the REAL
// ChatHeader — with the real TaskPicker, ModelPicker, CallButton, RoleBadge,
// UsagePopover, MemoryLauncher and working-folder chip inside it — and reads
// the boxes back out of Chromium.
//
// It drives the CHAT CONTAINER's width, not the viewport's, because that is
// the width the header actually answers to: the same shortage happens in a
// 1440px window with the sidebar and the computer panel open. The viewport
// stays wide while the column is narrowed, which is exactly the case a
// viewport-breakpoint fix would miss.
//
// Nothing here touches a real app, data directory, engine or network: a Vite
// fixture mounts the component against a fake store, and every /api call is
// intercepted.
import { test, expect, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

/** The acceptance matrix's container widths. */
const WIDTHS = [320, 390, 480, 640, 820, 1024] as const;
const SKINS = ["light", "dark"] as const;

let server: ViteDevServer, origin: string, cache: string;

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-chat-header-"));
  server = await createServer({
    configFile: false,
    root,
    cacheDir: cache,
    envFile: false,
    resolve: { alias: { "@": `${root}/src` } },
    server: { host: "127.0.0.1", hmr: false, watch: null },
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "chat-header-fixture",
        enforce: "pre",
        resolveId(id) {
          if (id.endsWith("/src/state/store") || id === "@/state/store") return "\0header-store";
          // The memory PANEL has its own spec (memory.human.spec.ts) and its own
          // backend; this one is about the header, so the dialog's body is a
          // stand-in with one editable field. That field is what proves a memory
          // edit in progress survives a relayout.
          if (id === "./MemorySettings" || id.endsWith("/MemorySettings")) return "\0header-memory";
          if (id === "/__header.js") return "\0header-entry";
        },
        load(id) {
          if (id === "\0header-store")
            return `export * from '/src/state/store.tsx?original';
import {useSyncExternalStore} from 'react';
export function useStore(){return useSyncExternalStore(window.subscribeFixture,()=>window.fixtureStore);}`;
          if (id === "\0header-memory")
            return `import React from 'react';
export function MemorySettings(){return React.createElement('textarea',{'aria-label':'Memory draft',rows:3});}`;
          if (id !== "\0header-entry") return;
          return `import React from 'react';import {createRoot} from 'react-dom/client';
import {initialState} from '/src/state/store.tsx?original';
import {ChatHeader} from '/src/components/ChatHeader.tsx';
import {en,locales} from '/src/locales/index.ts';
import {setLocale} from '/src/lib/i18n.ts';
import '/src/styles.css';
const listeners=new Set();window.subscribeFixture=fn=>{listeners.add(fn);return()=>listeners.delete(fn);};
const q=new URLSearchParams(location.search);
// ?labels=long: a pseudo-locale where every string is half again as long,
// the way German and French labels run against English. Registered like any
// other pack, so the header sees it through the same t() as a real one.
if(q.get('labels')==='long'){
  locales.xx=Object.fromEntries(Object.entries(en).map(([key,value])=>[key,value+' \u2014 l\u00e4ngere \u00dcbersetzung']));
  setLocale('xx');
}
const LONG='Quarterly Revenue Reconciliation & Board Narrative';
const bot={
  id:'analyst',
  name:q.get('name')==='short'?'Ada':LONG,
  color:'blue',
  threadId:'thread-1',
  chiefOfStaff:q.get('role')!=='member',
  chiefScope:'workspace',
  description:'',
  autoApprove:false,
  busy:q.get('busy')!=='0',
  activity:'working',
  cwd:'/Users/fixture/Murage/analyst',
  modelSelection:{instanceId:'fixture',model:'fixture-model'},
  messages:[],
  tasks:[
    {threadId:'thread-1',title:'Reconcile Q3 revenue against the board narrative',createdAt:1757000000000,
      cwd:q.get('cwd')==='bot'?undefined:'/Users/fixture/Murage/analyst/tasks/q3-revenue-reconciliation',
      usage:q.get('usage')==='0'?undefined:{input:1313000,output:412900,cachedInput:1200000,costUsd:1234.56,turns:41}},
    {threadId:'thread-2',title:'Second task',createdAt:1757000001000},
  ],
};
const state={...initialState,
  bots:[bot],selectedId:bot.id,connected:true,
  instances:[{instanceId:'fixture',displayName:'Fixture Engine',driverKind:'claude',enabled:true,
    models:{options:[{id:'fixture-model',label:'Fixture Model'}]},
    snapshot:{billing:'metered'},capabilities:{}}],
  config:{features:{},box:{configured:true},tts:{configured:false}},
};
window.actions=[];window.filesOpened=[];
window.addEventListener('murage:open-files',event=>window.filesOpened.push(event.detail));
const publish=()=>{window.fixtureStore={state:{...state},dispatch,refreshInstances:async()=>{}};listeners.forEach(fn=>fn());};
const dispatch=action=>{window.actions.push(action);
  if(action.type==='toggleComputer')state.computerOpen=!state.computerOpen;
  if(action.type==='toggleInspector')state.inspectorOpen=!state.inspectorOpen;
  if(action.type==='updateBot')Object.assign(bot,action.patch);
  if(action.type==='interrupt')bot.busy=false;
  publish();};
publish();
function HeaderFixture(){
  const [findOpen,setFindOpen]=React.useState(false);
  const {state:live}=window.fixtureStore;
  const [,force]=React.useReducer(n=>n+1,0);
  React.useEffect(()=>window.subscribeFixture(force),[]);
  void live;
  return React.createElement(ChatHeader,{bot,messages:[],mascotMotion:null,findOpen,
    onToggleFind:()=>setFindOpen(open=>!open)});
}
window.setColumnWidth=width=>{document.getElementById('column').style.width=width+'px';};
createRoot(document.getElementById('mount')).render(React.createElement(HeaderFixture));`;
        },
        configureServer(vite) {
          vite.middlewares.use((request, response, next) => {
            if (request.url !== "/__header" && !request.url?.startsWith("/__header?")) return next();
            response.setHeader("content-type", "text/html");
            response.end(
              '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
                '<body style="margin:0;background:var(--color-app)">' +
                '<div id="column" style="width:1024px;min-height:100dvh;background:var(--color-app);color:var(--color-ink)">' +
                // NOT id="root": styles.css gives the app's own #root `overflow: clip`,
                // which would silently clip the More menu below the header.
                '<div id="mount"></div></div><script type="module" src="/__header.js"></script></body></html>',
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

/** The fixture's own globals, declared where they are used rather than
 *  widened onto every Window in the project. */
interface Fixture {
  actions: Array<{ type: string }>;
  filesOpened: Array<{ botId?: string; threadId?: string }>;
  setColumnWidth: (width: number) => void;
  fixtureStore: { state: Record<string, unknown> };
}
/** A render error would leave a half-built header whose rectangles mean
 *  nothing, so every test asserts the page stayed clean. */
const pageErrors: string[] = [];
test.afterEach(() => {
  expect(pageErrors, `the fixture page reported ${pageErrors.length} error(s)`).toEqual([]);
  pageErrors.length = 0;
});

async function open(page: Page, { query = "", skin = "dark" as (typeof SKINS)[number] } = {}) {
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });
  // Nothing may reach a real harness. The catch-all is registered first so
  // the specific answers below win.
  await page.route("**/api/**", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/config", (route) => route.fulfill({ json: { surface: "desktop", features: {} } }));
  await page.route("**/api/desktop-secret", (route) => route.fulfill({ json: { secret: "fixture-secret" } }));
  // A wide window throughout: every narrowing below is the COLUMN, which is
  // what an open sidebar or computer panel actually does.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/__header${query}`);
  await page.evaluate((value) => document.documentElement.setAttribute("data-skin", value), skin);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator("[data-chat-header]")).toBeVisible();
  await settle(page);
}

/** Let the layout ladder finish. Each step is a layout effect, so two frames
 *  after the last one is past every re-render React can queue. */
async function settle(page: Page) {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

async function setWidth(page: Page, width: number) {
  await page.evaluate((value) => (window as unknown as Fixture).setColumnWidth(value), width);
  await settle(page);
}

interface Rect { x: number; y: number; width: number; height: number }
interface Control { name: string; rect: Rect }

/** Every interactive rectangle inside the header, with its accessible name. */
const controls = (page: Page): Promise<Control[]> =>
  page.evaluate(() => {
    const header = document.querySelector("[data-chat-header]")!;
    const nodes = [...header.querySelectorAll<HTMLElement>("button, input, a[href], [tabindex]")];
    return nodes
      .filter((node) => node.offsetParent !== null || node.getClientRects().length > 0)
      .map((node) => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return {
          name:
            node.getAttribute("aria-label") ??
            node.getAttribute("title") ??
            (node.textContent ?? "").trim() ??
            node.tagName,
          rect: { x, y, width, height },
        };
      })
      .filter((control) => control.rect.width > 0 && control.rect.height > 0);
  });

/** Overlapping area of two rectangles, in px². */
function intersection(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

const headerBox = (page: Page) =>
  page.evaluate(() => {
    const header = document.querySelector("[data-chat-header]") as HTMLElement;
    const name = header.querySelector<HTMLElement>("[data-chat-header-name] :is(button, input)");
    const style = getComputedStyle(header);
    const box = header.getBoundingClientRect();
    const left = box.left + parseFloat(style.paddingLeft || "0");
    const right = box.right - parseFloat(style.paddingRight || "0");
    // Every interactive rectangle must sit inside the content box: a
    // right-aligned row that does not fit spills to the LEFT, which
    // scrollWidth cannot see.
    let escape = 0;
    for (const node of header.querySelectorAll<HTMLElement>("button, input")) {
      // Not what floats above the row: an open menu, popover or dialog.
      if (node.closest("dialog, [role=menu], [role=dialog], [role=group]")) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width === 0) continue;
      escape = Math.max(escape, left - rect.left, rect.right - right);
    }
    return {
      rows: header.getAttribute("data-chat-header-rows"),
      relocated: Number(header.getAttribute("data-chat-header-relocated")),
      escape,
      chips: header.getAttribute("data-chat-header-chips"),
      clientWidth: header.clientWidth,
      scrollWidth: header.scrollWidth,
      contentWidth:
        header.clientWidth - parseFloat(style.paddingLeft || "0") - parseFloat(style.paddingRight || "0"),
      nameWidth: name?.getBoundingClientRect().width ?? 0,
      nameNatural: name?.scrollWidth ?? 0,
      documentScrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  });

/** The guarantee from src/lib/chat-header-layout.ts, restated here so the
 *  browser check cannot drift from the arithmetic the unit test pins. */
const nameTrackMinimum = (contentWidth: number, natural: number) =>
  Math.min(natural, Math.min(200, Math.max(96, contentWidth * 0.25)));

const more = (page: Page) => page.getByRole("button", { name: "More actions", exact: true });
const menu = (page: Page) => page.getByRole("menu", { name: "More header actions" });

for (const skin of SKINS) {
  test(`no control overlaps another and the name keeps its track at every container width (${skin})`, async (
    { page },
    info,
  ) => {
    await open(page, { skin });
    const rows: number[] = [];
    for (const width of WIDTHS) {
      await setWidth(page, width);
      const box = await headerBox(page);

      // 1. Nothing escapes the header, and the page never scrolls sideways.
      expect(box.scrollWidth, `${width}px: the header overflows by ${box.scrollWidth - box.clientWidth}px`)
        .toBeLessThanOrEqual(box.clientWidth + 1);
      expect(box.escape, `${width}px: a control runs ${Math.round(box.escape)}px past the header's edge`).toBeLessThanOrEqual(1);
      expect(box.documentScrollWidth, `${width}px: the document scrolls sideways`).toBeLessThanOrEqual(
        box.viewportWidth + 1,
      );

      // 2. THE REGRESSION: the bot name must still be readable. This is the
      //    assertion the shipped header fails at 390px with nameWidth 0.
      const minimum = nameTrackMinimum(box.contentWidth, box.nameNatural);
      expect(box.nameWidth, `${width}px: name track ${box.nameWidth}px < ${minimum}px`).toBeGreaterThanOrEqual(
        minimum - 0.5,
      );
      expect(box.nameWidth, `${width}px: the bot name has no width at all`).toBeGreaterThan(0);

      // 3. No two interactive rectangles may intersect.
      const found = await controls(page);
      for (let i = 0; i < found.length; i++) {
        for (let j = i + 1; j < found.length; j++) {
          const area = intersection(found[i]!.rect, found[j]!.rect);
          expect(
            area,
            `${width}px: "${found[i]!.name}" and "${found[j]!.name}" overlap by ${Math.round(area)}px²`,
          ).toBeLessThanOrEqual(1);
        }
      }

      // 4. Identity and Stop are never the thing that gets sacrificed.
      await expect(page.getByRole("button", { name: "Stop this turn", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: /profile$/ }).first()).toBeVisible();

      // 5. A wider column never needs MORE rows than a narrower one.
      rows.push(Number(box.rows));

      // Printed so the chosen layout is on the record, not just a boolean.
      // eslint-disable-next-line no-console
      console.log(
        `[chat header] ${skin} ${width}px → rows ${box.rows}, chips ${box.chips}, name ${Math.round(box.nameWidth)}px of ${Math.round(
          box.nameNatural,
        )}px natural, ${found.length} controls, header scrollWidth ${box.scrollWidth}/${box.clientWidth}`,
      );
      await page.screenshot({ path: info.outputPath(`header-${skin}-${width}.png`), fullPage: false });
    }
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i], `${WIDTHS[i]}px takes more rows than ${WIDTHS[i - 1]}px`).toBeLessThanOrEqual(rows[i - 1]!);
    }
  });
}

test("every width from 320 to 1024, eight pixels at a time: no threshold is a cliff", async ({ page }) => {
  // The layout has no fixed breakpoints to test either side of; every
  // threshold is where the measurement tips. So this walks the whole range
  // at 8px steps, which puts a sample within 4px of every transition, and
  // holds the same three rules at each: nothing escapes, the name keeps its
  // track, and nothing overlaps. Widening then never costs a control or a
  // row that narrowing did not.
  await open(page);
  const widths: number[] = [];
  for (let width = 320; width <= 1024; width += 8) widths.push(width);
  let previous = { relocated: 0, rows: 0 };
  const transitions: string[] = [];
  for (const width of [...widths].reverse()) {
    await setWidth(page, width);
    const box = await headerBox(page);
    expect(box.scrollWidth, `${width}px: the header overflows`).toBeLessThanOrEqual(box.clientWidth + 1);
    expect(box.escape, `${width}px: a control runs past the header's edge`).toBeLessThanOrEqual(1);
    expect(box.nameWidth, `${width}px: name track ${box.nameWidth}px`).toBeGreaterThanOrEqual(
      nameTrackMinimum(box.contentWidth, box.nameNatural) - 0.5,
    );
    const found = await controls(page);
    for (let i = 0; i < found.length; i++)
      for (let j = i + 1; j < found.length; j++)
        expect(
          intersection(found[i]!.rect, found[j]!.rect),
          `${width}px: "${found[i]!.name}" overlaps "${found[j]!.name}"`,
        ).toBeLessThanOrEqual(1);
    // Narrowing: never a control back out of the menu, never fewer rows.
    // (Raw button counts are not monotonic on purpose: the labelled second
    // row has room for the rename pencil that the compact one-row header
    // folds away.)
    const rowsNow = Number(box.rows);
    expect(box.relocated, `${width}px has fewer controls in the menu than ${width + 8}px`).toBeGreaterThanOrEqual(
      previous.relocated,
    );
    expect(rowsNow, `${width}px has fewer rows than ${width + 8}px`).toBeGreaterThanOrEqual(previous.rows);
    if (box.relocated !== previous.relocated || rowsNow !== previous.rows)
      transitions.push(`${width}px: ${box.relocated} in the menu, ${rowsNow} row(s), chips ${box.chips}, ${found.length} controls`);
    previous = { relocated: box.relocated, rows: rowsNow };
  }
  // eslint-disable-next-line no-console
  console.log(`[chat header] transitions, narrowing → ${transitions.join(" | ")}`);
  // And the same walk widening: the ladder restarts from the richest layout
  // on growth, so the picture must be the same in both directions.
  const widening: string[] = [];
  for (const width of widths) {
    await setWidth(page, width);
    const box = await headerBox(page);
    widening.push(`${width}:${box.relocated}/${box.rows}/${box.chips}`);
  }
  const narrowing: string[] = [];
  for (const width of widths) {
    await setWidth(page, 1024);
    await setWidth(page, width);
    const box = await headerBox(page);
    narrowing.push(`${width}:${box.relocated}/${box.rows}/${box.chips}`);
  }
  expect(widening, "the layout at a width depends on the direction it was reached from").toEqual(narrowing);
});

/** Every control, wherever it currently lives: in the header, or by name in
 *  the More menu. Leaves the menu closed again. */
async function reachable(page: Page): Promise<string> {
  const names = (await controls(page)).map((control) => control.name);
  if (await more(page).isVisible()) {
    await more(page).click();
    await expect(menu(page)).toBeVisible();
    names.push(...(await menu(page).getByRole("menuitem").allTextContents()));
    names.push(...(await menu(page).getByRole("menuitemcheckbox").allTextContents()));
    await page.keyboard.press("Escape");
    await expect(menu(page)).toHaveCount(0);
  }
  return names.join(" | ");
}

/** How many controls the header has moved into its menu. */
async function relocatedCount(page: Page): Promise<number> {
  return (await headerBox(page)).relocated;
}

test("every control is reachable at every width — relocated, never removed", async ({ page }, info) => {
  await open(page);
  // Lower-cased, because the same control is named "Memory" in the menu and
  // "Open memory for <bot>" in the header — the point is that it is THERE.
  const EVERY = [
    "usage",
    "inspector",
    "computer",
    "find in conversation",
    "memory",
    "task's files",
    "stop this turn",
    "all threads",
    "thread model",
  ];
  const counts: number[] = [];
  for (const width of WIDTHS) {
    await setWidth(page, width);
    const names = (await reachable(page)).toLowerCase();
    for (const control of EVERY) {
      expect(names, `${width}px: "${control}" is neither in the header nor in the menu`).toContain(control);
    }
    counts.push(await relocatedCount(page));
  }
  // Priority, not chance: a wider column never has MORE in the menu.
  for (let i = 1; i < counts.length; i++) {
    expect(counts[i], `${WIDTHS[i]}px relocates more than ${WIDTHS[i - 1]}px`).toBeLessThanOrEqual(counts[i - 1]!);
  }
  // eslint-disable-next-line no-console
  console.log(`[chat header] controls in the menu by width: ${WIDTHS.map((w, i) => `${w}:${counts[i]}`).join(" ")}`);

  await setWidth(page, 320);
  await more(page).click();
  await expect(menu(page)).toBeVisible();
  // Past the 0.2s pop-in, so the evidence shows the settled menu rather than
  // a half-faded one.
  await page.waitForTimeout(300);
  await page.screenshot({ path: info.outputPath("header-menu-320.png") });
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
});

test("Stop stops the selected task only, at every width", async ({ page }) => {
  // The fixture bot has two tasks and thread-1 open. Stop must name that
  // thread in its interrupt, whether it is a labelled pill or a folded icon.
  await open(page);
  for (const width of [1024, 320]) {
    await setWidth(page, width);
    const before = await page.evaluate(() => (window as unknown as Fixture).actions.length);
    await page.getByRole("button", { name: "Stop this turn", exact: true }).click();
    const actions = await page.evaluate(
      (from) => (window as unknown as Fixture).actions.slice(from),
      before,
    );
    expect(actions).toEqual([{ type: "interrupt", botId: "analyst", threadId: "thread-1" }]);
    // The fixture marks the bot idle on interrupt; put it back for the next width.
    await page.evaluate(() => {
      (window as unknown as { fixtureStore: { dispatch: (a: unknown) => void } }).fixtureStore.dispatch({ type: "updateBot", botId: "analyst", patch: { busy: true } });
    });
    await expect(page.getByRole("button", { name: "Stop this turn", exact: true })).toBeVisible();
  }
});

test("the menu is operable from the keyboard and gives focus back", async ({ page }) => {
  await open(page);
  await setWidth(page, 390);

  // Enter opens on the first item.
  await more(page).focus();
  await page.keyboard.press("Enter");
  await expect(menu(page)).toBeVisible();
  const items = menu(page).locator("[data-header-menu-item]");
  const count = await items.count();
  expect(count).toBeGreaterThan(0);
  await expect(items.first()).toBeFocused();

  // Arrows, End and Home move within the menu.
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(Math.min(1, count - 1))).toBeFocused();
  await page.keyboard.press("End");
  await expect(items.nth(count - 1)).toBeFocused();
  await page.keyboard.press("Home");
  await expect(items.first()).toBeFocused();

  // Escape closes and restores focus to the trigger.
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);
  await expect(more(page)).toBeFocused();

  // ArrowUp opens on the LAST item (WAI-ARIA menu button).
  await page.keyboard.press("ArrowUp");
  await expect(items.nth(count - 1)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(more(page)).toBeFocused();
});

test("a relocated toggle still toggles, and says so", async ({ page }) => {
  await open(page);
  await setWidth(page, 320);
  await more(page).click();
  const inspector = menu(page).getByRole("menuitemcheckbox", { name: /Inspector/ });
  await expect(inspector).toHaveAttribute("aria-checked", "false");
  await inspector.click();
  expect(await page.evaluate(() => (window as unknown as Fixture).actions.map((action) => action.type))).toContain("toggleInspector");
  expect(await page.evaluate(() => (window as unknown as Fixture).fixtureStore.state.inspectorOpen)).toBe(true);
  // Reopening shows the new state rather than a stale copy.
  await more(page).click();
  await expect(menu(page).getByRole("menuitemcheckbox", { name: /Inspector/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("the folder control opens the effective workspace, not settings", async ({ page }) => {
  await open(page);
  await setWidth(page, 1024);
  const chip = page.getByRole("button", { name: /^Open this task's files/ });
  // The complete resolved location travels with the friendly label, and a
  // task folder cannot read as the bot's default.
  await expect(chip).toHaveAttribute(
    "aria-label",
    "Open this task's files — This task's folder: /Users/fixture/Murage/analyst/tasks/q3-revenue-reconciliation",
  );
  await chip.click();
  expect(await page.evaluate(() => (window as unknown as Fixture).filesOpened)).toEqual([{ botId: "analyst", threadId: "thread-1" }]);
  expect(await page.evaluate(() => (window as unknown as Fixture).actions.map((action) => action.type))).not.toContain("toggleSettings");

  // At 320 the folder is the LAST control the header gives up, so it may be
  // in either place (folded to its icon if it stayed). Wherever it is, it
  // names the same action and carries the same resolved path, and it still
  // opens the workspace.
  await setWidth(page, 320);
  let control = page.getByRole("button", { name: /Open this task's files/ });
  if (!(await control.isVisible())) {
    await more(page).click();
    await expect(menu(page)).toBeVisible();
    control = menu(page).getByRole("menuitem", { name: /Open this task's files/ });
  }
  await expect(control).toHaveAccessibleName(/Open this task's files/);
  expect(
    (await control.getAttribute("aria-label")) ?? (await control.textContent()) ?? "",
    "the resolved location is not on the control at 320px",
  ).toContain("/Users/fixture/Murage/analyst/tasks/q3-revenue-reconciliation");
  await control.click();
  expect(await page.evaluate(() => (window as unknown as Fixture).filesOpened.length)).toBe(2);
});

test("a task with no folder of its own falls back to the bot's, and says which", async ({ page }) => {
  await open(page, { query: "?cwd=bot" });
  await setWidth(page, 1024);
  await expect(page.getByRole("button", { name: /^Open this bot's files/ })).toHaveAttribute(
    "aria-label",
    "Open this bot's files — This bot's folder: /Users/fixture/Murage/analyst",
  );
});

test("resizing changes no state: not the task, not the turn, not an open memory edit", async ({ page }) => {
  await open(page);
  // The layout at each width with nothing open, to compare against below.
  const closedLayouts = new Map<number, string>();
  for (const width of [...[...WIDTHS].reverse(), 280, 240, 200]) {
    await setWidth(page, width);
    const box = await headerBox(page);
    closedLayouts.set(width, `${box.rows}/${box.chips}/${box.relocated}`);
  }
  await setWidth(page, 1024);

  // Open the memory dialog while its trigger is in the header, type into it,
  // then narrow the column until the trigger has to move into the menu. The
  // launcher stays mounted and only the trigger moves, so neither the dialog
  // nor the half-written note may be discarded.
  await page.getByRole("button", { name: "Open memory for Quarterly Revenue Reconciliation & Board Narrative", exact: true }).click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog).toBeVisible();
  const draft = dialog.getByRole("textbox", { name: "Memory draft" });
  await draft.fill("half-written note");
  // Narrow until the trigger has actually left the header. Memory is one of
  // the last controls the ladder relocates, so where that happens is a
  // measurement, not a number to hard-code; what matters is that it did.
  // Read from the DOM, not a role query: while the modal dialog is open the
  // rest of the page is inert and a role query would report the trigger gone
  // at every width, proving nothing.
  const triggerInHeader = () =>
    page.evaluate(
      () => document.querySelector('[data-chat-header] button[aria-label^="Open memory for"]') !== null,
    );
  expect(await triggerInHeader()).toBe(true);
  let movedAt = 0;
  for (const width of [...[...WIDTHS].reverse(), 280, 240, 200]) {
    await setWidth(page, width);
    // The open dialog must not change the header's decision: it is not in
    // the row, so the layout at this width is the same as with it closed.
    const withDialog = await headerBox(page);
    expect(
      `${withDialog.rows}/${withDialog.chips}/${withDialog.relocated}`,
      `${width}px: the header laid out differently because a dialog is open`,
    ).toBe(closedLayouts.get(width));
    if (!(await triggerInHeader())) {
      movedAt = width;
      break;
    }
  }
  expect(movedAt, "the memory trigger never left the header, so nothing was proved").toBeGreaterThan(0);
  await expect(dialog, "narrowing the column closed an open memory edit").toBeVisible();
  await expect(draft, "narrowing the column discarded a memory edit in progress").toHaveValue("half-written note");
  // eslint-disable-next-line no-console
  console.log(`[chat header] memory trigger moved into the menu at ${movedAt}px; the open edit survived`);
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await setWidth(page, 1024);

  // A full sweep down and back up dispatches nothing.
  const before = await page.evaluate(() => (window as unknown as Fixture).actions.length);
  for (const width of [...WIDTHS].reverse()) await setWidth(page, width);
  for (const width of WIDTHS) await setWidth(page, width);
  const after = await page.evaluate(
    (from) => (window as unknown as Fixture).actions.slice(from).map((action) => action.type),
    before,
  );
  expect(after, `resizing dispatched ${after.join(", ")}`).toEqual([]);
  // And the turn is still running: Stop was never pressed for us.
  await expect(page.getByRole("button", { name: "Stop this turn", exact: true })).toBeVisible();
});

test("200% text scaling folds earlier instead of overlapping", async ({ page }, info) => {
  await open(page);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "32px";
  });
  for (const width of [1024, 640, 390]) {
    await setWidth(page, width);
    const box = await headerBox(page);
    expect(box.scrollWidth, `zoomed ${width}px: the header overflows`).toBeLessThanOrEqual(box.clientWidth + 1);
    expect(box.escape, `zoomed ${width}px: a control runs past the header's edge`).toBeLessThanOrEqual(1);
    // At 200% every rem-sized control doubles while the 15px name does not,
    // so the guaranteed quarter-track cannot always be met. What must still
    // hold is that the name is READABLE rather than a bare ellipsis.
    expect(box.nameWidth, `zoomed ${width}px: the bot name is down to ${box.nameWidth}px`).toBeGreaterThanOrEqual(40);
    const found = await controls(page);
    for (let i = 0; i < found.length; i++)
      for (let j = i + 1; j < found.length; j++)
        expect(
          intersection(found[i]!.rect, found[j]!.rect),
          `zoomed ${width}px: "${found[i]!.name}" overlaps "${found[j]!.name}"`,
        ).toBeLessThanOrEqual(1);
    // eslint-disable-next-line no-console
    console.log(`[chat header] 200% text, ${width}px → rows ${box.rows}, name ${Math.round(box.nameWidth)}px`);
    await page.screenshot({ path: info.outputPath(`header-zoom200-${width}.png`) });
  }
});

test("a short name keeps the controls that a long one costs", async ({ page }, info) => {
  await open(page, { query: "?name=short" });
  await setWidth(page, 640);
  const short = await headerBox(page);
  const shortControls = (await controls(page)).length;
  await page.screenshot({ path: info.outputPath("header-short-name-640.png") });

  await open(page);
  await setWidth(page, 640);
  const long = await headerBox(page);
  const longControls = (await controls(page)).length;
  await page.screenshot({ path: info.outputPath("header-long-name-640.png") });

  // The guarantee is not "the same layout regardless": a short name asks for
  // less track, so the header can afford at least as much as the long one.
  expect(shortControls).toBeGreaterThanOrEqual(longControls);
  expect(short.nameWidth).toBeGreaterThan(0);
  expect(long.nameWidth).toBeGreaterThan(0);
  // eslint-disable-next-line no-console
  console.log(
    `[chat header] 640px → short name: ${shortControls} controls (rows ${short.rows}); long name: ${longControls} controls (rows ${long.rows})`,
  );
});

test("an idle bot with no usage still reads as the same header", async ({ page }, info) => {
  await open(page, { query: "?busy=0&usage=0&role=member" });
  for (const width of [1024, 390]) {
    await setWidth(page, width);
    const box = await headerBox(page);
    expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1);
    expect(box.nameWidth).toBeGreaterThan(0);
    await expect(page.getByRole("button", { name: "Stop this turn", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Usage: / })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`header-idle-${width}.png`) });
  }
});

test("long translated labels fold earlier instead of overlapping", async ({ page }, info) => {
  // German and French run half again as long as English. The fixture's
  // pseudo-locale stretches EVERY string the header shows — Stop, Memory,
  // the menu, the folder action — and the same three rules must hold.
  await open(page, { query: "?labels=long" });
  await expect(page.getByRole("button", { name: /^Stop this turn — längere Übersetzung$/ })).toBeVisible();
  for (const width of WIDTHS) {
    await setWidth(page, width);
    const box = await headerBox(page);
    expect(box.scrollWidth, `long labels ${width}px: the header overflows`).toBeLessThanOrEqual(box.clientWidth + 1);
    expect(box.escape, `long labels ${width}px: a control runs past the header's edge`).toBeLessThanOrEqual(1);
    expect(box.nameWidth, `long labels ${width}px: name track ${box.nameWidth}px`).toBeGreaterThanOrEqual(
      nameTrackMinimum(box.contentWidth, box.nameNatural) - 0.5,
    );
    const found = await controls(page);
    for (let i = 0; i < found.length; i++)
      for (let j = i + 1; j < found.length; j++)
        expect(
          intersection(found[i]!.rect, found[j]!.rect),
          `long labels ${width}px: "${found[i]!.name}" overlaps "${found[j]!.name}"`,
        ).toBeLessThanOrEqual(1);
    // eslint-disable-next-line no-console
    console.log(`[chat header] long labels, ${width}px → rows ${box.rows}, chips ${box.chips}, ${found.length} controls`);
  }
  // The stretched menu still fits the column it opens in.
  await setWidth(page, 320);
  const moreLong = page.getByRole("button", { name: /^More actions/ });
  await moreLong.click();
  const menuLong = page.getByRole("menu", { name: /^More header actions/ });
  await expect(menuLong).toBeVisible();
  const menuBox = (await menuLong.boundingBox())!;
  const column = (await page.locator("#column").boundingBox())!;
  expect(menuBox.x + menuBox.width, "the menu escapes the column").toBeLessThanOrEqual(column.x + column.width + 1);
  await page.waitForTimeout(300);
  await page.screenshot({ path: info.outputPath("header-long-labels-menu-320.png") });
  await page.keyboard.press("Escape");
});

test("a real phone viewport, where the drawer button owns the corner too", async ({ page }, info) => {
  // Every other test here narrows the COLUMN inside a wide window, which is
  // the case a viewport breakpoint would miss. This one is the other half:
  // an actual 390x844 phone, where `pl-11` reserves the top-left corner for
  // the drawer button and the header has 44px less to spend.
  await open(page, { skin: "light" });
  await page.setViewportSize({ width: 390, height: 844 });
  await setWidth(page, 390);
  const box = await headerBox(page);
  expect(box.scrollWidth, "the header overflows a 390px phone").toBeLessThanOrEqual(box.clientWidth + 1);
  expect(box.escape, "a control runs past the header's edge on a 390px phone").toBeLessThanOrEqual(1);
  expect(box.documentScrollWidth, "a 390px phone scrolls sideways").toBeLessThanOrEqual(box.viewportWidth + 1);
  expect(box.nameWidth, `the bot name is ${box.nameWidth}px on a phone`).toBeGreaterThanOrEqual(
    nameTrackMinimum(box.contentWidth, box.nameNatural) - 0.5,
  );
  const found = await controls(page);
  for (let i = 0; i < found.length; i++)
    for (let j = i + 1; j < found.length; j++)
      expect(
        intersection(found[i]!.rect, found[j]!.rect),
        `phone: "${found[i]!.name}" overlaps "${found[j]!.name}"`,
      ).toBeLessThanOrEqual(1);
  // Nothing may sit under the drawer button's corner.
  const corner = found.filter((control) => control.rect.x < 44 && control.rect.y < 44);
  expect(corner.map((control) => control.name), "a control sits under the drawer button").toEqual([]);
  // eslint-disable-next-line no-console
  console.log(
    `[chat header] 390x844 phone → rows ${box.rows}, content ${Math.round(box.contentWidth)}px, name ${Math.round(box.nameWidth)}px, ${found.length} controls`,
  );
  await page.screenshot({ path: info.outputPath("header-phone-390.png") });
});
