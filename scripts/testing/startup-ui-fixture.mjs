import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export const startupFixtureSource=`import React from 'react';import {createRoot} from 'react-dom/client';import {StartupSettings} from '/src/components/StartupSettings.tsx';import '/src/styles.css';
  const query=new URLSearchParams(location.search);document.documentElement.dataset.skin=query.get('skin')||'light';
  if(!window.muragebox){let state={platform:'linux',keepRunning:false,defaultInherited:true,configurable:true,trayAvailable:query.get('tray')!=='missing',canKeepRunning:query.get('tray')!=='missing',effectiveKeepRunning:false,windowVisible:true,suspended:false,quitting:false,automationsPaused:false,login:{supported:true,openAtLogin:false}};const listeners=new Set();window.fixtureWrites=[];
    window.muragebox={platform:'linux',startup:{status:async()=>state,onChange:cb=>{listeners.add(cb);return()=>listeners.delete(cb);},update:async patch=>{window.fixtureWrites.push(patch);if('keepRunning'in patch)state={...state,keepRunning:patch.keepRunning,effectiveKeepRunning:patch.keepRunning&&state.canKeepRunning,defaultInherited:false};if('startAtLogin'in patch)state={...state,login:{...state.login,openAtLogin:patch.startAtLogin}};for(const cb of listeners)cb(state);return state;}}};
  }createRoot(document.getElementById('root')).render(React.createElement(StartupSettings));`;

export async function startStartupUiFixture(cacheDir){
  execFileSync(process.execPath,["--check","--input-type=module"],{input:startupFixtureSource,encoding:"utf8"});
  const root=fileURLToPath(new URL("../../",import.meta.url));
  const server=await createServer({root,configFile:false,envFile:false,cacheDir,resolve:{alias:{"@":join(root,"src")}},plugins:[react(),tailwindcss(),{
    name:"startup-settings-fixture",
    configureServer(server){server.middlewares.use((req,res,next)=>{
      if(req.url?.split("?")[0]!=="/startup-fixture")return next();
      res.setHeader("content-type","text/html");res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;background:var(--color-app);color:var(--color-ink)"><div id="root" style="max-width:760px;margin:auto;padding:24px"></div><script type="module" src="/@startup-fixture"></script></body></html>');
    });},
    resolveId(id){if(id==="/@startup-fixture")return id;},
    load(id){if(id==="/@startup-fixture")return startupFixtureSource;}
  }],server:{host:"127.0.0.1",port:0,watch:null,hmr:false}});
  await server.listen(0);const address=server.httpServer.address();if(!address||typeof address==="string")throw Error("No startup fixture port");
  return {url:`http://127.0.0.1:${address.port}/startup-fixture`,close:()=>server.close()};
}
