// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe,it,expect,vi } from "vitest";
import { BrowserApprovedSites } from "./BrowserApprovedSites";
import { BrowserExtensionConsent, BrowserExtensionPanelView, extensionNeedsUpdate, pairedExtensionProfile, rememberedBrowser, setupProgress, sitesLoweredIn, startNewTaskRoute, type BrowserExtensionPanelStatus } from "./BrowserExtensionPanel";
import { browserChoicePatch, MY_BROWSER, MY_CHROME } from "./UnifiedBrowserPanel";
const status:BrowserExtensionPanelStatus={profiles:[{profileId:"profile_one",browser:"Chrome"}],bindings:[{bindingId:"binding",botId:"bot",threadId:"thread",profileId:"profile_one",state:"active",sites:{"https://example.com":"ask"}}],helper:{running:true},storeUrl:null};
function props(){return {botName:"Mira",profileId:"profile_one",status, pending:false,error:"",connectBrowser:"chrome" as const,onConnectBrowser:vi.fn(),onCheck:vi.fn(),onProfile:vi.fn(),onAction:vi.fn(),onSite:vi.fn(),onOwnBrowser:vi.fn()};}
function find(node:ReactNode,predicate:(props:Record<string,any>)=>boolean):Record<string,any>|undefined {
 if(Array.isArray(node)){for(const child of node){const result=find(child,predicate);if(result)return result;}return;}
 if(!isValidElement(node))return;const p=node.props as Record<string,any>;if(predicate(p))return p;return find(p.children,predicate);
}
describe("browser extension panel",()=>{
 it("requires optional consent before selecting extension and preserves legacy choice",()=>{expect(browserChoicePatch({},MY_BROWSER)).toBeNull();expect(browserChoicePatch({useMyChrome:true,browserTransport:"extension"},MY_CHROME)).toEqual({});expect(browserChoicePatch({useMyChrome:true},MY_CHROME)).toEqual({});expect(browserChoicePatch({useMyChrome:true,browserTransport:"extension"},MY_BROWSER)).toEqual({});});
 it("explains site access and action approval separately in consent",()=>{const markup=renderToStaticMarkup(createElement(BrowserExtensionConsent,{botName:"Mira",pending:false,onConfirm:()=>{},onCancel:()=>{}}));expect(markup).toContain("Setup is optional");expect(markup).toContain("need separate approval");expect(markup).toContain("Keep current browser");});
 it("helper readiness alone never claims browser connected or invents store link",()=>{const dev={...props(),status:{...status,profiles:[],bindings:[],helper:{running:true,reason:"Register the development helper."},extensionBuild:"development" as const}};const markup=renderToStaticMarkup(createElement(BrowserExtensionPanelView,dev));expect(markup).toContain("Set up Murage for Chrome");expect(markup).toContain("unpacked development extension");expect(renderToStaticMarkup(createElement(BrowserExtensionPanelView,{...dev,wizard:{added:true,picker:false,changing:false}}))).toContain("Register the development helper.");expect(markup).not.toContain("href=");expect(markup).not.toContain("Connected through Murage for Chrome");});
 it("wrong selected profile remains disconnected",()=>{const markup=renderToStaticMarkup(createElement(BrowserExtensionPanelView,{...props(),profileId:"missing"}));expect(markup).toContain("Your selected browser profile is not connected");});
 it("shows live controls and site meaning without permission overclaim",()=>{const markup=renderToStaticMarkup(createElement(BrowserExtensionPanelView,props()));expect(markup).toContain("Connected through Murage for Chrome");expect(markup).toContain("Use my Chrome</h3>");expect(markup).toContain("Site access permits reading");expect(markup).toContain("Resume there after checking the page");expect(markup).toContain("Site access for https://example.com");});
 it("only offers profile selector for multiple profiles",()=>{const single=renderToStaticMarkup(createElement(BrowserExtensionPanelView,props()));expect(single).not.toContain("Connected browser profile");const multiple=renderToStaticMarkup(createElement(BrowserExtensionPanelView,{...props(),status:{...status,profiles:[...status.profiles,{profileId:"two",browser:"Edge"}]}}));expect(multiple).toContain("Connected browser profile");});
 it("Stop and site controls dispatch the exact binding and origin",()=>{const p=props();const tree=BrowserExtensionPanelView(p);find(tree,item=>item.children==="Stop")!.onClick();expect(p.onAction).toHaveBeenCalledWith("stop","binding");find(tree,item=>item["aria-label"]==="Site access for https://example.com")!.onChange({target:{value:"never"}});expect(p.onSite).toHaveBeenCalledWith("binding","https://example.com","never");});
 it("pause and stop are disabled after Stop",()=>{const p=props();const tree=BrowserExtensionPanelView({...p,status:{...status,bindings:[{...status.bindings[0],state:"stopped"}]}});expect(find(tree,item=>item.children==="Stop")!.disabled).toBe(true);expect(find(tree,item=>item.children==="Pause")!.disabled).toBe(true);});
 it("offline errors replace indefinite checking with repair action",()=>{const markup=renderToStaticMarkup(createElement(BrowserExtensionPanelView,{...props(),status:null,error:"Murage is offline"}));expect(markup).toContain("Browser connection unavailable");expect(markup).not.toContain("unpacked development extension");expect(markup).toContain('role="alert"');expect(markup).toContain('data-step="1" data-state="current"');expect(markup).not.toContain("Checking browser connection");});
});

