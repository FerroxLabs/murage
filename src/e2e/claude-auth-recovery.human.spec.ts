import {test,expect} from "@playwright/test";
import {createServer,type ViteDevServer} from "vite";
import tailwindcss from "@tailwindcss/vite";
import {readFileSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
let server:ViteDevServer,cache:string,origin:string;
test.beforeAll(async()=>{
 const root=fileURLToPath(new URL("../../",import.meta.url));cache=mkdtempSync(join(tmpdir(),"murage-auth-card-"));
 server=await createServer({configFile:false,root,cacheDir:cache,envFile:false,optimizeDeps:{noDiscovery:true,include:["react","react-dom/client","react/jsx-runtime","react/jsx-dev-runtime","lucide-react"]},resolve:{alias:{"@":`${root}/src`}},server:{host:"127.0.0.1",watch:null,hmr:false},plugins:[tailwindcss(),{name:"auth-card-fixture",enforce:"pre",
  resolveId(id){if(id==="@/state/store"||id.endsWith('/src/state/store'))return "\0auth-store";if(id==="/__auth.js")return "\0auth-entry";},
  load(id){
   if(id.endsWith('/src/styles.css'))return readFileSync(id,'utf8').replace('@import "tailwindcss";','@import "tailwindcss" source(none);\n@source "./components";');
   // Isolate the actual ErrorRow consumer from the rest of ChatView. Its body
   // and all rendered setup/error components are production source, unmodified.
   if(id.endsWith('/src/components/ChatView.tsx')){const source=readFileSync(id,'utf8'),start=source.indexOf('export function ErrorRow('),end=source.indexOf('\n}\n',start)+3;if(start<0||end<start)throw new Error('ErrorRow fixture anchor changed');return `import{useState}from'react';import{EngineSetup}from'./EngineSetup';import{ProviderErrorCard}from'./ProviderErrorCard';import{RuntimeErrorCard}from'./RuntimeErrorCard';`+source.slice(start,end);}
   if(id==="\0auth-store")return `export const useStore=()=>({state:{config:{}},dispatch:action=>{if(action.type==='instances')window.setInstance(action.instances[0]);}});export async function api(url,options={}){const response=await fetch(url,{...options,headers:{'content-type':'application/json'}});const value=await response.json();if(!response.ok)throw new Error(value.error||'Request failed');return value;}`;
   if(id!=="\0auth-entry")return;
   return `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{ErrorRow}from'/src/components/ChatView.tsx';import'/src/styles.css';
    window.terminalCalls=[];window.muragebox={platform:'darwin',openEngineSetupTerminal:async request=>{window.terminalCalls.push(request);return true;}};
    function Fixture(){const[instance,setInstance]=useState({instanceId:'claude',driverKind:'claudeAgent',displayName:'Claude',enabled:true,models:{default:'',options:[]},snapshot:{state:'available',authenticated:true},install:{command:{darwin:'fixture install'},signInCommand:'claude'}}),[mode,setMode]=useState('native');window.setInstance=setInstance;window.setMode=setMode;return React.createElement(ErrorRow,{key:mode,message:mode==='native'?'Not logged in · Please run /login':'The selected model provider could not authenticate. Review its saved connection in Settings.',setupInstance:mode==='native'?instance:undefined,authRequired:mode==='native',providerError:mode==='permission'?{kind:'permission',httpStatus:403}:undefined,onRetry:()=>{},onOpenProviderSettings:()=>{window.openedSettings=mode==='native'?'engines':'models';}});}createRoot(document.getElementById('root')).render(React.createElement(Fixture));`;
  },configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url!=="/__auth")return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root" style="max-width:640px;padding:12px"></div><script type="module" src="/__auth.js"></script>');});}
 }]});await server.listen(0);const address=server.httpServer!.address();if(!address||typeof address==='string')throw new Error('No fixture port');origin=`http://127.0.0.1:${address.port}`;
});
test.afterAll(async()=>{await server?.close();rmSync(cache,{recursive:true,force:true});});
test('expired Claude login overrides stale Ready until a fresh successful auth check; provider errors stay provider errors',async({page},info)=>{
 let authenticated=false;
 await page.route('**/api/instances',route=>route.fulfill({json:{instances:[{instanceId:'claude',driverKind:'claudeAgent',displayName:'Claude',enabled:true,models:{default:'',options:[]},snapshot:{state:'available',authenticated},install:{command:{darwin:'fixture install'},signInCommand:'claude'}}]}}));
 await page.goto(`${origin}/__auth`);
 await expect(page.getByText('Sign in to Claude',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Retry',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'Open sign-in in Terminal',exact:true}).click();
 expect(await page.evaluate(()=>(window as any).terminalCalls)).toEqual([{instanceId:'claude',action:'connect'}]);
 await page.getByRole('button',{name:'Check again',exact:true}).click();await expect(page.getByText('Sign in to Claude',{exact:true})).toBeVisible();
 await page.screenshot({path:info.outputPath('native-auth-required.png')});
 authenticated=true;await page.getByRole('button',{name:'Check again',exact:true}).click();
 await expect(page.getByText('Sign in to Claude',{exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Retry',exact:true})).toBeVisible();
 await page.evaluate(()=>(window as any).setMode('provider'));
 await expect(page.getByRole('button',{name:'Open sign-in in Terminal',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'Provider settings',exact:true}).click();expect(await page.evaluate(()=>(window as any).openedSettings)).toBe('models');
 await page.evaluate(()=>(window as any).setMode('permission'));await expect(page.getByText('Your model provider denied access',{exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await page.screenshot({path:info.outputPath('provider-permission.png')});
});
