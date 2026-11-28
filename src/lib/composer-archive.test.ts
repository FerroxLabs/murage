// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it, vi } from "vitest";
import { intakeFiles } from "./composer-attachments.ts";
afterEach(() => vi.unstubAllGlobals());

it.each(["bundle.zip", "bundle.tar.gz", "bundle.7z", "plan.xmind"])("uploads a pathless %s with a known type even when the browser reports no type", async name => {
  const request = vi.fn(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify({ path: "/fixture/attachments/file.md", name: "plan.md", bytes: 12 }), { status: 201 }));
  vi.stubGlobal("fetch", request);
  const file = new File(["opaque"], name);
  const result = await intakeFiles([file], { allowImages: false, getPath: () => "", uploadImage: async () => null });
  expect(result.notice).toBeNull();
  expect(result.attachments).toMatchObject([{ kind: "file", path: "/fixture/attachments/file.md" }]);
  expect(request).toHaveBeenCalledOnce();
  expect(request.mock.calls[0]?.[0]).toContain("/api/files?name=");
});

it("converts a desktop XMind file through the same upload before adding its chip", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ path: "/fixture/plan.md", name: "plan.md", bytes: 8 }), { status: 201 })));
  const result = await intakeFiles([new File(["map"], "plan.xmind")], { allowImages: false, getPath: () => "/fixture/plan.xmind", uploadImage: async () => null });
  expect(result.attachments).toMatchObject([{ path: "/fixture/plan.md", name: "plan.md" }]);
});

it("preserves an existing desktop archive path without reading or uploading it", async () => {
  const request = vi.fn(); vi.stubGlobal("fetch", request);
  const result = await intakeFiles([new File(["opaque"], "bundle.zip")], { allowImages: false, getPath: () => "/fixture/bundle.zip", uploadImage: async () => null });
  expect(result.attachments).toMatchObject([{ path: "/fixture/bundle.zip" }]);
  expect(request).not.toHaveBeenCalled();
});

it("uses the supplied translation and keeps a refusal's private words and filename out of the notice", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "private response words" }), { status: 400 })));
  const result = await intakeFiles([new File(["map"], "private-name.xmind")], {
    allowImages: false, getPath: () => "", uploadImage: async () => null,
    fileError: code => `translated ${code}`,
  });
  expect(result.attachments).toEqual([]);
  expect(result.notice).toBe("translated invalidMindMap");
  expect(result.notice).not.toContain("private");
});
