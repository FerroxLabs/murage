// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The commit this build is made from, for the About "Source code" link. A
// source tarball has no .git, so the answer may be null and the app falls
// back to the package version.
import { execFileSync } from "node:child_process";

const FULL_SHA = /^[0-9a-f]{40}$/;

/** `run` returns git's stdout and throws when git is missing or this is not a repository. */
export function resolveBuildCommit(run = () => execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) {
  try {
    const out = String(run()).trim().toLowerCase();
    return FULL_SHA.test(out) ? out : null;
  } catch {
    return null;
  }
}
