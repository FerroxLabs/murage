import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { githubApi, repositoryPath, decodeContent } from './workflow-github.mjs';
export const SIGNATURE='I have read the CLA Document and I hereby sign the CLA';
export async function handleCla({repository,eventName,event,checkOnly=false},api=githubApi) {
  const prefix=repositoryPath(repository);
  const comment=eventName==='issue_comment';
  if(comment && (!event.issue?.pull_request || event.comment?.body!==SIGNATURE)) return {signed:false,recorded:false};
  const number=String(eventName==='workflow_dispatch' ? event.inputs?.pr_number : comment ? event.issue?.number : event.pull_request?.number);
  if(!/^[1-9]\d*$/.test(number)) throw new Error('PR number is required');
  const pr=await api('GET',`${prefix}/pulls/${number}`);
  const author=pr?.user;
  if(!author?.login || !Number.isSafeInteger(author.id)) throw new Error('invalid PR author');
  if(comment && (event.comment.user?.id!==author.id || event.comment.user?.login!==author.login)) return {signed:false,recorded:false};
  if(['dependabot[bot]','github-actions[bot]'].includes(author.login)) return {signed:true,recorded:false};
  const path=`${prefix}/contents/signatures/cla.json`;
  const blob=await api('GET',`${path}?ref=cla-signatures`,undefined,{missing:true});
  const data=blob ? decodeContent(blob) : {signedContributors:[]};
  if(!Array.isArray(data.signedContributors)) throw new Error('invalid CLA signatures');
  if(data.signedContributors.some(s=>String(s.id)===String(author.id) && s.name===author.login)) return {signed:true,recorded:false};
  if(!comment || checkOnly) throw new Error(`CLA signature missing. Comment exactly: ${SIGNATURE}`);
  if(!Number.isSafeInteger(event.comment.id) || !Number.isFinite(Date.parse(event.comment.created_at))) throw new Error('invalid signature comment');
  data.signedContributors.push({name:author.login,id:author.id,created_at:event.comment.created_at,repoId:event.repository?.id,pullRequestNo:Number(number),comment_id:event.comment.id});
  await api('PUT',path,{message:`Record CLA signature for ${author.login}`,branch:'cla-signatures',...(blob ? {sha:blob.sha}:{}),content:Buffer.from(JSON.stringify(data,null,2)+'\n').toString('base64')});
  return {signed:true,recorded:true};
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await handleCla({repository:process.env.GITHUB_REPOSITORY,eventName:process.env.GITHUB_EVENT_NAME,event:JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8')),checkOnly:process.argv[2]==='check'});
  } catch(error) { console.error(error.message); process.exitCode=1; }
}
