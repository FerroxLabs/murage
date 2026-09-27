import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { TRANSCRIPT_GAP, observeDockHeight, transcriptEndPad } from "./composer-dock";

describe("transcriptEndPad", () => {
  it("adds one gap-3 of black above the measured composer", () => {
    expect(TRANSCRIPT_GAP).toBe("0.75rem");
    expect(transcriptEndPad(72)).toBe("calc(72px + 0.75rem)");
  });

  it("ceils fractional heights so a subpixel composer cannot eat the gap", () => {
    expect(transcriptEndPad(71.2)).toBe("calc(72px + 0.75rem)");
  });

  it("does not go negative", () => {
    expect(transcriptEndPad(-4)).toBe("calc(0px + 0.75rem)");
  });

  it("uses a one-line empty-composer fallback, not the old two-row slot", () => {
    expect(transcriptEndPad(Number.NaN)).toBe("calc(64px + 0.75rem)");
  });
});

describe("observeDockHeight", () => {
  class FakeObserver {
    static last: FakeObserver | null = null;
    observed: Element[] = [];
    disconnected = false;
    constructor(readonly callback: () => void) {
      FakeObserver.last = this;
    }
    observe(target: Element) {
      this.observed.push(target);
    }
    disconnect() {
      this.disconnected = true;
    }
  }
  const dock = (height: { px: number }) => ({ getBoundingClientRect: () => ({ height: height.px }) }) as unknown as Element;

  it("measures the dock at once and again on every resize", () => {
    const size = { px: 64 };
    const seen: number[] = [];
    const el = dock(size);
    const stop = observeDockHeight(el, (px) => seen.push(px), FakeObserver);
    expect(FakeObserver.last?.observed).toEqual([el]);
    // The queued chip, the busy hint and inject now land: the composer grows.
    size.px = 196;
    FakeObserver.last?.callback();
    expect(seen).toEqual([64, 196]);
    expect(transcriptEndPad(seen.at(-1)!)).toBe("calc(196px + 0.75rem)");
    stop();
    expect(FakeObserver.last?.disconnected).toBe(true);
  });

  it("reports no height while the dock is not mounted, so the fallback applies", () => {
    FakeObserver.last = null;
    const seen: number[] = [];
    observeDockHeight(null, (px) => seen.push(px), FakeObserver);
    expect(seen).toEqual([0]);
    expect(FakeObserver.last).toBeNull();
  });
});

// A project room opens on Overview, with no dock mounted. The hook took a
// RefObject and observed it once, so the Chat tab's dock was never measured
// and a grown composer covered the newest bubble. It now hands out a callback
// ref and observes whichever dock element is mounted.
describe("useComposerDockPad wiring", () => {
  const hook = readFileSync(new URL("./composer-dock.ts", import.meta.url), "utf8");
  const views = ["GroupView", "ChatView"].map((name) => [
    name,
    readFileSync(new URL(`../components/${name}.tsx`, import.meta.url), "utf8"),
  ]);

  it("re-observes when the dock element changes", () => {
    expect(hook).toMatch(/useLayoutEffect\(\(\) => observeDockHeight\(el, setHeight\), \[el\]\)/);
    expect(hook).toContain("export function useComposerDockPad() {");
    expect(hook).not.toMatch(/RefObject</);
  });

  it.each(views)("%s docks the composer on the hook's callback ref", (_name, source) => {
    expect(source).toContain("const composerDock = useComposerDockPad();");
    expect(source).toContain("ref={composerDock.ref}");
    expect(source).not.toContain("composerDockRef");
    expect(source).toContain("style={{ paddingBottom: composerDock.pad }}");
  });

  it("a room follows the bottom when its Chat tab opens and when the composer resizes", () => {
    const [, group] = views[0];
    expect(group).toMatch(/el\.scrollTo\(\{ top: el\.scrollHeight \}\);[\s\S]{0,240}composerDock\.pad, showChat\]\);/);
  });
});

// Second report: at the composer's normal height a "Thinking 30s" row sat
// under it too. Thinking, streaming and typing rows live inside the padded
// transcript, so they need the measured inset AND a growth observer on the
// transcript that is actually mounted.
describe("live rows at the bottom of a room", () => {
  const group = readFileSync(new URL("../components/GroupView.tsx", import.meta.url), "utf8");
  const follow = readFileSync(new URL("./bottom-follow.ts", import.meta.url), "utf8");

  it("sit inside the padded transcript, above the composer", () => {
    const transcript = group.slice(group.indexOf("style={{ paddingBottom: composerDock.pad }}"), group.indexOf("{!follow && ("));
    expect(transcript).toContain("<TurnPresence");
    expect(transcript).toContain("<Transcript");
  });

  it("are followed only once the Chat tab's transcript is mounted", () => {
    expect(group).toContain("useBottomFollowResize(scrollRef, transcriptRef, followRef, setupPending || !showChat ? null : transcriptKey);");
  });

  it("follow an inset change as well as new rows", () => {
    expect(follow).toContain('observer.observe(transcript, { box: "border-box" });');
  });
});
