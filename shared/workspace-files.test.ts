import { describe, expect, it } from "vitest";
import {
  OUTPUT_NAMESPACE, WORKSPACE_FILE_ERROR_CODES, WORKSPACE_FILE_ERROR_STATUS, WORKSPACE_FILES_ROUTE_PREFIX, WORKSPACE_FILES_ROUTES,
  WORKSPACE_LIST_PAGE_SIZE, WORKSPACE_SEARCH_MAX_DEPTH, WORKSPACE_SEARCH_MAX_ENTRIES,
  isFileRevision, isOutputNamespacePath, isWorkspaceFileErrorCode, isWorkspaceRelativePath, isWorkspaceScopeRef,
} from "./workspace-files.ts";
import {
  OUTPUT_PRODUCERS, OUTPUT_PUBLICATION_LIMITS, OUTPUT_RECEIPT_STAGES, canAdvanceOutputStage, isOutputPathToken, isOutputProducer, isOutputReceiptStage,
} from "./output-publication.ts";
import {
  IMAGE_REFERENCE_LIMITS, IMAGE_REFERENCE_ROUTE, MEDIA_CAPABILITY_TTL_MS, MEDIA_ROUTE_PREFIX, MEDIA_ROUTES,
  isImageReferenceSource, isMediaCapabilityToken, redactMediaCapability,
} from "./media-assets.ts";