it("forwards the explicit offline browser choice",()=>{const p=props();const tree=BrowserExtensionPanelView({...p,connectBrowser:"brave",status:{...status,profiles:[],bindings:[]},wizard:{added:true,picker:false,changing:false}});find(tree,item=>item["data-action"]==="connect-browser")!.onClick();expect(p.onCheck).toHaveBeenCalledWith("brave");const html=renderToStaticMarkup(tree);expect(html).toContain("Browser to connect");expect(html).toContain('value="edge"');});

describe("store link, repair and removal",()=>{
 const offline={...status,profiles:[],bindings:[]};
 const shared={chrome:["brave","chrome"],edge:["edge"],brave:["brave","chrome"]};
 const extra=()=>({removing:false,removedNote:"",onRepair:vi.fn(),onRemoveAsk:vi.fn(),onRemoveConfirm:vi.fn(),onRemoveCancel:vi.fn()});
 it("links the Chrome Web Store listing only when the server gives one",()=>{
  const url="https://chromewebstore.google.com/detail/"+"c".repeat(32);
  const listed=renderToStaticMarkup(createElement(BrowserExtensionPanelView,{...props(),...extra(),status:{...offline,storeUrl:url,extensionBuild:"release",helper:{running:true,reason:"Add Murage for Chrome from the Chrome Web Store, then open its side panel and connect."}}}));
  expect(listed).toContain(`href="${url}"`);expect(listed).toContain('target="_blank"');expect(listed).toContain("Open Chrome Web Store");expect(listed).not.toContain("unpacked development extension");
  const pending=renderToStaticMarkup(createElement(BrowserExtensionPanelView,{...props(),...extra(),wizard:{added:true,picker:false,changing:false},status:{...offline,storeUrl:null,extensionBuild:"release",helper:{running:true,reason:"Open Murage for Chrome's side panel to connect. You can keep using the bot's own browser."}}}));
  expect(pending).not.toContain("href=");expect(pending).toContain("Open Murage for Chrome&#x27;s side panel to connect.");expect(pending).not.toMatch(/not (in the Chrome Web Store|available)|No store listing/);expect(listed).not.toMatch(/not (in the Chrome Web Store|available)|No store listing/);expect(pending).not.toContain("unpacked development extension");
 });
 it("offers Repair when this build needs the old owned registration replaced",()=>{
  const p={...props(),...extra(),wizard:{added:true,picker:false,changing:false},connectBrowser:"brave" as const,status:{...offline,helper:{running:true,problem:"repair" as const,reason:"Remove this owned helper registration, then Connect again to use the new build."}}};
  const tree=BrowserExtensionPanelView(p);find(tree,item=>item.children==="Repair connection")!.onClick();expect(p.onRepair).toHaveBeenCalledWith("brave");
  expect(find(BrowserExtensionPanelView({...p,status:{...offline,helper:{running:true}}}),item=>item.children==="Repair connection")).toBeUndefined();
 });
 it("Remove asks first, names browsers that share the registration and says the extension stays installed",()=>{
  const p={...props(),...extra(),status:{...status,helper:{running:true,shared}}};
  find(BrowserExtensionPanelView(p),item=>item.children==="Remove browser helper")!.onClick();expect(p.onRemoveAsk).toHaveBeenCalled();
  const asking={...p,removing:true};const html=renderToStaticMarkup(createElement(BrowserExtensionPanelView,asking));
  expect(html).toContain("Chrome and Brave share one helper registration on this computer, so removing it affects both.");
  expect(html).toContain("does not uninstall Murage for Chrome");
  const tree=BrowserExtensionPanelView(asking);find(tree,item=>item.children==="Remove helper")!.onClick();expect(p.onRemoveConfirm).toHaveBeenCalledWith("chrome");
  find(tree,item=>item.children==="Cancel")!.onClick();expect(p.onRemoveCancel).toHaveBeenCalled();
  expect(renderToStaticMarkup(createElement(BrowserExtensionPanelView,{...asking,connectBrowser:"edge" as const}))).not.toContain("share one helper registration");
  expect(renderToStaticMarkup(createElement(BrowserExtensionPanelView,{...p,removedNote:"Removed the helper registration for Chrome and Brave."}))).toContain("Removed the helper registration for Chrome and Brave.");
 });
});
it("the connection check starts on the browser this bot was connected in",()=>{expect(rememberedBrowser({browserExtensionBrowser:"brave"})).toBe("brave");expect(rememberedBrowser({})).toBe("chrome");});
it("the owner can choose the one connected profile, which is how a profile is remembered",()=>{const one=renderToStaticMarkup(createElement(BrowserExtensionPanelView,{...props(),profileId:undefined}));expect(one).toContain("Connected browser profile");const chosen=renderToStaticMarkup(createElement(BrowserExtensionPanelView,props()));expect(chosen).not.toContain("Connected browser profile");});

