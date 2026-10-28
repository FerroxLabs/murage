// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Names (Rules 27..29, T32..T36), the F4 and F12 record types (Rules 54, 74)
// and the grant-key encoding (Rule 59, T76).

import { describe, expect, it } from "vitest";
import {
  acpToolKey, decodeKeyPart, encodeKeyPart, isExecEnv, isMountRecord, mountNameRefusal, nf, parseAcpToolKey, piForm, RESERVED_MOUNTS,
} from "./mount-identity.ts";
import { customMountEntries } from "../server/custom-mcp-mounts.ts";

describe("nf and the Pi form (Rule 27)", () => {
  it("accepts the camel-case own mount of the phone tools and still refuses a malformed own id", () => {
    expect(isMountRecord({ engineName: "phoneJobs", mountId: "own:phoneJobs", provenance: "own" })).toBe(true);
    for (const mountId of ["own:", "own:a_b", "own:a1", "own: x", "custom:phoneJobs"]) expect(isMountRecord({ engineName: "x", mountId, provenance: "own" }), mountId).toBe(false);
  });
  it("folds case, runs and compatibility forms", () => {
    expect(nf("Murage-Connectors")).toBe("murage_connectors");
    expect(nf("ａｇｅｎｔｓ")).toBe("agents");
    expect(nf("__a--b__")).toBe("a_b");
    expect(piForm("a__b")).toBe("a__b");
    expect(piForm("My-Server")).toBe("my_server");
  });
});

describe("Rule 28 refusals (T32..T36)", () => {
  it("each of a..h is refused with its own message", () => {
    const messages = new Set<string>();
    const refuse = (name: string, others: string[] = []) => {
      const why = mountNameRefusal(name, others);
      expect(why, name).not.toBeNull();
      messages.add(why!);
    };
    refuse("a__b"); // a
    refuse("murage-connectors"); // b under nf
    refuse("agents-x"); // c
    refuse("murage"); // d: a Pi prefix of murage_connectors
    refuse("my-tool", ["my_tool"]); // e equal
    refuse("my", ["my_tool"]); // e prefix
    refuse("tools_murage"); // f
    refuse("tools_murage2"); // f with digits
    expect(messages.size).toBeGreaterThanOrEqual(6);
    expect(mountNameRefusal("my-github")).toBeNull();
    expect(mountNameRefusal("github", ["gitlab"])).toBeNull();
  });

  it("refuses the ACP memory mount's name and the legacy connector under any spelling (T34)", () => {
    expect(mountNameRefusal("murage-memory")).not.toBeNull();
    expect(mountNameRefusal("murage_memory")).not.toBeNull();
    expect(RESERVED_MOUNTS.has("murage_memory")).toBe(true);
  });

  it("the reserved set is the union of every driver's built-ins under nf, and every driver's mount list reads it (T33)", () => {
    for (const name of ["muragebox", "computer", "agents", "browser", "phone", "phonejobs", "dweb", "murage_connectors", "murage_phone", "murage_memory"]) {
      expect(RESERVED_MOUNTS.has(name), name).toBe(true);
    }
    const mounted = customMountEntries({
      "Murage-Memory": { command: "x", args: [], env: {} },
      agents: { command: "x", args: [], env: {} },
      mine: { command: "x", args: [], env: {} },
    });
    expect(mounted.map((mount) => mount.name)).toEqual(["mine"]);
  });
});

describe("F4 and F12 records", () => {
  it("a mount record's provenance matches its mountId and its name holds no __", () => {
    expect(isMountRecord({ engineName: "murage_connectors", mountId: "own:connector", provenance: "own" })).toBe(true);
    expect(isMountRecord({ engineName: "gh", mountId: "custom:gh", provenance: "custom" })).toBe(true);
    expect(isMountRecord({ engineName: "x", mountId: "external:codex:0123456789abcdef:x", provenance: "external" })).toBe(true);
    expect(isMountRecord({ engineName: "a__b", mountId: "custom:a", provenance: "custom" })).toBe(false);
    expect(isMountRecord({ engineName: "gh", mountId: "own:connector", provenance: "custom" })).toBe(false);
    expect(isMountRecord({ engineName: "x", mountId: "external:codex:short:x", provenance: "external" })).toBe(false);
  });

  it("an F12 record whose env and absent share a name is not trusted", () => {
    const record = { env: { PATH: "/bin", HOME: "/h" }, absent: ["BASH_ENV"], cwd: "/p", shell: ["/bin/zsh", "-c"], capture: "session" };
    expect(isExecEnv(record)).toBe(true);
    expect(isExecEnv({ ...record, absent: ["PATH"] })).toBe(false);
    expect(isExecEnv({ ...record, capture: "observed" })).toBe(false);
    expect(isExecEnv({ ...record, env: { PATH: 1 } })).toBe(false);
  });
});

describe("Rule 59 encoding (T76)", () => {
  it("round-trips _, :, /, %, and space; a key with two / is not a grant", () => {
    for (const part of ["a_b", "x:y", "p/q", "100%", "with space", "external:codex:0123456789abcdef:my_srv", "plain"]) {
      const encoded = encodeKeyPart(part);
      expect(encoded).not.toMatch(/[:/_\s]/);
      expect(decodeKeyPart(encoded)).toBe(part);
    }
    const key = acpToolKey("custom:my_srv", "read/file");
    expect(parseAcpToolKey(key)).toEqual({ mountId: "custom:my_srv", tool: "read/file" });
    expect(parseAcpToolKey(`${key}/extra`)).toBeNull();
    expect(parseAcpToolKey("acp-tool:v2:custom%3Ax")).toBeNull();
    expect(parseAcpToolKey("acp-tool:mcp:custom__x")).toBeNull();
    expect(decodeKeyPart("a_b")).toBeNull();
    expect(decodeKeyPart("%41")).toBeNull();
  });
});
