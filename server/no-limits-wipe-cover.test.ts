// SPDX-License-Identifier: AGPL-3.0-or-later
// Permission inputs only: no external tools or destructive commands execute.
import { expect, it } from 'vitest';
import { d, fixture, baseRun } from './decision/fixture.ts';
import { describe, describeOwnerNoLimits } from './decision/action.ts';

const batch=(tools:unknown[])=>({tools});
const row=(tool_slug:string)=>({tool_slug,arguments:{}});
for(const slug of ['GMAIL_BATCH_DELETE_MESSAGES','GOOGLEDRIVE_EMPTY_TRASH','SHOPIFY_BULK_DELETE_PRODUCTS','GITHUB_DELETE_REPOSITORY','GMAIL_BULK_PERMANENTLY_DELETE_MESSAGES','AIRTABLE_DROP_TABLE'])it(`W1 bulk connector ${slug} cards`,()=>{
 const f=fixture(),input=batch([row(slug)]),tool='COMPOSIO_MULTI_EXECUTE_TOOL';
 expect(d.decide(f.open(slug,input,{tool,toolCall:{name:tool,input}}),baseRun).kind).toBe('card');
 expect(describeOwnerNoLimits({tool,input}).deletes).toContainEqual({path:`connector:${slug}`,op:'delete'});
 expect(describe({tool,input}).deletes).toEqual([]); // The RC Full access reader stays unchanged.
 f.dispose();
});
for(const slug of ['GMAIL_DELETE_DRAFT','GMAIL_DELETE_MESSAGE','GOOGLEDRIVE_DELETE_FILE','SHOPIFY_DELETE_PRODUCT','GMAIL_PERMANENTLY_DELETE_MESSAGE','GOOGLEDRIVE_PERMANENTLY_DELETE_FILE','SHOPIFY_DESTROY_PRODUCT','GMAIL_PURGE_MESSAGE','SHOPIFY_DROP_PRODUCT','GMAIL_LIST_MESSAGES','GMAIL_GET_BATCH_DELETE_STATUS'])it(`W1 single connector ${slug} runs`,()=>{
 const f=fixture(),input=batch([row(slug)]),tool='COMPOSIO_MULTI_EXECUTE_TOOL';
 expect(d.decide(f.open(slug,input,{tool,toolCall:{name:tool,input}}),baseRun).kind).toBe('run');f.dispose();
});
for(const count of [20,21,25])it(`W1 repeated delete batch ${count}`,()=>{
 const f=fixture(),input=batch(Array.from({length:count},(_,i)=>({tool_slug:'GOOGLEDRIVE_DELETE_FILE',arguments:{file_id:`fixture-${i}`}}))),tool='COMPOSIO_MULTI_EXECUTE_TOOL';
 expect(d.decide(f.open('batch',input,{tool,toolCall:{name:tool,input}}),baseRun).kind).toBe(count>20?'card':'run');f.dispose();
});
it('W1 direct connector slug is also checked',()=>{
 expect(describeOwnerNoLimits({tool:'GMAIL_BATCH_DELETE_MESSAGES',input:{}}).deletes).toContainEqual({path:'connector:GMAIL_BATCH_DELETE_MESSAGES',op:'delete'});
});

