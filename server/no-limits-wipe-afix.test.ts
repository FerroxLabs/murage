// SPDX-License-Identifier: AGPL-3.0-or-later
// Review regressions use permission fixtures only; no destructive tool executes.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { baseRun, d, fixture } from './decision/fixture.ts';
import { describe, describeOwnerNoLimits } from './decision/action.ts';
import { beginOutsideTurn, noteSessionEdits, sessionEdits } from './email/external-marks.ts';
import { noteToolStartOutside } from './outside-wire.ts';
import { noLimitsWipe } from './no-limits-wipe.ts';
import { mcpSchemaWipeHints, recordMcpWipeHints } from './no-limits-wipe-mcp.ts';
import { connectorWipes } from './no-limits-wipe-tools.ts';
import { useOutsideStoreFixture } from './testing/outside-store-fixture.ts';
import { removeTempDirSync } from './testing/cleanup.ts';

useOutsideStoreFixture();
const roots:string[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const root of roots.splice(0))removeTempDirSync(root);});
const root=()=>{const path=mkdtempSync(join(tmpdir(),'murage-wipe-afix-'));roots.push(path);return path;};
const mcp=(server:string,tool:string,input:unknown)=>({tool:`mcp__${server}__${tool}`,toolCall:{name:`mcp__${server}__${tool}`,input},toolEngine:'claude',mcpMounts:[{engineName:server,mountId:`custom:${server}`,provenance:'custom'}]});

for(const query of ['DELETE FROM public."customers";', 'DELETE FROM "public"."customers";', 'DELETE FROM [public].[customers];', 'DELETE FROM `public`.`customers`;', 'DELETE FROM public . "customers";', 'DELETE FROM "odd;schema"."odd;table";'])it(`H1 qualified quoted SQL deletes card: ${query}`,()=>{
 const f=fixture(),input={query};
 // MAIN RULING NARROW-WIPE 2026-11-14: SQL deletion is outside the filesystem/disk catastrophe list.
 expect(d.decide(f.open(query,input,mcp('fixture','execute_sql',input)),baseRun).kind).toBe('run');f.dispose();
});
for(const query of ['DELETE FROM public."customers" WHERE id=1;', 'SELECT \'DELETE FROM public."customers";\';', 'SELECT "DELETE FROM public.customers";', '-- DELETE FROM public."customers";\nSELECT 1'])it(`H1 SQL boundaries run: ${query}`,()=>{
 const f=fixture(),input={query};
 // MAIN RULING NARROW-WIPE 2026-11-14: SQL predicates, comments and quoted SQL do not create catastrophe cards.
 expect(d.decide(f.open(query,input,mcp('fixture','execute_sql',input)),baseRun).kind).toBe('run');f.dispose();
});

for(const interpreter of ['python3.12','/usr/bin/python3.12','env python3.12','python3.13'])for(const safe of [false,true])it(`H2 versioned written interpreter ${interpreter} safe=${safe}`,()=>{
 const cwd=root(),f=fixture(),file=join(cwd,'cleanup.py');
 d.installDecisionHost({store:f.store,view:()=>({title:'Fixture',subtitle:'Script'}),executionContext:()=>({cwd,project:cwd})});
 beginOutsideTurn('t','p','turn',false,Date.now()-20);
 const input={file_path:file,content:safe?'print("ok")':"import shutil; shutil.rmtree('/archive/backups')"};
 noteToolStartOutside('t',{origin:'engine',title:'Write',input},cwd);writeFileSync(file,input.content);
 const command=`${interpreter} cleanup.py`;
 // MAIN RULING NARROW-WIPE 2026-11-14: code loaded from disk is outside the submitted-command breaker.
 expect(d.decide(f.open(command,{command,cwd}),baseRun).kind).toBe('run');f.dispose();
});

for(const [cwd,command]of [
 ['/tmp/scratch','cd /home/alice/project && git clean -fdx',true],
 ['/home/alice/project','cd /tmp/scratch && git clean -fdx',false],
 ['/tmp/scratch',"bash -c 'cd /home/alice/project && git clean -fdx'",true],
 ['/tmp/scratch','cd /home/alice/project && git clean -ndx',false],
] as const)it(`M1 Git clean uses execution cwd: ${command} from ${cwd}`,()=>{
 // MAIN RULING NARROW-WIPE 2026-11-14: Git cleanup runs in every execution cwd.
 expect(!!noLimitsWipe(command,{cwd})).toBe(false);
});
for(const [initial,selected]of [['feature','main',true],['main','feature',false]] as const)it(`M1 force push uses selected repository ${initial} -> ${selected}`,()=>{
 const cwd=root(),target=join(cwd,'other');
 for(const [dir,branch]of [[cwd,initial],[target,selected]]){mkdirSync(join(dir,'.git'),{recursive:true});writeFileSync(join(dir,'.git','HEAD'),`ref: refs/heads/${branch}\n`);}
 // MAIN RULING NARROW-WIPE 2026-11-14: Git history changes are outside the catastrophe list.
 expect(!!noLimitsWipe('cd other && git push --force',{cwd})).toBe(false);
});

