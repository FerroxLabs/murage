import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync} from "node:fs";
import {EventEmitter} from "node:events";
import {createStartupSplash} from "./startup-splash.mjs";
import {runStartGate} from "./update-start-gate.mjs";
import {createReturnAuthority,revokeReturn} from "./backup-offline-return.mjs";
const main=readFileSync(new URL("./main.mjs",import.meta.url),"utf8");
function fixture(){
  let win,clock=0,probes=0,pauses=0,returns=0;const timers=new Map(),authority=createReturnAuthority();
  const app={quit:()=>revokeReturn(authority)};
  const ownerQuit=/function requestOwnerQuit\(\) \{[^\n]+\}/.exec(main);assert.ok(ownerQuit);
  const requestOwnerQuit=vm.runInNewContext(ownerQuit[0]+';requestOwnerQuit',{app,noteShutdownCause:cause=>assert.equal(cause,"owner")});
  const userClose=/onUserClose: (requestOwnerQuit)/.exec(main);assert.ok(userClose);
  class Window extends EventEmitter{
    constructor(){super();win=this;this.webContents=new EventEmitter();this.webContents.setWindowOpenHandler=()=>{};this.webContents.executeJavaScript=()=>Promise.resolve();this.dead=false;}
    loadURL(){return Promise.resolve();} isDestroyed(){return this.dead;} destroy(){this.emit("close");this.dead=true;}
  }
  const splash=createStartupSplash({BrowserWindow:Window,onUserClose:vm.runInNewContext(userClose[1],{requestOwnerQuit})});splash.set({title:"wait",keepOpen:true});
  const scope={recoveryWindow:null,desktopStartupFulfilled:true,deferredStartup:{size:0},desktopStartup:Promise.resolve(),startupDecisionPending:true,mainWindow:null,closeStartupSplash:()=>splash.close()};
  const finallyBody=/function closeSplashWhenNoMainWindow\(\) \{[\s\S]*?\n\}/.exec(main);assert.ok(finallyBody);
  const binding=/success: \(\) => \{ desktopStartupFulfilled = true; closeSplashWhenNoMainWindow\(\); \}/.exec(main);assert.ok(binding);
  const finallyRun=async()=>{vm.runInNewContext(finallyBody[0]+';({'+binding[0]+'}).success();',scope);await scope.desktopStartup;await Promise.resolve();};
  const start=(kind="installing")=>runStartGate({authority,now:()=>clock,schedule:(fn,ms)=>{const id={};timers.set(id,{fn,at:clock+ms});return id;},clear:id=>timers.delete(id),settle:()=>{probes++;return {kind};},startReturn:()=>{returns++;scope.startupDecisionPending=false;splash.close();},pause:()=>{pauses++;scope.startupDecisionPending=false;splash.close();}});
  const advance=to=>{while(true){const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>to)break;clock=next[1].at;timers.delete(next[0]);next[1].fn();}clock=to;};
  return {authority,splash,win:()=>win,start,finallyRun,advance,timers,counts:()=>({probes,pauses,returns})};
}
test("T26 real startup finally retains splash before first gate and pauses exactly at 60000",async()=>{
  const f=fixture();await f.finallyRun();assert.equal(f.splash.open,true);f.start();f.advance(59000);assert.equal(f.counts().pauses,0);assert.equal(f.splash.open,true);
  f.advance(60000);assert.equal(f.counts().pauses,1);assert.equal(f.splash.open,false);f.advance(90000);assert.equal(f.counts().pauses,1);assert.equal(f.authority.userQuitRequested,false,"programmatic close is not Quit");
});
test("T26 actual splash user-close callback revokes subsequent probes and relaunch",()=>{
  const f=fixture();f.start();const before=f.counts().probes;f.win().emit("close");assert.equal(f.authority.userQuitRequested,true);f.advance(120000);assert.equal(f.counts().probes,before);assert.equal(f.counts().returns,0);assert.equal(f.counts().pauses,0);assert.equal(f.timers.size,0);
});
for(const kind of ["cancel","landed"])test(`T26 ${kind} closes splash programmatically`,()=>{const f=fixture();f.start(kind);assert.equal(f.counts().returns,1);assert.equal(f.splash.open,false);assert.equal(f.authority.userQuitRequested,false);});
test("T12 active shared attempt stops ticks without another observation",()=>{const f=fixture();f.authority.attempt={promise:Promise.resolve()};f.start();assert.equal(f.counts().probes,0);assert.equal(f.timers.size,0);});
test("T12 held lease times out once using the same elapsed clock",()=>{const f=fixture();f.start("busy");f.advance(59000);assert.equal(f.counts().pauses,0);f.advance(60000);assert.equal(f.counts().pauses,1);});

test('F8 rendered installer-wait Quit control invokes the actual splash callback',()=>{
 const f=fixture(),elements=new Map();
 const document={body:{dataset:{}},documentElement:{},getElementById:id=>{if(!elements.has(id))elements.set(id,{textContent:'',style:{},classList:{toggle(){}},setAttribute(){},removeAttribute(){},addEventListener(_name,fn){this.click=fn;}});return elements.get(id);},set title(title){f.win().webContents.emit('page-title-updated',{preventDefault(){}},title);}};
 const context={document,matchMedia:()=>({matches:true}),performance:{now:()=>0},window:{matchMedia:()=>({matches:true})},setInterval(){},clearInterval(){},requestAnimationFrame(){}};
 const html=decodeURIComponent(splashPage().split(',').slice(1).join(','));vm.createContext(context);vm.runInContext(/<script>([\s\S]*?)<\/script>/.exec(html)[1],context);
 const setting=/startupSplash\?\.set\((\{title:"Murage",line:updateRecoveryWords[\s\S]*?keepOpen:true\})\);/.exec(main);assert.ok(setting);
 const view=vm.runInNewContext('('+setting[1]+')',{updateRecoveryWords,app:{getLocale:()=> 'de'}});context.window.__set({...view,kind:'upgrade'});
 assert.equal(elements.get('quit').textContent,'Beenden');f.start();const before=f.counts().probes;elements.get('quit').click();f.advance(120000);assert.equal(f.authority.userQuitRequested,true);assert.equal(f.counts().probes,before);assert.equal(f.counts().returns,0);
});
import {splashPage} from './startup-splash.mjs';
import {updateRecoveryWords} from './update-recovery-copy.mjs';