it("the lowered-sites notice comes from the status poll, without the sites list being opened", () => {
  expect(sitesLoweredIn(status)).toBe(false);
  expect(sitesLoweredIn({ ...status, bindings: [{ ...status.bindings[0], sitesLowered: true }] })).toBe(true);
  const bot = { id: "bot", name: "Mira" };
  expect(renderToStaticMarkup(createElement(BrowserApprovedSites, { bot, phone: false, sitesLowered: true }))).toContain('data-note="lowered"');
  expect(renderToStaticMarkup(createElement(BrowserApprovedSites, { bot, phone: false }))).not.toContain('data-note="lowered"');
});
it("Start a new task shows only for a stopped task and only when the server advertises its route",()=>{
  const stopped={...status,bindings:[{...status.bindings[0],state:"stopped" as const}]};
  const p=props();
  expect(renderToStaticMarkup(createElement(BrowserExtensionPanelView,{...p,onStartNew:p.onAction,status:stopped}))).not.toContain("Start a new task");
  const withRoute={...stopped,startTaskRoute:"/api/bots/x/browser-extension/start-task"};
  const q={...props(),onStartNew:vi.fn()};
  expect(renderToStaticMarkup(createElement(BrowserExtensionPanelView,{...q,status:withRoute}))).toContain("Start a new task");
  find(BrowserExtensionPanelView({...q,status:withRoute}),item=>item["data-action"]==="start-new-task")!.onClick();expect(q.onStartNew).toHaveBeenCalledWith("binding");
  expect(renderToStaticMarkup(createElement(BrowserExtensionPanelView,{...q,status:{...withRoute,bindings:[{...withRoute.bindings[0],state:"active" as const}]}}))).not.toContain("Start a new task");
  for(const bad of ["https://evil.example/x","//evil.example","/api/../x","javascript:alert(1)",""])expect(startNewTaskRoute({...stopped,startTaskRoute:bad}),bad).toBeNull();
  expect(startNewTaskRoute(withRoute)).toBe("/api/bots/x/browser-extension/start-task");
 });

