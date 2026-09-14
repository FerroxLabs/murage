// The node renderer cannot mount Composer: its dependencies intentionally use
// desktop capabilities. This focused contract pins the picker seam, while the
// isolated browser spec proves the keyboard interaction against fake bots.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "Composer.tsx"), "utf8");

describe("Composer mention picker", () => {
  it("does not truncate its already-authorised candidate pool", () => {
    const candidates = source.slice(source.indexOf("const candidates = useMemo"), source.indexOf("const mentionPickerOpen"));
    expect(candidates).not.toContain(".slice(0, 6)");
    expect(candidates).toContain('id: "__everyone__", name: "everyone"');
    expect(candidates).toContain("member.id !== bot?.id && !member.hidden");
  });

  it("uses a bounded scroll viewport and identifies each keyboard option", () => {
    expect(source).toContain("ref={mentionListRef}");
    expect(source).toContain("max-h-72");
    expect(source).toContain("overflow-y-auto");
    expect(source).toContain('data-mention-index={i}');
  });

  it("keeps the highlighted option in view as the keyboard moves beyond six", () => {
    expect(source).toContain('`[data-mention-index="${highlight}"]`');
    expect(source).toContain('scrollIntoView({ block: "nearest" })');
    const keyboard = source.slice(source.indexOf("if (mentionPickerOpen)"), source.indexOf("// an empty composer"));
    expect(keyboard).toContain("(h + delta + candidates.length) % candidates.length");
    expect(keyboard).toContain("pickMention(candidates[highlight])");
  });
});
