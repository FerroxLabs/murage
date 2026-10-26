// Adapted from OpenMausBot PR #2687, commit b5f570198f0469c62c007ee8353a70e6a923725b (Apache-2.0).
const MAX_LENGTH = 2_048;
const GITHUB = /^https?:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+\/(?:pull|issues)\/(\d+)(?:[/?#]|$)/i;
const GITLAB_MR = /^https?:\/\/[^/]+\/.+\/-\/merge_requests\/(\d+)(?:[/?#]|$)/i;

/** The normalised address, or null when it is not an http(s) address of at most 2048 characters. */
export function threadLinkUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_LENGTH) return null;
  try {
    const url = new URL(value.trim());
    return (url.protocol === "http:" || url.protocol === "https:") && url.href.length <= MAX_LENGTH ? url.href : null;
  } catch {
    return null;
  }
}

/** `#123` for a GitHub pull request or issue, `!45` for a GitLab merge request, else null. */
export function threadLinkLabel(url: string): string | null {
  const github = GITHUB.exec(url);
  if (github) return `#${github[1]}`;
  const mergeRequest = GITLAB_MR.exec(url);
  return mergeRequest ? `!${mergeRequest[1]}` : null;
}

const GITLAB_MR_URL = /https?:\/\/([\w.-]+)(?::\d+)?\/[\w./-]+?\/-\/merge_requests\/\d+(?![\w-])/gi;
const GITHUB_PR_URL = /https?:\/\/(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+(?![\w-])/gi;

/** Hosts whose merge requests are linked on sight: gitlab.com, a `gitlab.` host, and any host the bot's own remote names. */
function trustedGitlabHost(host: string, remoteHosts: readonly string[]): boolean {
  const lower = host.toLowerCase();
  return lower === "gitlab.com" || lower.startsWith("gitlab.") || remoteHosts.some((remote) => remote.toLowerCase() === lower);
}

/** The last pull or merge request address a reply names, if any. A GitHub pull request always counts; a merge request counts
 * only on a known GitLab host or on `remoteHosts` (the host of the folder's own git remote), so a stray address in prose is not
 * attached to the conversation. */
export function lastChangeRequestUrl(text: string, remoteHosts: readonly string[] = []): string | null {
  const found: Array<{ at: number; url: string }> = [];
  for (const match of text.matchAll(GITHUB_PR_URL)) found.push({ at: match.index!, url: match[0] });
  for (const match of text.matchAll(GITLAB_MR_URL)) if (trustedGitlabHost(match[1]!, remoteHosts)) found.push({ at: match.index!, url: match[0] });
  const last = found.sort((a, b) => a.at - b.at).at(-1)?.url;
  return last ? threadLinkUrl(last) : null;
}
