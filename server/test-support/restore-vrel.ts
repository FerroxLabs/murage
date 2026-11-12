import {existsSync,readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import type {DatabaseSync} from "node:sqlite";
// v1.0.18 capability-db asset records fc3782abe834bb0a62c96437bff78ac4dbd96eeb.
// Extract that commit with git archive into .vrel-ref before running DG1.
const root=join(process.cwd(),".vrel-ref");
export const haveVRel=existsSync(join(root,"server/installation-database-snapshot.ts"));
export async function realVRel(){
 const source=readFileSync(join(root,"server/installation-database-snapshot.ts"),"utf8").replace("function referenceSchema()","export function referenceSchema()");
 writeFileSync(join(root,"server/installation-database-snapshot.export.ts"),source);
 const specifier="../../.vrel-ref/server/installation-database-snapshot.export.ts";
 return await import(/* @vite-ignore */ specifier) as {inspectInstallationDatabase(db:DatabaseSync):unknown;referenceSchema():Map<string,unknown>};
}