describe("workspace-files contract", () => {
  it("freezes the U-02 namespace, R3-T1 bounds and route shapes", () => {
    expect(OUTPUT_NAMESPACE).toBe("outputs");
    expect([WORKSPACE_LIST_PAGE_SIZE, WORKSPACE_SEARCH_MAX_ENTRIES, WORKSPACE_SEARCH_MAX_DEPTH]).toEqual([200, 2000, 8]);
    for (const route of Object.values(WORKSPACE_FILES_ROUTES)) expect(route.startsWith(`${WORKSPACE_FILES_ROUTE_PREFIX}/`)).toBe(true);
    expect(new Set(Object.values(WORKSPACE_FILES_ROUTES)).size).toBe(Object.keys(WORKSPACE_FILES_ROUTES).length);
  });

  it("maps every error code to one HTTP status", () => {
    expect(WORKSPACE_FILE_ERROR_CODES.length).toBeGreaterThan(10);
    for (const code of WORKSPACE_FILE_ERROR_CODES) {
      expect(isWorkspaceFileErrorCode(code)).toBe(true);
      expect(WORKSPACE_FILE_ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
    expect(WORKSPACE_FILE_ERROR_STATUS["not-implemented"]).toBe(501);
    expect(WORKSPACE_FILE_ERROR_STATUS["revision-conflict"]).toBe(409);
    expect(isWorkspaceFileErrorCode("toString")).toBe(false);
    expect(isWorkspaceFileErrorCode("teapot")).toBe(false);
  });

  it("accepts only exact opaque scopes", () => {
    expect(isWorkspaceScopeRef({ botId: "bot_1", threadId: "th-2" })).toBe(true);
    for (const value of [null, [], {}, { botId: "b" }, { botId: "b", threadId: "t", root: "/" }, { botId: "../b", threadId: "t" }, { botId: "b", threadId: 1 }]) {
      expect(isWorkspaceScopeRef(value)).toBe(false);
    }
  });

  it("validates relative paths the same way the artifact store does", () => {
    for (const path of ["report.md", "outputs/report.html", "a/b/c d.txt", "reports/2026-09-11.md"]) expect(isWorkspaceRelativePath(path), path).toBe(true);
    for (const path of ["", "/etc/passwd", "../x", "a/../b", "a//b", "a/./b", ".hidden", "a/.git/config", "C:/x", "a\\b", "a\u0000b", "a\nb", "x".repeat(2049), `${"y".repeat(256)}/z`, 42]) {
      expect(isWorkspaceRelativePath(path), JSON.stringify(path)).toBe(false);
    }
    expect(isWorkspaceRelativePath("", { allowRoot: true })).toBe(true);
    expect(isOutputNamespacePath("outputs/report.html")).toBe(true);
    expect(isOutputNamespacePath("outputs/nested/report.html")).toBe(true);
    for (const path of ["outputs", "outputs/", "report/outputs/x.md", "outputsx/a.md", "../outputs/a.md"]) expect(isOutputNamespacePath(path), path).toBe(false);
  });

  it("treats revisions as opaque bounded tokens", () => {
    expect(isFileRevision("r1.abcdEFGH_1234")).toBe(true);
    for (const value of ["short", "has space here", "a/b/c/d/e/f", "x".repeat(257), 12345678]) expect(isFileRevision(value)).toBe(false);
  });
});

describe("output-publication contract", () => {
  it("freezes producers, stages, limits and forward-only transitions", () => {
    expect([...OUTPUT_PRODUCERS]).toEqual(["shell-output", "image-operation", "assistant-image"]);
    expect([...OUTPUT_RECEIPT_STAGES]).toEqual(["retained", "attached", "registered", "failed"]);
    expect(OUTPUT_PUBLICATION_LIMITS).toEqual({ maxFileBytes: 25 * 1024 * 1024, maxFilesPerTurn: 20, hostCardsPerTurn: 1 });
    expect(canAdvanceOutputStage("retained", "registered")).toBe(true);
    expect(canAdvanceOutputStage("failed", "registered")).toBe(true);
    expect(canAdvanceOutputStage("registered", "retained")).toBe(false);
    expect(canAdvanceOutputStage("registered", "failed")).toBe(false);
    expect(canAdvanceOutputStage("attached", "retained")).toBe(false);
    expect(isOutputProducer("shell-output")).toBe(true);
    expect(isOutputProducer("bash")).toBe(false);
    expect(isOutputReceiptStage("failed")).toBe(true);
    expect(isOutputReceiptStage("done")).toBe(false);
    expect(isOutputPathToken("generated-images/0f.png")).toBe(true);
    expect(isOutputPathToken("/Users/x/generated-images/0f.png")).toBe(false);
  });
});

describe("media-assets contract", () => {
  it("freezes routes, capability lifetime and reference limits", () => {
    expect(MEDIA_ROUTES.resolve.startsWith(`${MEDIA_ROUTE_PREFIX}/`)).toBe(true);
    expect(MEDIA_ROUTES.bytes.startsWith(`${MEDIA_ROUTE_PREFIX}/`)).toBe(true);
    expect(IMAGE_REFERENCE_ROUTE).toBe("/api/internal/resolve-image-reference");
    expect(MEDIA_CAPABILITY_TTL_MS).toBe(600_000);
    expect(IMAGE_REFERENCE_LIMITS).toEqual({ maxCount: 4, maxBytesEach: 10 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024 });
  });

  it("shapes and redacts capability tokens", () => {
    const token = `mc1.eyJ2IjoxfQ.${"A".repeat(43)}`;
    expect(isMediaCapabilityToken(token)).toBe(true);
    for (const value of ["mc1..sig", `mc2.eyJ2IjoxfQ.${"A".repeat(43)}`, `mc1.eyJ2IjoxfQ.${"A".repeat(42)}`, "", 1]) expect(isMediaCapabilityToken(value)).toBe(false);
    expect(redactMediaCapability(`GET /api/media/bytes/a1?cap=${token}&x=1`)).toBe("GET /api/media/bytes/a1?cap=[redacted]&x=1");
    expect(redactMediaCapability(`/api/media/bytes/a1?x=1&cap=${token}`)).toBe("/api/media/bytes/a1?x=1&cap=[redacted]");
  });

  it("accepts exactly one discriminated reference source without roots or URLs", () => {
    const artifactId = "0f2a1c3e-1111-4222-8333-944455566677";
    expect(isImageReferenceSource({ kind: "attachment", attachmentId: "4b1e-uuid.png" })).toBe(true);
    expect(isImageReferenceSource({ kind: "artifact", artifactId, sha256: "a".repeat(64) })).toBe(true);
    expect(isImageReferenceSource({ kind: "workspace", relativePath: "outputs/cover.png" })).toBe(true);
    expect(isImageReferenceSource({ kind: "workspace", relativePath: "outputs/cover.png", revision: "r1.abcdEFGH_1234" })).toBe(true);
    for (const value of [
      null, "x.png", { kind: "attachment", attachmentId: "../x.png" }, { kind: "attachment", attachmentId: "x.gif" },
      { kind: "attachment", attachmentId: "x.png", path: "/tmp/x.png" }, { kind: "artifact", artifactId }, { kind: "artifact", artifactId, sha256: "zz" },
      { kind: "workspace", relativePath: "/Users/me/x.png" }, { kind: "workspace", relativePath: "../x.png" }, { kind: "workspace", relativePath: "x.png", root: "/" },
      { kind: "url", url: "https://example.com/x.png" }, { kind: "workspace", relativePath: "x.png", revision: "bad revision" },
    ]) expect(isImageReferenceSource(value), JSON.stringify(value)).toBe(false);
  });
});
