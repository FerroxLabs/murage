// SPDX-License-Identifier: AGPL-3.0-or-later
// Release finding 12-B3: Watch screen was an anchor whose href was the viewer address with the desktop password in its fragment, opened in the
// system browser (and so kept in its history). The address now goes only from a fresh status answer into Murage's own viewer window.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { openLocalVmViewer, withoutViewerUrl } from "./local-vm-viewer";

const URL_WITH_PASSWORD = "http://127.0.0.1:6080/vnc.html#autoconnect=true&resize=scale&password=s3cr3tpw";

describe("the Local VM viewer address", () => {
  it("is removed from the status a page keeps", () => {
    const kept = withoutViewerUrl({ ready: true, viewer_url: URL_WITH_PASSWORD, mode: "shared" });
    expect(JSON.stringify(kept)).not.toContain("s3cr3tpw");
    expect(kept).toEqual({ ready: true, mode: "shared" });
  });
  it("goes straight to Murage's own viewer window", async () => {
    const open = vi.fn(async () => true);
    expect(await openLocalVmViewer(async () => ({ viewer_url: URL_WITH_PASSWORD }), { open }, "Local VM", "local-vm")).toBe(true);
    expect(open).toHaveBeenCalledWith(URL_WITH_PASSWORD, "Local VM", "local-vm");
  });
  it("opens nothing when the status has no viewer address", async () => {
    const open = vi.fn(async () => true);
    expect(await openLocalVmViewer(async () => ({ viewer_url: "" }), { open }, "t", "c")).toBe(false);
    expect(await openLocalVmViewer(async () => null, { open }, "t", "c")).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
  it("is never an anchor or page state in Settings", () => {
    const source = readFileSync(new URL("../components/LocalComputerSection.tsx", import.meta.url), "utf8");
    expect(source).not.toContain("href={status?.viewer_url");
    expect(source).not.toContain("viewer_url");
    expect(source).toContain("withoutViewerUrl(");
  });
});
