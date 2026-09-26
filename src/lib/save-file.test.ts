// Every "save a copy" goes through one door. In a browser that door is the
// same a[download] click the app has always made. Inside the phone app a
// blob: link has nowhere to go — Android's DownloadListener cannot read a
// blob URL (spec §3.2) — so the bytes go to native instead: a server file by
// its URL, generated content in 1 MB pieces, never more than 25 MB.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetNativeShellForTest } from "./native-shell";
import { dataUrlBlob, NATIVE_SAVE_CHUNK_BYTES, NATIVE_SAVE_MAX_BYTES, onSaveFailed, reportSaveFailure, saveBlob, saveFailureMessage, saveSource, saveUrl } from "./save-file";

let link: { href: string; download: string; rel: string; referrerPolicy: string; click: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.useFakeTimers();
  link = { href: "", download: "", rel: "", referrerPolicy: "", click: vi.fn(), remove: vi.fn() };
  vi.stubGlobal("document", { createElement: vi.fn(() => link), body: { appendChild: vi.fn() } });
  vi.stubGlobal("location", { href: "https://desk.tailexample.ts.net/", origin: "https://desk.tailexample.ts.net" });
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
    expect(saveFile).toHaveBeenCalledWith({ kind: "url", url: "https://desk.tailexample.ts.net/api/artifacts/a1/download", filename: "report.pdf" });
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

  it("reads a blob: link locally and sends its bytes, since native cannot fetch it", async () => {
    const saveFile = nativeSave();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["png-bytes"], { type: "image/png" }))));
    await saveUrl("blob:https://desk.tailexample.ts.net/1234", "photo.png");
    expect(saveFile.mock.calls.map(([r]) => r.kind)).toEqual(["begin", "chunk", "end"]);
    expect(saveFile.mock.calls[0]![0]).toMatchObject({ mime: "image/png", filename: "photo.png" });
  });

  // I1: the door's CSP says connect-src 'self', and a data: URL's origin is
  // opaque, so fetch("data:…") is refused there. The bytes are decoded here.
  it("decodes a data: image in the page, without fetch, and sends its exact bytes", async () => {
    const saveFile = nativeSave();
    const fetchSpy = vi.fn(async () => { throw new TypeError("Refused to connect: CSP connect-src"); });
    vi.stubGlobal("fetch", fetchSpy);
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]);
    await saveUrl(`data:image/png;base64,${Buffer.from(bytes).toString("base64")}`, "chart.png");
    expect(fetchSpy).not.toHaveBeenCalled();
    const requests = saveFile.mock.calls.map(([r]) => r);
    expect(requests.map((r) => r.kind)).toEqual(["begin", "chunk", "end"]);
    expect(requests[0]).toMatchObject({ mime: "image/png", filename: "chart.png", size: bytes.length });
    expect(new Uint8Array(Buffer.from(requests[1].base64, "base64"))).toEqual(bytes);
  });

  it("never hands native a download from another site; that opens in the system browser", async () => {
    const saveFile = vi.fn(async () => undefined);
    const openExternal = vi.fn(async () => undefined);
    vi.stubGlobal("murageNative", { hello: async () => ({ version: 1, methods: ["saveFile", "openExternal"] }), saveFile, openExternal });
    await saveUrl("https://cdn.example.com/file.zip", "file.zip");
    expect(saveFile).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith("https://cdn.example.com/file.zip");
  });

  it("says so when another site's file cannot be opened either", async () => {
    const saveFile = nativeSave();
    await expect(saveUrl("https://cdn.example.com/file.zip", "file.zip")).rejects.toMatchObject({ code: "elsewhere" });
    expect(saveFile).not.toHaveBeenCalled();
  });
});

describe("reading a data: URL", () => {
  const text = async (blob: Blob) => new TextDecoder().decode(await blob.arrayBuffer());

  it("decodes base64, keeping the type and its parameters", async () => {
    const blob = dataUrlBlob("data:text/plain;charset=utf-8;base64,aGVsbG8gd29ybGQ=");
    expect(blob.type).toBe("text/plain;charset=utf-8");
    expect(await text(blob)).toBe("hello world");
  });

  it("decodes percent-encoding byte for byte, and defaults the type as the spec does", async () => {
    const blob = dataUrlBlob("data:,a%20b%E2%9C%93c");
    expect(blob.type).toBe("text/plain;charset=us-ascii");
    expect(await text(blob)).toBe("a b\u2713c");
  });

  it("tolerates whitespace and escapes inside base64", async () => {
    expect(await text(dataUrlBlob("data:;base64,aGVs%0AbG8="))).toBe("hello");
  });

  it("refuses a damaged link in words, not with a decoder error", () => {
    expect(() => dataUrlBlob("data:image/png;base64")).toThrow("damaged");
    expect(() => dataUrlBlob("data:image/png;base64,***")).toThrow("damaged");
  });
});

describe("where a save link's bytes live", () => {
  const ORIGIN = "https://desk.tailexample.ts.net";
  it("is one rule: page bytes, this server, or somewhere else", () => {
    expect(saveSource("blob:https://desk.tailexample.ts.net/1", ORIGIN)).toBe("page");
    expect(saveSource("DATA:image/png;base64,AA==", ORIGIN)).toBe("page");
    expect(saveSource("/api/attachments/a1", ORIGIN)).toBe("server");
    expect(saveSource(`${ORIGIN}/api/attachments/a1`, ORIGIN)).toBe("server");
    expect(saveSource("https://desk.tailexample.ts.net.evil.example/x", ORIGIN)).toBe("external");
    expect(saveSource("http://desk.tailexample.ts.net/x", ORIGIN)).toBe("external");
    expect(saveSource("https://cdn.example.com/x", ORIGIN)).toBe("external");
  });

  it("has exactly one copy of the blob:/data: test in the source", async () => {
    const { readFileSync } = await import("node:fs");
    const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
    const pattern = "(?:blob|data):";
    expect(read("./save-file.ts").split(pattern)).toHaveLength(2);
    expect(read("./open-external.ts")).not.toContain(pattern);
  });
});

describe("a save that fails", () => {
  it("is announced once, in plain words, instead of vanishing into the console", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const target = new EventTarget();
    vi.stubGlobal("addEventListener", target.addEventListener.bind(target));
    vi.stubGlobal("removeEventListener", target.removeEventListener.bind(target));
    vi.stubGlobal("dispatchEvent", target.dispatchEvent.bind(target));
    const heard: string[] = [];
    const stop = onSaveFailed((message) => heard.push(message));
    reportSaveFailure(new Error("NSURLErrorDomain -1009"));
    stop();
    reportSaveFailure(new Error("again"));
    expect(heard).toEqual(["Couldn't save that file. Try again."]);
  });

  it("reaches the person from the media card too, as the store's error toast", async () => {
    const { readFileSync } = await import("node:fs");
    const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
    expect(read("../components/MediaPlayer.tsx")).toContain("void saveUrl(next.url, asset.name).catch(reportSaveFailure);");
    expect(read("../state/store.tsx")).toContain("useEffect(() => onSaveFailed((message) => {");
  });

  it("keeps the words of a refusal this module wrote", () => {
    const tooLarge = Object.assign(new Error("This file is bigger than 25 MB"), { code: "too-large" });
    expect(saveFailureMessage(tooLarge)).toBe("This file is bigger than 25 MB");
    expect(saveFailureMessage("boom")).toBe("Couldn't save that file. Try again.");
  });
});
