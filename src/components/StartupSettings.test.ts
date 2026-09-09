import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect,it } from "vitest";
import { StartupSettingsView } from "./StartupSettings";
import type { StartupBackgroundState } from "@/types/muragebox";

const state:StartupBackgroundState={platform:"darwin",keepRunning:true,defaultInherited:true,configurable:true,trayAvailable:true,canKeepRunning:true,effectiveKeepRunning:true,windowVisible:true,suspended:false,quitting:false,automationsPaused:false,login:{supported:true,openAtLogin:false}};
const render=(value=state)=>renderToStaticMarkup(createElement(StartupSettingsView,{state:value,busy:false,onChange:()=>{}}));
it("labels the explicit controls and preserves the inherited Mac behavior",()=>{
  const html=render();expect(html).toContain("Keep running when the window closes");expect(html).toContain("Start when I sign in");expect(html).toContain("The Mac default");expect(html).toContain("Sleeping or switching it off stops progress");
});
it("does not promise hidden background operation without a reopen surface",()=>{
  const html=render({...state,platform:"linux",trayAvailable:false,canKeepRunning:false,effectiveKeepRunning:false,login:{supported:true,openAtLogin:true}});
  expect(html).toContain("Closing the last window quits Murage");expect(html).toContain("Sign-in startup opens the window");expect(html).not.toContain("opens quietly");
});
it("reports suspension and OS login approval instead of claiming readiness",()=>{
  const html=render({...state,suspended:true,login:{supported:true,openAtLogin:false,requiresApproval:true}});expect(html).toContain("This computer is asleep");expect(html).toContain("Approve Murage in your system");
});
