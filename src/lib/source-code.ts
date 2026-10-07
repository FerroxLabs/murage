// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Where the source of this build lives. The GNU AGPL (section 13) asks that
// people who use Murage over a network are offered the source; the About
// section links here on the desktop and in the browser door alike.
export const SOURCE_CODE_URL = "https://github.com/FerroxLabs/murage";

declare const __MURAGE_COMMIT__: string | null | undefined;

/** The commit vite.config.ts baked in at build time, or null (no git, as in a source tarball). */
export const BUILD_COMMIT: string | null = typeof __MURAGE_COMMIT__ === "string" && __MURAGE_COMMIT__ ? __MURAGE_COMMIT__ : null;

/** The exact commit when this build knows it, otherwise the repository. */
export function sourceCodeLink(commit: string | null = BUILD_COMMIT): string {
  return commit && /^[0-9a-f]{40}$/.test(commit) ? `${SOURCE_CODE_URL}/tree/${commit}` : SOURCE_CODE_URL;
}

/** "Murage 0.1.62" or "Murage 0.1.62 (commit abcdef0)". */
export function sourceVersionLabel(version: string, commit: string | null = BUILD_COMMIT): string {
  return commit ? `Murage ${version} (commit ${commit.slice(0, 7)})` : `Murage ${version}`;
}
