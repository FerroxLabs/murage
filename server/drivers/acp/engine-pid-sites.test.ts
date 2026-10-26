// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// U24 design R2.4 / T11: on Windows the ACP root child is the job launcher; every probe that treats "the engine" as the parent
// of MCP children must look at the engine CLI (engineProcessPid), never at child.pid. The driver's tree probes are closures
// inside createAcpDriver, so this gate reads the source: the four baseline/reconcile sites use engineProcessPid and no
// descendantIdentities / untrackedIdentified call takes proc.child.pid.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("./core.ts", import.meta.url)), "utf8");

describe("ACP tree probes look at the engine, not the launcher (U24)", () => {
  it("baseline and reconcile probes use engineProcessPid", () => {
    expect(source.match(/descendantIdentities\(engineProcessPid\(proc\.child\)!\)/g)?.length).toBe(2);
    expect(source).toContain("const reconcileReusedTree = async (proc: AcpProcess, servers: ReadonlyArray<{ command: string; args: string[] }>): Promise<{ baseline: ProcessIdentities; leftover: string | null }> => {\n        const pid = engineProcessPid(proc.child);");
    expect(source).toContain("const guardParkedTree = (threadId: string, proc: AcpProcess) => {\n        const pid = engineProcessPid(proc.child);");
    expect(source).not.toMatch(/descendantIdentities\(proc\.child\.pid\)/);
    expect(source).not.toMatch(/untrackedIdentified\(proc\.child\.pid/);
  });
});
