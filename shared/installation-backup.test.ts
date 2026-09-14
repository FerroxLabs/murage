import { expect,it } from "vitest";
import { backupSelectionSchema } from "./installation-backup.ts";
it("requires explicit encrypted credential preservation and a bounded application scope",()=>{
  expect(backupSelectionSchema.safeParse({scope:"application-data",credentialPolicy:"preserve-in-encrypted-fidelity"}).success).toBe(true);
  for(const selection of [{scope:"application-data"},{scope:"full"},{scope:"application-data",credentialPolicy:"preserve-in-encrypted-fidelity",externalRoots:["/"]}])expect(backupSelectionSchema.safeParse(selection).success).toBe(false);
});