describe("Use my Chrome through Murage for Chrome (1.0.7)",()=>{
 it("picks the one paired profile, Chrome first",()=>{expect(pairedExtensionProfile([{profileId:"a",browser:"Chrome"}])).toEqual({ready:true,profileId:"a"});expect(pairedExtensionProfile([{profileId:"e",browser:"edge"}])).toEqual({ready:false});expect(pairedExtensionProfile([{profileId:"a",browser:"chrome"},{profileId:"b",browser:"chrome"}])).toEqual({ready:true});expect(pairedExtensionProfile([])).toEqual({ready:false});
  // Murage for Chrome's own hello says "chromium" in Chrome, Edge and Brave alike (real Google Chrome 156, 1.0.7):
  // paired, so "auto" takes the extension route, but never chosen for the owner, so the picker asks.
  expect(pairedExtensionProfile([{profileId:"e",browser:"brave"},{profileId:"c",browser:"chromium"}])).toEqual({ready:true});
  expect(pairedExtensionProfile([{profileId:"c",browser:"chromium"}])).toEqual({ready:true});
  expect(pairedExtensionProfile([{profileId:"a",browser:"chrome"},{profileId:"c",browser:"chromium"}])).toEqual({ready:true});});
 it("asks the owner to choose the profile when the only one says chromium",()=>{const markup=renderToStaticMarkup(createElement(BrowserExtensionPanelView,{...props(),profileId:undefined,status:{...status,profiles:[{profileId:"profile_one",browser:"chromium"}],bindings:[]}}));expect(markup).toContain("Choose a profile");expect(markup).toContain('aria-label="Connected browser profile"');});
 it("tells the owner how to install it and that the bot connects by itself",()=>{const p={...props(),profileId:undefined,status:{...status,profiles:[],bindings:[],helper:{running:false}}};const markup=renderToStaticMarkup(createElement(BrowserExtensionPanelView,p));expect(markup).toContain("Set up Murage for Chrome");expect(markup).toContain("Add Murage for Chrome to your browser from the Chrome Web Store. It takes about a minute.");const two=renderToStaticMarkup(createElement(BrowserExtensionPanelView,{...p,wizard:{added:true,picker:false,changing:false}}));expect(two).toContain("Press Connect my browser. Then click the Murage for Chrome icon at the top of your browser. Mira connects by itself.");expect(two).not.toContain("\u2014");});
 it("says once that the bot moved over by itself",()=>{const markup=renderToStaticMarkup(createElement(BrowserExtensionPanelView,{...props(),upgraded:true,onDismissUpgraded:()=>{}}));expect(markup).toContain("Mira now works through Murage for Chrome. No more Allow prompts, and your tabs stay yours.");});
});

