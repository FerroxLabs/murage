import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {afterEach,expect,it,vi} from "vitest";
import type {UpdaterState} from "../types/muragebox";
const current=vi.hoisted(()=>({value:null as UpdaterState|null}));
vi.mock("@/lib/updater",()=>({useUpdaterState:()=>current.value}));
import {UpdateBanner} from "./UpdateBanner";
import {UpdatesRow} from "./SettingsModal";
afterEach(()=>{vi.unstubAllGlobals();current.value=null;});
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
