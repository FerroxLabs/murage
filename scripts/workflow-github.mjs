// Small transport for repository administration. No shell interpolation and no
// response bodies in errors (GitHub errors may include sensitive information).
import { spawnSync } from 'node:child_process';
export function repositoryPath(repository) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) throw new Error('invalid repository');
  return `repos/${repository}`;
}
export async function githubApi(method, path, body, { missing = false } = {}) {
  const args = ['api', '--include', '--method', method, path];
  if (body !== undefined) args.push('--input', '-');
  const result = spawnSync('gh', args, {encoding:'utf8', input:body === undefined ? undefined : JSON.stringify(body), timeout:30_000, maxBuffer:4*1024*1024});
  const status = Number(result.stdout?.match(/^HTTP\/\S+\s+(\d+)/)?.[1]);
  if (!result.error && missing && status === 404) return null;
  if (result.error || result.status !== 0 || status < 200 || status >= 300 || !status) throw new Error(`GitHub API failed (${status || 'unknown'})`);
  const text = result.stdout.replace(/^.*?\r?\n\r?\n/s, '').trim();
  return text ? JSON.parse(text) : null;
}
export function decodeContent(blob) {
  if (blob?.encoding !== 'base64' || typeof blob.content !== 'string') throw new Error('invalid content response');
  return JSON.parse(Buffer.from(blob.content,'base64').toString('utf8'));
}