for(const command of [undefined,'echo ok','bash cleanup.sh'])it(`M2 wipe reads never iterate session history: ${command??'non-command'}`,()=>{
 const cwd=root(),f=fixture(),file=join(cwd,'cleanup.sh');
 d.installDecisionHost({store:f.store,view:()=>({title:'Fixture',subtitle:'History'}),executionContext:()=>({cwd,project:cwd})});
 beginOutsideTurn('t','p','turn',false,Date.now()-20);
 noteSessionEdits('t','p',Array.from({length:1024},(_,i)=>join(cwd,`old-${i}.sh`)));
 noteSessionEdits('t','p',[file]);writeFileSync(file,'rm -rf backups');
 const iteration=vi.spyOn(sessionEdits('t','p') as Set<string>,Symbol.iterator);
 const input=command?{command,cwd}:{file_path:join(cwd,'notes.txt'),content:'ok'};
 const extra=command?{}:{tool:'Write',toolCall:{name:'Write',input}};
 // MAIN RULING NARROW-WIPE 2026-11-14: script execution does not inspect session history or bodies on disk.
 expect(d.decide(f.open('history',input,extra),baseRun).kind).toBe('run');
 expect(iteration).not.toHaveBeenCalled();f.dispose();
});

for(const [slug,card]of [['GOOGLEDRIVE_EMPTY_TRASH',true],['GMAIL_BATCH_DELETE_MESSAGES',true],['SHOPIFY_BULK_DELETE_PRODUCTS',true],['GOOGLEDRIVE_DELETE_FILE',false],['GMAIL_GET_BATCH_DELETE_STATUS',false]] as const)it(`M3 direct namespaced connector ${slug}`,()=>{
 const f=fixture(),input={},tool=`mcp__murage_connectors__${slug}`;
 const extra={tool,toolCall:{name:tool,input},toolEngine:'claude'};
 // MAIN RULING NARROW-WIPE 2026-11-14: connector bulk operations run; preserve their independent legacy classifier evidence.
 expect(d.decide(f.open(slug,input,extra),baseRun).kind).toBe('run');
 expect(describe({tool,input}).deletes).toEqual([]);
 if(card)expect(connectorWipes(tool,input)).toContainEqual({path:`connector:${slug}`,op:'delete'});
 expect(describeOwnerNoLimits({tool,input}).deletes).toEqual([]);
 f.dispose();
});

it('M4 live annotation catalogs survive more than 4096 registrations',()=>{
 const hints=mcpSchemaWipeHints([{name:'perform',annotations:{title:'Purge all owner records'}}]);
 expect(recordMcpWipeHints('t','oldest-live',hints,true)).toBe(true);
 for(let i=0;i<4097;i++)expect(recordMcpWipeHints(`catalog-thread-${i}`,'fixture',hints,true)).toBe(true);
 const f=fixture(),input={};
 // MAIN RULING NARROW-WIPE 2026-11-14: a retained bulk-operation annotation supplies no catastrophe target.
 expect(d.decide(f.open('oldest',input,mcp('oldest-live','perform',input)),baseRun).kind).toBe('run');
 expect(recordMcpWipeHints('t','oldest-live',[],true)).toBe(true);
 expect(d.decide(f.open('cleared',input,mcp('oldest-live','perform',input)),baseRun).kind).toBe('run');f.dispose();
});

for(const [title]of [['Destroy workspace',true],['Drop database',true],['Delete repository',true],['Purge mailbox',true],['Delete one record',false],['Read status of destroy workspace',false],['Update workspace',false]] as const)it(`M5 MCP annotation container scope: ${title}`,()=>{
 const f=fixture(),input={};
 expect(recordMcpWipeHints('t','container-title',mcpSchemaWipeHints([{name:'perform',annotations:{title}}]),true)).toBe(true);
 // MAIN RULING NARROW-WIPE 2026-11-14: annotation wording alone is outside the concrete-root breaker.
 expect(d.decide(f.open(title,input,mcp('container-title','perform',input)),baseRun).kind).toBe('run');f.dispose();
});

// Fold H1: recovered pipeline code keeps the shell consumer's execution cwd.
for(const [cwd,command]of [
 ['/home/alice/project',"printf '%s\\n' 'git clean -fdx' | bash -s",true],
 ['/home/alice/project',"printf '%s\\n' 'git clean -ndx' | bash -s",false],
 ['/home/alice/project',"printf '%s\\n' 'git clean -fdx'",false],
 ['/tmp/scratch',"printf '%s\\n' 'git clean -fdx' | bash -s",false],
 ['/tmp/scratch',"cd /home/alice/project && printf '%s\\n' 'git clean -fdx' | bash -s",true],
 ['/home/alice/project',"cd /tmp/scratch && printf '%s\\n' 'git clean -fdx' | bash -s",false],
] as const)it(`fold H1 piped Git wipe from ${cwd}: ${command}`,()=>{
 // MAIN RULING NARROW-WIPE 2026-11-14: printed and shell-consumed Git cleanup both run.
 expect(!!noLimitsWipe(command,{cwd})).toBe(false);
});
