// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A room reply always says who wrote it. With tool calls hidden, each bot's
// folded activity run is not drawn; it used to still count as the previous
// row, so the reply after it matched "same sender" and lost its name label
// (two bots answering in a row showed two unlabelled bubbles).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./GroupView.tsx", import.meta.url), "utf8");
const transcript = source.slice(source.indexOf("const Transcript = memo("), source.indexOf("function DefaultResponderSelect("));

describe("room sender labels", () => {
  it("judges a new sender against the last row actually drawn, not the last item", () => {
    expect(transcript).toContain("const prev = shownPrev;");
    expect(transcript).not.toMatch(/items\[i - 1\]/);
  });

  it("only a drawn row becomes the previous sender", () => {
    // Set exactly twice: a drawn run, and a drawn message row. Never before a
    // `return null` (hidden run, streaming bubble, quiet step).
    expect(transcript.match(/shownPrev = /g)).toHaveLength(2);
    expect(transcript).toMatch(/shownPrev = item\.messages\.at\(-1\);\s*return \(/);
    expect(transcript).toMatch(/if \(!row\) return null;\s*shownPrev = m;/);
    expect(transcript).toMatch(/if \(!showToolCalls\) return null;\s*const cluster/);
  });

  it("an error row always names its bot, even inside that bot's cluster", () => {
    expect(transcript).toContain(
      'const errorRow = m.kind === "activity" && Boolean(m.tool) && (m.tool!.ok === false || m.tool!.name.startsWith("error:"));',
    );
    expect(transcript).toMatch(/\{!user && m\.from && \(newCluster \|\| errorRow\) && \(\s*<ClusterLabel/);
  });
});
