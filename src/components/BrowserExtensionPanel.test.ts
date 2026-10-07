// SPDX-License-Identifier: AGPL-3.0-or-later
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe,it,expect,vi } from "vitest";
import { BrowserApprovedSites } from "./BrowserApprovedSites";
import { BrowserExtensionConsent, BrowserExtensionPanelView, rememberedBrowser, sitesLoweredIn, startNewTaskRoute, type BrowserExtensionPanelStatus } from "./BrowserExtensionPanel";
import { browserChoicePatch, MY_BROWSER, MY_CHROME } from "./UnifiedBrowserPanel";
const status:BrowserExtensionPanelStatus={profiles:[{profileId:"profile_one",browser:"Chrome"}],bindings:[{bindingId:"binding",botId:"bot",threadId:"thread",profileId:"profile_one",state:"active",sites:{"https://example.com":"ask"}}],helper:{running:true},storeUrl:null};
function props(){return {botName:"Mira",profileId:"profile_one",status, pending:false,error:"",connectBrowser:"chrome" as const,onConnectBrowser:vi.fn(),onCheck:vi.fn(),onProfile:vi.fn(),onAction:vi.fn(),onSite:vi.fn(),onOwnBrowser:vi.fn()};}
function find(node:ReactNode,predicate:(props:Record<string,any>)=>boolean):Record<string,any>|undefined {
 if(Array.isArray(node)){for(const child of node){const result=find(child,predicate);if(result)return result;}return;}
 if(!isValidElement(node))return;const p=node.props as Record<string,any>;if(predicate(p))return p;return find(p.children,predicate);
}
describe("browser extension panel",()=>{
 it("requires optional consent before selecting extension and preserves legacy choice",()=>{expect(browserChoicePatch({},MY_BROWSER)).toBeNull();expect(browserChoicePatch({useMyChrome:true,browserTransport:"extension"},MY_CHROME)).toBeNull();expect(browserChoicePatch({useMyChrome:true},MY_CHROME)).toEqual({});expect(browserChoicePatch({useMyChrome:true,browserTransport:"extension"},MY_BROWSER)).toEqual({});});
 it("explains site access and action approval separately in consent",()=>{const markup=renderToStaticMarkup(createElement(BrowserExtensionConsent,{botName:"Mira",pending:false,onConfirm:()=>{},onCancel:()=>{}}));expect(markup).toContain("Setup is optional");expect(markup).toContain("need separate approval");expect(markup).toContain("Keep current browser");});
 it("helper readiness alone never claims browser connected or invents store link",()=>{const markup=renderToStaticMarkup(createElement(BrowserExtensionPanelView,{...props(),status:{...status,profiles:[],bindings:[],helper:{running:true,reason:"Register the development helper."},extensionBuild:"development"}}));expect(markup).toContain("Browser extension not connected");expect(markup).toContain("unpacked development extension");expect(markup).toContain("Register the development helper.");expect(markup).not.toContain("href=");expect(markup).not.toContain("Browser profile connected");});
 it("wrong selected profile remains disconnected",()=>{const markup=renderToStaticMarkup(createElement(BrowserExtensionPanelView,{...props(),profileId:"missing"}));expect(markup).toContain("Your selected browser profile is not connected");});
 it("shows live controls and site meaning without permission overclaim",()=>{const markup=renderToStaticMarkup(createElement(BrowserExtensionPanelView,props()));expect(markup).toContain("Browser profile connected");expect(markup).toContain("Site access permits reading");expect(markup).toContain("Resume there after checking the page");expect(markup).toContain("Site access for https://example.com");});
 it("only offers profile selector for multiple profiles",()=>{const single=renderToStaticMarkup(createElement(BrowserExtensionPanelView,props()));expect(single).not.toContain("Connected browser profile");const multiple=renderToStaticMarkup(createElement(BrowserExtensionPanelView,{...props(),status:{...status,profiles:[...status.profiles,{profileId:"two",browser:"Edge"}]}}));expect(multiple).toContain("Connected browser profile");});
 it("Stop and site controls dispatch the exact binding and origin",()=>{const p=props();const tree=BrowserExtensionPanelView(p);find(tree,item=>item.children==="Stop")!.onClick();expect(p.onAction).toHaveBeenCalledWith("stop","binding");find(tree,item=>item["aria-label"]==="Site access for https://example.com")!.onChange({target:{value:"never"}});expect(p.onSite).toHaveBeenCalledWith("binding","https://example.com","never");});
 it("pause and stop are disabled after Stop",()=>{const p=props();const tree=BrowserExtensionPanelView({...p,status:{...status,bindings:[{...status.bindings[0],state:"stopped"}]}});expect(find(tree,item=>item.children==="Stop")!.disabled).toBe(true);expect(find(tree,item=>item.children==="Pause")!.disabled).toBe(true);});
 it("offline errors replace indefinite checking with repair action",()=>{const markup=renderToStaticMarkup(createElement(BrowserExtensionPanelView,{...props(),status:null,error:"Murage is offline"}));expect(markup).toContain("Browser connection unavailable");expect(markup).not.toContain("unpacked development extension");expect(markup).toContain('role="alert"');expect(markup).toContain("Check connection");expect(markup).not.toContain("Checking browser connection");});
});

it("forwards the explicit offline browser choice",()=>{const p=props();const tree=BrowserExtensionPanelView({...p,connectBrowser:"brave",status:{...status,profiles:[],bindings:[]}});find(tree,item=>item.children==="Check connection")!.onClick();expect(p.onCheck).toHaveBeenCalledWith("brave");const html=renderToStaticMarkup(tree);expect(html).toContain("Browser to connect");expect(html).toContain('value="edge"');});

describe("store link, repair and removal",()=>{
 const offline={...status,profiles:[],bindings:[]};
 const shared={chrome:["brave","chrome"],edge:["edge"],brave:["brave","chrome"]};
 const extra=()=>({removing:false,removedNote:"",onRepair:vi.fn(),onRemoveAsk:vi.fn(),onRemoveConfirm:vi.fn(),onRemoveCancel:vi.fn()});
 it("links the Chrome Web Store listing only when the server gives one",()=>{
  const url="https://chromewebstore.google.com/detail/"+"c".repeat(32);
  const listed=renderToStaticMarkup(createElement(BrowserExtensionPanelView,{...props(),...extra(),status:{...offline,storeUrl:url,extensionBuild:"release",helper:{running:true,reason:"Add Murage for Chrome from the Chrome Web Store, then open its side panel and connect."}}}));
  expect(listed).toContain(`href="${url}"`);expect(listed).toContain('target="_blank"');expect(listed).toContain("Open Chrome Web Store");expect(listed).not.toContain("unpacked development extension");
  const pending=renderToStaticMarkup(createElement(BrowserExtensionPanelView,{...props(),...extra(),status:{...offline,storeUrl:null,extensionBuild:"release",helper:{running:true,reason:"Murage for Chrome is not in the Chrome Web Store yet. You can keep using the bot's own browser."}}}));
  expect(pending).not.toContain("href=");expect(pending).toContain("not in the Chrome Web Store yet");expect(pending).not.toContain("unpacked development extension");
 });
 it("offers Repair when this build needs the old owned registration replaced",()=>{
  const p={...props(),...extra(),connectBrowser:"brave" as const,status:{...offline,helper:{running:true,problem:"repair" as const,reason:"Remove this owned helper registration, then Connect again to use the new build."}}};
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

