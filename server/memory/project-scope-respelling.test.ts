// One folder, one project scope — including the folders a user already bound
// under a different spelling of the same path.
//
// The project path arrives from a free-text box, so `~/documents/app` and
// `~/Documents/app` are both things a user types for one folder. Before the
// native realpath landed each spelling produced its own owner_key: a second
// scope, and memories that silently stopped surfacing. These cover the
// migration that re-keys the row a user already has, and the line it must not
// cross — a canonical scope that already exists is not merged into.
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { ownerMemoryTicket } from "./authority.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { memoryOwnerRoute } from "./settings.ts";
import type { MemoryRecord } from "../../shared/memory.ts";

const roster = {bots:[{id:"a",threadId:"ta"},{id:"b",threadId:"tb"}],groups:[]};
beforeEach(()=>{closeDatabase();rmSync(DATA_DIR,{recursive:true,force:true});mkdirSync(DATA_DIR,{recursive:true});reconcileMemoryRoster(roster);});

const route=(body:unknown)=>memoryOwnerRoute("/api/memory/action",body,ownerMemoryTicket(),roster);
const bind=(path:string)=>route({action:"project",path,subjectType:"bot",subjectId:"a"}) as Promise<{scopeId:string;path:string}>;
const list=(scopeId:string)=>route({action:"list",botId:"a",scopeId}) as Promise<{records:MemoryRecord[]}>;

// The throwaway home from server/testing/setup.ts outlives each test's data
// directory reset, so project fixtures live there rather than under DATA_DIR.
let made=0;
function projectDirectory(name:string){
  const path=join(homedir(),"project-fixtures",`${name}-${++made}`);
  mkdirSync(path,{recursive:true});
  // The system temp directory is itself reached through a link on macOS, so
  // the fixture is named the way the route will answer: these tests are about
  // spelling, and a link the route resolves is not the difference under test.
  return realpathSync.native(path);
}
/** The same folder, spelled with a lowercase final segment. */
const lowercaseLeaf=(path:string)=>join(dirname(path),basename(path).toLowerCase());

// A case respelling only names the same folder where the filesystem is
// case-insensitive (macOS and Windows by default). On a case-sensitive volume
// the two spellings are two folders, and adopting across them would be wrong.
const caseInsensitive=(()=>{const probe=projectDirectory("CaseProbe");return existsSync(lowercaseLeaf(probe));})();

function note(scopeId:string,id:string){
  database().prepare("INSERT INTO memory_records VALUES(?,1,?,'fact',?,'owner-statement','active',0,1,NULL,NULL,1)").run(id,scopeId,`note ${id}`);
}
const projectScopes=()=>database().prepare("SELECT id,owner_key,revision FROM memory_scopes WHERE kind='project' ORDER BY owner_key").all()
  .map(row=>({id:String(row.id),ownerKey:String(row.owner_key),revision:Number(row.revision)}));
const recordsIn=(scopeId:string)=>database().prepare("SELECT id FROM memory_records WHERE scope_id=? ORDER BY id").all(scopeId).map(row=>String(row.id));

/** The scope the user already has under `legacy` is re-keyed to the canonical
 * `directory`, and the memories bound to it come back. */
async function adopts(directory:string,legacy:string){
  const original=ensureScope("project",legacy);note(original,"kept");
  const bound=await bind(directory);
  expect(bound).toEqual({scopeId:original,path:directory});
  expect(projectScopes()).toEqual([{id:original,ownerKey:directory,revision:1}]);
  expect((await list(original)).records.map(record=>record.id)).toEqual(["kept"]);
}

it("adopts a scope stored with a trailing separator, and its records still resolve",async()=>{
  const directory=projectDirectory("app");
  await adopts(directory,`${directory}/`);
});

it.skipIf(!caseInsensitive)("adopts a scope stored under another casing of the same folder, and its records still resolve",async()=>{
  const directory=projectDirectory("App");
  await adopts(directory,lowercaseLeaf(directory));
});

it.skipIf(!caseInsensitive)("leaves the older row alone when a canonical scope already exists",async()=>{
  const directory=projectDirectory("App");
  const canonical=ensureScope("project",directory);note(canonical,"canonical");
  const older=ensureScope("project",lowercaseLeaf(directory));note(older,"older");
  expect(older).not.toBe(canonical);

  const bound=await bind(directory);
  expect(bound.scopeId).toBe(canonical);
  // The older row keeps its id, its spelling and its revision: two scopes is
  // what the user has, and merging their records is not a rename.
  expect(projectScopes()).toContainEqual({id:older,ownerKey:lowercaseLeaf(directory),revision:0});
  expect(projectScopes()).toHaveLength(2);
  expect(recordsIn(older)).toEqual(["older"]);
  expect((await list(canonical)).records.map(record=>record.id)).toEqual(["canonical"]);
});

it("gives a genuinely different project its own scope",async()=>{
  const directory=projectDirectory("app");
  // A sibling whose name merely starts with the other's is still another
  // folder — the one a prefix comparison would have swallowed.
  const sibling=`${directory}-archive`;mkdirSync(sibling,{recursive:true});
  const first=ensureScope("project",directory);note(first,"first");

  const bound=await bind(sibling);
  expect(bound.scopeId).not.toBe(first);
  expect(projectScopes()).toEqual([
    {id:first,ownerKey:directory,revision:0},
    {id:bound.scopeId,ownerKey:sibling,revision:0},
  ]);
  expect(recordsIn(first)).toEqual(["first"]);
  expect((await list(bound.scopeId)).records).toEqual([]);
});

it.skipIf(!caseInsensitive)("adopts once and stays put across repeated runs",async()=>{
  const directory=projectDirectory("App");
  const original=ensureScope("project",lowercaseLeaf(directory));note(original,"kept");

  const runs=[await bind(directory),await bind(directory),await bind(lowercaseLeaf(directory))];
  for(const run of runs)expect(run).toEqual({scopeId:original,path:directory});
  // One adoption, one revision bump — a re-run is not a second rename.
  expect(projectScopes()).toEqual([{id:original,ownerKey:directory,revision:1}]);
  expect((await list(original)).records.map(record=>record.id)).toEqual(["kept"]);
});
