import {mkdtempSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,relative} from "node:path";
import {expect,it} from "vitest";
import {scanMoves,type MoveClass} from "./test-support/restore-path-scan.ts";
import {removeTempDirSync} from "./testing/cleanup.ts";
it("P4 inventory covers every database move and names an executed drop",async()=>{
 const {RESTORE_PATH_INVENTORY}=await import("./restore-path-inventory.ts");const result=scanMoves(["server","deploy/cloud-home"],RESTORE_PATH_INVENTORY);
 expect(result.unclassified).toEqual([]);expect(result.stale).toEqual([]);
 for(const site of result.sites){const c=RESTORE_PATH_INVENTORY[site.key];if(c.kind==="not-live-db"||c.kind==="restores-outgoing")expect(c.reason.length).toBeGreaterThanOrEqual(20);
 if(c.kind==="installs-live-db"){const [file,fn]=c.drop.split("::");expect(result.functions.get(`${file}::${fn}`)).toContain("DROP TABLE IF EXISTS restore_boot_wait");const {readFileSync,readdirSync}=await import("node:fs");const testFiles=[...readdirSync("server").map(n=>join("server",n)),...readdirSync("server/email").map(n=>join("server/email",n))].filter(n=>n.endsWith(".test.ts"));expect(testFiles.some(p=>readFileSync(p,"utf8").includes(c.test))).toBe(true);}}
});
it("P4f new files cannot hide an unclassified move",()=>{const root=mkdtempSync(join(tmpdir(),"j4d3-scan-"));try{writeFileSync(join(root,"fixture.ts"),"function relocate(a,b){renameSync(a,b)};function a(){relocate(x,dataDir)}");expect(scanMoves([root],{}).unclassified).toContain(`${relative(process.cwd(),join(root,"fixture.ts"))}::relocate::renameSync::0`);}finally{removeTempDirSync(root);}});
it("P4g new caller of a generic helper must be classified",()=>{const root=mkdtempSync(join(tmpdir(),"j4d3-scan-"));try{const file=join(root,"fixture.ts"),f=relative(process.cwd(),file);writeFileSync(file,"function relocate(a,b){renameSync(a,b)};function a(){relocate(x,dataDir)};function b(){relocate(y,dataDir)}");const inventory:Record<string,MoveClass>={[`${f}::relocate::renameSync::0`]:{kind:"generic"},[`${f}::a::relocate::0`]:{kind:"not-live-db",reason:"fixture caller moves its own document"}};expect(scanMoves([root],inventory).unclassified).toEqual([`${f}::b::relocate::0`]);inventory[`${f}::b::relocate::0`]={kind:"not-live-db",reason:"fixture caller moves its own document"};expect(scanMoves([root],inventory).unclassified).toEqual([]);}finally{removeTempDirSync(root);}});
