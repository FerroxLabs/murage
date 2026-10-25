// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { githubPillFor, parseGithubRef } from "./github-refs";

describe("github refs", () => {
  it("recognises pull requests, issues and commits", () => {
    expect(parseGithubRef("https://github.com/acme/widgets/pull/42")).toMatchObject({ kind: "pull", label: "acme/widgets#42" });
    expect(parseGithubRef("https://github.com/acme/widgets/issues/7#issuecomment-1")).toMatchObject({ kind: "issue", id: "7" });
    expect(parseGithubRef("https://github.com/acme/widgets/commit/ABCDEF1234567")).toMatchObject({ kind: "commit", id: "abcdef1", label: "acme/widgets@abcdef1" });
    expect(parseGithubRef("https://github.com/acme/widgets/pull/42/files")).toMatchObject({ kind: "pull", id: "42" });
  });
  it("rejects lookalike hosts, credentials, ports, http and odd paths", () => {
    for (const bad of [
      "https://github.com.evil.example/acme/widgets/pull/1",
      "https://evil-github.com/acme/widgets/pull/1",
      "https://www.github.com/acme/widgets/pull/1",
      "https://user:pw@github.com/acme/widgets/pull/1",
      "https://github.com:8443/acme/widgets/pull/1",
      "http://github.com/acme/widgets/pull/1",
      "https://github.com/acme/widgets/pull/0",
      "https://github.com/acme/widgets/pull/abc",
      "https://github.com/acme/widgets/tree/main",
      "https://github.com/acme/widgets/commit/xyz",
      "https://github.com/-bad/widgets/pull/1",
      "https://github.com/acme",
    ]) expect(parseGithubRef(bad), bad).toBeNull();
  });
  it("only becomes a pill when the visible text is the link itself", () => {
    const url = "https://github.com/acme/widgets/issues/7";
    expect(githubPillFor(url, url)).not.toBeNull();
    expect(githubPillFor(url, "acme/widgets#7")).not.toBeNull();
    expect(githubPillFor(url, "see the bug report")).toBeNull();
    expect(githubPillFor(url, "")).toBeNull();
    expect(githubPillFor(undefined, "x")).toBeNull();
  });
});

import { cardPlacement } from "./github-refs";

describe("hover card placement", () => {
  const view = { width: 1000, height: 700 };
  it("sits under and left-aligned when there is room", () => {
    expect(cardPlacement({ left: 100, right: 200, top: 100, bottom: 120 }, view)).toEqual({ horizontal: "left", vertical: "below" });
  });
  it("flips right-aligned near the right edge and above near the bottom", () => {
    expect(cardPlacement({ left: 900, right: 980, top: 600, bottom: 620 }, view)).toEqual({ horizontal: "right", vertical: "above" });
  });
  it("stays put when flipping would not fit either", () => {
    expect(cardPlacement({ left: 10, right: 60, top: 5, bottom: 25 }, { width: 300, height: 100 })).toEqual({ horizontal: "left", vertical: "below" });
  });
});
