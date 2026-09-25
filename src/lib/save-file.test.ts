// Every "save a copy" goes through one door. In a browser that door is the
// same a[download] click the app has always made. Inside the phone app a
// blob: link has nowhere to go — Android's DownloadListener cannot read a
// blob URL (spec §3.2) — so the bytes go to native instead: a server file by
// its URL, generated content in 1 MB pieces, never more than 25 MB.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetNativeShellForTest } from "./native-shell";
import { NATIVE_SAVE_CHUNK_BYTES, NATIVE_SAVE_MAX_BYTES, saveBlob, saveUrl } from "./save-file";

let link: { href: string; download: string; rel: string; referrerPolicy: string; click: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.useFakeTimers();
  link = { href: "", download: "", rel: "", referrerPolicy: "", click: vi.fn(), remove: vi.fn() };
  vi.stubGlobal("document", { createElement: vi.fn(() => link), body: { appendChild: vi.fn() } });
  vi.stubGlobal("location", { href: "https://desk.tail0a48a4.ts.net/" });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:synthetic");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => {
  resetNativeShellForTest();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function nativeSave(impl: (request: any) => unknown = async () => undefined) {
  const saveFile = vi.fn(impl);
  vi.stubGlobal("murageNative", { hello: async () => ({ version: 1, methods: ["saveFile"] }), saveFile });
  return saveFile;
}

describe("in a plain browser", () => {
  it("clicks the same a[download] it always did, and frees the object URL later", async () => {
    await saveBlob(new Blob(["hello"]), "note.md");
    expect(link.href).toBe("blob:synthetic");
    expect(link.download).toBe("note.md");
    expect(link.click).toHaveBeenCalledOnce();
    expect(link.remove).toHaveBeenCalledOnce();
    vi.runAllTimers();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:synthetic");
  });

  it("still cleans up when the browser refuses the click", async () => {
    link.click.mockImplementation(() => { throw new Error("Download unavailable"); });
    await expect(saveBlob(new Blob(["x"]), "x.txt")).rejects.toThrow("Download unavailable");
    expect(link.remove).toHaveBeenCalledOnce();
    vi.runAllTimers();
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it("saves a server file by pointing the anchor at it", async () => {
    await saveUrl("/api/artifacts/a1/download", "report.pdf");
    expect(link.href).toBe("/api/artifacts/a1/download");
    expect(link.download).toBe("report.pdf");
  });
});

describe("inside the phone app", () => {
  it("hands a server file over by absolute URL, so its bytes never cross the channel", async () => {
    const saveFile = nativeSave();
    await saveUrl("/api/artifacts/a1/download", "report.pdf");
    expect(saveFile).toHaveBeenCalledWith({ kind: "url", url: "https://desk.tail0a48a4.ts.net/api/artifacts/a1/download", filename: "report.pdf" });
    expect(link.click).not.toHaveBeenCalled();
  });

  it("sends generated content in 1 MB pieces that reassemble byte for byte", async () => {
    const saveFile = nativeSave();
    const bytes = new Uint8Array(NATIVE_SAVE_CHUNK_BYTES * 2 + 5).map((_, i) => i % 251);
    await saveBlob(new Blob([bytes], { type: "application/zip" }), "team.zip");
    const requests = saveFile.mock.calls.map(([request]) => request);
    expect(requests.map((r) => r.kind)).toEqual(["begin", "chunk", "chunk", "chunk", "end"]);
    expect(requests[0]).toMatchObject({ filename: "team.zip", mime: "application/zip", size: bytes.length });
    expect(new Set(requests.map((r) => r.id)).size).toBe(1);
    const joined = Buffer.concat(requests.filter((r) => r.kind === "chunk").map((r) => Buffer.from(r.base64, "base64")));
    expect(new Uint8Array(joined)).toEqual(bytes);
    expect(requests.filter((r) => r.kind === "chunk").map((r) => r.index)).toEqual([0, 1, 2]);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("refuses more than 25 MB before sending anything", async () => {
    const saveFile = nativeSave();
    await expect(saveBlob(new Blob([new Uint8Array(NATIVE_SAVE_MAX_BYTES + 1)]), "huge.bin")).rejects.toMatchObject({ code: "too-large" });
    expect(saveFile).not.toHaveBeenCalled();
  });

  it("aborts the transfer when native fails part way, and says why", async () => {
    const saveFile = nativeSave(async (request) => {
      if (request.kind === "chunk" && request.index === 1) throw new Error("disk full");
    });
    await expect(saveBlob(new Blob([new Uint8Array(NATIVE_SAVE_CHUNK_BYTES * 2)]), "a.bin")).rejects.toThrow("disk full");
    expect(saveFile.mock.calls.at(-1)?.[0]).toMatchObject({ kind: "abort" });
  });

  it("saves an empty file as begin and end with no chunks", async () => {
    const saveFile = nativeSave();
    await saveBlob(new Blob([]), "empty.txt");
    expect(saveFile.mock.calls.map(([r]) => r.kind)).toEqual(["begin", "end"]);
  });

  it("reads a blob: or data: link locally and sends its bytes, since native cannot fetch it", async () => {
    const saveFile = nativeSave();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["png-bytes"], { type: "image/png" }))));
    await saveUrl("blob:https://desk.tail0a48a4.ts.net/1234", "photo.png");
    expect(saveFile.mock.calls.map(([r]) => r.kind)).toEqual(["begin", "chunk", "end"]);
    expect(saveFile.mock.calls[0]![0]).toMatchObject({ mime: "image/png", filename: "photo.png" });
  });
});
