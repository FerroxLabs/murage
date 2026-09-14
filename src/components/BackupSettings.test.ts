import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect,it } from "vitest";
import { BackupSettingsView } from "./BackupSettings";
it("distinguishes encrypted app data and projected recovery without claiming native coverage",()=>{
  const html=renderToStaticMarkup(createElement(BackupSettingsView,{supported:true,busy:false,onRestart:()=>{}}));
  expect(html).toContain("Restart into Backup mode");expect(html).toContain("reduced recovery copy");expect(html).toContain("not included");expect(html).not.toContain('type="password"');
});
it("unavailable and pending states cannot offer an active restart",()=>{
  const unavailable=renderToStaticMarkup(createElement(BackupSettingsView,{supported:false,busy:false,onRestart:()=>{}}));
  expect(unavailable).toContain("supported packaged app with its verified backup tool");
  expect(unavailable).not.toContain("packaged Mac app");
  for(const state of [{supported:false,busy:false},{supported:true,busy:true}])expect(renderToStaticMarkup(createElement(BackupSettingsView,{...state,onRestart:()=>{}}))).toContain('disabled=""');
});
