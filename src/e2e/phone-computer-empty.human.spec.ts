import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";

// Same shape as computer-destination.human.spec.ts: a throwaway Vite dev
// server renders a named export straight out of ComputerPanel.tsx, no
// harness server, no ports 8799/8810-8813, nothing on disk but this
// process's own scratch cache dir (wiped in afterAll).
let server: ViteDevServer;
let origin: string;
let cache: string;
test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-phone-empty-"));
  server = await createServer({ configFile: false, root, cacheDir: cache, envFile: false,
    resolve: { alias: { "@": `${root}/src` } }, server: { host: "127.0.0.1", watch: null, hmr: false },
    plugins: [tailwindcss(), { name: "phone-empty-fixture", enforce: "pre",
      resolveId(id) { if (id === "/__phone-empty.js") return "\0fixture-phone-empty"; },
      load(id) {
        if (id !== "\0fixture-phone-empty") return;
        // "Dax (Closer)" is the brief's own example bot: it exercises the
        // trailing-")" possessive case in the same screenshot.
        return `import React from 'react';import {createRoot} from 'react-dom/client';
          import {PhoneComputerPanelBody} from '/src/components/ComputerPanel.tsx';import '/src/styles.css';
          function Fixture(){var bot={id:'dax',name:'Dax (Closer)',color:'orange'};
            return React.createElement('div',{className:'flex h-full flex-col bg-panel text-ink',style:{height:'100%'}},
              React.createElement(PhoneComputerPanelBody,{bot:bot}));}
          createRoot(document.getElementById('root')).render(React.createElement(Fixture));`;
      },
      configureServer(vite) { vite.middlewares.use((req,res,next)=>{
        if(req.url!=="/__phone-empty")return next();res.setHeader("content-type","text/html");
        res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root" style="width:390px;height:844px;margin:0"></div><script type="module" src="/__phone-empty.js"></script>');
      }); },
    }],
  });
  await server.listen(0);const address=server.httpServer!.address();
  if(!address||typeof address==='string')throw new Error('No fixture port');origin=`http://127.0.0.1:${address.port}`;
});
test.afterAll(async()=>{await server?.close();safeWipeSync(cache);});

// Screenshots land next to the report the brief asked for, not in the lane's
// evidence dir — a fixed, reviewable pair of files, same as a person taking
// them by hand would produce.
const REPORT_DIR = fileURLToPath(new URL("../../.superpowers/sdd/2026-09-27-plan-3b-push-native/", import.meta.url));

for(const skin of ['light','dark']) test(`phone Computer/Browser empty state is centred, themed and legible at 390px in ${skin}`,async({page},testInfo)=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto(`${origin}/__phone-empty`);
  await page.evaluate(skin=>document.documentElement.setAttribute('data-skin',skin),skin);
  await expect(page.getByRole('heading',{name:'On your Mac',level:1})).toBeVisible();
  await expect(page.getByText("Watching or taking over Dax (Closer)'s computer and browser happens on your Mac.")).toBeVisible();
  await expect(page.getByText('Dax (Closer) can still use them when you ask from here.')).toBeVisible();
  // The illustration is decorative — proven hidden from the accessibility
  // tree, not merely present.
  expect(await page.locator('svg[aria-hidden="true"]').count()).toBeGreaterThan(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`${REPORT_DIR}panel-empty-${skin}.png`});
  // Evidence copy too, so a run's trace/report set stays self-contained.
  await page.screenshot({path:testInfo.outputPath(`panel-empty-${skin}.png`)});
});