describe("a reinstalled extension makes a new profile (#20 a)",()=>{
 const fresh={...status,profiles:[{profileId:"profile_new",browser:"Chrome"}],bindings:[]};
 it("offers the picker and a confirm button when the stored profile is gone and one new one is live",()=>{const p={...props(),profileId:"profile_old",status:fresh};const markup=renderToStaticMarkup(createElement(BrowserExtensionPanelView,p));expect(markup).toContain("Connected browser profile");expect(markup).toContain("new browser profile");expect(markup).not.toContain("\u2014");const tree=BrowserExtensionPanelView(p);find(tree,item=>item["data-action"]==="use-new-profile")!.onClick();expect(p.onProfile).toHaveBeenCalledWith("profile_new");});
 it("offers only the picker when several new profiles are live",()=>{const p={...props(),profileId:"profile_old",status:{...fresh,profiles:[...fresh.profiles,{profileId:"profile_other",browser:"Chrome"}]}};const tree=BrowserExtensionPanelView(p);expect(find(tree,item=>item["data-action"]==="use-new-profile")).toBeUndefined();expect(find(tree,item=>item["aria-label"]==="Connected browser profile")).toBeDefined();});
 it("shows nothing extra while the bound profile is still live or nothing is live",()=>{expect(find(BrowserExtensionPanelView(props()),item=>item["data-rebind-profile"]!==undefined)).toBeUndefined();expect(find(BrowserExtensionPanelView({...props(),profileId:"profile_old",status:{...fresh,profiles:[]}}),item=>item["data-rebind-profile"]!==undefined)).toBeUndefined();});
});

