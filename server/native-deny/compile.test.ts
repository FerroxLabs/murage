import { describe, expect, it } from "vitest";
import { compileDenySpec } from "./test-support.ts";
import { canonicalJson, sha256, canonicalPath } from "./compile.ts";
import { ALWAYS_ASK_NO_LIMITS, protectedPathClass } from "./upstream.ts";

describe("T-DS compiler parity", () => {
  it("T-DS-1 derives wipe rows and protected classes, with stable canonical hash", () => {
    const spec = compileDenySpec({ paths: ["/", "~", "/home/alice", "/Volumes/disk", "/etc", "/private", "/dev", "/var"] });
    expect(spec.version).toBe(2);
    expect(spec.wipe.map(r => r.rule).sort()).toEqual(Object.entries(ALWAYS_ASK_NO_LIMITS).filter(([, v]) => v === "wipe").map(([r]) => r).sort());
    for (const p of ["/", "~", "/home/alice", "/Volumes/disk", "/etc"]) {
      const row = spec.protectedPaths.find(r => r.path === canonicalPath(p).path);
      expect(row?.cls).toBe(protectedPathClass(p));
      expect(row?.scope).toBe(row?.cls === "system" ? "descendants" : "self");
    }
    for (const path of ["/private", "/var", "/dev"]) expect(spec.protectedPaths.find(r => r.path === path)?.except.length).toBeGreaterThan(0);
    const { hash, ...data } = spec;
    expect(hash).toBe(sha256(canonicalJson(data)));
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
  });
  it("T-DS-2 preserves ordinary descendants and canonicalizes or rejects Windows aliases", () => {
    const spec = compileDenySpec({ paths: ["~/x", "/Users/alice/y", "/Volumes/disk/y", "/etc/x", "/private/tmp/x", "/var/folders/x", "/dev/null"] });
    expect(spec.protectedPaths.some(p => p.path === "/etc/x")).toBe(true);
    for (const path of ["~/x", "/Users/alice/y", "/Volumes/disk/y", "/private/tmp/x", "/var/folders/x", "/dev/null"]) expect(spec.protectedPaths.some(p => p.path === canonicalPath(path).path)).toBe(false);
    expect(canonicalPath("C:\\..\\Windows")).toEqual({ status: "ok", path: "c:/windows" });
    expect(canonicalPath("c:/WINDOWS")).toEqual({ status: "ok", path: "c:/windows" });
    for (const p of ["C:foo", "\\\\server\\share\\x", "\\\\?\\UNC\\server\\share", "\\\\?\\C:\\", "\\\\.\\PhysicalDrive0", "C:/GLOBALROOT/x", "C:/PROGRA~1", "C:/Users/USERNA~1", "C:/Windows.", "C:/Windows ", "C:/x::$DATA"]) expect(canonicalPath(p).status, p).toBe("unexpressible");
  });
  it("normalizes, deduplicates and hashes refusals and self paths deterministically", () => {
    const a = { kind: "path" as const, value: "/tmp/refused", reason: "owner" };
    const b = { kind: "tool" as const, value: "web_search", reason: "off" };
    expect(compileDenySpec({ refusals: [a, b, a], selfPaths: ["/tmp/b", "/tmp/a"] })).toEqual(compileDenySpec({ refusals: [b, a], selfPaths: ["/tmp/a", "/tmp/b"] }));
    expect(() => canonicalJson({ x: undefined })).toThrow();
    expect(() => compileDenySpec({ selfPaths: ["C:ambiguous"] })).toThrow();
  });
});

it("requires an injected descriptor until upstream ownership is released", async () => {
  const { compileDenySpec: compile } = await import("./compile.ts");
  expect(() => compile({} as never)).toThrow("descriptor required");
});
