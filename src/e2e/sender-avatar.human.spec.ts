import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
let server: ViteDevServer, origin: string, cache: string;
test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url)); cache = mkdtempSync(join(tmpdir(), "murage-sender-avatar-"));
  server = await createServer({ configFile: false, root, envFile: false, cacheDir: cache, resolve: { alias: { "@": root + "/src" } }, server: { host: "127.0.0.1", watch: null, hmr: false }, plugins: [tailwindcss(), {
    name: "sender-avatar-fixture", resolveId(id) { if (id === "/__avatar.js") return "\0avatar"; }, load(id) { if (id !== "\0avatar") return; return `
      import React from 'react';import{createRoot}from'react-dom/client';import{CommAvatar}from'/src/components/CommAvatar.tsx';import'/src/styles.css';
      document.documentElement.dataset.skin=new URLSearchParams(location.search).get('skin')||'light';
      const comm={groupId:'room',withBotId:'sable',withName:'Sable',withColor:'blue'};
      const bots=[{id:'finch',name:'Finch',color:'blue',avatarCrop:'circle',avatarUrl:'/api/attachments/recipient.png'},{id:'sable',name:'Sable',color:'blue',avatarCrop:'circle',avatarUrl:'/api/attachments/sender.png'}];
      createRoot(document.getElementById('root')).render(React.createElement('button',{style:{display:'flex',alignItems:'center',gap:8,padding:12}},React.createElement(CommAvatar,{comm,bots}),'Message from @Sable'));`; },
    configureServer(vite) { vite.middlewares.use((req,res,next)=>{if(req.url !== '/__avatar' && !req.url?.startsWith('/__avatar?'))return next();res.setHeader('content-type','text/html');res.end('<body style="background:var(--color-app);color:var(--color-ink);padding:24px"><main id="root"></main><script type="module" src="/__avatar.js"></script>');}); },
  }] });
  await server.listen(0);const address=server.httpServer!.address();if(!address||typeof address==='string')throw Error('No fixture port');origin=`http://127.0.0.1:${address.port}`;
});
test.afterAll(async()=>{await server?.close();rmSync(cache,{recursive:true,force:true});});
for(const skin of ['light','dark'])test('sender custom avatar and failed-image fallback in '+skin,async({page},info)=>{
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.route('**/api/attachments/sender.png',route=>route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=','base64')}));
  await page.goto(origin+'/__avatar?skin='+skin); const avatar=page.getByRole('img',{name:'Sable avatar'});await expect(avatar).toBeVisible();await expect(avatar).toHaveAttribute('src','/api/attachments/sender.png');expect(await avatar.evaluate((img:HTMLImageElement)=>img.complete&&img.naturalWidth>0)).toBe(true);
  await page.screenshot({path:info.outputPath('sender-'+skin+'.png')});
  await avatar.dispatchEvent('error');await expect(page.locator('img')).toHaveCount(0);await expect(page.getByRole('button',{name:/Message from @Sable/})).toBeVisible();await page.screenshot({path:info.outputPath('sender-fallback-'+skin+'.png')});
});
