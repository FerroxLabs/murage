import { describe, expect, it, vi } from "vitest";

import { loadSectionContext, saveSectionContext, sectionContextPath } from "./section-context-client";

/** A harness stand-in holding one brief per section, the way
 *  section-context.ts stores it: blank clears, anything else is kept verbatim. */
function fakeHarness() {
  const saved = new Map<string, { text: string; updatedAt: number }>();
  let clock = 1_000;
  return vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
    const section = new URL(path, "http://x").searchParams.get("section")!.trim();
    if (init?.method === "PUT") {
      const text = (JSON.parse(init.body!) as { text: string }).text;
      if (text.trim()) saved.set(section, { text, updatedAt: ++clock });
      else saved.delete(section);
    }
    const record = saved.get(section);
    return { section, label: section || "General", text: record?.text ?? "", updatedAt: record?.updatedAt ?? null, maxBytes: 24_000 };
  });
}

describe("team instructions client", () => {
  it("addresses the team by its section name, including names that need escaping", () => {
    expect(sectionContextPath("Creator Studio & Ops")).toBe("/api/section-context?section=Creator%20Studio%20%26%20Ops");
  });

  it("saves instructions for a team after it exists and reads them back on reopen", async () => {
    const request = fakeHarness();
    expect((await loadSectionContext("Operations", request)).text).toBe("");

    const saved = await saveSectionContext("Operations", "Ship the weekly report every Friday.", request);
    expect(saved.text).toBe("Ship the weekly report every Friday.");
    expect(saved.updatedAt).toEqual(expect.any(Number));

    const put = request.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(JSON.parse(put[1]!.body!)).toEqual({ text: "Ship the weekly report every Friday." });

    const reopened = await loadSectionContext("Operations", request);
    expect(reopened.text).toBe("Ship the weekly report every Friday.");

    const edited = await saveSectionContext("Operations", "Ship the report on Thursdays.", request);
    expect((await loadSectionContext("Operations", request)).text).toBe(edited.text);
  });

  it("passes a server refusal through unchanged", async () => {
    const request = vi.fn().mockRejectedValue(new Error("section context is capped at 24KB"));
    await expect(saveSectionContext("Operations", "x", request)).rejects.toThrow("capped at 24KB");
  });
});
