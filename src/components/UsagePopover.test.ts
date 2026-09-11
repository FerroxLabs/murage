// Source contracts, not render tests: the renderer suite runs in a node
// environment with no DOM (see SkillAffordances.test.ts for the same reason).
// What is worth pinning here is not how the popover looks — it is the set of
// behaviours a native `title` attribute could not have, and which are the
// entire reason this component exists.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

const popover = read("./UsagePopover.tsx");
// UsageChip moved to ChatHeader.tsx with the rest of the header (U0-T1);
// every assertion below is the one that was already here.
const chat = read("./ChatHeader.tsx");
const skillsPanel = read("./BotSkillsPanel.tsx");

/** The `UsageChip` function alone, so an assertion about the chip cannot be
 *  satisfied by the working-folder chip sitting right beside it. */
const usageChipSource = (() => {
  const start = chat.indexOf("function UsageChip(");
  expect(start, "UsageChip is missing entirely").toBeGreaterThan(-1);
  return chat.slice(start, chat.indexOf("\nfunction ", start + 10));
})();

describe("the token chip has a real popover, not a title attribute", () => {
  it("no longer hands the breakdown to the browser as a native tooltip", () => {
    // A `title` cannot be styled or positioned, needs about a second of
    // MOTIONLESS hover, and vanishes the moment the pointer moves toward it.
    // The user remembered this as a fly-out that had been deleted; it never
    // existed. If this assertion fails, it has been reintroduced.
    expect(usageChipSource).not.toMatch(/title=\{/);
    expect(usageChipSource).toContain("<UsagePopover");
  });

  it("opens on hover AND on focus, so a keyboard reaches it at all", () => {
    expect(popover).toContain("onMouseEnter={() => setOpen(true)}");
    expect(popover).toContain("onFocus={() => setOpen(true)}");
  });

  it("stays open while the pointer is inside it", () => {
    // Two halves of one promise: the panel is a CHILD of the element that
    // owns the open state, and the gap between chip and panel is the panel's
    // own padding rather than a margin — so crossing it never fires
    // `mouseleave`. Either one alone is the `title` failure again.
    const wrapper = popover.slice(popover.indexOf("ref={wrap}"));
    expect(wrapper).toContain("onMouseLeave={() => setOpen(false)}");
    expect(wrapper.indexOf("trigger({")).toBeLessThan(wrapper.indexOf('role="group"'));
    expect(wrapper).toContain("top-full z-50 pt-2");
  });

  it("closes on Escape and on an outside click", () => {
    expect(popover).toContain('if (event.key !== "Escape") return;');
    expect(popover).toContain('document.addEventListener("keydown", onKey)');
    expect(popover).toContain('document.addEventListener("pointerdown", onPointerDown)');
    expect(popover).toContain("if (!wrap.current?.contains(event.target as Node)) setOpen(false);");
    // Both are removed again — a listener per open would pile up.
    expect(popover).toContain('document.removeEventListener("keydown", onKey)');
    expect(popover).toContain('document.removeEventListener("pointerdown", onPointerDown)');
  });

  it("closes when focus leaves the whole popover, not merely the chip", () => {
    expect(popover).toContain("if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);");
  });

  it("cannot overflow a 390px viewport", () => {
    // Right-anchored, because the chip sits in a cluster hard against the
    // right edge, and capped against the viewport rather than trusting the
    // anchor to have room.
    expect(popover).toContain("absolute right-0");
    expect(popover).toContain("max-w-[min(19rem,calc(100vw-1.5rem))]");
  });

  it("respects prefers-reduced-motion", () => {
    expect(popover).toContain("motion-reduce:animate-none");
    expect(popover).toContain("motion-reduce:transition-none");
  });

  it("leads somewhere: the same all-bots destination the Usage card uses", () => {
    expect(popover).toContain("All bots →");
    expect(usageChipSource).toContain('dispatch({ type: "toggleAppSettings", open: true, section: "usage" })');
  });

  it("keeps the chip's own click on the agent profile", () => {
    expect(usageChipSource).toContain('onClick={() => dispatch({ type: "toggleSettings", open: true })}');
  });

  it("keeps the folded and narrow variants working", () => {
    // The chip folds to one figure when the header's measured layout says so
    // (`chip-fold:`, U0-T1), and leaves the header entirely — into the More
    // menu, figure intact — when the conversation name needs every pixel.
    // Neither is a container breakpoint of the chip's own any more.
    expect(usageChipSource).not.toMatch(/@max-\w+\/chathead/);
    expect(usageChipSource).toContain("chip-trim:px-2");
    expect(usageChipSource).toContain('<span className="chip-trim:hidden">{text}</span>');
    expect(usageChipSource).toContain('<span className="hidden chip-trim:inline">{short}</span>');
    expect(chat).toContain('{inHeader("usage") && <UsageChip bot={bot} />}');
    expect(chat).toContain('label: t("chatHeader.usageMenu", { usage: usageText })');
  });

  it("names the open panel to a screen reader", () => {
    expect(usageChipSource).toContain("aria-describedby={describedBy}");
    // Not role="tooltip": a tooltip may hold no interactive content, and this
    // one holds the link through to every bot.
    expect(popover).toContain('role="group"');
    expect(popover).toContain('aria-label="Usage detail"');
  });

  it("renders the report the pure function assembles, line for line", () => {
    // The wording lives in src/lib/usage.ts, where it is tested against
    // engines that report no cache and no cost, and against a bot mid-turn.
    expect(usageChipSource).toContain("usageReport(usage, { billing, busy: bot.busy, activity: bot.activity })");
    expect(popover).toContain("lines.map((line) =>");
  });
});

describe("removing a skill actually issues the DELETE", () => {
  it("does not gate the request behind a native confirm dialog", () => {
    // ROOT CAUSE. `onRemove` opened with an early return gated on the
    // browser's own confirm() prompt, whose name is spelled out only in the
    // assertion below so this comment cannot satisfy it.
    // A native JS dialog is auto-dismissed under automation, and a dismissed
    // dialog is indistinguishable from "no", so the handler returned before
    // reaching `store.remove` — a network log across the whole click showed
    // only the `GET .../skills` re-reads and no DELETE at all.
    expect(skillsPanel).not.toContain(["window", "confirm"].join("."));
    expect(skillsPanel).toContain("onRemove={(skill) => void store.remove(skill)}");
  });

  it("still sends exactly one DELETE, to the route that was never broken", () => {
    expect(skillsPanel).toContain(
      'await request(`/api/bots/${botId}/skills/${encodeURIComponent(skill.name)}`, { method: "DELETE" });',
    );
  });

  it("says on the control what the single click will do", () => {
    // No dialog means the click IS the action, so the consequence and the way
    // back have to be on the control itself.
    expect(skillsPanel).toContain("title={`Remove ${skill.name} from ${botName}. Add it again from the library at any time.`}");
  });
});
