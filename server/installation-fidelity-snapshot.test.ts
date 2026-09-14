import { mkdirSync,readFileSync,rmSync,symlinkSync,writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect,it } from "vitest";
import { withOfflineInstallation } from "./installation-database-snapshot.ts";
import { stageInstallationStateWhileOwned } from "./installation-state-snapshot.ts";
import { inventoryFidelity } from "./installation-fidelity-snapshot.ts";
import { backupFixture } from "./testing/backup-fixture.ts";
const selection={scope:"application-data",credentialPolicy:"preserve-in-encrypted-fidelity"} as const;
it("keeps fidelity metadata under the same lease and detects later component changes",async()=>{
  const f=backupFixture();try{await withOfflineInstallation(f.data,async installation=>{
    const stage=await stageInstallationStateWhileOwned(installation,f.parent);
    const inventory=await inventoryFidelity(f.data,stage,selection);
    expect(inventory.coverage.fullInstallation).toBe(false);
    expect(inventory.sources.find(file=>file.path==="config.json")?.bytes).toBe(readFileSync(join(f.data,"config.json")).length);
    writeFileSync(join(f.data,"workspaces","report.md"),"changed");
    expect(inventory.assertUnchanged).toThrow();expect(stage.assertSourceUnchanged).toThrow();
  });}finally{f.db.close();rmSync(f.parent,{recursive:true,force:true});}
});
it.each(["unknown","symlink"])("refuses incomplete selected coverage: %s",async kind=>{
  const f=backupFixture();try{
    if(kind==="unknown")writeFileSync(join(f.data,"new-state.json"),"private unknown component");
    else{mkdirSync(join(f.parent,"outside"));symlinkSync(join(f.parent,"outside"),join(f.data,"workspaces","linked"));}
    await expect(withOfflineInstallation(f.data,async installation=>{const stage=await stageInstallationStateWhileOwned(installation,f.parent);return inventoryFidelity(f.data,stage,selection);})).rejects.toThrow();
  }finally{f.db.close();rmSync(f.parent,{recursive:true,force:true});}
});
