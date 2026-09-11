import { test, expect } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeWipeSync } from "../../server/testing/safe-wipe.mjs";
let server: ViteDevServer, origin: string, cache: string;
test.beforeAll(async () => {
  const root=fileURLToPath(new URL("../../",import.meta.url));cache=mkdtempSync(join(tmpdir(),"murage-call-avatar-"));
  server=await createServer({configFile:false,root,cacheDir:cache,envFile:false,optimizeDeps:{noDiscovery:true,include:["react","react-dom/client","react/jsx-runtime","react/jsx-dev-runtime","lucide-react"]},resolve:{alias:{"@":`${root}/src`}},server:{host:"127.0.0.1",watch:null,hmr:false},plugins:[tailwindcss(),{name:"call-avatar-fixture",enforce:"pre",
    resolveId(id){const map:Record<string,string>={"@/state/store":"store","@/lib/call":"call","@/lib/tts":"tts","@/lib/tts/useSpeech":"speech","@/lib/push-to-talk":"push"};for(const[alias,key]of Object.entries(map))if(id===alias||id.endsWith("/src/"+alias.slice(2)))return "\0avatar-"+key;if(id==="/__call.js")return "\0avatar-entry";},
    load(id){
      if(id.endsWith("/src/styles.css"))return readFileSync(id,"utf8").replace('@import "tailwindcss";','@import "tailwindcss" source(none);\n@source "./components";');
      if(id==="\0avatar-store")return `const empty=[];export const visibleMessages=()=>empty;export const useStore=()=>({state:{config:{}},dispatch:()=>{}});export const api=async()=>({});`;
      if(id==="\0avatar-call")return `export const useOnCall=()=>"portrait-bot";export const currentCall=()=>"portrait-bot";export const deferCallCleanup=()=>{};export const endCall=()=>{};export const startCall=()=>{};`;
      if(id==="\0avatar-tts")return `export const speaker={isSpeaking:()=>false,speak:async()=>{},stop:()=>{}};`;
      if(id==="\0avatar-speech")return `export const useSpeech=()=>({caption:"",error:null});`;
      if(id==="\0avatar-push")return `export const usePushToTalk=()=>false;`;
      if(id!=="\0avatar-entry")return;
      return `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{CallOverlay}from'/src/components/CallView.tsx';import'/src/styles.css';
        function Fixture(){const[bot,setBot]=useState({id:'portrait-bot',name:'Ada',color:'green',busy:true,messages:[],avatarUrl:'/api/attachments/portrait.png',avatarCrop:'circle'});window.setAvatar=patch=>setBot(current=>({...current,...patch}));return React.createElement(CallOverlay,{bot});}createRoot(document.getElementById('root')).render(React.createElement(Fixture));`;
    },configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url!=="/__call")return next();res.setHeader("content-type","text/html");res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/__call.js"></script>');});}
  }]});await server.listen(0);const address=server.httpServer!.address();if(!address||typeof address==='string')throw new Error('No fixture port');origin=`http://127.0.0.1:${address.port}`;
});
test.afterAll(async()=>{await server?.close();safeWipeSync(cache);});
test("call overlay honors a stored portrait/crops and retains animated mascot fallbacks",async({page},info)=>{
  // Deterministic PNG portrait fixture; no remote photo, personal data or image API.
  const png=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=320;canvas.height=400;const c=canvas.getContext('2d')!;c.fillStyle='#16384a';c.fillRect(0,0,320,400);c.fillStyle='#7ad6c3';c.fillRect(0,300,320,100);c.fillStyle='#e9b78e';c.beginPath();c.ellipse(160,165,85,110,0,0,Math.PI*2);c.fill();c.fillStyle='#352827';c.beginPath();c.ellipse(160,82,93,52,0,Math.PI,Math.PI*2);c.fill();c.fillRect(118,157,13,9);c.fillRect(190,157,13,9);c.strokeStyle='#873b35';c.lineWidth=7;c.beginPath();c.arc(160,205,33,0.2,Math.PI-0.2);c.stroke();return canvas.toDataURL('image/png').split(',')[1];});
  await page.route('**/api/attachments/portrait.png',route=>route.fulfill({contentType:'image/png',body:Buffer.from(png,'base64')}));
  await page.route('**/api/attachments/missing.png',route=>route.fulfill({status:404,body:'missing fixture'}));
  await page.goto(`${origin}/__call`);await expect(page.locator('button[aria-label="Hang up"]')).toBeVisible();
  await expect(page.getByTestId('call-waiting-ring')).toBeVisible();
  await expect(page.getByTestId('call-waiting-ring')).toHaveCSS('animation-duration','3s');
  await page.emulateMedia({reducedMotion:'reduce'});await expect(page.getByTestId('call-waiting-ring')).toHaveCSS('animation-name','none');
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.evaluate(()=>document.documentElement.dataset.skin='light');
  const portrait=page.getByRole('img',{name:'Ada avatar',exact:true});
  for(const[crop,radius]of[['circle','50%'],['rounded','22%'],['square','0px']]){
    await page.evaluate(crop=>(window as any).setAvatar({avatarCrop:crop}),crop);
    await expect(portrait).toBeVisible();await expect(portrait).toHaveCSS('border-radius',radius);await expect(portrait).toHaveCSS('object-fit','cover');
    expect(await portrait.evaluate(image=>(image as HTMLImageElement).naturalWidth)).toBe(320);
    expect(await portrait.boundingBox()).toMatchObject({width:220,height:220});
    await page.screenshot({path:info.outputPath(`portrait-${crop}.png`)});
  }
  await page.evaluate(()=>document.documentElement.dataset.skin='dark');await page.screenshot({path:info.outputPath('portrait-dark.png')});
  await page.evaluate(()=>(window as any).setAvatar({avatarCrop:'mascot'}));
  const mascot=page.locator('svg[role="img"][aria-label="Ada"]');await expect(mascot).toBeVisible();await expect(portrait).toHaveCount(0);
  const before=await mascot.evaluate(node=>node.outerHTML);await page.mouse.move(20,20);await expect.poll(()=>mascot.evaluate(node=>node.outerHTML)).not.toBe(before);
  await page.screenshot({path:info.outputPath('mascot.png')});
  await page.evaluate(()=>(window as any).setAvatar({avatarCrop:'circle',avatarUrl:null}));await expect(mascot).toBeVisible();
  await page.evaluate(()=>(window as any).setAvatar({avatarUrl:'/api/attachments/missing.png'}));await expect(mascot).toBeVisible();await expect(portrait).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});
