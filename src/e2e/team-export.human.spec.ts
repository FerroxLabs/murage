import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
let server: ViteDevServer, origin: string, cache: string;
test.beforeAll(async()=>{
  const root=fileURLToPath(new URL('../../',import.meta.url));cache=mkdtempSync(join(tmpdir(),'murage-export-ui-'));
  server=await createServer({configFile:false,root,cacheDir:cache,envFile:false,resolve:{alias:{'@':`${root}/src`}},server:{host:'127.0.0.1',watch:null,hmr:false},plugins:[tailwindcss(),{
    name:'export-fixture',resolveId(id){if(id==='/__export.js')return '\0fixture-export';},load(id){if(id!=='\0fixture-export')return;return `import React from 'react';import {createRoot} from 'react-dom/client';import {TeamExportDialog} from '/src/components/TeamExportDialog.tsx';import '/src/styles.css';createRoot(document.getElementById('root')).render(React.createElement(TeamExportDialog,{onClose:()=>{},onExported:()=>{}}));`;},
    configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url!=='/__export')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/__export.js"></script>');});},
  }]});await server.listen(0);const address=server.httpServer!.address();if(!address||typeof address==='string')throw new Error('No fixture port');origin=`http://127.0.0.1:${address.port}`;
});
test.afterAll(async()=>{await server?.close();rmSync(cache,{recursive:true,force:true});});
const options={bots:[{id:'a',key:'a',name:'Researcher',playbookKeys:['research']}],playbooks:[{key:'research',name:'Research playbook'}],routines:[{id:'r',key:'r',name:'Daily review',botId:'a',supported:true}]};
test('selection review gates downloads and stale previews require another review',async({page},testInfo)=>{
  await page.setViewportSize({width:390,height:844});
  await page.route('**/api/desktop-secret',route=>route.fulfill({json:{secret:'fixture-secret'}}));
  const requests:any[]=[];let stale=true;
  await page.route('**/api/teams/export',async route=>{
    const body=route.request().postDataJSON();requests.push(body);
    if(body.action==='options')return route.fulfill({json:options});
    if(body.action==='preview')return route.fulfill({json:{name:'Selected',members:1,previewHash:'review-hash',markdown:'# Exact selected instructions',scan:{blocked:false,reviewRequired:true,findings:[{path:'instructions.md',rule:'environment-lookup',line:1}]}}});
    if(stale){stale=false;return route.fulfill({status:409,json:{error:'Contents changed.'}});}
    return route.fulfill({json:{name:'Selected',members:1,markdown:'# Selected package'}});
  });
  await page.goto(`${origin}/__export`);
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('button',{name:'Preview selection'})).toBeDisabled();
  await page.getByRole('checkbox',{name:'Researcher',exact:true}).check();
  await page.getByRole('button',{name:'Preview selection'}).click();
  await expect(page.getByRole('button',{name:'Download package'})).toBeDisabled();
  await page.getByText('Review exported text',{exact:true}).click();
  await expect(page.getByText('# Exact selected instructions',{exact:true})).toBeVisible();
  await page.getByRole('checkbox',{name:'Research playbook',exact:true}).check();
  await expect(page.getByRole('button',{name:'Download package'})).toHaveCount(0);
  await page.getByRole('button',{name:'Preview selection'}).click();
  await page.getByRole('checkbox',{name:/I reviewed the warnings/}).check();
  await page.getByRole('button',{name:'Download package'}).click();
  await expect(page.getByRole('alert')).toContainText('Preview the selection again');
  await expect(page.getByRole('button',{name:'Download package'})).toHaveCount(0);
  await page.getByRole('button',{name:'Preview selection'}).click();
  await expect(page.getByRole('checkbox',{name:/I reviewed the warnings/})).not.toBeChecked();
  await page.getByRole('checkbox',{name:/I reviewed the warnings/}).check();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('export-reviewed-mobile.png')});
  const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'Download package'}).click();
  expect((await downloaded).suggestedFilename()).toBe('selected.md');
  expect(requests.filter(item=>item.action==='download').at(-1)).toMatchObject({selection:{botIds:['a'],playbookKeys:['research'],routineIds:[]},previewHash:'review-hash',acknowledgeWarnings:true});
});
test('blocked scan never renders payload content or enables download',async({page})=>{
  await page.route('**/api/desktop-secret',route=>route.fulfill({json:{secret:'fixture-secret'}}));
  await page.route('**/api/teams/export',route=>route.fulfill({json:route.request().postDataJSON().action==='options'?options:{name:'Blocked',members:1,previewHash:'blocked',markdown:'FAKE_SECRET_MUST_NOT_RENDER',scan:{blocked:true,reviewRequired:true,findings:[{path:'instructions.md',rule:'provider-token'}]}}}));
  await page.goto(`${origin}/__export`);await page.getByRole('checkbox',{name:'Researcher',exact:true}).check();
  await page.getByRole('button',{name:'Preview selection'}).click();
  await expect(page.getByRole('alert')).toContainText('Export blocked');
  await expect(page.getByRole('button',{name:'Download package'})).toBeDisabled();
  await expect(page.getByText('FAKE_SECRET_MUST_NOT_RENDER')).toHaveCount(0);
});