describe("Use my Chrome setup in three steps (1.0.18)",()=>{
 const none={added:false,picker:false,changing:false};
 const offline={...status,profiles:[],bindings:[]};
 const other={...status,profiles:[{profileId:"profile_two",browser:"Chrome"}],bindings:[]};
 const state=(html:string,n:number)=>html.match(new RegExp(`data-step="${n}" data-state="(\\w+)"`))?.[1];
 it("opens the steps in order: 1 before 2 before 3, and 3 never before 2",()=>{
  expect(setupProgress(offline,undefined,none,true)).toEqual({step:1,done:[false,false,false]});
  expect(setupProgress(offline,undefined,{...none,added:true},true)).toEqual({step:2,done:[true,false,false]});
  // A hello from another profile ticks step 1 but not step 2, so step 3 stays shut even with the mode known.
  expect(setupProgress(other,"profile_one",none,true)).toEqual({step:2,done:[true,false,false]});
  expect(setupProgress(status,"profile_one",none,false)).toEqual({step:3,done:[true,true,false]});
  expect(setupProgress(status,"profile_one",none,true)).toEqual({step:"done",done:[true,true,true]});
  expect(setupProgress(status,"profile_one",{...none,changing:true},true).step).toBe(3);
  expect(setupProgress(null,undefined,none,true).step).toBe(1);
  // A live profile the owner has not picked for this bot yet keeps step 2 open.
  expect(setupProgress(status,undefined,none,true)).toEqual({step:2,done:[true,false,false]});
 });
 it("keeps Full access reachable to turn off while setup is back on step 1 or 2",()=>{
  const p={...props(),status:offline,modeKnown:true,approvalMode:"full" as const,onWizard:vi.fn(),modeSettings:createElement("div",{"data-slot":"settings-full"})};
  expect(renderToStaticMarkup(createElement(BrowserExtensionPanelView,p))).toContain('data-slot="settings-full"');
  expect(renderToStaticMarkup(createElement(BrowserExtensionPanelView,{...p,approvalMode:"task" as const}))).not.toContain('data-slot="settings-full"');
 });
 it("moves on by itself: no hello is step 1, a hello is step 2, connected is step 3 until the mode is read",()=>{
  const view=(st:BrowserExtensionPanelStatus,modeKnown=false)=>renderToStaticMarkup(createElement(BrowserExtensionPanelView,{...props(),status:st,modeKnown,onWizard:vi.fn()}));
  const a=view(offline);expect(state(a,1)).toBe("current");expect(state(a,2)).toBe("todo");expect(state(a,3)).toBe("todo");expect(a).toContain('aria-current="step"');
  const b=view({...other,profiles:other.profiles});expect(state(b,1)).toBe("done");expect(state(b,2)).toBe("current");expect(b).toContain('data-action="connect-browser"');
  const c=view(status);expect(state(c,1)).toBe("done");expect(state(c,2)).toBe("done");expect(state(c,3)).toBe("current");
  // Only the open step is expanded.
  expect(a).toContain("I have added it");expect(a).not.toContain("Connect my browser");
 });
 it("connected with the stored mode read shows only the summary and Change",()=>{
  const p={...props(),modeKnown:true,approvalMode:"task" as const,onWizard:vi.fn(),modeCards:createElement("div",{"data-slot":"cards"}),modeSettings:createElement("div",{"data-slot":"settings-full"})};
  const html=renderToStaticMarkup(createElement(BrowserExtensionPanelView,p));
  expect(html).toContain("Connected. Mira asks once per task.");expect(html).toContain('data-action="change-setup"');expect(html).not.toContain("data-setup-steps");expect(html).not.toContain('data-slot="cards"');
  find(BrowserExtensionPanelView(p),item=>item["data-action"]==="change-setup")!.onClick();expect(p.onWizard).toHaveBeenCalledWith({changing:true});
  const changing=renderToStaticMarkup(createElement(BrowserExtensionPanelView,{...p,wizard:{...none,changing:true}}));
  expect(state(changing,3)).toBe("current");expect(changing).toContain('data-slot="settings-full"');expect(changing).toContain('data-action="setup-keep"');
  find(BrowserExtensionPanelView({...p,wizard:{...none,changing:true}}),item=>item["data-action"]==="setup-keep")!.onClick();expect(p.onWizard).toHaveBeenLastCalledWith({changing:false});
 });
 it("an already-connected bot never sees the steps again: done comes from the server's stored mode, not this computer",()=>{
  for(const [mode,line] of [["step","Connected. Mira asks each step."],["task","Connected. Mira asks once per task."],["full","Connected. Mira has Full access. Danger zone."]] as const){
   const html=renderToStaticMarkup(createElement(BrowserExtensionPanelView,{...props(),modeKnown:true,approvalMode:mode,onWizard:vi.fn()}));
   expect(html).toContain(line);expect(html).not.toContain("data-setup-steps");
  }
  const source=readFileSync(new URL("./BrowserExtensionPanel.tsx",import.meta.url),"utf8");
  expect(source).not.toContain("localStorage");expect(source).toContain("modeKnown={approval.known}");
  expect(readFileSync(new URL("./BrowserApprovalMode.tsx",import.meta.url),"utf8")).toContain("return { mode, known, view }");
 });
 it("keeps the browser choice behind Using Edge or Brave until tapped, or while the remembered browser is not Chrome",()=>{
  const p={...props(),status:offline,wizard:{...none,added:true},onWizard:vi.fn()};
  const html=renderToStaticMarkup(createElement(BrowserExtensionPanelView,p));
  expect(html).toContain("Using Edge or Brave? Choose it here");expect(html).not.toContain("Browser to connect");
  find(BrowserExtensionPanelView(p),item=>item["data-action"]==="other-browser")!.onClick();expect(p.onWizard).toHaveBeenCalledWith({picker:true});
  expect(renderToStaticMarkup(createElement(BrowserExtensionPanelView,{...p,wizard:{...none,added:true,picker:true}}))).toContain("Browser to connect");
  expect(renderToStaticMarkup(createElement(BrowserExtensionPanelView,{...p,connectBrowser:"edge" as const}))).toContain("Browser to connect");
  const one={...p,wizard:none};find(BrowserExtensionPanelView(one),item=>item["data-action"]==="setup-added")!.onClick();expect(p.onWizard).toHaveBeenCalledWith({added:true});
 });
});
describe("EXT-RESTART FU-6: an extension older than 1.0.1 is told to update",()=>{
 it("flags 1.0.0, 0.9 and 1.0 only; 1.0.1, 1.1, 2.0 and an unknown version are not flagged",()=>{
  for(const v of ["1.0.0","0.9","1.0","0.1.0"])expect(extensionNeedsUpdate(v)).toBe(true);
  for(const v of ["1.0.1","1.1","2.0.0","1.0.1.5",undefined,"","x.y"])expect(extensionNeedsUpdate(v)).toBe(false);
 });
});
