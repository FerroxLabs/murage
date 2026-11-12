import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { prepareRelease } from './release-preparation.mjs';
import { handleCla, SIGNATURE } from './cla-record.mjs';
const sha = 'a'.repeat(40);
const repo = 'owner/repo';
function fixture(rows) {
  const calls=[];
  const api=async(method,path,body)=>{
    calls.push({method,path,body});
    const row=rows.shift();
    expect([method,path]).toEqual(row.slice(0,2));
    if(row[2] instanceof Error) throw row[2];
    return row[2];
  };
  return {api,calls,done:()=>expect(rows).toEqual([])};
}
const blob = value => ({encoding:'base64',content:Buffer.from(JSON.stringify(value)).toString('base64'),sha});
const branch='release/prep-1.2.3';
const prefix=`repos/${repo}`;
const prs=`${prefix}/pulls?state=open&base=main&head=owner%3Arelease%2Fprep-1.2.3`;
const ref=`${prefix}/git/ref/heads/release/prep-1.2.3`;
const packagePath=`${prefix}/contents/package.json?ref=release%2Fprep-1.2.3`;
const notFound=Object.assign(new Error('missing'),{status:404});
it('preparation creates only the version branch, opens its PR and dispatches CI',async()=>{
 const f=fixture([
  ['GET',ref,null],['GET',`${prefix}/git/commits/${sha}`,{tree:{sha}}],
  ['GET',`${prefix}/contents/package.json?ref=${sha}`,blob({name:'murage',version:'1.2.2'})],
  ['POST',`${prefix}/git/trees`,{sha}],['POST',`${prefix}/git/commits`,{sha}],
  ['POST',`${prefix}/git/refs`,{}],['GET',prs,[]],['POST',`${prefix}/pulls`,{number:42,html_url:'https://github.com/owner/repo/pull/42'}],
  ['POST',`${prefix}/actions/workflows/ci.yml/dispatches`,null],
 ]);
 const result=await prepareRelease({repository:repo,version:'1.2.3',sha},f.api);
 expect(result.number).toBe(42); f.done();
 expect(f.calls.find(c=>c.path.endsWith('/git/refs')).body.ref).toBe(`refs/heads/${branch}`);
 expect(JSON.parse(f.calls.find(c=>c.path.endsWith('/git/trees')).body.tree[0].content).version).toBe('1.2.3');
 expect(f.calls.at(-1).body).toEqual({ref:branch});
});
it.each([true,false])('preparation inspects an existing branch and reuses PR=%s without rewriting',async existing=>{
 const pr={number:42,html_url:'https://github.com/owner/repo/pull/42'};
 const rows=[['GET',ref,{object:{sha}}],['GET',packagePath,blob({version:'1.2.3'})],['GET',prs,existing?[pr]:[]]];
 if(!existing) rows.push(['POST',`${prefix}/pulls`,pr]);
 rows.push(['POST',`${prefix}/actions/workflows/ci.yml/dispatches`,null]);
 const f=fixture(rows); await prepareRelease({repository:repo,version:'1.2.3',sha},f.api); f.done();
 expect(f.calls.filter(c=>c.method!=='GET').map(c=>c.path)).toEqual(existing?[`${prefix}/actions/workflows/ci.yml/dispatches`]:[`${prefix}/pulls`,`${prefix}/actions/workflows/ci.yml/dispatches`]);
});
it('preparation refuses a mismatched existing version before mutations',async()=>{
 const f=fixture([['GET',ref,{}],['GET',packagePath,blob({version:'9.9.9'})]]);
 await expect(prepareRelease({repository:repo,version:'1.2.3',sha},f.api)).rejects.toThrow(/version/); f.done();
});
it('preparation propagates API failure without treating it as missing',async()=>{
 const f=fixture([['GET',ref,new Error('API failed')]]);
 await expect(prepareRelease({repository:repo,version:'1.2.3',sha},f.api)).rejects.toThrow('API failed'); f.done();
});
const author={login:'alice',id:7};
const event=(body=SIGNATURE,user=author)=>({issue:{number:42,pull_request:{}},comment:{body,user,created_at:'2026-11-10T00:00:00Z',id:23}});
const signatures=`${prefix}/contents/signatures/cla.json`;
it('exact signature by the API-derived PR author is recorded at the signatures location',async()=>{
 const f=fixture([['GET',`${prefix}/pulls/42`,{user:author}],['GET',`${signatures}?ref=cla-signatures`,blob({signedContributors:[]})],['PUT',signatures,{}]]);
 expect(await handleCla({repository:repo,eventName:'issue_comment',event:event()},f.api)).toEqual({signed:true,recorded:true}); f.done();
 const body=f.calls.at(-1).body;
 expect(body.branch).toBe('cla-signatures'); expect(body.sha).toBe(sha);
 expect(JSON.parse(Buffer.from(body.content,'base64')).signedContributors[0]).toMatchObject({name:'alice',id:7,created_at:'2026-11-10T00:00:00Z'});
});
it.each([[SIGNATURE,{login:'mallory',id:8}],[SIGNATURE+' ',author],['recheck',author]])('non-author or non-exact comment does not record: %s',async(body,user)=>{
 const calls=[]; const api=async(...args)=>{calls.push(args);return {user:author};};
 expect(await handleCla({repository:repo,eventName:'issue_comment',event:event(body,user)},api)).toMatchObject({recorded:false});
 expect(calls.every(c=>c[0]==='GET')).toBe(true);
});
it('manual recheck derives author from PR number and reads their signature',async()=>{
 const f=fixture([['GET',`${prefix}/pulls/42`,{user:author}],['GET',`${signatures}?ref=cla-signatures`,blob({signedContributors:[{name:'alice',id:7}]})]]);
 expect(await handleCla({repository:repo,eventName:'workflow_dispatch',event:{inputs:{pr_number:'42'}}},f.api)).toEqual({signed:true,recorded:false}); f.done();
});
it('manual recheck rejects an unsigned author',async()=>{
 const f=fixture([['GET',`${prefix}/pulls/42`,{user:author}],['GET',`${signatures}?ref=cla-signatures`,blob({signedContributors:[]})]]);
 await expect(handleCla({repository:repo,eventName:'workflow_dispatch',event:{inputs:{pr_number:'42'}}},f.api)).rejects.toThrow(/CLA/); f.done();
});
it('CLA dispatch requires a PR number and the comment handler is wired',()=>{
 const d=parse(readFileSync(new URL('../.github/workflows/cla.yml',import.meta.url),'utf8'));
 expect(d.on.issue_comment.types).toEqual(['created']);
 expect(d.on.workflow_dispatch.inputs.pr_number.required).toBe(true);
 expect(d.jobs.record.permissions).toEqual({contents:'write'});
 expect(d.jobs.record.steps.at(-1).run).toBe('node scripts/cla-record.mjs');
});
it('preparation retains the patch and connects its pinned version to open-pr',()=>{
 const d=parse(readFileSync(new URL('../.github/workflows/prepare-release.yml',import.meta.url),'utf8'));
 expect(d.jobs.prepare.steps.some(s=>s.with?.name==='release-version-patch')).toBe(true);
 expect(d.jobs['open-pr'].needs).toEqual(['prepare']);
 expect(d.jobs['open-pr'].permissions).toEqual({contents:'write','pull-requests':'write',actions:'write'});
 expect(d.jobs['open-pr'].steps.at(-1).run).toBe('node scripts/release-preparation.mjs');
});
it('release and CLA procedures document the exact implemented handoffs',()=>{
 const release=readFileSync(new URL('../docs/releasing.md',import.meta.url),'utf8');
 const cla=readFileSync(new URL('../CLA.md',import.meta.url),'utf8');
 expect(release).toContain('release/prep-');
 expect(release).toContain('release-version-patch');
 expect(release).toContain('Re-run all jobs');
 expect(cla).toContain('signatures/cla.json');
 expect(cla).toContain('pr_number');
 expect(cla).toContain('Re-run failed jobs');
});
