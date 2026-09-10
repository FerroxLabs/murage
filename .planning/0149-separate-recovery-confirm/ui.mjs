import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const output=path.dirname(fileURLToPath(import.meta.url)), root=path.resolve(output,'../..');
const assets=Object.fromEntries(await Promise.all(['index.html','renderer.js','recovery.css'].map(async name=>[name,await readFile(path.join(root,'electron/recovery',name))])));
const browser=await chromium.launch({headless:true}); const results=[];
try { for(const skin of ['light','dark']) for(const width of [390,1000]) {
  const page=await browser.newPage({viewport:{width,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{const name=new URL(route.request().url()).pathname.slice(1);assert.ok(assets[name]);return route.fulfill({body:assets[name],contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'});});
  await page.addInitScript(({skin})=>{
    window.fixtureCalls=[];
    const state={available:false,separateAvailable:true,busy:false,selection:null,context:{skin,reason:'Foreign-host ownership requires recovery.',dataDirectory:'C:\\Users\\Fixture\\.murage',ownership:{claimKind:'primary',recordedHost:'<img src=x onerror="alert(1)">',currentHost:'FIXTURE-RENAMED',code:'LEASE_FOREIGN_HOST'}}};
    window.murageRecovery={action:async(action,id)=>{window.fixtureCalls.push({action,id});if(action==='choose-separate-backup')state.selection={id:'selection-1',name:'Private snapshot.zip',separate:true,destination:'C:\\Users\\Fixture\\AppData\\Roaming\\Murage\\recovered-installations\\fixture\\data',snapshotId:'snapshot-1',sha256:'a'.repeat(64),omittedCount:1,missingCount:0};return structuredClone(state);}};
  },{skin});
  await page.goto('http://recovery.fixture/index.html',{waitUntil:'networkidle'});
  await page.getByRole('button',{name:'Choose backup for separate installation',exact:true}).click();
  await page.getByRole('button',{name:'Restore separately and restart for review',exact:true}).waitFor();
  assert.equal(await page.locator('#ownership-summary img').count(),0);
  assert.ok((await page.locator('#ownership-summary').innerText()).includes('<img'));
  assert.ok((await page.locator('#separate-recovery').innerText()).includes('Newer conversations and deletion records'));
  for(const action of ['backup','rollback','review-installation','activate','choose-backup'])assert.equal(await page.locator(`button[data-action="${action}"]`).isDisabled(),true);
  assert.equal(await page.locator('#restore').isVisible(),false);
  await page.locator('#restore-separate').click();
  await page.waitForFunction(()=>!document.querySelector('#restore-separate').disabled);
  assert.deepEqual(await page.evaluate(()=>window.fixtureCalls),[{action:'state',id:undefined},{action:'choose-separate-backup',id:undefined},{action:'restore-separate',id:'selection-1'}]);
  await page.screenshot({path:path.join(output,`recovery-${width}-${skin}.png`),fullPage:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.deepEqual(errors,[]);results.push({skin,width,result:'PASS',scope:'Actual recovery HTML/renderer, fake trusted bridge; native dialog separate'});await page.close();
}await writeFile(path.join(output,'ui.json'),JSON.stringify(results,null,2)+'\n');console.log('4 recovery UI layouts PASS');}finally{await browser.close();}
