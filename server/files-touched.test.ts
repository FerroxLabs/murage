// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { filesNamedByToolLine } from "./files-touched.ts";

describe("filesNamedByToolLine (receipt file count counts files, not tool lines)", () => {
  it("one path is one file, however the line is worded", () => {
    expect(filesNamedByToolLine("Write", "src/a.ts")).toEqual({ paths: ["src/a.ts"], anonymous: 0 });
    expect(filesNamedByToolLine("Edit", "Edit src/a.ts")).toEqual({ paths: ["src/a.ts"], anonymous: 0 });
  });
  it("the same file edited twice, with different wording or slashes, is one file", () => {
    const a = filesNamedByToolLine("edit", "./src/a.ts").paths, b = filesNamedByToolLine("Write", "src\\a.ts").paths;
    expect(a).toEqual(b);
  });
  it("a patch line naming several files counts each", () => {
    const line = "*** Update File: src/a.ts\n*** Add File: src/b.ts\n*** Delete File: old/c.md";
    expect(filesNamedByToolLine("apply_patch", line).paths.sort()).toEqual(["old/c.md", "src/a.ts", "src/b.ts"]);
    expect(filesNamedByToolLine("patch", "diff --git a/x/y.ts b/x/y.ts").paths).toEqual(["x/y.ts"]);
  });
  it("a count phrase counts anonymous files; prose with no path counts nothing", () => {
    expect(filesNamedByToolLine("apply_patch", "Edited 3 files")).toEqual({ paths: [], anonymous: 3 });
    expect(filesNamedByToolLine("write", "Saved the draft")).toEqual({ paths: [], anonymous: 0 });
    expect(filesNamedByToolLine("write", undefined)).toEqual({ paths: [], anonymous: 0 });
  });
  it("a complete path list counts every file, and a quoted path keeps its spaces", () => {
    expect(filesNamedByToolLine("write", "src/a.ts, src/b.ts; docs/c.md").paths.sort()).toEqual(["docs/c.md", "src/a.ts", "src/b.ts"]);
    expect(filesNamedByToolLine("edit", "\"My Docs/notes file.md\"").paths).toEqual(["My Docs/notes file.md"]);
    expect(filesNamedByToolLine("edit", "Edit 'a b/c d.ts' and src/e.ts").paths).toEqual(["a b/c d.ts"]);
  });
  it("counts whose distinctness is unknown are never added together, and never beside named paths", () => {
    expect(filesNamedByToolLine("apply_patch", "Edited 3 files\nEdited 3 files")).toEqual({ paths: [], anonymous: 3 });
    expect(filesNamedByToolLine("apply_patch", "Edited 3 files\nsrc/a.ts")).toEqual({ paths: ["src/a.ts"], anonymous: 0 });
  });
  it("a/ and b/ are stripped only from git diff paths; ordinary a/config.ts and b/config.ts are two files", () => {
    expect(filesNamedByToolLine("write", "a/config.ts, b/config.ts").paths.sort()).toEqual(["a/config.ts", "b/config.ts"]);
    expect(filesNamedByToolLine("patch", "diff --git a/x/y.ts b/x/y.ts").paths).toEqual(["x/y.ts"]);
  });
  it("a long summary is bounded", () => {
    const many = Array.from({ length: 500 }, (_, i) => `f${i}.ts`).join("\n");
    expect(filesNamedByToolLine("apply_patch", many).paths.length).toBeLessThanOrEqual(100);
  });
});
