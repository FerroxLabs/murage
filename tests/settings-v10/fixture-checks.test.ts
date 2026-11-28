// Q1: the v10 fixture checks (1,469 claims over 96 pages) and the v10 mockup rules must pass on the committed generator.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pythonOut, withScratchGen } from "./run-mockup";

describe("settings v10 fixture checks (Q1)", () => {
  const out = withScratchGen((gen) => pythonOut([join(gen, "build.py")], gen));
  const line = (re: RegExp) => re.exec(out)?.slice(1);

  it("keeps the generator's own HTML checks clean (balanced tags, unique ids, named switches)", () => {
    expect(line(/^wrote (\d+) files; size mismatches: (\d+)$/m)).toEqual(["98", "0"]);
    expect(line(/^HTML parse: (\d+) files, (\d+) with errors$/m)).toEqual(["96", "0"]);
    expect(out).not.toMatch(/^ {2}\S+\.html \[/m);
  });
  it("keeps all 1,469 fixture claims with 0 mismatches", () => {
    expect(line(/^fixture consistency: (\d+) claims checked across (\d+) pages, (\d+) mismatches$/m)).toEqual(["1469", "96", "0"]);
  });
  it("keeps every link, id and signpost clean", () => {
    expect(line(/^links: (\d+) checked, (\d+) broken/m)?.[1]).toBe("0");
    expect(line(/^one home: \d+ control and action ids drawn, (\d+) with more than one home; \d+ signposts, (\d+) unresolved/m)).toEqual(["0", "0"]);
    expect(line(/^signposts tied to their target .*: (\d+) point somewhere else; (\d+) signposts/m)).toEqual(["0", "0"]);
    expect(line(/^Fix links: \d+; without an exact control anchor: (\d+)/m)).toEqual(["0"]);
  });
  it("keeps contrast, copy rules, switch names and help topics clean", () => {
    expect(line(/^contrast: (\d+) pairs, (\d+) fail/m)).toEqual(["88", "0"]);
    expect(out).toMatch(/^copy rules .*: clean$/m);
    expect(line(/^switches: \d+ distinct labels, (\d+) inverted/m)).toEqual(["0"]);
    expect(line(/^action labels: (\d+) actions, (\d+) duplicate/m)).toEqual(["96", "0"]);
    expect(line(/^help: (\d+) topics written/m)).toEqual(["24"]);
    expect(line(/^help: \d+ topics written; links use \d+; links with no topic: (\[[^\]]*\]); topics with no link: (\[[^\]]*\])/m)).toEqual(["[]", "[]"]);
    expect(line(/^aliases: (\d+), (\d+) do not land; curated answers: (\d+), (\d+) do not land/m)).toEqual(["18", "0", "8", "0"]);
  });
  it("draws the 39 fixture bots plus 2 archived", () => {
    expect(line(/^bots\.html draws (\d+) bot rows \(fixture: (\d+) \+ (\d+) archived\)/m)).toEqual(["41", "39", "2"]);
  });
});
