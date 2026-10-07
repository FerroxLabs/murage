// SPDX-License-Identifier: AGPL-3.0-or-later
// Isolated component fixture, not server integration or branded-browser proof.
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { resolve, join, dirname, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { chromium } from "@playwright/test";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(root, "artifacts/browser-extension/app-ui-" + new Date().toISOString().replace(/[:.]/g,"-"));
const fixture = join(output,"fixture"); await mkdir(fixture,{recursive:true});
const stub = join(fixture,"store.ts");
await writeFile(stub, `
export const calls = []; window.fixtureCalls = calls;
const mode = new URLSearchParams(location.search).get('mode');
let status = {profiles:mode==='offline'?[]:[{profileId:'profile_one',browser:'Chrome'},{profileId:'profile_two',browser:'Edge'}],bindings:mode==='offline'?[]:[{bindingId:'binding_one',botId:'fixture_bot',threadId:'fixture_thread',profileId:'profile_one',state:'active',sites:{'https://example.com':'ask'}}],helper:{running:true,reason:'Install the development extension and register its helper to connect.'},storeUrl:null};
export async function api(path,options={}) {
 const body=options.body?JSON.parse(options.body):undefined;calls.push({path,method:options.method||'GET',body});
 if(mode==='error'&&options.method!=='PATCH') throw new Error('Fixture connection unavailable. Check the helper, then try again.');
 if(options.method==='PATCH')return {bot:{...window.fixtureBot,...body}};
 if(options.method==='POST'&&body.action==='stop')status={...status,bindings:status.bindings.map(b=>b.bindingId===body.bindingId?{...b,state:'stopped'}:b)};
 if(options.method==='POST'&&body.action==='pause')status={...status,bindings:status.bindings.map(b=>b.bindingId===body.bindingId?{...b,state:'paused'}:b)};
 if(options.method==='POST'&&body.action==='site')status={...status,bindings:status.bindings.map(b=>b.bindingId===body.bindingId?{...b,sites:{...b.sites,[body.origin]:body.access}}:b)};
 return structuredClone(status);
}
export function useStore(){return {state:{config:{}},dispatch(action){if(action.type==='botPatched'){window.fixtureBot=action.bot;window.dispatchEvent(new Event('fixture-bot'));}}};}
`);
await writeFile(join(fixture,"styles.css"), `@import ${JSON.stringify(join(root,"src/styles.css"))};\n@source ${JSON.stringify(join(root,"src/components/BrowserExtensionPanel.tsx"))};\n@source "./main.tsx";`);
await writeFile(join(fixture,"main.tsx"), `import React,{useState,useEffect} from 'react';import{createRoot}from'react-dom/client';import${JSON.stringify(join(fixture,"styles.css"))};import{BrowserExtensionPanel}from${JSON.stringify(join(root,"src/components/BrowserExtensionPanel.tsx"))};window.fixtureBot={id:'fixture_bot',name:'Mira',useMyChrome:true,browserTransport:'extension',browserExtensionProfileId:'profile_one'};function Fixture(){const[bot,setBot]=useState(window.fixtureBot);useEffect(()=>{const update=()=>setBot({...window.fixtureBot});window.addEventListener('fixture-bot',update);return()=>window.removeEventListener('fixture-bot',update)},[]);return <main style={{maxWidth:640,margin:'0 auto',padding:16}}><h1 className="text-lg text-ink mb-3">Browser settings</h1><h2 className="text-base text-ink-secondary mb-3">Mira</h2><BrowserExtensionPanel bot={bot}/></main>};createRoot(document.getElementById('root')!).render(<Fixture/>);`);
await writeFile(join(fixture,"index.html"), '<!doctype html><html lang="en" data-skin="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0a0a0a"><title>Browser settings fixture</title></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>');
await build({configFile:false,root:fixture,publicDir:false,logLevel:"error",plugins:[react(),tailwind()],resolve:{alias:[{find:"@/state/store",replacement:stub},{find:"@",replacement:join(root,"src")}]},build:{outDir:join(output,"dist"),emptyOutDir:true}});
const dist=join(output,"dist");
const server=createServer(async(req,res)=>{try{let name=new URL(req.url,'http://fixture').pathname;if(name==='/favicon.ico'){res.writeHead(204);res.end();return;}if(name==='/')name='/index.html';const file=resolve(dist,'.'+decodeURIComponent(name));if(!file.startsWith(dist+'/'))throw Error();const data=await readFile(file);res.setHeader('Content-Type',({'.html':'text/html','.js':'application/javascript','.css':'text/css','.woff2':'font/woff2'})[extname(file)]||'application/octet-stream');res.end(data);}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port;
const receipt={scope:'Actual BrowserExtensionPanel with isolated mocked API and real app CSS; no server integration',output,checks:[],screenshots:[],lighthouse:null};
let browser;
try{
 browser=await chromium.launchPersistentContext(join(output,'profile'),{headless:true,args:['--remote-debugging-port=0'],viewport:{width:390,height:844}});
 const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
 const require=createRequire(import.meta.url),axe=await readFile(require.resolve('axe-core/axe.min.js'),'utf8');
 if(!process.argv.includes("--offline-only")){
 for(const width of [390,820,1440]){
  await page.setViewportSize({width,height:900});await page.goto(url);await page.getByText('Browser profile connected',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  const shot=join(output,String(width)+'.png');await page.screenshot({path:shot,fullPage:true});receipt.screenshots.push(shot);
  await page.addScriptTag({content:axe});const audit=await page.evaluate(async()=>await window.axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}));
  await writeFile(join(output,'axe-'+width+'.json'),JSON.stringify(audit,null,2));assert.equal(audit.violations.filter(v=>['critical','serious'].includes(v.impact)).length,0);
  receipt.checks.push({name:'layout-and-axe-'+width,pass:true});
 }
 await page.setViewportSize({width:390,height:844});await page.goto(url);await page.getByRole('button',{name:'Stop',exact:true}).waitFor();
 const focus=[];await page.locator('body').click({position:{x:1,y:1}});
 for(let i=0;i<5;i++){await page.keyboard.press('Tab');focus.push(await page.evaluate(()=>{const e=document.activeElement,s=getComputedStyle(e);return {tag:e.tagName,label:e.getAttribute('aria-label')||e.textContent,visible:s.outlineStyle!=='none'&&parseFloat(s.outlineWidth)>0||s.boxShadow!=='none',focusVisible:e.matches(':focus-visible'),outlineStyle:s.outlineStyle,outlineWidth:s.outlineWidth,outlineColor:s.outlineColor,height:e.getBoundingClientRect().height};}));if(focus.at(-1).tag==='SELECT')await page.screenshot({path:join(output,'focused-select-'+i+'.png'),fullPage:true});}
 receipt.checks.push({name:'keyboard-focus-targets',pass:focus.every(item=>item.visible&&item.height>=44),focus});assert(focus.some(item=>item.label==='Stop'));assert(focus.every(item=>item.visible&&item.height>=44));
 const select=page.getByRole('combobox',{name:'Connected browser profile'});await select.focus();await page.keyboard.press('e');
 await page.waitForFunction(()=>window.fixtureCalls.some(call=>call.method==='PATCH'&&call.body.browserExtensionProfileId==='profile_two'));
 receipt.checks.push({name:'keyboard-profile-selection',pass:true});
 await page.getByRole('button',{name:'Stop',exact:true}).focus();await page.keyboard.press('Enter');await page.getByText('Stopped by you',{exact:true}).waitFor();assert(await page.getByRole('button',{name:'Stop',exact:true}).isDisabled());receipt.checks.push({name:'keyboard-stop',pass:true});
 }
 await page.goto(url+'?mode=offline');await page.getByText('Browser extension not connected',{exact:true}).waitFor();await page.getByRole('combobox',{name:'Browser to connect'}).focus();await page.keyboard.press('b');await page.getByRole('button',{name:'Check connection',exact:true}).focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>window.fixtureCalls.some(call=>call.body?.action==='connect'&&call.body.browser==='brave'));await page.screenshot({path:join(output,'offline-390.png'),fullPage:true});receipt.checks.push({name:'offline-connect-explicit-brave',pass:true});
 if(process.argv.includes('--offline-only'))for(const width of [390,820,1440]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);const file=join(output,'offline-'+width+'.png');await page.screenshot({path:file,fullPage:true});receipt.screenshots.push(file);await page.addScriptTag({content:axe});const audit=await page.evaluate(()=>window.axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']}}));assert.equal(audit.violations.filter(v=>['serious','critical'].includes(v.impact)).length,0);await writeFile(join(output,'axe-offline-'+width+'.json'),JSON.stringify(audit,null,2));receipt.checks.push({name:'offline-layout-axe-'+width,pass:true});}
 await page.goto(url+'?mode=error');await page.getByRole('alert').waitFor();assert.equal(await page.getByText('Browser profile connected',{exact:true}).count(),0);await page.screenshot({path:join(output,'error-390.png'),fullPage:true});receipt.checks.push({name:'error-truthful-status',pass:true});
 assert.deepEqual(errors,[]);receipt.checks.push({name:'console-clean',pass:true});
 const lighthousePath=process.env.LIGHTHOUSE_CORE ?? '/opt/lighthouse/core/index.js';
 if(!process.argv.includes('--offline-only'))try {await stat(lighthousePath);const {default:lighthouse}=await import(pathToFileURL(lighthousePath).href);const port=Number((await readFile(join(output,'profile/DevToolsActivePort'),'utf8')).split('\n')[0]);const result=await lighthouse(url,{port,output:'json',logLevel:'error',onlyCategories:['performance','accessibility']});await writeFile(join(output,'lighthouse.json'),result.report);receipt.lighthouse={performance:result.lhr.categories.performance.score*100,accessibility:result.lhr.categories.accessibility.score*100};assert(receipt.lighthouse.performance>=90);assert(receipt.lighthouse.accessibility>=95);}
 catch(error){if(error.code==='ENOENT')receipt.lighthouse={pending:'Lighthouse unavailable'};else throw error;}
 receipt.pass=true;
}catch(error){receipt.pass=false;receipt.error=error.stack;process.exitCode=1;}
finally{await browser?.close();await new Promise(resolve=>server.close(resolve));await writeFile(join(output,'review.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));}
