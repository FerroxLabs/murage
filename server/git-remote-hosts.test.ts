// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { remoteHostsFromGitConfig } from "./git-remote-hosts.ts";

describe("remoteHostsFromGitConfig", () => {
  it("reads https, ssh and scp-style remotes", () => {
    const config = `[remote "origin"]\n\turl = https://git.example.org/team/repo.git\n[remote "up"]\n\turl = git@code.example.net:team/repo.git\n[remote "x"]\n\turl = ssh://git@ssh.example.com:2222/team/repo.git\n`;
    expect(remoteHostsFromGitConfig(config).sort()).toEqual(["code.example.net", "git.example.org", "ssh.example.com"]);
  });
  it("ignores local paths and other keys", () => {
    expect(remoteHostsFromGitConfig(`[remote "o"]\n\turl = /srv/git/repo.git\n[core]\n\tbare = false\n`)).toEqual([]);
  });
});
