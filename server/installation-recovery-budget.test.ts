import { beforeEach, expect, it, vi } from "vitest";
const write=vi.hoisted(()=>vi.fn(async()=>({path:"fixture.age"})));
vi.mock("./installation-encrypted-backup.ts",()=>({writeEncryptedInstallationBackup:write,inspectEncryptedInstallationBackup:vi.fn(),restoreEncryptedInstallationNew:vi.fn()}));
import { installationRecoveryCommand } from "./installation-recovery-command.ts";
const args=["backup-encrypted","--data-dir","fixture","--output","fixture.age","--age-tool","fixed-age","--recipient","fixture-public-recipient","--credential-policy","preserve-in-encrypted-fidelity"];
beforeEach(()=>write.mockClear());
it("legacy five-option backup is unchanged; explicit budgets reach existing backend fields",async()=>{
 const readIdentity=vi.fn(async()=>"fixture-private-input");await installationRecoveryCommand(args,{readIdentity});expect(write).toHaveBeenLastCalledWith("fixture","fixture.age",{ageExecutable:"fixed-age",recipient:"fixture-public-recipient",identity:"fixture-private-input",selection:{scope:"application-data",credentialPolicy:"preserve-in-encrypted-fidelity"}});
 await installationRecoveryCommand([...args,"--max-bytes","500000","--max-duration-ms","120000"],{readIdentity});expect(write).toHaveBeenLastCalledWith("fixture","fixture.age",expect.objectContaining({maxBytes:500000,timeoutMs:120000,signal:expect.any(AbortSignal)}));
});
it("invalid, overflowing, duplicate and unknown limits refuse before private input or backend",async()=>{
 const readIdentity=vi.fn(async()=>"fixture-private-input");for(const extra of [["--max-bytes","0"],["--max-bytes","1099511627777"],["--max-bytes","9007199254740992"],["--max-bytes","1e6"],["--max-bytes","+1"],["--max-duration-ms","999"],["--max-duration-ms","1800001"],["--max-duration-ms","NaN"],["--max-bytes","1","--max-bytes","2"],["--unknown","1"]])await expect(installationRecoveryCommand([...args,...extra],{readIdentity})).rejects.toThrow();expect(readIdentity).not.toHaveBeenCalled();expect(write).not.toHaveBeenCalled();
});