for(const command of ['dropdb prod','sudo dropdb --if-exists prod','redis-cli FLUSHALL','redis-cli -h fixture FLUSHDB ASYNC','mongosh --eval "db.dropDatabase()"','mongo --eval "db.customers.drop()"','supabase db reset','prisma migrate reset --force','prisma db push --force-reset','rails db:drop','rake db:reset',"psql <<'SQL'\nDROP TABLE customers;\nSQL",'mysql <<SQL\nTRUNCATE TABLE customers;\nSQL','sqlite3 fixture.db <<< "DELETE FROM customers;"'])it(`W2 shell SQL wipe ${command}`,()=>{
 const f=fixture();expect(d.decide(f.open(command,{command,cwd:'/w'}),baseRun).kind).toBe('card');f.dispose();
});
for(const command of ['redis-cli GET FLUSHALL','echo dropdb prod','echo "redis-cli FLUSHALL"',"cat <<'SQL'\nDROP TABLE customers;\nSQL",'psql -c "select \'drop table customers\'"',"psql -c \"-- DROP TABLE customers\nSELECT 1\"",'mysql -e "DELETE FROM customers WHERE id=1"',"psql <<SQL < /tmp/fixture.sql\nDROP TABLE customers;\nSQL",'redis-cli --help'])it(`W2 ordinary SQL/data runs ${command}`,()=>{
 const f=fixture();expect(d.decide(f.open(command,{command,cwd:'/w'}),baseRun).kind).toBe('run');f.dispose();
});
const sqlEvent=(tool:string,input:unknown)=>({tool:`mcp__fixture__${tool}`,toolCall:{name:`mcp__fixture__${tool}`,input},toolEngine:'claude',mcpMounts:[{engineName:'fixture',mountId:'custom:fixture',provenance:'custom'}]});
for(const [query,card]of [['DROP TABLE customers',true],['/*fixture*/ DROP SCHEMA public CASCADE',true],["select 'drop table x'",false],["select $$; DROP TABLE x;$$",false],['-- DROP TABLE x\nselect 1',false],['DELETE FROM customers WHERE id=1',false],['DELETE FROM customers;',true],['select 1; TRUNCATE TABLE customers',true]] as const)it(`W2 MCP SQL ${query}`,()=>{
 const f=fixture(),input={query},extra=sqlEvent('execute_sql',input);
 expect(d.decide(f.open(query,input,extra),baseRun).kind).toBe(card?'card':'run');f.dispose();
});
for(const field of ['query','sql','statement','statements','migration'])it(`W2 MCP SQL field ${field}`,()=>{
 const f=fixture(),input={[field]:field==='statements'?['select 1','DROP DATABASE fixture']: 'DROP DATABASE fixture'},extra=sqlEvent('execute_sql',input);
 expect(d.decide(f.open(field,input,extra),baseRun).kind).toBe('card');f.dispose();
});

for(const [command,card]of [['git push --force',true],['git push -f origin',true],['git push --mirror',true],['git push --mirror --dry-run',false],['git push --mirror -n',false],['git push --force --all',true],['git clean -fdx',true],['git clean -f -d -X',true],['git clean -fd',false],['git clean -ndx',false],['git push --force-with-lease',false],['git -C /tmp/murage-fixture clean -fdx',false]] as const)it(`W5 git bulk wipe ${command}`,()=>{
 const f=fixture();expect(d.decide(f.open(command,{command,cwd:'/w'}),baseRun).kind).toBe(card?'card':'run');f.dispose();
});

for(const [tool,input,card]of [
 ['delete_all_files',{},true],['bulk_delete_records',{ids:['a','b']},true],['destroy_workspace',{workspace_id:'fixture'},true],['purge',{scope:'all'},true],['delete_records',{ids:Array.from({length:25},(_,i)=>`fixture-${i}`)},true],['delete_directory',{path:'/w'},true],
 ['delete_file',{path:'/w/tmp/x'},false],['delete_record',{id:'fixture'},false],['purge_cache',{key:'fixture'},false],['describe',{text:'delete all files'},false],['list_all_files',{},false],['list_all_delete_jobs',{},false],
] as const)it(`W6 MCP bulk scope ${tool}: ${card}`,()=>{
 const f=fixture(),extra=sqlEvent(tool,input);
 d.installDecisionHost({store:f.store,view:()=>({title:'Fixture',subtitle:'MCP'}),executionContext:()=>({cwd:'/w',project:'/w'})});
 expect(d.decide(f.open(tool,input,extra),baseRun).kind).toBe(card?'card':'run');f.dispose();
});
for(const command of ['redis-cli --scan --pattern FLUSHALL',`mongosh --eval "print('db.dropDatabase()')"`])it(`W2 CLI value is data: ${command}`,()=>{
 const f=fixture();expect(d.decide(f.open(command,{command,cwd:'/w'}),baseRun).kind).toBe('run');f.dispose();
});
