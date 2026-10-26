// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The host names a folder's own git remotes point at, read from .git/config
// (no process is started). Used to tell which merge-request addresses in a
// bot's reply belong to the project it works on.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Hosts from `url = ...` lines of a git config, for https, ssh:// and scp-style (`git@host:path`) remotes. */
export function remoteHostsFromGitConfig(config: string): string[] {
  const hosts = new Set<string>();
  for (const line of config.split(/\r?\n/)) {
    const value = /^\s*url\s*=\s*(\S+)\s*$/.exec(line)?.[1];
    if (!value) continue;
    const host = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)/i.exec(value)?.[1] ?? /^(?:[^@/\s]+@)?([^/:\s]+):(?!\/\/)/.exec(value)?.[1];
    if (host) hosts.add(host.toLowerCase());
  }
  return [...hosts];
}

export function gitRemoteHosts(folder: string | undefined | null): string[] {
  if (!folder) return [];
  try {
    return remoteHostsFromGitConfig(readFileSync(join(folder, ".git", "config"), "utf8"));
  } catch {
    return [];
  }
}
