// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// GitHub pull request, issue and commit links, recognised so a reply can show them as a compact pill. Idea from OpenMaus
// (Apache-2.0, src/lib/github-refs.ts). Nothing is fetched: the pill and its hover card show only what the link itself says.
//
// Strict on purpose: the host must be exactly github.com over https, with no credentials or port, and a lookalike such as
// github.com.evil.example or evil-github.com is never a pill. A link whose visible text is anything other than the link
// itself (or its own short form) is left alone: the author's words are not ours to replace.

export type GithubRefKind = "pull" | "issue" | "commit";

export interface GithubRef {
  kind: GithubRefKind;
  owner: string;
  repo: string;
  /** "123" for a pull request or issue, the short sha (7 characters) for a commit. */
  id: string;
  /** The full link, as written. */
  url: string;
  /** The compact text: owner/repo#123, or owner/repo@abc1234. */
  label: string;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

export function parseGithubRef(href: string | undefined): GithubRef | null {
  if (!href || href.length > 2048) return null;
  let url: URL;
  try { url = new URL(href); } catch { return null; }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.port) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 4) return null;
  const [owner, repo, section, id] = parts as [string, string, string, string];
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === "." || repo === "..") return null;
  if (section === "pull" || section === "issues") {
    if (!/^[1-9]\d{0,8}$/.test(id)) return null;
    return { kind: section === "pull" ? "pull" : "issue", owner, repo, id, url: href, label: `${owner}/${repo}#${id}` };
  }
  if (section === "commit" || section === "commits") {
    if (!/^[0-9a-f]{7,40}$/i.test(id)) return null;
    const short = id.slice(0, 7).toLowerCase();
    return { kind: "commit", owner, repo, id: short, url: href, label: `${owner}/${repo}@${short}` };
  }
  return null;
}

/** Whether the visible text is the link itself (or the pill's own short form), so replacing it loses nothing the author wrote. */
export function textIsTheLink(href: string, text: string): boolean {
  const shown = text.trim();
  if (!shown) return false;
  if (shown === href || shown === href.replace(/\/$/, "")) return true;
  const ref = parseGithubRef(href);
  return ref !== null && shown === ref.label;
}

/** The pill to draw for a link in a reply, or null to render it as an ordinary link. */
export function githubPillFor(href: string | undefined, text: string): GithubRef | null {
  if (!href) return null;
  const ref = parseGithubRef(href);
  return ref && textIsTheLink(href, text) ? ref : null;
}

/** Where the hover card goes so it stays inside the window: under the pill unless there is no room, and flush right when the
 *  left edge would run off. `rect` is the pill's bounding box, `view` the window; sizes are the card's. */
export function cardPlacement(
  rect: { left: number; right: number; top: number; bottom: number },
  view: { width: number; height: number },
  card = { width: 288, height: 150 },
): { horizontal: "left" | "right"; vertical: "below" | "above" } {
  const horizontal = rect.left + card.width > view.width - 8 && rect.right - card.width >= 8 ? "right" : "left";
  const vertical = rect.bottom + card.height > view.height - 8 && rect.top - card.height >= 8 ? "above" : "below";
  return { horizontal, vertical };
}
