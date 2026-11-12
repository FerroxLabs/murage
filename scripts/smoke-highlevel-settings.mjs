// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Isolated Electron interaction smoke of the production Settings component.
// Explicit offline Electron binary required; no account, server or credentials.
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { safeWipeSync } from "../server/testing/safe-wipe.mjs";

const args = process.argv.slice(2);
const option = flag => args[args.indexOf(flag) + 1];
if (!args.includes("--electron") || !args.includes("--out")) throw Error("Explicit --electron and --out are required");
const executable = resolve(option("--electron")), out = resolve(option("--out"));
const root = mkdtempSync(join(tmpdir(), "murage-highlevel-renderer-"));
mkdirSync(out, { recursive: true });
const bundle = join(root, "renderer.js"), html = join(root, "index.html"), main = join(root, "main.cjs");
try {
  await build({ absWorkingDir: process.cwd(), bundle: true, outfile: bundle, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' },
    stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
      import { createElement } from 'react'; import { createRoot } from 'react-dom/client';
      import { HighLevelSettings } from './src/components/HighLevelSettings';
      import { defaultHighLevelFamilies } from './shared/highlevel';
      import { fixture } from '@/state/store';
      const families = {...defaultHighLevelFamilies(), contacts:'full', forms:'off', payments:'change'};
      const access = {grantsVersion:2, roleBinding:'owner', revision:1, denyRules:[], grants:[{toolkit:'highlevel', accountId:'hl_fixture', botId:'b1', revision:1, ceiling:'propose', tools:[], families, operations:{contacts:['contacts.get','contacts.tags.add']}}]};
      const scope = {present:['contacts.write'],missing:[],missingNames:[],canRead:true,canChange:true,canFull:true};
      fixture.view = {tokenSaved:true,redacted:false,connection:{connectionId:'hl_fixture',locationId:'loc_fixture',state:'connected',confirmedAt:'fixture'}, bots:[{botId:'b1',offered:true,access}],familyScopes:{contacts:scope,payments:scope}};
      const root = createRoot(document.getElementById('root')); let key=0;
      fixture.render = () => root.render(createElement(HighLevelSettings,{key:++key}));
      window.fixture=fixture; fixture.render();
    ` },
    plugins: [{ name: "isolated-settings-store", setup(api) {
      api.onResolve({ filter: /^@\/state\/store$/ }, () => ({ path: "fixture-store", namespace: "fixture" }));
      api.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ loader: "js", contents: `
        export const fixture={calls:[],view:null};
        export const useStore=()=>({state:{bots:[{id:'b1',name:'Fixture bot'}]}});
        export async function api(path,init){
          fixture.calls.push({path,...init});
          if(init?.method==='PUT'){
            const grants=JSON.parse(init.body).grants, access=fixture.view.bots[0].access;
            access.grants=grants.map(row=>({...access.grants[0],families:row.families}));
          }
          return fixture.view;
        }
      ` }));
    } }],
  });
  writeFileSync(html, '<!doctype html><html lang="en"><body><div id="root"></div><script src="renderer.js"></script></body></html>');
  writeFileSync(main, String.raw`
    const {app,BrowserWindow,session}=require('electron'), fs=require('node:fs'),assert=require('node:assert/strict');
    app.disableHardwareAcceleration();
    app.setPath('userData',${JSON.stringify(join(root, "profile"))});
    const checks=[],report=${JSON.stringify(join(out, "renderer.json"))};
    app.whenReady().then(async()=>{
      session.defaultSession.webRequest.onBeforeRequest((details,done)=>done({cancel:!details.url.startsWith('file:')&&!details.url.startsWith('data:')}));
      const win=new BrowserWindow({show:true,width:1000,height:1200,webPreferences:{nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});
      const run=source=>win.webContents.executeJavaScript(source);
      const wait=async source=>{for(let i=0;i<200;i++){if(await run(source))return;await new Promise(r=>setTimeout(r,25));}throw Error('Renderer wait failed: '+source);};
      try {
        await win.loadFile(${JSON.stringify(html)});
        await wait('document.querySelector(\'[role="switch"]\')!==null');
        assert.equal(await run('document.querySelectorAll("select").length'),0);
        await run('document.querySelector(\'[role="switch"]\').click()');
        await wait('fixture.calls.some(c=>c.method==="PUT")');
        const saved=await run('JSON.parse(fixture.calls.find(c=>c.method==="PUT").body).grants[0]');
        assert.equal(saved.families.contacts,'read');assert.equal(saved.families.payments,'read');assert.equal(saved.families.forms,'off');assert.equal(saved.broaden,undefined);
        checks.push('simple-downgrade-preserves-off-and-reads-without-broadening');
        await wait('!document.querySelector(\'[role="switch"]\').disabled');
        await run('[...document.querySelectorAll("button")].find(b=>b.textContent==="Advanced").click()');
        await wait('document.querySelectorAll("select").length===17');
        await run('const s=document.querySelector(\'select[aria-label="Contacts"]\');s.value="full";s.dispatchEvent(new Event("change",{bubbles:true}))');
        await wait('fixture.calls.filter(c=>c.method==="PUT").length===2');
        const full=await run('JSON.parse(fixture.calls.filter(c=>c.method==="PUT")[1].body).grants[0]');
        assert.equal(full.families.contacts,'full');assert.deepEqual(full.broaden,{contacts:true});checks.push('advanced-explicit-family-full-control');
        await wait('document.querySelector(\'select[aria-label="Contacts"]\')?.value==="full" && !document.querySelector(\'select[aria-label="Contacts"]\')?.disabled');
        await run('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
        await win.webContents.capturePage().then(image=>fs.writeFileSync(${JSON.stringify(join(out, "settings.png"))},image.toPNG()));
        await run('fixture.view.familyScopes={};fixture.view.bots=[{botId:"b1",offered:true}];fixture.render()');
        await wait('document.querySelector(\'[role="switch"]\')?.disabled===true');
        checks.push('unverified-scopes-block-write-upgrades');
        await run('fixture.view.redacted=true;fixture.render()');
        await wait('document.querySelector(\'[role="switch"]\')?.disabled===true');
        checks.push('redacted-phone-cannot-upgrade');
        fs.writeFileSync(report,JSON.stringify({ok:true,electron:process.versions.electron,checks,providerCalls:0,kind:'isolated-production-component; fixture store; no packaged-main/preload proof'},null,2));app.exit(0);
      } catch(error){fs.writeFileSync(report,JSON.stringify({ok:false,checks,error:String(error.stack)},null,2));app.exit(1);}
    }).catch(error=>{console.error(error);app.exit(1)});
  `);
  const env = { ...process.env, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"), GSETTINGS_BACKEND: "memory", MURAGE_DATA_DIR: join(root, "data") };
  if (args.includes("--library-path")) env.LD_LIBRARY_PATH = resolve(option("--library-path"));
  const child = spawn(executable, ["--no-sandbox", "--disable-gpu", main], { env, stdio: "inherit" });
  const timer = setTimeout(() => child.kill("SIGTERM"), 60_000);
  try {
    const result = await new Promise((done, reject) => { child.once("error", reject); child.once("exit", (code, signal) => done({ code, signal })); });
    if (result.code !== 0) throw Error('Electron renderer smoke failed: ' + JSON.stringify(result));
    console.log(readFileSync(join(out, "renderer.json"), "utf8"));
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGTERM"); }
} finally { safeWipeSync(root); }
