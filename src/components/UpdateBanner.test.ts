import {readFileSync} from "node:fs";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {afterEach,expect,it,vi} from "vitest";
import type {UpdaterState} from "../types/muragebox";
const current=vi.hoisted(()=>({value:null as UpdaterState|null}));
vi.mock("@/lib/updater",()=>({useUpdaterState:()=>current.value}));
vi.mock("@/lib/update-card",async(importOriginal)=>({...(await importOriginal<typeof import("@/lib/update-card")>()),useUpdateCardOpen:()=>true}));
import {UpdateBanner} from "./UpdateBanner";
import {UpdatesRow} from "./SettingsModal";
afterEach(()=>{vi.unstubAllGlobals();current.value=null;});
it("publisher refusal shows one translated line and the website download action in both surfaces",()=>{
 vi.stubGlobal("window",{muragebox:{updater:{},openExternal:vi.fn()}});
 current.value={status:"error",currentVersion:"0.1.63",message:"PRIVATE_DIAGNOSTIC",action:"download-from-murage"};
 for(const Component of [UpdateBanner,UpdatesRow]){
  const html=renderToStaticMarkup(createElement(Component));
  expect(html).toContain("This update could not be verified, so Murage did not install it.");
  expect(html).toContain("Download from murage.ai");
  expect(html).not.toContain("PRIVATE_DIAGNOSTIC");
  expect(html).not.toContain("Update could not finish");
  expect(html).not.toContain("Try again");
 }
});
it("deferred updater renders fixed backup guidance with no install/download/retry/check action",()=>{
 const calls=vi.fn();vi.stubGlobal("window",{muragebox:{updater:{download:calls,install:calls,retry:calls,check:calls}}});
 current.value={status:"deferred",version:"0.1.54",message:"PRIVATE_UPDATER_CANARY",command:"PRIVATE_COMMAND",installMode:"handoff"};
 for(const Component of [UpdateBanner,UpdatesRow]){const html=renderToStaticMarkup(createElement(Component));expect(html).toContain("waiting for the pre-upgrade backup flow");expect(html).not.toContain("PRIVATE_");expect(html).not.toMatch(/>Install<|>Download<|>Retry<|>Check for updates</);}
 expect(renderToStaticMarkup(createElement(UpdatesRow))).not.toContain("<button");expect(calls).not.toHaveBeenCalled();
});
it("ordinary downloaded and handoff updater actions remain unchanged",()=>{
 vi.stubGlobal("window",{muragebox:{updater:{}}});current.value={status:"downloaded",version:"0.1.54",installMode:"restart"};expect(renderToStaticMarkup(createElement(UpdateBanner))).toContain("Restart to finish updating");
 current.value={status:"downloaded",version:"0.1.54",installMode:"handoff"};const html=renderToStaticMarkup(createElement(UpdateBanner));expect(html).toContain("Copy the install command and open a terminal");expect(html).toContain("Install</button>");expect(html).not.toContain("pre-upgrade backup");
});
it("the card is closed until the round button opens it",async()=>{
 vi.doMock("@/lib/update-card",async(importOriginal)=>({...(await importOriginal<typeof import("@/lib/update-card")>()),useUpdateCardOpen:()=>false}));
 vi.resetModules();
 vi.stubGlobal("window",{muragebox:{updater:{}}});current.value={status:"available",version:"0.1.54"};
 const {UpdateBanner:Closed}=await import("./UpdateBanner");
 expect(renderToStaticMarkup(createElement(Closed))).toBe("");
 vi.doUnmock("@/lib/update-card");
});
it("shows the release highlights on the card, as text",()=>{
 vi.stubGlobal("window",{muragebox:{updater:{}}});current.value={status:"available",version:"0.1.54",releaseNotesText:"- Chats open faster\n- Bots remember more"};
 const html=renderToStaticMarkup(createElement(UpdateBanner));
 expect(html).toContain("What&#x27;s new");expect(html).toContain("Chats open faster");expect(html).toContain("Bots remember more");
});
it("the card is a modal dialog that owns its keys and hands focus back",()=>{
 vi.stubGlobal("window",{muragebox:{updater:{}}});current.value={status:"available",version:"0.1.54"};
 const html=renderToStaticMarkup(createElement(UpdateBanner));
 expect(html).toContain('role="dialog"');expect(html).toContain('aria-modal="true"');
 const source=readFileSync(new URL("./UpdateBanner.tsx",import.meta.url),"utf8");
 expect(source).toContain("onKeyDown={onCardKeyDown}");expect(source).not.toContain('document.addEventListener("keydown"');
 expect(source).toContain('[data-testid="update-indicator"]');
});
