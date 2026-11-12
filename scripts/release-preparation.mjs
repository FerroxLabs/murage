import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { githubApi, repositoryPath, decodeContent } from './workflow-github.mjs';
// This module has only repository/PR/CI operations. It never receives the
// release credential, creates a tag, or rewrites an existing branch.
export async function prepareRelease({repository,version,sha}, api = githubApi) {
  const prefix=repositoryPath(repository);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '') || !/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('invalid version or source commit');
  const branch=`release/prep-${version}`;
  const existing=await api('GET',`${prefix}/git/ref/heads/${branch}`,undefined,{missing:true});
  if (existing) {
    const pkg=decodeContent(await api('GET',`${prefix}/contents/package.json?ref=${encodeURIComponent(branch)}`));
    if(pkg.version!==version) throw new Error('existing branch version differs; inspect it before retrying');
  } else {
    const commit=await api('GET',`${prefix}/git/commits/${sha}`);
    const pkg=decodeContent(await api('GET',`${prefix}/contents/package.json?ref=${sha}`));
    pkg.version=version;
    const tree=await api('POST',`${prefix}/git/trees`,{base_tree:commit.tree.sha,tree:[{path:'package.json',mode:'100644',type:'blob',content:JSON.stringify(pkg,null,2)+'\n'}]});
    const next=await api('POST',`${prefix}/git/commits`,{message:`chore: prepare ${version}`,tree:tree.sha,parents:[sha]});
    await api('POST',`${prefix}/git/refs`,{ref:`refs/heads/${branch}`,sha:next.sha});
  }
  const prs=await api('GET',`${prefix}/pulls?state=open&base=main&head=${encodeURIComponent(repository.split('/')[0]+':'+branch)}`);
  if(!Array.isArray(prs) || prs.length>1) throw new Error('ambiguous release PR');
  const pr=prs[0] ?? await api('POST',`${prefix}/pulls`,{title:`chore: release ${version}`,head:branch,base:'main',body:'Reviewed version bump. Merging starts the gated draft release workflow.'});
  if(!Number.isSafeInteger(pr?.number) || pr.number<1 || pr.html_url!==`https://github.com/${repository}/pull/${pr.number}`) throw new Error('invalid release PR');
  // GITHUB_TOKEN commits do not trigger push CI. Dispatch explicitly on the
  // inspected branch, including on retries that reuse the existing PR.
  await api('POST',`${prefix}/actions/workflows/ci.yml/dispatches`,{ref:branch});
  return pr;
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const pr=await prepareRelease({repository:process.env.GITHUB_REPOSITORY,version:process.env.VERSION,sha:process.env.SHA});
    if(process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,`Release PR: ${pr.html_url}\nCI dispatched on its preparation branch.\n`);
  } catch(error) { console.error(error.message); process.exitCode=1; }
}
