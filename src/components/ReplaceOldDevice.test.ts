import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { lastSeenLabel, ReplaceOldDevice } from "./ReplaceOldDevice";

const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

const device = (id: string, name: string, lastSeenAt: number) => ({
  id,
  name,
  createdAt: lastSeenAt,
  lastSeenAt,
  cloudDesktopAccess: false,
});

describe("Replace an old device", () => {
  it("renders nothing while there is room for another device", () => {
    expect(renderToStaticMarkup(createElement(ReplaceOldDevice, { candidates: [], busy: false, onReplace: vi.fn() }))).toBe("");
  });

  it("lists devices in the order the computer sent, each with its own labelled Replace button", () => {
    const now = Date.now();
    const html = renderToStaticMarkup(
      createElement(ReplaceOldDevice, {
        candidates: [device("a", "Old iPad", now - 40 * 86_400_000), device("b", "Pixel", now - 60_000)],
        max: 20,
        busy: false,
        onReplace: vi.fn(),
      }),
    );
    expect(html).toContain("Replace an old device");
    expect(html).toContain("already has 20 devices");
    expect(html.indexOf("Old iPad")).toBeLessThan(html.indexOf("Pixel"));
    expect(html).toContain('aria-label="Replace Old iPad, last seen 40 d ago"');
    expect(html).toContain('type="button"');
  });

  it("says when each was last seen in words", () => {
    const now = 1_700_000_000_000;
    expect(lastSeenLabel(now - 30_000, now)).toBe("just now");
    expect(lastSeenLabel(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(lastSeenLabel(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(lastSeenLabel(now - 40 * 86_400_000, now)).toBe("40 d ago");
    expect(lastSeenLabel(now + 60_000, now)).toBe("just now");
    expect(lastSeenLabel(NaN, now)).toBe("unknown");
  });

  it("is offered on both pairing screens, and replacing is the ordinary revoke", () => {
    for (const source of [read("./CompanionSection.tsx"), read("./PhoneSetupFlow.tsx")]) {
      expect(source).toContain("<ReplaceOldDevice");
      expect(source).toContain("candidates={c.state?.replaceCandidates ?? []}");
      expect(source).toContain("onReplace={(id) => void c.act((companion) => companion.revoke(id))}");
    }
  });
});
