import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let server: ViteDevServer;
let origin: string;
let cache: string;
test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  cache = mkdtempSync(join(tmpdir(), "murage-destination-"));
  server = await createServer({ configFile: false, root, cacheDir: cache, envFile: false,
    resolve: { alias: { "@": `${root}/src` } }, server: { host: "127.0.0.1", watch: null, hmr: false },
    plugins: [tailwindcss(), { name: "destination-fixture", enforce: "pre",
      resolveId(id) { if (id === "/__destination.js") return "\0fixture-destination"; },
      load(id) {
        if (id !== "\0fixture-destination") return;
        return `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
          import {ComputerDestinationGrid} from '/src/components/ComputerPanel.tsx';import '/src/styles.css';
          function Fixture(){const [value,setValue]=useState('auto');return React.createElement(ComputerDestinationGrid,{value,unavailable:{browser:'Interactive browser is unavailable here'},onSelect:setValue});}
          createRoot(document.getElementById('root')).render(React.createElement(Fixture));`;
      },
      configureServer(vite) { vite.middlewares.use((req,res,next)=>{
        if(req.url!=="/__destination")return next();res.setHeader("content-type","text/html");
        res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root" style="max-width:390px;padding:16px"></div><script type="module" src="/__destination.js"></script>');
      }); },
    }],
  });
  await server.listen(0);const address=server.httpServer!.address();
  if(!address||typeof address==='string')throw new Error('No fixture port');origin=`http://127.0.0.1:${address.port}`;
});
test.afterAll(async()=>{await server?.close();rmSync(cache,{recursive:true,force:true});});

for(const skin of ['light','dark']) test(`computer destination grid is equal and usable at 390px in ${skin}`,async({page},testInfo)=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto(`${origin}/__destination`);
  await page.evaluate(skin=>document.documentElement.setAttribute('data-skin',skin),skin);
  const grid=page.getByRole('group',{name:'Computer destination'});
  const choices=grid.getByRole('button');
  await expect(choices).toHaveCount(6);
  await expect(page.getByRole('button',{name:'Auto',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(page.getByRole('button',{name:'Browser',exact:true})).toBeDisabled();
  await expect(grid.getByText('Interactive browser is unavailable here')).toBeVisible();
  await page.getByRole('button',{name:'Cloud',exact:true}).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button',{name:'Cloud',exact:true})).toHaveAttribute('aria-pressed','true');
  for(const name of ['Local VM','This computer','Off','Auto']){
    await page.getByRole('button',{name,exact:true}).click();
    await expect(page.getByRole('button',{name,exact:true})).toHaveAttribute('aria-pressed','true');
  }
  const sizes=await choices.evaluateAll(buttons=>buttons.map(button=>({width:button.getBoundingClientRect().width,height:button.getBoundingClientRect().height})));
  expect(new Set(sizes.map(size=>size.width)).size).toBe(1);
  expect(new Set(sizes.map(size=>size.height)).size).toBe(1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath(`computer-destination-${skin}.png`)});
});
