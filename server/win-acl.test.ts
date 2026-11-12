// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { ownerVerdict } from "./win-acl.ts";
import ts from "typescript";
import { fileURLToPath } from "node:url";

const user = "S-1-5-21-1-2-3-1001";
const dacl = `D:P(A;;FA;;;${user})`;
describe("T-OWNER-PURE", () => {
  it.each([user, "SY", "BA", "S-1-5-18", "S-1-5-32-544"])("accepts owner %s", owner => {
    expect(ownerVerdict(`O:${owner}G:SY${dacl}`, user)).toBe("ok");
  });
  it.each(["BU", "WD", "AU", "CO", "OW", "LA", "S-1-5-21-9-8-7-1001"])(
    "rejects foreign owner %s; kills DACL-only ownership", owner => {
      expect(ownerVerdict(`O:${user}${dacl}`, user)).toBe("ok");
      expect(ownerVerdict(`O:${owner}${dacl}`, user)).toBe("foreign");
    },
  );
  it("maps LA only for the current RID-500 user; kills root-like alias shortcut", () => {
    expect(ownerVerdict(`O:LA${dacl}`, "S-1-5-21-1-2-3-500")).toBe("ok");
    expect(ownerVerdict(`O:LA${dacl}`, user)).toBe("foreign");
  });
  it.each([dacl, `O:${dacl}`, `O:garbled${dacl}`, `O:S-1-x${dacl}`, `O:${user}O:SY${dacl}`, `junk O:${user}${dacl}`])(
    "fails closed on malformed owner %s; kills missing-owner acceptance", sddl => {
      expect(ownerVerdict(`O:${user}${dacl}`, user)).toBe("ok");
      expect(ownerVerdict(sddl, user)).toBe("unknown");
    },
  );
  it("rejects an unknown current identity", () => {
    expect(ownerVerdict(`O:${user}${dacl}`, user)).toBe("ok");
    expect(ownerVerdict(`O:${user}${dacl}`, "")).toBe("unknown");
  });
});

it("B3 implements the frozen StorageGuard contract without type errors", () => {
  const program = ts.createProgram({
    rootNames: ["./win-acl.ts", "./channels/signal/storage.ts"].map(path => fileURLToPath(new URL(path, import.meta.url))),
    options: { noEmit: true, strict: true, skipLibCheck: true, allowImportingTsExtensions: true,
      types: ["node"], target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext },
  });
  expect(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
});
