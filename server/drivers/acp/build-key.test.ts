// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The ACP support cache is keyed by the engine build. A build that reports no
// agentInfo is told apart by its executable (path, mtime, size), so an upgrade
// or a switch does not inherit the old build's "does not notify" verdict.
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { claudeExecutableIdentity } from "../claude-guards.ts";
import { acpBuildKey } from "./core.ts";

describe("acpBuildKey", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "acp-build-key-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const identityOf = (cli: string) => () => claudeExecutableIdentity(cli, {});

  it("keys a build that names itself by name and version alone", () => {
    const init = { agentInfo: { name: "grok", version: "1.2.3" } };
    expect(acpBuildKey("grok", init, () => { throw new Error("not asked"); })).toBe("grok|grok@1.2.3");
  });

  it("changes when the executable is replaced (size or mtime) and when another one is used, if no agentInfo", () => {
    const cli = join(dir, "engine");
    writeFileSync(cli, "v1");
    const before = acpBuildKey("grok", {}, identityOf(cli));
    expect(acpBuildKey("grok", {}, identityOf(cli))).toBe(before);
    writeFileSync(cli, "version two");
    const upgraded = acpBuildKey("grok", {}, identityOf(cli));
    expect(upgraded).not.toBe(before);
    utimesSync(cli, new Date(0), new Date(86_400_000));
    expect(acpBuildKey("grok", {}, identityOf(cli))).not.toBe(upgraded);
    const other = join(dir, "other");
    writeFileSync(other, "version two");
    expect(acpBuildKey("grok", {}, identityOf(other))).not.toBe(upgraded);
  });
});
