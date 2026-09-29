import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect,it } from "vitest";
import { BackupSettingsView, RecoveryKeyCloudNotice, type ScheduleController } from "./BackupSettings";
import { cloudKeyMoved, cloudKeyNotice } from "./backups-section-ui";
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

// 0.1.61 (Sean, 2026-09-29): a recovery key 0.1.60 left in a folder that syncs
// to the cloud is named once, with Move and Keep here.
it("names the cloud service and the key's file name, with Move and Keep here",()=>{
  const s={cloudKey:cloudKeyNotice({provider:"OneDrive",label:"murage-recovery-key.txt",path:"C:\\Users\\sam\\OneDrive\\Documents\\murage-recovery-key.txt"}),moveCloudKey:()=>{},keepCloudKey:()=>{},busy:false} as unknown as ScheduleController;
  const html=renderToStaticMarkup(createElement(RecoveryKeyCloudNotice,{s}));
  expect(html).toContain("Your recovery key is in a folder that syncs to OneDrive.");
  expect(html).toContain(">Move<");expect(html).toContain(">Keep here<");
  expect(html).not.toContain("Users");expect(html).not.toMatch(/—|\bsafe/i);
  expect(renderToStaticMarkup(createElement(RecoveryKeyCloudNotice,{s:{...s,cloudKey:null} as ScheduleController}))).toBe("");
  expect(cloudKeyNotice({provider:"OneDrive"})).toBeNull();
});
it("says where the key went and that the cloud may still hold the old file",()=>{
  const moved=cloudKeyMoved({moved:true,provider:"OneDrive",label:"murage-recovery-key.txt",folder:"sam",oldRemoved:true});
  expect(moved).toBe("Your recovery key is now murage-recovery-key.txt in sam, on this computer only, and your backups use it. OneDrive may still keep the old file in its recycle bin: empty it there to remove it from the cloud.");
  expect(cloudKeyMoved({moved:true,provider:"OneDrive",label:"k.txt",folder:"sam",oldRemoved:false})).toContain("The old file in OneDrive could not be removed: delete it there yourself.");
  expect(()=>cloudKeyMoved({refused:"BACKUP_BUSY"})).toThrow("BACKUP_BUSY");
  expect(()=>cloudKeyMoved({moved:true,provider:"OneDrive"})).toThrow();
});
